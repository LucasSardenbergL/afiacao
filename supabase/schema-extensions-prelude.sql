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

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm     WITH SCHEMA extensions;

-- O tipo vector é referenciado como public.vector(...) no snapshot.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- pg_cron cria o schema `cron`; as views v_cron_jobs_status / v_cron_jobs_falhas
-- leem cron.job e cron.job_run_details. Em Supabase, habilitar pg_cron normalmente
-- é via dashboard (Database > Extensions); em Postgres puro exige pg_cron em
-- shared_preload_libraries. Se não puder habilitar, as 2 views v_cron_jobs_*
-- falham no replay e podem ser puladas (ver README-schema.md).
CREATE EXTENSION IF NOT EXISTS pg_cron;
