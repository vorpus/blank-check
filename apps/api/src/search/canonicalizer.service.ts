import { Injectable } from "@nestjs/common";

/**
 * CanonicalizerService (doc 01 §4.1) — derives the dedup/lock/cache key from a raw
 * query. It is what makes "a ladder", "the ladders", and "Ladder!" collapse to one
 * canonical generation: lowercase, strip punctuation + filler words, collapse
 * whitespace, naive singularize. Good enough for Stage 1 (semantic dedup is Stage 2).
 */
@Injectable()
export class CanonicalizerService {
  canon(raw: string): string {
    return raw
      .toLowerCase()
      .trim()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .replace(/[^\p{L}\p{N}\s]/gu, "") // strip punctuation
      .replace(/\b(a|an|the|some|please|my|your)\b/g, "") // strip filler
      .replace(/\s+/g, " ")
      .trim()
      .replace(/s\b/g, "") // naive singularize
      .replace(/\s+/g, " ")
      .trim();
  }

  cacheKey(storefrontId: string, canon: string): string {
    return `canon:${storefrontId}:${canon}`;
  }

  lockKey(storefrontId: string, canon: string): string {
    return `gen:lock:${storefrontId}:${canon}`;
  }

  popKey(storefrontId: string, canon: string): string {
    return `pop:${storefrontId}:${canon}`;
  }
}
