-- Stage 1 FTS + trigram search (doc 01 §3.1). Prisma can't express tsvector/GIN,
-- so this hand-written migration adds them. The generated `search_doc` column keeps
-- FTS always in sync with no app-side maintenance. NO pgvector (Stage 2).

-- Extensions are also provisioned by infra/postgres/init on a fresh volume; create
-- here too so `prisma migrate deploy` is self-sufficient on any database.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Generated tsvector: title weighted A, description weighted B.
ALTER TABLE "listings"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'B')
  ) STORED;

CREATE INDEX "listings_search_doc_gin" ON "listings" USING GIN ("search_doc");      -- FTS
CREATE INDEX "listings_title_trgm"     ON "listings" USING GIN ("title" gin_trgm_ops); -- fuzzy/partial

-- One active cart per (user, storefront) as a partial unique index (doc 01 §3).
CREATE UNIQUE INDEX "carts_one_active" ON "carts" ("userId", "storefrontId") WHERE "status" = 'active';

-- STAGE 2 WILL ADD (do not run now):
--   CREATE EXTENSION vector;
--   ALTER TABLE listings ADD COLUMN embedding vector(1536);
--   CREATE INDEX listings_embedding_hnsw ON listings USING hnsw (embedding vector_cosine_ops);
