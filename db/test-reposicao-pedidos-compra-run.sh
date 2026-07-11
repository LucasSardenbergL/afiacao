#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: reposicao_pedidos_compra_run (PR1 reconciliação PO)     ║
# ║  Migration 20260711143616_reposicao_pedidos_compra_run.sql                     ║
# ║  (1) tabela imutável de run + colunas last_seen single-writer em               ║
# ║      purchase_orders_tracking existem                                         ║
# ║  (2) INSERT de um run funciona, volume_ok aceita NULL (bootstrap)             ║
# ║  (3) RLS: staff (pode_ver_carteira_completa=true) vê; não-staff NÃO vê        ║
# ║                                                                                ║
# ║  Rode:  bash db/test-reposicao-pedidos-compra-run.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  Lei de Ferro: 1) migration REAL  2) negativo com condição esperada            ║
# ║                3) FALSIFICAÇÃO (sabota → exige vermelho → restaura).           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="reposicao-pedidos-compra-run"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "/tmp/fn-${SLUG}"-*.sql 2>/dev/null || true; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: pode_ver_carteira_completa (stub que lê test.staff)
#           + purchase_orders_tracking mínima
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.staff', true),'')::bool, false) $f$;
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa text, omie_codigo_pedido bigint, updated_at timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260711143616_reposicao_pedidos_compra_run.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── estrutura ──"
# (+) estrutura: colunas last_seen existem
eq "coluna last_seen_run_id existe" \
  "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='purchase_orders_tracking' AND column_name='last_seen_pedidos_full_run_id'")" "1"
eq "coluna last_seen_at existe" \
  "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='purchase_orders_tracking' AND column_name='last_seen_pedidos_full_at'")" "1"

echo "── insert (bootstrap, volume_ok NULL) ──"
# (+) INSERT de um run funciona e volume_ok aceita NULL
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (empresa,modo,janela_de,janela_ate,ids_distintos,volume_ok)
VALUES ('OBEN','completo', current_date-365, current_date+120, 404, NULL);
SQL
eq "run inserido" "$(Pq -c "SELECT count(*) FROM reposicao_pedidos_compra_run WHERE empresa='OBEN'")" "1"
eq "volume_ok aceita NULL (bootstrap)" \
  "$(Pq -c "SELECT count(*) FROM reposicao_pedidos_compra_run WHERE empresa='OBEN' AND volume_ok IS NULL")" "1"

echo "── RLS (staff vê, não-staff não vê) ──"
# (+) RLS: staff SELECT vê; não-staff NÃO vê (SET ROLE authenticated + GUC)
P -q <<'SQL'
GRANT USAGE ON SCHEMA public TO authenticated;
SQL
STAFF=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','true',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
eq "staff vê o run" "$STAFF" "1"
NAO=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','false',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
eq "não-staff NÃO vê (RLS)" "$NAO" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (sabota a policy → exige VERMELHO)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# (−/FALSIFICAÇÃO) sabota a policy (USING true) → não-staff passaria a ver → exige VERMELHO
P -q <<'SQL'
DROP POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run FOR SELECT TO authenticated USING (true);
SQL
SAB=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','false',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
if [ "$SAB" = "0" ]; then bad "FALSIFICAÇÃO deveria vazar (RLS sabotada) mas não vazou"; else ok "falsificação confirmada: RLS sabotada vaza ($SAB) — o assert tem dente"; fi

# restaura a policy real e reconfirma que o não-staff volta a não ver (fecha o teste em estado correto)
P -q -f "$MIG"
RESTORE=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','false',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
eq "restore migration real de volta (não-staff volta a não ver)" "$RESTORE" "0"

echo "═══ PASS=$PASS FAIL=$FAIL ═══"; [ "$FAIL" = "0" ]
