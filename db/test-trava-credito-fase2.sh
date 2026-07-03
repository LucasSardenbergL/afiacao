#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Trava de crédito Fase 2 (venda_gate_credito + exceção + RLS)     ║
# ║  Migrations: 20260702233000_trava_credito_fase2.sql                            ║
# ║            + 20260703140000_trava_credito_gate_excecao_por_par.sql (P1 Codex)  ║
# ║  Spec/veredito Codex: docs/superpowers/specs/trava-credito-fase2.md            ║
# ║  Rode: bash db/test-trava-credito-fase2.sh > /tmp/t.log 2>&1; echo "exit=$?"   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="trava-credito-f2"
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
-- Supabase real: authenticated/anon têm USAGE no schema auth (toda policy/trigger chama auth.uid())
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê/referencia mas não cria)
# Helpers de role: definições REAIS de prod (pg_get_functiondef via psql-ro, 2026-07-02).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='commercial_role') THEN
    CREATE TYPE public.commercial_role AS ENUM
      ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE IF NOT EXISTS public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);

-- fiel a prod (verbatim)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $function$;

CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR (
      has_role(_uid, 'employee'::app_role)
      AND get_commercial_role(_uid) IN (
        'gerencial'::commercial_role,
        'estrategico'::commercial_role,
        'super_admin'::commercial_role
      )
    );
$function$;

-- tabelas que a migration referencia (stub das colunas usadas)
CREATE TABLE IF NOT EXISTS public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE IF NOT EXISTS public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  omie_codigo_cliente bigint,
  saldo numeric,
  status_titulo text,
  data_vencimento date
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260702233000_trava_credito_fase2.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260703140000_trava_credito_gate_excecao_por_par.sql"
P -q -f "$MIG"
P -q -f "$MIG2"
echo "migrations aplicadas: $(basename "$MIG") + $(basename "$MIG2")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs
# u-gestor 1111 (employee+gerencial) · u-vendedor 2222 (employee+farmer) · u-master 3333
# cliente 100: oben 2 títulos 61/90d (100 + 250.50) + ruído (59d, saldo 0, recebido);
#              colacor 1 título 61d+ (500) — isolamento por company
# cliente 200: sem títulos · cliente 300: só título com status fora do vocabulário
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('11111111-1111-1111-1111-111111111111','gerencial'),
  ('22222222-2222-2222-2222-222222222222','farmer');

INSERT INTO public.sales_orders(id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.fin_contas_receber(company, omie_codigo_cliente, saldo, status_titulo, data_vencimento) VALUES
  -- cliente 100 @ oben: contam (61d e 90d)
  ('oben', 100, 100.00, 'ATRASADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)),
  ('oben', 100, 250.50, 'VENCIDO',  ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 61)),
  -- ruído que NÃO conta: 59d, saldo 0, já recebido
  ('oben', 100, 999.00, 'ATRASADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 59)),
  ('oben', 100, 0,      'ATRASADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)),
  ('oben', 100, 777.00, 'RECEBIDO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)),
  -- cliente 100 @ colacor (isolamento por company)
  ('colacor', 100, 500.00, 'ATRASADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 70)),
  -- cliente 300: só status fora do vocabulário
  ('oben', 300, 888.00, 'CANCELADO', ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90));

-- migration é --no-privileges no Supabase → concede p/ os asserts de RLS
GRANT SELECT, INSERT ON public.venda_excecao_credito TO authenticated;
GRANT SELECT ON public.venda_bloqueio_credito_log TO authenticated;
GRANT SELECT ON public.user_roles, public.commercial_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: gate (RPC) ──"

G_OBEN=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A1 bloqueia vencido 60+ (oben/100)"      "$(echo "$G_OBEN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')" "True"
eq "A2 soma SÓ o que conta (100+250.50)"     "$(echo "$G_OBEN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["vencido"])')" "350.5"
eq "A3 conta 2 títulos (59d/saldo0/recebido fora)" "$(echo "$G_OBEN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["titulos"])')" "2"

G_COL=$(Pq -c "SELECT public.venda_gate_credito('colacor', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A4 isolamento por company (colacor/100 = 500)" "$(echo "$G_COL" | python3 -c 'import sys,json; print(json.load(sys.stdin)["vencido"])')" "500.0"

G_LIMPO=$(Pq -c "SELECT public.venda_gate_credito('oben', 200, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A5 cliente sem títulos → passa"          "$(echo "$G_LIMPO" | python3 -c 'import sys,json; print(json.load(sys.stdin)["motivo"])')" "sem_vencido_60d"

G_VOCAB=$(Pq -c "SELECT public.venda_gate_credito('oben', 300, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A6 status fora do vocabulário não conta" "$(echo "$G_VOCAB" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')" "False"

G_NULO=$(Pq -c "SELECT public.venda_gate_credito('oben', NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A7 sem código → passa com motivo explícito (threat-model)" "$(echo "$G_NULO" | python3 -c 'import sys,json; print(json.load(sys.stdin)["motivo"])')" "sem_codigo"

echo "── asserts: exceção + RLS ──"

# A8: gestor (gerencial) INSERE exceção pro pedido A — e tenta FORJAR aprovado_por=master
P -q <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
INSERT INTO public.venda_excecao_credito
  (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'oben', 100, 'cliente prometeu quitar sexta',
   now() + interval '3 days', '33333333-3333-3333-3333-333333333333');
RESET ROLE;
SQL
ok "A8 gestor consegue aprovar exceção (INSERT passou)"

AUTOR=$(Pq -c "SELECT aprovado_por FROM public.venda_excecao_credito WHERE sales_order_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';")
eq "A9 anti-forje: trigger força aprovado_por = quem inseriu" "$AUTOR" "11111111-1111-1111-1111-111111111111"

G_EXC=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A10 exceção válida LIBERA o pedido A"    "$(echo "$G_EXC" | python3 -c 'import sys,json; print(json.load(sys.stdin)["motivo"])')" "excecao_valida"

G_SOB=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');")
eq "A11 exceção NÃO vaza pro pedido B (por-pedido)" "$(echo "$G_SOB" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')" "True"

# A11b (P1 review Codex): a exceção do pedido A é do PAR (oben,100) — o MESMO pedido
# invocado com OUTRO par bloqueável (colacor/100 tem 500 vencido 70d) segue bloqueado.
G_PAR=$(Pq -c "SELECT public.venda_gate_credito('colacor', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');")
eq "A11b exceção NÃO vaza p/ outro PAR no mesmo pedido" "$(echo "$G_PAR" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')" "True"

# A12: exceção EXPIRADA não libera (insere com validade no passado — CHECK 30d permite)
P -q <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
INSERT INTO public.venda_excecao_credito
  (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'oben', 100, 'liberacao antiga',
   now() - interval '1 hour', '11111111-1111-1111-1111-111111111111');
RESET ROLE;
SQL
G_EXP=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');")
eq "A12 exceção expirada continua bloqueando" "$(echo "$G_EXP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')" "True"

# A13: VENDEDOR (farmer) não aprova exceção → RLS nega (42501) e re-lança o resto
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.venda_excecao_credito
    (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
  VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'oben', 100, 'auto-liberacao do vendedor',
     now() + interval '1 day', '22222222-2222-2222-2222-222222222222');
  RAISE EXCEPTION 'RLS_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VENDEDOR_BARRADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *VENDEDOR_BARRADO*) ok "A13 vendedor não aprova exceção (42501)" ;; *) bad "A13 — veio: $R" ;; esac

# A14: authenticated NÃO executa a RPC do gate (REVOKE → 42501)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.venda_gate_credito('oben', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  RAISE EXCEPTION 'REVOKE_NAO_PEGOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'RPC_SO_SERVICE';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *RPC_SO_SERVICE*) ok "A14 gate é exclusivo do service_role (REVOKE pegou)" ;; *) bad "A14 — veio: $R" ;; esac

# A15: CHECK motivo vazio → 23514
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.venda_excecao_credito
    (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'oben', 100, '   ',
          now() + interval '1 day', '11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'CHECK_MOTIVO_NAO_PEGOU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'MOTIVO_OBRIGATORIO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *MOTIVO_OBRIGATORIO*) ok "A15 motivo vazio rejeitado (23514)" ;; *) bad "A15 — veio: $R" ;; esac

# A16: CHECK validade > 30 dias → 23514
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.venda_excecao_credito
    (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'oben', 100, 'validade eterna',
          now() + interval '90 days', '11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'CHECK_30D_NAO_PEGOU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'TETO_30D';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *TETO_30D*) ok "A16 validade acima de 30d rejeitada (23514)" ;; *) bad "A16 — veio: $R" ;; esac

# A17: anon não lê exceções (ou 0 linhas por RLS, ou permission denied por falta de GRANT)
if ANON_OUT=$(P -tA -c "SET ROLE anon; SELECT count(*) FROM public.venda_excecao_credito;" 2>/dev/null); then
  ANON=$(echo "$ANON_OUT" | tail -1)
  case "$ANON" in 0) ok "A17 anon não lê exceções (RLS → 0 linhas)" ;; *) bad "A17 anon leu $ANON linhas" ;; esac
else
  ok "A17 anon não lê exceções (permission denied)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: sabota a RÉGUA (60 → 6000 dias) → A1 tem de virar "não bloqueia"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.venda_gate_credito(p_company text, p_codigo bigint, p_sales_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_vencido numeric;
BEGIN
  -- SABOTADO: corte impossível (nada vence há 6000 dias)
  SELECT COALESCE(sum(saldo),0) INTO v_vencido FROM public.fin_contas_receber
   WHERE company = p_company AND omie_codigo_cliente = p_codigo
     AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL')
     AND saldo > 0
     AND data_vencimento < ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 6000);
  RETURN jsonb_build_object('bloqueado', v_vencido > 0, 'vencido', v_vencido, 'titulos', 0,
                            'vencimento_mais_antigo', null, 'excecao_id', null, 'motivo', 'x');
END; $$;
SQL
F1=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')
if [ "$F1" = "False" ]; then ok "F1 régua sabotada deixou de bloquear → A1 tem dente"; else bad "F1 sabotei a régua e AINDA bloqueia → assert fraco"; fi

# F2: sabota a POLICY de INSERT (WITH CHECK true) → vendedor passa a conseguir aprovar
P -q <<'SQL'
DROP POLICY IF EXISTS "venda_excecao_insert_gestor" ON public.venda_excecao_credito;
CREATE POLICY "venda_excecao_insert_gestor"
  ON public.venda_excecao_credito FOR INSERT WITH CHECK (true);
SQL
if P -q -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; INSERT INTO public.venda_excecao_credito (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','oben',100,'furada', now() + interval '1 day', '22222222-2222-2222-2222-222222222222');" >/dev/null 2>&1; then
  ok "F2 policy furada deixou o vendedor aprovar → A13 tem dente"
else
  bad "F2 sabotei a policy e o vendedor AINDA foi barrado → A13 é fraco"
fi
P -q -c "DELETE FROM public.venda_excecao_credito WHERE motivo='furada';" >/dev/null

# F3: DROPA o trigger anti-forje → o forje de aprovado_por passa a colar
P -q -c "DROP TRIGGER IF EXISTS trg_venda_excecao_forca_autor ON public.venda_excecao_credito;"
P -q <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
INSERT INTO public.venda_excecao_credito
  (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'oben', 100, 'forje-teste',
        now() + interval '1 day', '33333333-3333-3333-3333-333333333333');
RESET ROLE;
SQL
FORJADO=$(Pq -c "SELECT aprovado_por FROM public.venda_excecao_credito WHERE motivo='forje-teste';")
if [ "$FORJADO" = "33333333-3333-3333-3333-333333333333" ]; then
  ok "F3 sem o trigger o forje cola → A9 tem dente"
else
  bad "F3 droppei o trigger e o autor AINDA foi forçado → A9 não prova o trigger"
fi
P -q -c "DELETE FROM public.venda_excecao_credito WHERE motivo='forje-teste';" >/dev/null

# RESTAURA tudo re-aplicando as migrations reais (idempotentes) e re-prova A1+A13
P -q -f "$MIG"
P -q -f "$MIG2"
G_RESTORE=$(Pq -c "SELECT public.venda_gate_credito('oben', 100, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')
eq "F4 migrations restauradas voltam a bloquear" "$G_RESTORE" "True"
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.venda_excecao_credito
    (sales_order_id, company, omie_codigo_cliente, motivo, valido_ate, aprovado_por)
  VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','oben',100,'pos-restauro',
          now() + interval '1 day', '22222222-2222-2222-2222-222222222222');
  RAISE EXCEPTION 'RLS_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VENDEDOR_BARRADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *VENDEDOR_BARRADO*) ok "F5 policy restaurada volta a barrar o vendedor" ;; *) bad "F5 — veio: $R" ;; esac

# F6: SABOTA voltando a função à versão PRÉ-FIX (re-aplica só a migration antiga,
# cujo match de exceção ignora o par) → A11b tem de VAZAR (bloqueado=False)
P -q -f "$MIG"
F6=$(Pq -c "SELECT public.venda_gate_credito('colacor', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')
if [ "$F6" = "False" ]; then
  ok "F6 função pré-fix deixa a exceção vazar entre pares → A11b tem dente"
else
  bad "F6 re-apliquei a função ANTIGA e A11b ainda bloqueia → A11b não prova o fix"
fi

# F7: restaura o fix (migration nova) → A11b volta a bloquear
P -q -f "$MIG2"
F7=$(Pq -c "SELECT public.venda_gate_credito('colacor', 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bloqueado"])')
eq "F7 fix restaurado volta a segurar o par" "$F7" "True"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
