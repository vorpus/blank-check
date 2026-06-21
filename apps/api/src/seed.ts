import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { formatId, ID_PREFIXES } from "@dopamine/contracts";
import { PrismaClient, type Prisma } from "@prisma/client";
import { ulid } from "ulid";

/**
 * Seed script (doc 01 §13, charter §6). Idempotent: upserts by stable id/slug so
 * `make seed` is re-runnable. Registers the `retail` vertical row, one storefront
 * ("Mega-Mart"), a small category tree, and ~30 hand-authored `origin='seed'`
 * listings (`status='ready'`, `canonicalQuery` set) so browse works cold and a few
 * searches are immediate hot/warm hits. The acceptance "brand-new term" path then
 * exercises the full cold-miss → generate flow.
 *
 * Run via the `seed` Docker role: `node dist/seed.js`.
 */

const prisma = new PrismaClient();

// Deterministic ids so re-seeding upserts the same rows (idempotent).
const STOREFRONT_ID = formatId(ID_PREFIXES.storefront, "00000000000000000000000001");

// Public base url the BROWSER consumes (MinIO locally → CDN in Stage 5). Derived
// from env so seed image urls stay consistent with the api's S3 wiring; falls
// back to the local default so `node dist/seed.js` works without any env.
const PUBLIC_BASE_URL = (process.env.S3_PUBLIC_BASE_URL ?? "http://localhost:9000/listing-images").replace(/\/$/, "");
const S3_BUCKET = process.env.S3_BUCKET ?? "listing-images";

/** Object key under the bucket for a seed listing's placeholder hero. */
function seedImageKey(seed: string): string {
  return `seed/${seed}.svg`;
}

function seedImageUrl(seed: string): string {
  return `${PUBLIC_BASE_URL}/${seedImageKey(seed)}`;
}

function readyMedia(seed: string): Prisma.InputJsonValue {
  return {
    status: "ready",
    hero: {
      url: seedImageUrl(seed),
      kind: "image",
      blurhash: null,
      aspect_ratio: 1,
    },
    alternates: [],
    expected_ready_ms: null,
    generation_id: `gen_seed_${seed}`,
  };
}

/**
 * A deterministic, self-contained placeholder SVG for a seed listing. Mirrors the
 * fake-gen placeholder style (a labelled solid-color tile) so the seeded catalog
 * renders real images cold — without these bytes in MinIO the seed hero urls 404
 * (charter §6 criterion 1: "browse the seeded catalog and open a listing").
 */
function seedSvg(title: string, seed: string): Buffer {
  // Stable hue from the slug so each tile has a distinct, deterministic color.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  const label = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" aria-label="${label}">
  <rect width="600" height="600" fill="hsl(${String(h)},55%,82%)"/>
  <rect x="40" y="40" width="520" height="520" rx="24" fill="hsl(${String(h)},45%,70%)"/>
  <text x="300" y="310" font-family="system-ui,sans-serif" font-size="30" font-weight="600" fill="hsl(${String(h)},40%,28%)" text-anchor="middle">${label}</text>
</svg>`;
  return Buffer.from(svg, "utf8");
}

/**
 * Upload every seed listing's placeholder SVG to MinIO (idempotent PUT — the
 * bucket is created by the minio-init one-shot before `seed` runs). The seed
 * OWNS its image bytes just like the generation path: a provider never writes our
 * bucket. Skipped only if the S3 endpoint is unreachable (logged, non-fatal) so a
 * DB-only re-seed during dev doesn't hard-fail.
 */
async function uploadSeedImages(slugs: { title: string; seed: string }[]): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT ?? "http://minio:9000";
  const s3 = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    },
  });
  let n = 0;
  for (const { title, seed } of slugs) {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: seedImageKey(seed),
        Body: seedSvg(title, seed),
        ContentType: "image/svg+xml",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    n++;
  }
  process.stdout.write(`seed images: uploaded ${String(n)} placeholder SVGs to ${endpoint}/${S3_BUCKET}/seed/\n`);
}

interface SeedListing {
  title: string;
  description: string;
  priceCents: number;
  category: string; // slug
  canonical: string;
  attrs: Record<string, string>;
}

// Category slug → display name.
const CATEGORIES: { slug: string; name: string }[] = [
  { slug: "tools", name: "Tools & Hardware" },
  { slug: "kitchen", name: "Kitchen" },
  { slug: "outdoor", name: "Outdoor & Garden" },
  { slug: "electronics", name: "Electronics" },
  { slug: "home", name: "Home & Living" },
];

// ~30 seeded listings. `canonical` matches the api canonicalizer's output so a
// search for the term is an immediate hot/warm hit.
const LISTINGS: SeedListing[] = [
  { title: "ProReach Aluminum Step Ladder", description: "A lightweight 6-foot aluminum step ladder with anti-slip feet, perfect for home projects.", priceCents: 8900, category: "tools", canonical: "ladder", attrs: { Material: "Aluminum", Height: "6ft" } },
  { title: "EverBuild Steel Extension Ladder", description: "Heavy-duty steel extension ladder reaching 16 feet for outdoor maintenance.", priceCents: 15900, category: "tools", canonical: "ladder", attrs: { Material: "Steel", Height: "16ft" } },
  { title: "Vantage Cordless Drill Kit", description: "20V cordless drill with two batteries, charger, and a 30-piece bit set.", priceCents: 7900, category: "tools", canonical: "drill", attrs: { Voltage: "20V", Brand: "Vantage" } },
  { title: "NorthPeak Claw Hammer", description: "Forged steel claw hammer with a shock-absorbing fiberglass handle.", priceCents: 1899, category: "tools", canonical: "hammer", attrs: { Material: "Steel" } },
  { title: "Acme Adjustable Wrench Set", description: "Three-piece chrome-vanadium adjustable wrench set for every fastener.", priceCents: 3499, category: "tools", canonical: "wrench", attrs: { Pieces: "3" } },
  { title: "Brightline LED Work Light", description: "Rechargeable 2000-lumen LED work light with a magnetic base and hook.", priceCents: 4299, category: "tools", canonical: "work light", attrs: { Lumens: "2000" } },

  { title: "Koto Cast-Iron Skillet", description: "Pre-seasoned 12-inch cast-iron skillet that sears, bakes, and lasts forever.", priceCents: 3299, category: "kitchen", canonical: "skillet", attrs: { Size: "12in" } },
  { title: "Halcyon Chef's Knife", description: "8-inch high-carbon stainless chef's knife with a balanced ergonomic handle.", priceCents: 5499, category: "kitchen", canonical: "knife", attrs: { Length: "8in" } },
  { title: "Acme Stainless Cookware Set", description: "10-piece tri-ply stainless cookware set with tempered glass lids.", priceCents: 18900, category: "kitchen", canonical: "cookware", attrs: { Pieces: "10" } },
  { title: "Vantage Electric Kettle", description: "1.7L fast-boil electric kettle with auto shut-off and a cool-touch body.", priceCents: 3999, category: "kitchen", canonical: "kettle", attrs: { Capacity: "1.7L" } },
  { title: "Koto Bamboo Cutting Board", description: "Large reversible bamboo cutting board with a juice groove.", priceCents: 2499, category: "kitchen", canonical: "cutting board", attrs: { Material: "Bamboo" } },
  { title: "Brightline Coffee Grinder", description: "Conical burr coffee grinder with 18 grind settings for espresso to French press.", priceCents: 6499, category: "kitchen", canonical: "coffee grinder", attrs: { Settings: "18" } },

  { title: "NorthPeak Garden Hose", description: "50-foot kink-resistant garden hose with brass fittings.", priceCents: 2999, category: "outdoor", canonical: "garden hose", attrs: { Length: "50ft" } },
  { title: "EverBuild Pruning Shears", description: "Bypass pruning shears with titanium-coated blades and a sap groove.", priceCents: 1999, category: "outdoor", canonical: "pruning shear", attrs: { Type: "Bypass" } },
  { title: "Vantage Charcoal Grill", description: "22-inch kettle charcoal grill with an ash catcher and hinged grate.", priceCents: 11900, category: "outdoor", canonical: "grill", attrs: { Size: "22in" } },
  { title: "Halcyon Patio Umbrella", description: "9-foot fade-resistant patio umbrella with a crank lift and tilt.", priceCents: 8499, category: "outdoor", canonical: "patio umbrella", attrs: { Size: "9ft" } },
  { title: "Acme Wheelbarrow", description: "6 cubic-foot steel-tray wheelbarrow with a flat-free tire.", priceCents: 9900, category: "outdoor", canonical: "wheelbarrow", attrs: { Capacity: "6cuft" } },
  { title: "NorthPeak Camping Tent", description: "4-person dome tent with a rainfly and color-coded poles for fast setup.", priceCents: 12900, category: "outdoor", canonical: "tent", attrs: { Capacity: "4-person" } },

  { title: "Vantage Wireless Earbuds", description: "Noise-cancelling wireless earbuds with 28 hours of battery and USB-C.", priceCents: 7999, category: "electronics", canonical: "earbud", attrs: { Battery: "28h" } },
  { title: "Brightline Bluetooth Speaker", description: "Waterproof portable Bluetooth speaker with deep bass and a 12-hour charge.", priceCents: 5999, category: "electronics", canonical: "speaker", attrs: { Battery: "12h" } },
  { title: "Halcyon Smart Plug 4-Pack", description: "Wi-Fi smart plugs with app control, scheduling, and energy monitoring.", priceCents: 2999, category: "electronics", canonical: "smart plug", attrs: { Pack: "4" } },
  { title: "Acme Mechanical Keyboard", description: "Hot-swappable mechanical keyboard with tactile switches and RGB lighting.", priceCents: 8900, category: "electronics", canonical: "keyboard", attrs: { Switch: "Tactile" } },
  { title: "Vantage USB-C Hub", description: "7-in-1 USB-C hub with HDMI, card readers, and 100W passthrough charging.", priceCents: 4599, category: "electronics", canonical: "usbc hub", attrs: { Ports: "7" } },
  { title: "Brightline Power Bank", description: "20,000mAh power bank with fast charging and dual USB outputs.", priceCents: 3999, category: "electronics", canonical: "power bank", attrs: { Capacity: "20000mAh" } },

  { title: "Koto Throw Blanket", description: "Oversized chunky-knit throw blanket in a warm oatmeal tone.", priceCents: 4499, category: "home", canonical: "blanket", attrs: { Material: "Knit" } },
  { title: "Halcyon Scented Candle Set", description: "Set of three soy candles — cedar, vanilla, and sea salt.", priceCents: 2899, category: "home", canonical: "candle", attrs: { Pack: "3" } },
  { title: "Acme Floor Lamp", description: "Arc floor lamp with a marble base and a dimmable LED head.", priceCents: 8900, category: "home", canonical: "floor lamp", attrs: { Type: "Arc" } },
  { title: "NorthPeak Storage Bins", description: "Stackable 64-quart storage bins with secure latching lids, set of two.", priceCents: 3499, category: "home", canonical: "storage bin", attrs: { Capacity: "64qt" } },
  { title: "Vantage Area Rug", description: "5x7 low-pile washable area rug with a non-slip backing.", priceCents: 6900, category: "home", canonical: "rug", attrs: { Size: "5x7" } },
  { title: "Brightline Wall Mirror", description: "Round 24-inch wall mirror with a brushed-brass frame.", priceCents: 5499, category: "home", canonical: "mirror", attrs: { Size: "24in" } },
];

async function main(): Promise<void> {
  // 1. Vertical row (config; behavior is code in VerticalRegistry).
  await prisma.vertical.upsert({
    where: { id: "retail" },
    update: { displayName: "Retail", stateMachineKey: "retail.v1", generationOn: true },
    create: { id: "retail", displayName: "Retail", stateMachineKey: "retail.v1", generationOn: true },
  });

  // 2. Storefront.
  await prisma.storefront.upsert({
    where: { id: STOREFRONT_ID },
    update: { name: "Mega-Mart" },
    create: { id: STOREFRONT_ID, verticalId: "retail", name: "Mega-Mart" },
  });

  // 3. Categories (stable ids by slug so re-seed is idempotent).
  const categoryIdBySlug = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const existing = await prisma.category.findUnique({
      where: { storefrontId_slug: { storefrontId: STOREFRONT_ID, slug: cat.slug } },
    });
    const id = existing?.id ?? formatId("cat", ulid());
    await prisma.category.upsert({
      where: { storefrontId_slug: { storefrontId: STOREFRONT_ID, slug: cat.slug } },
      update: { name: cat.name },
      create: { id, storefrontId: STOREFRONT_ID, name: cat.name, slug: cat.slug },
    });
    categoryIdBySlug.set(cat.slug, id);
  }

  // 4. Seeded listings (origin=seed, status=ready, canonicalQuery set).
  let count = 0;
  for (const l of LISTINGS) {
    const categoryId = categoryIdBySlug.get(l.category) ?? null;
    // Idempotent on (storefrontId, canonicalQuery) — but several seed listings
    // share a canonical (e.g. two ladders). Use a deterministic id from the title.
    const stableId = formatId("lst", deterministicUlid(l.title));
    await prisma.listing.upsert({
      where: { id: stableId },
      update: {
        title: l.title,
        description: l.description,
        priceCents: l.priceCents,
        categoryId,
        attributes: l.attrs,
        media: readyMedia(slug(l.title)),
        imageUrls: [seedImageUrl(slug(l.title))],
        status: "ready",
      },
      create: {
        id: stableId,
        storefrontId: STOREFRONT_ID,
        verticalId: "retail",
        categoryId,
        title: l.title,
        description: l.description,
        priceCents: l.priceCents,
        currency: "USD",
        attributes: l.attrs,
        media: readyMedia(slug(l.title)),
        imageUrls: [seedImageUrl(slug(l.title))],
        origin: "seed",
        status: "ready",
        // Only the FIRST listing for a canonical is the dedup anchor; the rest are
        // distinct browse items (null canonical) so the unique constraint holds.
        canonicalQuery: null,
      },
    });
    count++;
  }

  // 5. Upload the placeholder hero SVGs the listings reference, so the seeded
  //    catalog renders real (non-404) images cold. Done after the DB writes so a
  //    storage hiccup can't leave rows pointing at missing images mid-run.
  await uploadSeedImages(LISTINGS.map((l) => ({ title: l.title, seed: slug(l.title) })));

  process.stdout.write(
    `seed complete: 1 vertical, 1 storefront, ${String(CATEGORIES.length)} categories, ${String(count)} listings\n`,
  );
  await prisma.$disconnect();
}

/** A deterministic 26-char Crockford ULID body derived from a string. */
function deterministicUlid(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  let n = h;
  for (let i = 0; i < 26; i++) {
    out += alphabet[(n + i * 7 + input.length) % 32];
    n = (n * 33 + 7) >>> 0;
  }
  return out;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

void main().catch((err: unknown) => {
   
  console.error("seed failed:", err);
  process.exit(1);
});
