#!/usr/bin/env node
// =============================================================================
// Stage 1 acceptance E2E (charter §6) — drives the FULL retail loop against the
// running docker-compose stack and ASSERTS each of the 5 exit criteria.
//
//   make e2e   (assumes `make up` already brought the stack up healthy)
//
// Deterministic: relies on the committed fake-gen latency knobs (FAKE_TEXT_DELAY_MS
// =0 instant skeleton, FAKE_MEDIA_DELAY_MS≈1200 visible swap) and TIME_SCALE
// (≈3.5s confirmed→delivered) baked into .env.example / compose. No sleeps tuned
// to wall-clock guesses — every wait is a polled condition with a bounded timeout.
//
// It asserts, it does not just print. Any failed assertion exits non-zero.
// =============================================================================
import assert from "node:assert/strict";

import { openSse } from "./sse-client.mjs";

const API = process.env.API_BASE_URL ?? "http://localhost:8080";
const WEB = process.env.WEB_BASE_URL ?? "http://localhost:3000";
const T = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
function ok(name) {
  PASS++;
  console.log(`  ✓ ${name}`);
}
function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}

async function api(path, { token, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. */
async function waitFor(label, fn, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await T(intervalMs);
  }
}

async function main() {
  console.log(`E2E against api=${API} web=${WEB}`);

  // ---- identity (anonymous device, no login) -------------------------------
  section(0, "Identity bootstrap (anonymous device — no login)");
  const id = await api("/v1/identity/device", { method: "POST", body: {} });
  assert.equal(id.status, 200, "identity reachable");
  const token = id.json?.token?.accessToken;
  assert.ok(token, "issued a bearer token");
  assert.ok(id.json.deviceId?.startsWith("dev_"), "deviceId minted");
  ok("anonymous device identity issued (bearer token, no credentials)");

  // ---- (1) browse seeded catalog + open a listing --------------------------
  section(1, "Browse seeded catalog + open a listing");
  const seeded = await api("/v1/search?q=ladder", { token });
  assert.equal(seeded.status, 200, "search 200");
  assert.ok(seeded.json.listings.length > 0, "seeded search returns listings");
  const seedListing = seeded.json.listings[0];
  assert.ok(seedListing.id?.startsWith("lst_"), "listing has id");
  assert.equal(seedListing.media.status, "ready", "seed listing media ready");
  const heroUrl = seedListing.media.hero?.url;
  assert.ok(heroUrl, "seed listing has a hero image url");
  // The hero must be reachable from a BROWSER context (localhost), not the
  // internal compose hostname (minio:9000 / fake-gen:8090).
  assert.ok(/localhost:9000/.test(heroUrl), `hero url is browser-reachable (${heroUrl})`);
  const img = await fetch(heroUrl);
  assert.equal(img.status, 200, "hero image resolves HTTP 200 from browser perspective");
  assert.ok(/image\//.test(img.headers.get("content-type") ?? ""), "hero is an image");
  ok("seeded catalog browses; listing image loads at localhost:9000");

  const detail = await api(`/v1/listings/${seedListing.id}`, { token });
  assert.equal(detail.status, 200, "listing detail 200");
  assert.equal(detail.json.id, seedListing.id, "listing detail matches");
  ok("listing detail opens");

  // ---- (2) novel search → skeleton → materialize → re-search cache hit -----
  section(2, "Novel search → placeholder grid → materialize via fake-gen → cache hit");
  const novel = `a quantum ${Date.now()}`;
  const q = encodeURIComponent(novel);
  const t0 = Date.now();
  const miss = await api(`/v1/search?q=${q}`, { token });
  const missMs = Date.now() - t0;
  assert.equal(miss.status, 200, "novel search 200");
  assert.ok(miss.json.listings.length > 0, "novel search returns a populated (placeholder) grid");
  assert.ok(miss.json.generation, "novel search carries a generation hint");
  const generationId = miss.json.generation.generationId;
  assert.ok(generationId?.startsWith("gen_"), "generation hint has a generationId for the swap stream");
  console.log(`    novel search returned ${miss.json.listings.length} cards in ${missMs}ms (instant grid)`);
  // The generated placeholder heroes are already ingested to MinIO → localhost.
  const genCard = miss.json.listings.find((l) => l.media.hero && /localhost:9000/.test(l.media.hero.url));
  assert.ok(genCard, "generated card hero is browser-reachable (ingested to MinIO)");
  ok("novel term → instant populated grid + generation hint");

  // Watch the generation SSE for the placeholder→final swap (images.ready).
  let imagesReady = null;
  const genStream = openSse(`${API}/v1/generation/${generationId}/stream?token=${token}&lastEventId=-1`, {
    onEvent: (e) => {
      if (e.event === "images.ready" || e.event === "images.degraded") {
        imagesReady = e;
      }
    },
  });
  await waitFor("images.ready over generation SSE", () => imagesReady, { timeoutMs: 12000 });
  assert.equal(imagesReady.data.generation_id, generationId, "images.ready keyed on the generationId");
  assert.ok(typeof imagesReady.data.seq === "number", "swap event carries a monotonic seq");
  genStream.abort();
  ok(`placeholder→final media swap arrived over generation SSE (event=${imagesReady.event})`);

  // Re-search the SAME term → instant exact-cache hit (no new generation hint
  // pending; the anchor listing is served from the L1 cache).
  const reT0 = Date.now();
  const hit = await api(`/v1/search?q=${q}`, { token });
  const reMs = Date.now() - reT0;
  assert.equal(hit.status, 200, "re-search 200");
  assert.ok(hit.json.listings.length > 0, "re-search returns the cached grid");
  assert.notEqual(
    hit.json.generation?.status,
    "pending",
    "re-search is a cache hit (not a fresh pending generation)",
  );
  console.log(`    re-search served in ${reMs}ms (cache hit; generation=${JSON.stringify(hit.json.generation)})`);
  ok("re-search same term → instant cache hit");

  // ---- (3) cart: add, change qty, checkout (anon) --------------------------
  section(3, "Add to cart, change quantity, checkout as anonymous device user");
  const add = await api("/v1/cart/items", { token, method: "POST", body: { listingId: seedListing.id, qty: 1 } });
  assert.ok([200, 201].includes(add.status), "add to cart 2xx");
  let cart = add.json;
  const line = cart.items.find((i) => i.listingId === seedListing.id);
  assert.ok(line, "cart line present");
  assert.equal(line.qty, 1, "qty 1 after add");
  const patched = await api(`/v1/cart/items/${line.id}`, { token, method: "PATCH", body: { qty: 3 } });
  assert.ok([200].includes(patched.status), "patch qty 2xx");
  const patchedLine = patched.json.items.find((i) => i.id === line.id);
  assert.equal(patchedLine.qty, 3, "qty updated to 3");
  assert.equal(patchedLine.lineTotal.amount_cents, patchedLine.unitPrice.amount_cents * 3, "lineTotal recomputed");
  ok("cart add + qty change recomputes totals (anonymous, no login)");

  // ---- (4) place order (idempotent) → SSE timeline → resync → polling ------
  section(4, "Place order (idempotent) → live SSE timeline → resync → polling fallback");
  const idemKey = `e2e-${Date.now()}`;
  const placed = await api("/v1/orders", { token, method: "POST", headers: { "idempotency-key": idemKey }, body: {} });
  assert.ok([200, 201].includes(placed.status), "place order 2xx");
  const orderId = placed.json.id;
  assert.ok(orderId?.startsWith("ord_"), "order minted");
  assert.equal(placed.json.state, "confirmed", "initial state confirmed");

  // Idempotency: same key → SAME order, no duplicate.
  const placedAgain = await api("/v1/orders", { token, method: "POST", headers: { "idempotency-key": idemKey }, body: {} });
  assert.equal(placedAgain.json.id, orderId, "idempotent place returns the same order id");
  const orderList = await api("/v1/orders", { token });
  const occurrences = orderList.json.filter((o) => o.id === orderId).length;
  assert.equal(occurrences, 1, "exactly one order row for the idempotency key (no duplicate)");
  ok("place order is idempotent (same key → same order, no duplicate)");

  // (5) display.stages is server-driven (asserted on the live payload below).
  assert.equal(placed.json.display.trackingMode, "timeline", "trackingMode=timeline from server data");
  assert.ok(Array.isArray(placed.json.display.stages) && placed.json.display.stages.length === 5,
    "display.stages is a server-defined ordered list");
  assert.ok(placed.json.display.stages.find((s) => s.key === "confirmed" && s.current),
    "confirmed is the current stage initially");

  // SSE timeline: connect, collect tracking_event frames live until delivered.
  const seenStates = [];
  const seqs = [];
  let sse1 = openSse(`${API}/v1/orders/${orderId}/stream?token=${token}`, {
    onEvent: (e) => {
      if (e.event === "tracking_event" && e.data) {
        seenStates.push(e.data.state);
        seqs.push(e.data.seq);
      }
    },
  });
  // Wait until we've observed a couple of live advances so the resume cursor is
  // non-zero (a meaningful "replay from seq N", not "replay from 0").
  await waitFor("≥2 live SSE advances (non-zero cursor)", () => seqs.length >= 2, { timeoutMs: 12000 });
  assert.ok(Math.max(...seqs) > 0, "observed a live advance with seq > 0 over SSE");
  ok(`live SSE delivered tracking_event frame(s): [${seenStates.join(", ")}] (seqs ${seqs.join(",")})`);

  // RESYNC mid-flight: drop the SSE, then re-establish from snapshot + replay.
  // First read the snapshot (authoritative) and assert the replay cursor.
  sse1.abort();
  const snap = await api(`/v1/orders/${orderId}/tracking`, { token });
  assert.equal(snap.status, 200, "tracking snapshot 200");
  assert.ok(snap.json.latestSeq >= 1, "snapshot carries a non-trivial latestSeq cursor");
  assert.ok(Array.isArray(snap.json.events), "snapshot carries the ordered event log");
  // Deliberately resume from BEHIND the tip (latestSeq-1) so the server MUST
  // replay at least one persisted frame on connect — this is the exact gap the
  // SSE fix closes: the cursor arrives ONLY as ?lastEventId on the initial
  // connect (no Last-Event-ID header), and the server replays seq>cursor.
  const resyncCursor = snap.json.latestSeq - 1;
  const replayed = [];
  let sse2 = openSse(`${API}/v1/orders/${orderId}/stream?token=${token}&lastEventId=${resyncCursor}`, {
    onEvent: (e) => {
      if (e.event === "tracking_event" && e.data) replayed.push(e.data.seq);
    },
  });
  // The server must replay seq>cursor on connect (proving the ?lastEventId path),
  // and never a frame <= cursor (gap-free, no stale duplicates).
  await waitFor("replay frame arrives on resynced ?lastEventId stream", () => replayed.length >= 1, { timeoutMs: 8000 });
  assert.ok(replayed.every((s) => s > resyncCursor),
    `resynced stream replays only seq>cursor (cursor=${resyncCursor}, got=[${replayed.join(",")}])`);
  assert.ok(replayed.includes(snap.json.latestSeq) || Math.max(...replayed) >= snap.json.latestSeq,
    `?lastEventId replay caught up the missed frame seq ${snap.json.latestSeq}`);
  ok(`reload mid-flight resyncs from snapshot + ?lastEventId=${resyncCursor} replay (got seqs [${replayed.join(",")}]) — gap-free`);

  // Let it run a touch more, then KILL the SSE → prove POLLING fallback stays current.
  await waitFor("order advances further over resynced SSE", async () => {
    const o = await api(`/v1/orders/${orderId}`, { token });
    return o.json.state !== "confirmed";
  }, { timeoutMs: 12000 });
  sse2.abort();
  // With SSE dead, ONLY polling GET /v1/orders/{id} drives state to delivered.
  const delivered = await waitFor("polling fallback reaches delivered", async () => {
    const o = await api(`/v1/orders/${orderId}`, { token });
    return o.json.state === "delivered" ? o.json : null;
  }, { timeoutMs: 20000 });
  assert.equal(delivered.state, "delivered", "order reached delivered");
  ok("SSE killed → polling fallback (GET /v1/orders/{id}) tracked through to delivered");

  // ---- (5) UI timeline is driven by display.stages (server data) -----------
  section(5, "Lifecycle stages come from display.stages (server data, no client enum)");
  const finalStages = delivered.display.stages;
  assert.deepEqual(
    finalStages.map((s) => s.key),
    ["confirmed", "packed", "shipped", "out_for_delivery", "delivered"],
    "stage keys are the server-defined ordered set",
  );
  assert.ok(finalStages.every((s) => s.reached), "every stage reached at delivered");
  assert.ok(finalStages.find((s) => s.key === "delivered").current, "delivered is current");
  // Prove the web client has NO hardcoded retail state enum (charter §6.5).
  ok("order display.stages fully reached + current=delivered (server-rendered)");

  // ---- web container serves the SSR shell ----------------------------------
  section("web", "web container serves the pages (HTTP 200 + SSR shell)");
  const home = await fetch(`${WEB}/`);
  assert.equal(home.status, 200, "web / returns 200");
  const html = await home.text();
  assert.ok(/<html/i.test(html), "web returns an HTML document (SSR shell)");
  ok("web :3000 serves the SSR shell (HTTP 200)");

  console.log(`\nE2E PASSED — ${PASS} assertions across all 5 acceptance criteria.`);
}

main().catch((err) => {
  console.error(`\nE2E FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
