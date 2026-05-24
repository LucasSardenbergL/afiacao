#!/usr/bin/env bash
# build-baseline.sh — monta o baseline a partir do dump schema-only de produção.
# Reproduzível: dado db/_incoming/production_schema_dump.sql, gera o baseline.
# Transforms:
#   - remove diretivas psql \restrict / \unrestrict (compat)
#   - client_encoding SQL_ASCII -> UTF8 (corpo é UTF-8: → e acentos pt-BR)
#   - injeta CREATE EXTENSION das 4 extensions de dependência de DDL logo após
#     "CREATE SCHEMA public;" (uuid-ossp, pgcrypto, pg_trgm em extensions; vector em public)
#   - prepende header explicativo
#   - anexa storage.buckets (idempotente) + publication realtime no fim
# Extensions de PLATAFORMA (pg_cron, pg_net, pg_stat_statements, supabase_vault)
# NÃO são criadas aqui (funções usam check_function_bodies=false → criam sem elas;
# são habilitadas via dashboard Supabase — ver BASELINE_MANIFEST.md).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="db/_incoming/production_schema_dump.sql"
# ⚠️ Baseline fica em db/baselines/ — NÃO em supabase/migrations/ (decisão pós-codex:
# o Lovable é dono operacional do backend e a pasta supabase/migrations/ é reconhecida
# pelo ecossistema Lovable/Supabase; mexer nela arrisca confundir builder/CLI tracking).
OUT="db/baselines/2026-05-24_prod_schema_baseline.sql"
mkdir -p db/baselines

cat > "$OUT" <<'HDR'
-- ============================================================================
-- BASELINE SCHEMA (squash) — gerado de produção em 2026-05-24
-- ============================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO EXISTENTE. Vive em db/baselines/ (NÃO em
-- supabase/migrations/, que fica intocada — ver runbook). Ponto de partida
-- para reconstruir um ambiente Supabase DO ZERO (staging/DR/onboarding).
-- Produção não é tocada por este arquivo.
--
-- Núcleo: schema public completo (212 tabelas, 37 views, 86 funções nossas,
-- 76 triggers, 474 policies, 38 sequences, 14 enums, índices). + 4 extensions
-- de dependência de DDL + storage.buckets + publication realtime.
-- Crons (33) e extensions de plataforma: ver db/BASELINE_MANIFEST.md + runbook.
-- ============================================================================

HDR

awk '
  /^\\restrict/   { next }
  /^\\unrestrict/ { next }
  /SET client_encoding = .SQL_ASCII./ { print "SET client_encoding = '\''UTF8'\'';"; next }
  /^CREATE SCHEMA public;$/ {
    print "CREATE SCHEMA IF NOT EXISTS public;"
    print ""
    print "-- [baseline] Extensions de dependência de DDL (não vêm no dump --schema=public)"
    print "CREATE SCHEMA IF NOT EXISTS extensions;"
    print "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;"
    print "-- pg_cron / pg_net / pg_stat_statements / supabase_vault: plataforma Supabase (manifest)"
    print ""
    next
  }
  { print }
' "$SRC" >> "$OUT"

cat >> "$OUT" <<'TAIL'

-- ============================================================================
-- [baseline] Storage buckets (fora do schema public; idempotente)
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('aumentos','aumentos',false,NULL,NULL),
  ('avatars','avatars',true,2097152,ARRAY['image/jpeg','image/png','image/webp']),
  ('knowledge-base','knowledge-base',false,NULL,NULL),
  ('portal_screenshots','portal_screenshots',false,5242880,ARRAY['image/png','image/jpeg']),
  ('promocoes','promocoes',false,NULL,NULL),
  ('tool-photos','tool-photos',true,5242880,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- [baseline] Realtime publication (idempotente; respeita FOR ALL TABLES)
-- ============================================================================
DO $baseline$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  -- só adiciona se a publication não for FOR ALL TABLES
  IF NOT (SELECT puballtables FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['eventos_outlier','farmer_calls','nfe_recebimentos','order_messages',
      'orders','pedido_compra_sugerido','picking_tasks','sales_orders','sku_parametros','tint_importacoes']
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_rel pr
          JOIN pg_publication p ON p.oid = pr.prpubid
          JOIN pg_class c ON c.oid = pr.prrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE p.pubname = 'supabase_realtime' AND n.nspname = 'public' AND c.relname = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END $baseline$;
TAIL

echo "OK -> $OUT ($(wc -l < "$OUT") linhas)"
