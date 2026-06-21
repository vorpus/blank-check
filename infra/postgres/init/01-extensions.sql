-- Stage 1: full-text search + fuzzy/trigram matching only.
--
-- This script runs ONCE, automatically, the first time the postgres named
-- volume (pgdata) is initialized (it lives in /docker-entrypoint-initdb.d).
-- `make reset` wipes the volume so it runs again on the next `make up`.
--
-- It provisions only the EXTENSIONS the Prisma migrations (owned by
-- 01-backend-api.md) assume already exist. The schema, tsvector columns,
-- and GIN/trigram indexes are created by those migrations, not here.
--
-- NOTE: plain Postgres 16. pgvector is intentionally NOT enabled here --
-- it arrives in Stage 02 (semantic dedup), at which point this file adds
--   CREATE EXTENSION IF NOT EXISTS vector;
-- and the compose image moves to pgvector/pgvector:pg16. Nothing else changes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy / trigram similarity for search
CREATE EXTENSION IF NOT EXISTS unaccent;   -- accent-insensitive full-text search
-- tsvector / FTS itself is core Postgres -- no extension required.
