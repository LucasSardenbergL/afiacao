#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — seed_targets_faltantes() (anti-ressurreição no SEED, money-path) ║
# ║  Migration: supabase/migrations/20260621120000_seed_targets_faltantes_rpc.sql ║
# ║  Rode:  bash db/test-seed-targets-faltantes.sh > /tmp/t.log 2>&1; echo $?     ║
# ║                                                                                ║
# ║  Prova que a RPC retorna SÓ quem é seguro semear (omie − fcs − flaggeds) e     ║
# ║  FALSIFICA: sem o filtro de flaggeds, o fornecedor excluído RESSUSCITA.        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="seed-targets"
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
# ZONA 1 — pré-requisitos (tabelas que a RPC LÊ; stub mínimo com as colunas usadas)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.omie_clientes (
  user_id      uuid,
  empresa_omie text DEFAULT 'colacor'
);
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid
);
CREATE TABLE public.cliente_classificacao (
  user_id             uuid PRIMARY KEY,
  excluir_da_carteira boolean NOT NULL DEFAULT false
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplicar a migration REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260621120000_seed_targets_faltantes_rpc.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seed dos cenários + grant p/ service_role (espelha o admin role do Supabase)
# ══════════════════════════════════════════════════════════════════════════════
# c1 faltante+flagged (o caso do bug) | c2 faltante limpo | c3 faltante SEM classificacao
# c4 existente limpo | c5 existente+flagged | c6 faltante em 2 empresas (dedup) | NULL (guard)
P -q <<'SQL'
INSERT INTO public.omie_clientes (user_id, empresa_omie) VALUES
  ('00000000-0000-0000-0000-0000000000c1','colacor'),
  ('00000000-0000-0000-0000-0000000000c2','colacor'),
  ('00000000-0000-0000-0000-0000000000c3','colacor'),
  ('00000000-0000-0000-0000-0000000000c4','colacor'),
  ('00000000-0000-0000-0000-0000000000c5','colacor'),
  ('00000000-0000-0000-0000-0000000000c6','colacor'),
  ('00000000-0000-0000-0000-0000000000c6','oben'),    -- dup: mesmo cliente, +1 empresa
  (NULL,                                  'colacor'); -- guard: user_id NULL nunca vira alvo

INSERT INTO public.farmer_client_scores (customer_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000c5');

INSERT INTO public.cliente_classificacao (user_id, excluir_da_carteira) VALUES
  ('00000000-0000-0000-0000-0000000000c1', true),   -- flagged
  ('00000000-0000-0000-0000-0000000000c2', false),
  ('00000000-0000-0000-0000-0000000000c4', false),
  ('00000000-0000-0000-0000-0000000000c5', true),   -- flagged
  ('00000000-0000-0000-0000-0000000000c6', false);
  -- c3 NÃO tem linha em cliente_classificacao (não-fornecedor implícito → deve aparecer)

GRANT SELECT ON public.omie_clientes, public.farmer_client_scores, public.cliente_classificacao TO service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts (positivo / negativo / dedup / guard / auth)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
TOTAL=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes();")
eq  "A1 total de alvos = {c2,c3,c6}"                         "$TOTAL" "3"

C1=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c1';")
eq  "A2 ⭐ faltante+flagged NÃO aparece (anti-ressurreição)" "$C1"    "0"

C2=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c2';")
eq  "A3 faltante limpo aparece"                              "$C2"    "1"

C3=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c3';")
eq  "A4 faltante SEM classificação aparece"                  "$C3"    "1"

C4=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c4';")
eq  "A5 já-existente (limpo) NÃO re-semeado"                 "$C4"    "0"

C5=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c5';")
eq  "A6 já-existente+flagged NÃO aparece"                    "$C5"    "0"

C6=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c6';")
eq  "A7 dedup: cliente em 2 empresas aparece 1×"             "$C6"    "1"

NULLS=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id IS NULL;")
eq  "A8 guard: user_id NULL fora"                            "$NULLS" "0"

# auth: authenticated NÃO executa (REVOKE EXECUTE → insufficient_privilege 42501)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM count(*) FROM public.seed_targets_faltantes();
  RAISE EXCEPTION 'EXECUTOU_SEM_GRANT';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *REVOKE_OK*) ok "A9 REVOKE: authenticated não executa (42501)" ;; *) bad "A9 REVOKE — veio: $R" ;; esac

# auth: service_role executa (GRANT EXECUTE + BYPASSRLS + SELECT nas fontes)
SR=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.seed_targets_faltantes();" | tail -1)
eq  "A10 service_role executa (3 alvos)"                     "$SR"    "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1 ⭐: RPC SEM o filtro de flaggeds → c1 (fornecedor excluído) DEVE vazar p/ os alvos (prova A2)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT oc.user_id FROM public.omie_clientes oc
  WHERE oc.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = oc.user_id)
  ORDER BY oc.user_id
$f$;
SQL
SAB1=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c1';")
if [ "$SAB1" = "1" ]; then ok "F1 ⭐ sem o filtro de flaggeds, c1 RESSUSCITA → A2 tem dente"; else bad "F1 sabotei flaggeds e c1 NÃO vazou → A2 é fraco"; fi
P -q -f "$MIG"   # restaura

# F2: RPC SEM o filtro de fcs → c4 (já-existente) DEVE vazar (prova A5)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT oc.user_id FROM public.omie_clientes oc
  WHERE oc.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = oc.user_id AND cc.excluir_da_carteira)
  ORDER BY oc.user_id
$f$;
SQL
SAB2=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-0000000000c4';")
if [ "$SAB2" = "1" ]; then ok "F2 sem o filtro de fcs, c4 (existente) vaza → A5 tem dente"; else bad "F2 sabotei fcs e c4 NÃO vazou → A5 é fraco"; fi
P -q -f "$MIG"   # restaura

# sanidade pós-restauro: volta a 3 alvos
TOTAL2=$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes();")
eq  "A11 pós-restauro: volta a 3 alvos"                      "$TOTAL2" "3"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
