#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — recência colacor (created_at = data do pedido) c/ FALSIFICAÇÃO   ║
# ║  Migration: 20260618130000_recencia_colacor_created_at.sql                     ║
# ║  Rodar:  bash db/test-recencia-colacor-created-at.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="recencia-colacor"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — SCHEMA STUB + SEED (a migration é UPDATE → dados precisam existir ANTES)
# ══════════════════════════════════════════════════════════════════════════════
# Sessão em UTC (espelha o SQL Editor do Lovable / Supabase default).
P -q <<'SQL'
SET timezone = 'UTC';
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  account text,
  hash_payload text,
  order_date_kpi date,
  created_at timestamptz
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  sales_order_id uuid REFERENCES public.sales_orders(id),
  customer_user_id uuid,
  created_at timestamptz
);

-- ── pais ──────────────────────────────────────────────────────────────────────
-- SO1 colacor omie DIVERGENTE (pedido 2025-09-15, mas created_at na carga 2026-03-05)
INSERT INTO public.sales_orders VALUES
  ('11111111-1111-1111-1111-111111111111','colacor','omie_colacor_1','2025-09-15','2026-03-05 10:00:00+00'),
-- SO2 colacor omie JÁ CORRETO (created_at já = data do pedido)
  ('22222222-2222-2222-2222-222222222222','colacor','omie_colacor_2','2026-06-10','2026-06-10 12:00:00+00'),
-- SO3 colacor NÃO-omie (hash placeholder) — fora de escopo
  ('33333333-3333-3333-3333-333333333333','colacor','-cah8zx','2025-01-01','2026-03-05 10:00:00+00'),
-- SO4 OBEN omie divergente — BLOQUEADO, não deve ser tocado
  ('44444444-4444-4444-4444-444444444444','oben','omie_oben_1','2025-05-01','2026-03-05 10:00:00+00'),
-- SO5 colacor omie com order_date_kpi NULL — guard contra cast nulo
  ('55555555-5555-5555-5555-555555555555','colacor','omie_colacor_5',NULL,'2026-03-05 10:00:00+00');

-- ── filhos ────────────────────────────────────────────────────────────────────
INSERT INTO public.order_items VALUES
  ('a1a1a1a1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999','2026-03-05 10:00:00+00'), -- OI1a errado→deve consertar
  ('a1a1a1a1-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999','2026-03-05 10:00:00+00'), -- OI1b errado→deve consertar
  ('a2a2a2a2-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','99999999-9999-9999-9999-999999999999','2026-06-10 12:00:00+00'), -- OI2 já certo
  ('a3a3a3a3-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','99999999-9999-9999-9999-999999999999','2026-03-05 10:00:00+00'), -- OI3 não-omie
  ('a4a4a4a4-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','99999999-9999-9999-9999-999999999999','2026-03-05 10:00:00+00'), -- OI4 OBEN
  ('a5a5a5a5-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','99999999-9999-9999-9999-999999999999','2026-03-05 10:00:00+00'); -- OI5 kpi NULL
SQL
echo "seed pronto"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260618130000_recencia_colacor_created_at.sql"
P -q -c "SET timezone='UTC';" -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos (efeito) ──"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a1a1a1a1-0000-0000-0000-000000000001';")
eq "P1 OI1a created_at → data do pedido (UTC)" "$V" "2025-09-15"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a1a1a1a1-0000-0000-0000-000000000002';")
eq "P1 OI1b consertado" "$V" "2025-09-15"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.sales_orders WHERE id='11111111-1111-1111-1111-111111111111';")
eq "P2 SO1 (pai) consertado" "$V" "2025-09-15"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text FROM public.order_items WHERE id='a1a1a1a1-0000-0000-0000-000000000001';")
eq "P3 OI1a data civil em BRT tbm bate (timezone-safe)" "$V" "2025-09-15"
V=$(Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.account='colacor' AND so.hash_payload LIKE 'omie\_%' AND so.order_date_kpi IS NOT NULL AND (oi.created_at AT TIME ZONE 'UTC')::date <> so.order_date_kpi;")
eq "P4 cobertura: 0 colacor-omie ainda divergente" "$V" "0"

echo "── asserts não-toca (escopo morde) ──"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a4a4a4a4-0000-0000-0000-000000000001';")
eq "N1 OI4 OBEN intacto (bloqueado no #B)" "$V" "2026-03-05"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a3a3a3a3-0000-0000-0000-000000000001';")
eq "N2 OI3 não-omie intacto" "$V" "2026-03-05"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a2a2a2a2-0000-0000-0000-000000000001';")
eq "N3 OI2 já-correto permanece certo" "$V" "2026-06-10"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a5a5a5a5-0000-0000-0000-000000000001';")
eq "N4 OI5 (order_date_kpi NULL) intacto" "$V" "2026-03-05"

echo "── idempotência ──"
H1=$(Pq -c "SELECT md5(coalesce(string_agg(id::text||'|'||created_at::text, ',' ORDER BY id),'')) FROM public.order_items;")
SO1=$(Pq -c "SELECT md5(coalesce(string_agg(id::text||'|'||created_at::text, ',' ORDER BY id),'')) FROM public.sales_orders;")
P -q -c "SET timezone='UTC';" -f "$MIG"   # 2ª aplicação
H2=$(Pq -c "SELECT md5(coalesce(string_agg(id::text||'|'||created_at::text, ',' ORDER BY id),'')) FROM public.order_items;")
SO2=$(Pq -c "SELECT md5(coalesce(string_agg(id::text||'|'||created_at::text, ',' ORDER BY id),'')) FROM public.sales_orders;")
eq "I1 order_items idêntico após 2ª aplicação (idempotente)" "$H2" "$H1"
eq "I1 sales_orders idêntico após 2ª aplicação (idempotente)" "$SO2" "$SO1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1: versão FURADA sem o filtro account='colacor' deve TOCAR oben (OI4, hoje intacto em 2026-03-05).
# Prova que o filtro de conta é o que protege oben.
P -q -c "SET timezone='UTC';
  UPDATE public.order_items oi
  SET created_at = ((so.order_date_kpi + time '12:00') AT TIME ZONE 'UTC')
  FROM public.sales_orders so
  WHERE oi.sales_order_id = so.id
    AND so.hash_payload LIKE 'omie\_%'
    AND so.order_date_kpi IS NOT NULL
    AND (oi.created_at AT TIME ZONE 'UTC')::date <> so.order_date_kpi;"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'UTC')::date::text FROM public.order_items WHERE id='a4a4a4a4-0000-0000-0000-000000000001';")
if [ "$V" = "2025-05-01" ]; then ok "F1 sem o filtro de conta, OBEN É tocado → o filtro account tem dente"; else bad "F1 esperava OBEN tocado (2025-05-01), veio [$V]"; fi

# F3: fórmula com MEIA-NOITE UTC recua 1 dia em fuso negativo. Re-seto OI1a divergente e aplico a
# fórmula furada (sem o +12h); a data civil em BRT deve recuar → prova que meio-dia tem dente.
P -q -c "SET timezone='UTC';
  UPDATE public.order_items SET created_at = ('2026-03-05 10:00:00+00')
  WHERE id='a1a1a1a1-0000-0000-0000-000000000001';
  UPDATE public.order_items oi
  SET created_at = ((so.order_date_kpi) AT TIME ZONE 'UTC')   -- FURADA: meia-noite, sem +12h
  FROM public.sales_orders so
  WHERE oi.id='a1a1a1a1-0000-0000-0000-000000000001' AND so.id=oi.sales_order_id;"
V=$(Pq -c "SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text FROM public.order_items WHERE id='a1a1a1a1-0000-0000-0000-000000000001';")
if [ "$V" = "2025-09-14" ]; then ok "F3 meia-noite UTC recua p/ 2025-09-14 em BRT → meio-dia tem dente"; else bad "F3 esperava recuo (2025-09-14), veio [$V]"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
