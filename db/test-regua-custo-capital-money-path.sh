#!/usr/bin/env bash
# Prova PG17 da migration 20260704190000_fin_regua_custo_capital.sql (F2 custo do prazo).
# Taxa correta (exclui armazenagem) · degradação · unit gate · gate staff · REVOKE anon · falsificação.
#   bash db/test-regua-custo-capital-money-path.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="regua-custo-capital"
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
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisitos: app_role + user_roles + has_role + empresa_configuracao_custos ──
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
CREATE TABLE IF NOT EXISTS public.empresa_configuracao_custos (
  empresa text PRIMARY KEY,
  selic_anual numeric,
  spread_oportunidade numeric,
  armazenagem_fisica numeric
);
CREATE TABLE IF NOT EXISTS public.omie_condicao_pagamento_catalogo (
  codigo text, descricao text, num_parcelas integer, empresa text, ativo boolean
);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260704190000_fin_regua_custo_capital.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260704190500_fin_regua_condicao_prazo.sql"
P -q -f "$MIG"
P -q -f "$MIG2"
echo "migrations aplicadas: $(basename "$MIG"), $(basename "$MIG2")"

# ── ZONA 3 — seed (config OBEN real + BADCO absurda; roles employee/master/customer) ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','customer') ON CONFLICT DO NOTHING;
INSERT INTO public.empresa_configuracao_custos(empresa, selic_anual, spread_oportunidade, armazenagem_fisica) VALUES
  ('OBEN', 14.75, 3.00, 8.00),
  ('BADCO', 1000, 3, 8) ON CONFLICT DO NOTHING;
INSERT INTO public.omie_condicao_pagamento_catalogo(codigo, descricao, num_parcelas, empresa, ativo) VALUES
  ('C30', '30/60/90', 3, 'OBEN', true),
  ('CINATIVA', 'A Vista', 1, 'OBEN', false);
SQL

EMP='22222222-2222-2222-2222-222222222222'
MASTER='33333333-3333-3333-3333-333333333333'
CUST='44444444-4444-4444-4444-444444444444'

# retorna a taxa (arredondada) ou 'NULL', executando como authenticated + uid dado
call_val() { # $1=uid $2=empresa  → última linha = valor (as linhas 'SET' são ruído)
  local out
  out=$(P -qtA -v uid="$1" -v emp="$2" 2>/dev/null <<'SQL'
SET ROLE authenticated;
SET test.uid = :'uid';
SELECT coalesce(round(public.fin_regua_custo_capital(:'emp'),4)::text,'NULL');
SQL
)
  echo "$out" | tail -n1
}

# executa o gate como $3(role)+$1(uid): imprime 'BLOQUEOU' (42501) ou 'PASSOU' (sem bloqueio)
gate_probe() { # $1=uid(may be empty) $2=empresa $3=role
  local out
  out=$(P -v uid="$1" -v emp="$2" -v rol="$3" 2>&1 <<'SQL'
SET ROLE :rol;
SET test.uid = :'uid';
SET myapp_emp.v = :'emp';
DO $$
BEGIN
  PERFORM public.fin_regua_custo_capital(current_setting('myapp_emp.v', true));
  RAISE EXCEPTION 'PROBE_PASSOU_SEM_BLOQUEIO';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'PROBE_BLOQUEOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
  if echo "$out" | grep -q 'PROBE_BLOQUEOU_42501'; then echo 'BLOQUEOU';
  elif echo "$out" | grep -q 'PROBE_PASSOU_SEM_BLOQUEIO'; then echo 'PASSOU';
  else echo "ERRO_INESPERADO:${out}"; fi
}

# fin_regua_condicao_prazo: "descricao|num" ou 'VAZIO' (0 linhas), como employee
cond_val() { # $1=uid $2=empresa $3=codigo
  local out last
  out=$(P -qtA -F'|' -v uid="$1" -v emp="$2" -v cod="$3" 2>/dev/null <<'SQL'
SET ROLE authenticated;
SET test.uid = :'uid';
SELECT descricao, num_parcelas FROM public.fin_regua_condicao_prazo(:'emp', :'cod');
SQL
)
  last=$(echo "$out" | tail -n1)
  if [ -z "$last" ]; then echo 'VAZIO'; else echo "$last"; fi
}

# gate da fin_regua_condicao_prazo: 'BLOQUEOU' (42501) ou 'PASSOU'
cond_gate() { # $1=uid $2=role
  local out
  out=$(P -v uid="$1" -v rol="$2" 2>&1 <<'SQL'
SET ROLE :rol;
SET test.uid = :'uid';
DO $$
BEGIN
  PERFORM descricao FROM public.fin_regua_condicao_prazo('oben','C30');
  RAISE EXCEPTION 'PROBE_PASSOU_SEM_BLOQUEIO';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'PROBE_BLOQUEOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
  if echo "$out" | grep -q 'PROBE_BLOQUEOU_42501'; then echo 'BLOQUEOU'; else echo 'PASSOU'; fi
}

echo "── positivos ──"
eq "A1 employee/oben → 17,75% (case-insensitive; exclui armazenagem, ≠0.2575)" "$(call_val "$EMP" oben)" "0.1775"
eq "A2 master/OBEN → 17,75%" "$(call_val "$MASTER" OBEN)" "0.1775"
eq "A3 config ausente (colacor) → NULL (degrada)" "$(call_val "$EMP" colacor)" "NULL"
eq "A4 unit gate: componente absurdo (BADCO selic=1000) → NULL" "$(call_val "$EMP" badco)" "NULL"

echo "── gate / autorização ──"
eq "A5 customer (não-staff) → bloqueia (42501)" "$(gate_probe "$CUST" oben authenticated)" "BLOQUEOU"
eq "A6 sem uid (auth.uid null) → bloqueia (42501)" "$(gate_probe "" oben authenticated)" "BLOQUEOU"
eq "A7 anon (REVOKE) → bloqueia (42501 insufficient_privilege)" "$(gate_probe "" oben anon)" "BLOQUEOU"

echo "── condição (fin_regua_condicao_prazo) ──"
eq "B1 employee/oben/C30 → descricao+num (case-insensitive)" "$(cond_val "$EMP" oben C30)" "30/60/90|3"
eq "B2 código inexistente → VAZIO (degrada)" "$(cond_val "$EMP" oben NOPE)" "VAZIO"
eq "B3 condição INATIVA → VAZIO (filtro ativo)" "$(cond_val "$EMP" oben CINATIVA)" "VAZIO"
eq "B4 customer (não-staff) → bloqueia (42501)" "$(cond_gate "$CUST" authenticated)" "BLOQUEOU"
eq "B5 anon (REVOKE) → bloqueia" "$(cond_gate "" anon)" "BLOQUEOU"

echo "── falsificação (sabota → exige que o assert FIQUE VERMELHO) ──"
# F1: remove o gate → A5 (customer) DEVE deixar de bloquear (senão o assert não tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_regua_custo_capital(p_empresa text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_selic numeric; v_spread numeric;
BEGIN
  -- GATE REMOVIDO (sabotagem)
  SELECT selic_anual, spread_oportunidade INTO v_selic, v_spread
  FROM public.empresa_configuracao_custos WHERE upper(empresa)=upper(p_empresa) LIMIT 1;
  IF v_selic IS NULL OR v_spread IS NULL THEN RETURN NULL; END IF;
  RETURN (v_selic + v_spread)/100.0;
END $$;
SQL
FALS_GATE="$(gate_probe "$CUST" oben authenticated)"
if [ "$FALS_GATE" = "PASSOU" ]; then ok "FALS-1 sem gate, customer PASSOU → A5 tem dente"; else bad "FALS-1 sabotagem do gate não flipou A5 (veio [$FALS_GATE])"; fi

# F2: inclui armazenagem → A1 DEVE virar 0.2575 (senão o assert de valor não tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_regua_custo_capital(p_empresa text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_selic numeric; v_spread numeric; v_arm numeric;
BEGIN
  IF NOT (public.has_role((SELECT auth.uid()),'master'::public.app_role)
       OR public.has_role((SELECT auth.uid()),'employee'::public.app_role))
  THEN RAISE EXCEPTION 'nope' USING ERRCODE='42501'; END IF;
  SELECT selic_anual, spread_oportunidade, armazenagem_fisica INTO v_selic, v_spread, v_arm
  FROM public.empresa_configuracao_custos WHERE upper(empresa)=upper(p_empresa) LIMIT 1;
  IF v_selic IS NULL THEN RETURN NULL; END IF;
  RETURN (v_selic + v_spread + v_arm)/100.0;  -- INCLUI armazenagem (sabotagem)
END $$;
SQL
FALS_ARM="$(call_val "$EMP" oben)"
if [ "$FALS_ARM" = "0.2575" ]; then ok "FALS-2 com armazenagem vira 0.2575 → A1 tem dente"; else bad "FALS-2 sabotagem da armazenagem não flipou A1 (veio [$FALS_ARM])"; fi

# restaura a versão verdadeira (higiene)
P -q -f "$MIG"

echo "═══════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || { echo "❌ FALHOU"; exit 1; }
echo "✅ TUDO VERDE (com dente)"
