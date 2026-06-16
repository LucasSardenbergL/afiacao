-- ============================================================================
-- PRELUDE — pré-requisitos de extensions/schemas para schema-snapshot.sql
-- ============================================================================
-- Rode ESTE arquivo ANTES de schema-snapshot.sql ao reconstruir o schema public
-- num ambiente Supabase NOVO/vazio (staging, recuperação de desastre, projeto novo).
--
-- Por quê: schema-snapshot.sql é um pg_dump --schema-only de `public` e NÃO emite
-- nenhum CREATE EXTENSION. Os objetos do dump referenciam extensions que precisam
-- existir antes. Inventário extraído do snapshot (gerado 2026-05-24, PG 17.6):
--   - extensions.uuid_generate_v4()             -> uuid-ossp em schema `extensions`
--   - extensions.gen_random_bytes()             -> pgcrypto  em schema `extensions`
--   - extensions.gin_trgm_ops                   -> pg_trgm   em schema `extensions`
--   - public.vector(1536) / public.vector_cosine_ops -> vector em schema `public`
--   - cron.job / cron.job_run_details (views v_cron_jobs_*) -> pg_cron (schema `cron`)
--
-- NÃO incluídas de propósito:
--   - gen_random_uuid() (157 usos) é built-in do PostgreSQL 13+, não requer extension.
--   - pg_net NÃO é referenciado pelo schema public (vive nos crons, fora deste snapshot).
--   - supabase_vault / pg_stat_statements / plpgsql são geridas/builtin — não recriar.
-- ============================================================================

-- NOTA: estes comandos assumem ambiente NOVO/vazio. `IF NOT EXISTS` NÃO move uma
-- extension que já exista em OUTRO schema — apenas emite notice e não faz nada.
-- Como o snapshot usa nomes qualificados (extensions.*, public.vector), num alvo
-- não-limpo valide `SELECT extname, extnamespace::regnamespace FROM pg_extension`
-- depois, senão as referências quebram.

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm     WITH SCHEMA extensions;

-- O tipo vector é referenciado como public.vector(...) no snapshot.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- pg_cron: deixado COMENTADO de propósito. `CREATE EXTENSION pg_cron` pode falhar
-- (permissão / shared_preload_libraries) e, sob ON_ERROR_STOP, abortaria o restore
-- antes do snapshot. Habilite-o ANTES pelo dashboard do Supabase (Database >
-- Extensions) se quiser as views v_cron_jobs_status / v_cron_jobs_falhas (que leem
-- cron.job / cron.job_run_details). Sem ele, essas 2 views falham no replay do
-- snapshot e devem ser puladas.
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
