#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — gate authz de fin_estimar_estoque_omie (P2, reverter regressão)  ║
# ║  Migration: supabase/migrations/20260709120500_authz_estimar_estoque_omie.sql ║
# ║  Rode:  bash db/test-authz-estimar-estoque-omie.sh > /tmp/t.log 2>&1; echo $?  ║
# ║                                                                                ║
# ║  Gate = service_role OR pode_ver_carteira_completa(auth.uid()) (revisão Codex).║
# ║  Prova: master/service_role/employee-GERENCIAL OBTÊM o valor; customer,        ║
# ║  employee-COMUM e anon são BARRADOS (42501); defesa em profundidade (gate      ║
# ║  barra anon mesmo com grant). Falsifica: remover o gate → customer vaza;       ║
# ║  afrouxar p/ qualquer employee → employee comum vaza → vermelho.               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="authz-estoque-omie"
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

# ── base Supabase: roles, schema auth, auth.uid()/role() via GUC ──
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
# ZONA 1 — PRÉ-REQUISITOS + cadeia de gate REAL de PROD (has_role/get_commercial_role/
#          pode_ver_carteira_completa), stubada com text no lugar dos enums (lógica idêntica).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- fonte de dados da RPC
CREATE TABLE public.inventory_position (account text, saldo numeric, cmc numeric);
-- lidas pela cadeia de gate
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $fn$;

CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $fn$;

-- pode_ver_carteira_completa: cópia FIEL do corpo de PROD (psql-ro 2026-07-09).
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.has_role(_uid, 'master')
    OR (public.has_role(_uid, 'employee')
        AND public.get_commercial_role(_uid) IN ('gerencial','estrategico','super_admin'));
$fn$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260709120500_authz_estimar_estoque_omie.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS (espelha PROD: authenticated+service_role EXECUTE; anon/PUBLIC negado)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master
  ('22222222-2222-2222-2222-222222222222'),  -- employee GERENCIAL (autorizado)
  ('66666666-6666-6666-6666-666666666666'),  -- employee COMUM/vendedor (barrado — o "apertar")
  ('44444444-4444-4444-4444-444444444444')   -- customer sem role (o alvo do vazamento)
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('66666666-6666-6666-6666-666666666666','employee');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','gerencial'),
  ('66666666-6666-6666-6666-666666666666','vendedor');

-- inventory_position: 'vendas' (=oben) → 3 SKUs saldo>0 (2 com cmc, 1 sem); 'colacor_vendas' isolada.
INSERT INTO public.inventory_position(account, saldo, cmc) VALUES
  ('vendas',         10,  5.00),   -- 50.00
  ('vendas',          4, 25.00),   -- 100.00
  ('vendas',          7,  0.00),   -- cmc=0 → fora do valor, dentro da cobertura
  ('colacor_vendas', 100,  9.99);  -- outra account: NÃO deve entrar em 'oben'
-- esperado('oben'): valor=150.00 · skus_total=3 · skus_com_custo=2 · cobertura=66.67

REVOKE ALL ON FUNCTION public.fin_estimar_estoque_omie(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated, service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos (autorizado obtém o número) ──"
V=$(Pq -c "SET test.role='authenticated'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT valor_estimado FROM public.fin_estimar_estoque_omie('oben');" | tail -1)
eq "P1 master obtém valor_estimado" "$V" "150.00"

C=$(Pq -c "SET test.role='authenticated'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT cobertura_pct FROM public.fin_estimar_estoque_omie('oben');" | tail -1)
eq "P1b cobertura correta" "$C" "66.67"

V=$(Pq -c "SET test.role='service_role'; SET ROLE service_role; SELECT valor_estimado FROM public.fin_estimar_estoque_omie('oben');" | tail -1)
eq "P2 service_role passa o gate" "$V" "150.00"

V=$(Pq -c "SET test.role='authenticated'; SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT valor_estimado FROM public.fin_estimar_estoque_omie('oben');" | tail -1)
eq "P3 employee GERENCIAL passa" "$V" "150.00"

echo "── asserts negativos (a defesa morde) ──"
# N1 — CORE do P2: customer sem role barrado no corpo (42501)
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.fin_estimar_estoque_omie('oben');
  RAISE EXCEPTION 'GATE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GATE_OK*) ok "N1 customer sem role → 42501 (vazamento fechado)" ;; *) bad "N1 — veio: $R" ;; esac

# N2 — o APERTAR (Codex): employee COMUM (não gerencial) barrado
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.fin_estimar_estoque_omie('oben');
  RAISE EXCEPTION 'GATE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GATE_OK*) ok "N2 employee comum (não gerencial) → 42501 (menor privilégio)" ;; *) bad "N2 — veio: $R" ;; esac

# N3 — anon negado pela camada de GRANT (nem entra no corpo)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.fin_estimar_estoque_omie('oben');
  RAISE EXCEPTION 'GRANT_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ANON_DENY_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *ANON_DENY_OK*) ok "N3 anon negado por grant (42501)" ;; *) bad "N3 — veio: $R" ;; esac

# N4 — defesa em profundidade: mesmo COM grant a anon, o gate barra (COALESCE fail-closed, auth.uid()=NULL)
P -q -c "GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO anon;" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.fin_estimar_estoque_omie('oben');
  RAISE EXCEPTION 'DEFESA_PROFUNDIDADE_FALHOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_BARRA_ANON_TB';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GATE_BARRA_ANON_TB*) ok "N4 defesa em profundidade: gate barra anon mesmo com grant" ;; *) bad "N4 — veio: $R" ;; esac
P -q -c "REVOKE EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) FROM anon;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1 — remover o gate (a regressão do feed) → customer VAZA → o assert N1 tem dente
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
 RETURNS TABLE(valor_estimado numeric, cobertura_pct numeric, skus_total integer, skus_com_custo integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_account text;
BEGIN
  -- GATE REMOVIDO (regressão)
  v_account := CASE lower(trim(p_company))
                 WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v_account IS NULL THEN RAISE EXCEPTION 'empresa invalida %', p_company USING ERRCODE='P0001'; END IF;
  RETURN QUERY WITH canon AS (SELECT ip.saldo, ip.cmc FROM public.inventory_position ip WHERE ip.account=v_account AND ip.saldo>0)
    SELECT COALESCE(SUM(CASE WHEN cmc>0 THEN saldo*cmc ELSE 0 END),0)::numeric,
           CASE WHEN COUNT(*)=0 THEN 0::numeric ELSE ROUND(100.0*COUNT(*) FILTER (WHERE cmc>0)/COUNT(*),2) END,
           COUNT(*)::int, COUNT(*) FILTER (WHERE cmc>0)::int FROM canon;
END; $fn$;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ DECLARE v numeric; BEGIN
  SELECT valor_estimado INTO v FROM public.fin_estimar_estoque_omie('oben');
  RAISE NOTICE 'SABOTAGEM_VAZOU:%', v;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *SABOTAGEM_VAZOU*) ok "F1 sem o gate o customer VAZA o valor (N1 tem dente)" ;;
  *) bad "F1 sabotei o gate e N1 não mudou → assert fraco. Veio: $R" ;;
esac
P -q -f "$MIG"   # restaura

# F2 — afrouxar o gate p/ QUALQUER employee → employee comum VAZA → o assert N2 (gerencial) tem dente
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
 RETURNS TABLE(valor_estimado numeric, cobertura_pct numeric, skus_total integer, skus_com_custo integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_account text;
BEGIN
  -- GATE AFROUXADO: qualquer employee (sem exigir gerencial)
  IF NOT (COALESCE(auth.role()='service_role',false) OR COALESCE(public.has_role(auth.uid(),'employee'),false)) THEN
    RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501'; END IF;
  v_account := CASE lower(trim(p_company))
                 WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v_account IS NULL THEN RAISE EXCEPTION 'empresa invalida %', p_company USING ERRCODE='P0001'; END IF;
  RETURN QUERY WITH canon AS (SELECT ip.saldo, ip.cmc FROM public.inventory_position ip WHERE ip.account=v_account AND ip.saldo>0)
    SELECT COALESCE(SUM(CASE WHEN cmc>0 THEN saldo*cmc ELSE 0 END),0)::numeric,
           CASE WHEN COUNT(*)=0 THEN 0::numeric ELSE ROUND(100.0*COUNT(*) FILTER (WHERE cmc>0)/COUNT(*),2) END,
           COUNT(*)::int, COUNT(*) FILTER (WHERE cmc>0)::int FROM canon;
END; $fn$;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated;
DO $$ DECLARE v numeric; BEGIN
  SELECT valor_estimado INTO v FROM public.fin_estimar_estoque_omie('oben');
  RAISE NOTICE 'LARGO_VAZOU:%', v;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *LARGO_VAZOU*) ok "F2 gate 'qualquer employee' deixa o comum ler (N2 exige gerencial → tem dente)" ;;
  *) bad "F2 afrouxei p/ employee e N2 não mudou → assert fraco. Veio: $R" ;;
esac
P -q -f "$MIG"   # restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
