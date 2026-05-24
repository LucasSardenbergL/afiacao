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
TS="20260524130000"
OUT="supabase/migrations/${TS}_baseline_schema_NAO_APLICAR_EM_PROD_EXISTENTE.sql"

cat > "$OUT" <<'HDR'
-- ============================================================================
-- BASELINE SCHEMA (squash) — gerado de produção em 2026-05-24
-- ============================================================================
-- ⚠️  NÃO APLICAR EM PRODUÇÃO EXISTENTE.
-- Ponto de partida para reconstruir um ambiente Supabase do zero
-- (staging / disaster-recovery / onboarding). Substitui as 222 migrations
-- incrementais (arquivadas em db/archive/migrations_pre_baseline/).
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
  { print }
  /^CREATE SCHEMA public;$/ {
    print ""
    print "-- [baseline] Extensions de dependência de DDL (não vêm no dump --schema=public)"
    print "CREATE SCHEMA IF NOT EXISTS extensions;"
    print "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;"
    print "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;"
    print "-- pg_cron / pg_net / pg_stat_statements / supabase_vault: plataforma Supabase (manifest)"
    print ""
  }
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
-- [baseline] Realtime publication (supabase_realtime existe por padrão no Supabase)
-- ============================================================================
DO $baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $baseline$;
ALTER PUBLICATION supabase_realtime ADD TABLE public.eventos_outlier, public.farmer_calls,
  public.nfe_recebimentos, public.order_messages, public.orders, public.pedido_compra_sugerido,
  public.picking_tasks, public.sales_orders, public.sku_parametros, public.tint_importacoes;
TAIL

echo "OK -> $OUT ($(wc -l < "$OUT") linhas)"
