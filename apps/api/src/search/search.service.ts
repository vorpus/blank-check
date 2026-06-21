import { type Listing, type SearchResult } from "@dopamine/contracts";
import { Injectable } from "@nestjs/common";

import { CatalogService } from "../catalog/catalog.service";
import { StructuredLogger } from "../common/logger";
import { GenerationGateway } from "../generation/generation-gateway.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

import { CanonicalizerService } from "./canonicalizer.service";
import { GridPolicyService } from "./grid-policy.service";

/** Context the search carries (resolved storefront + the requesting device). */
export interface SearchContext {
  storefrontId: string;
  verticalId: string;
  deviceId: string;
}

const POP_TTL_SECONDS = 3600; // popularity decays hourly (doc 01 §5)

/**
 * SearchService (doc 01 §4, §5) — the search→miss→generate→persist seam.
 *
 * 1. canonicalize the query.
 * 2. L1 exact-cache (`canon → listing_id`): instant hit, origin=exact_cache.
 * 3. else run the blended grid policy: FTS + pg_trgm `matchCount` + Redis
 *    popularity → hot / warm / cold regime.
 *    - hot  → full grid from cache, no generation.
 *    - warm → matches now + generate the remainder.
 *    - cold → loose trgm filler + generate a batch (first card a live skeleton).
 * 4. on warm/cold, route through the gateway (lock → fake-gen → persist →
 *    exact-cache set → enqueue enrich). Returns a populated grid + a `generation`
 *    hint. NEVER blocks on generation.
 */
@Injectable()
export class SearchService {
  private readonly logger = new StructuredLogger("search");

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly gateway: GenerationGateway,
    private readonly redis: RedisService,
    private readonly canon: CanonicalizerService,
    private readonly grid: GridPolicyService,
  ) {}

  async search(rawQuery: string, ctx: SearchContext): Promise<SearchResult> {
    const canonical = this.canon.canon(rawQuery);

    // Empty/degenerate query → just return recent ready listings, no generation.
    if (canonical.length === 0) {
      const browse = await this.recentListings(ctx.storefrontId);
      return { listings: browse, generation: null };
    }

    // L1 exact-cache.
    const cachedId = await this.redis.client.get(this.canon.cacheKey(ctx.storefrontId, canonical));
    if (cachedId) {
      const listings = await this.catalog.getListings([cachedId]);
      if (listings.length > 0) {
        // Bump popularity even on a cache hit (signal stays warm).
        await this.bumpPopularity(ctx.storefrontId, canonical);
        const filler = await this.ftsMatches(ctx.storefrontId, canonical, 24);
        const merged = dedupeById([...listings, ...filler]);
        return { listings: markOrigin(merged, listings[0]?.id), generation: null };
      }
    }

    // Blended grid policy.
    const matches = await this.ftsMatches(ctx.storefrontId, canonical, 24);
    const popularity = await this.bumpPopularity(ctx.storefrontId, canonical);
    const plan = this.grid.classify(matches.length, popularity);
    this.logger.log(
      `search "${rawQuery}" → canon="${canonical}" matchCount=${String(matches.length)} pop=${String(popularity)} regime=${plan.regime}`,
    );

    if (plan.generate === 0) {
      // 🔥 hot — full grid from cache, no generation.
      return { listings: matches.slice(0, plan.fromCache), generation: null };
    }

    // 🌤/❄️ warm/cold — filler now + generate the remainder.
    const filler =
      plan.regime === "cold"
        ? await this.trgmFiller(ctx.storefrontId, canonical, plan.fromCache)
        : matches.slice(0, plan.fromCache);

    const outcome = await this.gateway.requestGeneration({
      storefrontId: ctx.storefrontId,
      verticalId: ctx.verticalId,
      deviceId: ctx.deviceId,
      rawQuery,
      canonicalQuery: canonical,
      count: plan.generate,
      regime: plan.regime,
    });

    const listings = dedupeById([...filler, ...(outcome?.listings ?? [])]);
    return { listings, generation: outcome?.generation ?? null };
  }

  /** FTS (search_doc tsvector) ranked matches for a canonical query. */
  private async ftsMatches(storefrontId: string, canonical: string, limit: number): Promise<Listing[]> {
    const tsquery = toTsQuery(canonical);
    if (!tsquery) return [];
    // Column names are camelCase as declared (no per-field @map) → quote them.
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM listings
      WHERE "storefrontId" = ${storefrontId}
        AND status IN ('ready', 'placeholder', 'degraded')
        AND search_doc @@ to_tsquery('english', ${tsquery})
      ORDER BY ts_rank(search_doc, to_tsquery('english', ${tsquery})) DESC
      LIMIT ${limit}`;
    return this.catalog.getListings(ids.map((r) => r.id));
  }

  /** Loose pg_trgm fuzzy filler for a cold miss (relax the FTS bar). */
  private async trgmFiller(storefrontId: string, canonical: string, limit: number): Promise<Listing[]> {
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM listings
      WHERE "storefrontId" = ${storefrontId}
        AND status IN ('ready', 'placeholder', 'degraded')
      ORDER BY similarity(title, ${canonical}) DESC
      LIMIT ${limit}`;
    return this.catalog.getListings(ids.map((r) => r.id));
  }

  /** Recent ready listings for an empty/browse query. */
  private async recentListings(storefrontId: string): Promise<Listing[]> {
    const rows = await this.prisma.listing.findMany({
      where: { storefrontId, status: { in: ["ready", "placeholder"] } },
      orderBy: { createdAt: "desc" },
      take: 24,
    });
    return rows.map((r) => r.id).length === 0 ? [] : this.catalog.getListings(rows.map((r) => r.id));
  }

  /** INCR the popularity counter with an hourly TTL (decay). */
  private async bumpPopularity(storefrontId: string, canonical: string): Promise<number> {
    const key = this.canon.popKey(storefrontId, canonical);
    const pop = await this.redis.client.incr(key);
    if (pop === 1) await this.redis.client.expire(key, POP_TTL_SECONDS);
    return pop;
  }
}

/** Build a safe `to_tsquery` AND-of-prefixes string from a canonical query. */
function toTsQuery(canonical: string): string | null {
  const terms = canonical
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

function dedupeById(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const l of listings) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out;
}

/** Stamp origin=exact_cache on the cache-hit anchor for the response. */
function markOrigin(listings: Listing[], anchorId: string | undefined): Listing[] {
  if (!anchorId) return listings;
  return listings.map((l) => (l.id === anchorId ? { ...l, origin: "exact_cache" as const } : l));
}
