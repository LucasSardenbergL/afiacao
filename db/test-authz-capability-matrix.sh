#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — E2/FU4: matriz de capability por recurso × ação                   ║
# ║      bash db/test-authz-capability-matrix.sh > /tmp/t.log 2>&1; echo exit=$?      ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20260718190000_authz_capability_matrix_e2.sql e prova     ║
# ║  o que ela existe para garantir: que `commercial_role='gerencial'` deixa de        ║
# ║  conceder ESCRITA em preço/crédito e LEITURA de custo/markup/compras — sem         ║
# ║  perder nenhuma das condições próprias das 64 policies reescritas.                 ║
# ║                                                                                    ║
# ║  RLS é provada sob `SET ROLE authenticated` + GUC de uid. Rodar como superuser     ║
# ║  passaria FALSAMENTE (o owner ignora RLS) — spec §4.5.                            ║
# ║                                                                                    ║
# ║  ZONA 5 sabota a migration de propósito e EXIGE vermelho. Assert que sobrevive à   ║
# ║  sabotagem não tem dente.                                                          ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="authzcap"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260718190000_authz_capability_matrix_e2.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

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

MASTER="10000000-0000-0000-0000-000000000001"
GERENCIAL="20000000-0000-0000-0000-000000000002"
ESTRATEG="30000000-0000-0000-0000-000000000003"
VENDEDOR="40000000-0000-0000-0000-000000000004"
OUTRO_VEND="50000000-0000-0000-0000-000000000005"
CLIENTE="60000000-0000-0000-0000-000000000006"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que a migration lê/altera mas não cria
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 1: pré-requisitos ──"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA storage TO authenticated, service_role;
-- O Supabase real concede USAGE em `auth` para authenticated/anon. Sem isto o harness fica MENOS
-- permissivo que prod e mascara asserts: as policies continuam funcionando (guardam a expressão
-- por OID, não precisam de USAGE — lição do #1427), mas qualquer chamada direta a auth.uid()
-- num assert falharia com "permission denied for schema auth" e leríamos como negação de gate.
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;

CREATE TYPE public.app_role        AS ENUM ('customer','employee','master','admin');
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, role public.app_role NOT NULL
);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL,
  assigned_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

-- has_role: cópia verbatim de prod (pg_get_functiondef, 2026-07-18)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- carteira (para carteira_visivel_para, que as policies de SELECT preservam)
CREATE TABLE public.carteira_assignments (
  customer_user_id uuid NOT NULL, owner_user_id uuid NOT NULL, eligible boolean DEFAULT true
);
CREATE TABLE public.carteira_coverage (
  covered_user_id uuid, covering_user_id uuid, active boolean DEFAULT true,
  valid_from timestamptz DEFAULT now() - interval '1 day', valid_until timestamptz
);
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT _uid IS NOT NULL AND (
    COALESCE(public.has_role(_uid,'master'::public.app_role), false)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
                WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid AND a.eligible IS TRUE)
  );
$f$;
GRANT EXECUTE ON FUNCTION private.carteira_visivel_para(uuid,uuid) TO authenticated, service_role;

-- O gate ANTIGO precisa existir: a assertion A1 da migration procura resíduo dele.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
                       AND cr.commercial_role IN ('gerencial','estrategico','super_admin')));
$f$;
GRANT EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO authenticated, service_role;

-- ── as 34 tabelas gateadas (só as colunas que as policies tocam) ──
CREATE TABLE public.cliente_tier_preco    (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, customer_user_id uuid, tier text);
CREATE TABLE public.venda_excecao_credito (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), aprovado_por uuid, motivo text);
CREATE TABLE public.cmc_ledger            (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, cmc numeric);
CREATE TABLE public.markup_policy         (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, piso_markup numeric);

CREATE TABLE public.reposicao_cold_start_log             (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_depara_auto_log            (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_motor_run                  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_param_auto_log             (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_param_auto_run             (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_param_pin                  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_pedidos_compra_run         (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);
CREATE TABLE public.reposicao_po_last_seen               (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nota text);

CREATE TABLE public.farmer_client_scores          (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid, score numeric);
CREATE TABLE public.customer_visit_scores         (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid, score numeric);
CREATE TABLE public.farmer_recommendations        (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid);
CREATE TABLE public.farmer_calls                  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid);
CREATE TABLE public.farmer_bundle_recommendations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid);
CREATE TABLE public.farmer_copilot_sessions       (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid);
CREATE TABLE public.route_visits                  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visited_by uuid, customer_user_id uuid);
CREATE TABLE public.visitas_agendadas             (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scheduled_by uuid);

CREATE TABLE public.tarefas                      (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assigned_to uuid, created_by uuid, titulo text);
CREATE TABLE public.tarefa_eventos               (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tarefa_id uuid, tipo text);
CREATE TABLE public.tarefa_satisfacao_candidatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tarefa_id uuid, nota int);
CREATE TABLE public.tarefa_templates             (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assigned_to uuid, created_by uuid, nome text);

CREATE TABLE public.radar_empresas     (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text);
CREATE TABLE public.radar_contatos     (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TABLE public.radar_municipios   (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TABLE public.radar_ingest_state (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), estado text);

CREATE TABLE public.customer_canonical_alias      (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alias text);
CREATE TABLE public.omie_clientes_nao_vinculados  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TABLE public.omie_nao_vinculados_state     (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), estado text);
CREATE TABLE public.selfservice_cliente_allowlist (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid);

-- storage.objects + storage.foldername (a policy de comprovante de tarefa)
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
CREATE OR REPLACE FUNCTION storage.foldername(_name text) RETURNS text[]
 LANGUAGE sql IMMUTABLE AS $f$ SELECT string_to_array(_name, '/') $f$;

-- ── dependências das 2 RPCs SECDEF de custo ──
CREATE TABLE public.inventory_position (omie_codigo_produto text, account text, saldo numeric, cmc numeric, synced_at timestamptz DEFAULT now());
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, customer_user_id uuid,
  deleted_at timestamptz, status text, omie_numero_pedido text, order_date_kpi date, created_at timestamptz DEFAULT now());
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, omie_codigo_produto text, unit_price numeric, quantity numeric);
CREATE TABLE public.omie_products (omie_codigo_produto text, account text, familia text);
CREATE OR REPLACE FUNCTION public.resolve_markup_policy(_company text, _sku text, _familia text, _tier text)
 RETURNS TABLE(piso_markup numeric) LANGUAGE sql STABLE AS $f$ SELECT 30::numeric $f$;

-- get_preco_cockpit / get_defasagem_cliente — stubs com a MESMA ESTRUTURA DE GATE de prod:
-- um gate de staff que barra não-employee, e a variável `v_pode_num` (do gate universal) que
-- decide se os NÚMEROS de custo saem preenchidos ou NULL. A migration reescreve estas duas
-- programaticamente via pg_get_functiondef + replace, então o stub precisa conter a string
-- exata `v_pode_num := pode_ver_carteira_completa(auth.uid());` — é ela que é substituída.
CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pode_num boolean; v_cmc numeric;
BEGIN
  IF NOT (auth.uid() IS NOT NULL AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());
  SELECT l.cmc INTO v_cmc FROM public.cmc_ledger l LIMIT 1;
  RETURN jsonb_build_array(jsonb_build_object(
    'faixa', 'verde',
    'cmc', CASE WHEN v_pode_num THEN to_jsonb(v_cmc) ELSE 'null'::jsonb END));
END; $function$;

CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_pode_num boolean; v_cmc numeric;
BEGIN
  IF NOT (auth.uid() IS NOT NULL AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());
  SELECT l.cmc INTO v_cmc FROM public.cmc_ledger l LIMIT 1;
  RETURN jsonb_build_array(jsonb_build_object(
    'motivo', 'ok',
    'c_now', CASE WHEN v_pode_num THEN to_jsonb(v_cmc) ELSE 'null'::jsonb END));
END; $function$;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb, uuid) TO authenticated;

-- RLS ligada em tudo que a migration gateia (senão as policies são decorativas)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cliente_tier_preco','venda_excecao_credito','cmc_ledger','markup_policy',
    'reposicao_cold_start_log','reposicao_depara_auto_log','reposicao_estoque_nao_confirmado_log',
    'reposicao_motor_run','reposicao_param_auto_log','reposicao_param_auto_run','reposicao_param_pin',
    'reposicao_pedidos_compra_run','reposicao_po_last_seen',
    'farmer_client_scores','customer_visit_scores','farmer_recommendations','farmer_calls',
    'farmer_bundle_recommendations','farmer_copilot_sessions','route_visits','visitas_agendadas',
    'tarefas','tarefa_eventos','tarefa_satisfacao_candidatos','tarefa_templates',
    'radar_empresas','radar_contatos','radar_municipios','radar_ingest_state',
    'customer_canonical_alias','omie_clientes_nao_vinculados','omie_nao_vinculados_state',
    'selfservice_cliente_allowlist']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON storage.objects TO authenticated;

-- As policies ANTIGAS (com o gate único) — a migration faz DROP+CREATE por cima delas.
-- Sem isto o teste provaria só o estado final, não a TRANSIÇÃO.
CREATE POLICY cliente_tier_preco_insert_gestor ON public.cliente_tier_preco FOR INSERT
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
CREATE POLICY cliente_tier_preco_update_gestor ON public.cliente_tier_preco FOR UPDATE
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
CREATE POLICY venda_excecao_insert_gestor ON public.venda_excecao_credito FOR INSERT
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) AND aprovado_por = (SELECT auth.uid()));
CREATE POLICY cmc_ledger_select_gestor ON public.cmc_ledger FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa(auth.uid()));
CREATE POLICY markup_policy_select_carteira ON public.markup_policy FOR SELECT
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
CREATE POLICY reposicao_motor_run_sel ON public.reposicao_motor_run FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));
CREATE POLICY fcs_insert_own_or_gestor ON public.farmer_client_scores FOR INSERT
  WITH CHECK ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) OR farmer_id = (SELECT auth.uid()));
SQL
echo "  pré-requisitos criados"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 2: aplicar migration real ──"
# A precondição da migration ABORTA se houver papel gerencial vivo. Isso é o comportamento
# desejado em prod — aqui aplicamos com o banco limpo e semeamos os papéis DEPOIS.
P -q -f "$MIG"
echo "  migration aplicada: $(basename "$MIG")"

# IDEMPOTÊNCIA (achado da rodada 2 da revisão adversária): o dono cola a migration à mão; uma
# queda de rede no meio não pode travar a 2ª tentativa. Re-aplicar com o banco LIMPO tem de
# passar — inclusive o bloco que reescreve as RPCs, cujo padrão de busca já não existe.
if P -q -f "$MIG" >/dev/null 2>&1; then
  ok "P0a migration é IDEMPOTENTE (2ª aplicação passa)"
else
  bad "P0a re-aplicar a migration falhou — não é idempotente"
fi
# ...e a 2ª aplicação não pode ter desfeito o gate novo nas RPCs.
eq "P0b RPC segue com o gate novo após re-aplicar" \
   "$(Pq -c "SELECT pg_get_functiondef('public.get_preco_cockpit(jsonb)'::regprocedure) ~ 'private\.cap_custo_ler' ;")" "t"

# Prova que a precondição de papel gerencial tem dente: re-aplicar COM um gerencial vivo falha.
P -q -c "INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES ('$GERENCIAL','gerencial');"
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "P0 precondição: migration re-aplicou COM papel gerencial vivo (deveria abortar)"
else
  ok "P0 precondição aborta se há papel gerencial vivo"
fi

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 3: seeds ──"
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'), ('$GERENCIAL','employee'), ('$ESTRATEG','employee'),
  ('$VENDEDOR','employee'), ('$OUTRO_VEND','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$ESTRATEG','estrategico'), ('$VENDEDOR','farmer'), ('$OUTRO_VEND','farmer')
  ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.cmc_ledger(sku,cmc) VALUES ('SKU-1', 42.50);
INSERT INTO public.markup_policy(company,piso_markup) VALUES ('oben', 30);
INSERT INTO public.reposicao_motor_run(nota) VALUES ('run-1');
INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','A');

-- carteira: CLIENTE pertence a VENDEDOR
INSERT INTO public.carteira_assignments(customer_user_id,owner_user_id,eligible) VALUES ('$CLIENTE','$VENDEDOR',true);
-- score do VENDEDOR e score de OUTRO_VEND (para provar o escopo próprio)
INSERT INTO public.farmer_client_scores(farmer_id,customer_user_id,score) VALUES
  ('$VENDEDOR','$CLIENTE', 10), ('$OUTRO_VEND','$CLIENTE', 20);
-- recomendação autorada por OUTRO_VEND para um cliente que NÃO é da carteira dele: só a
-- cláusula farmer_id=uid desta policy o deixa ver (contraste com farmer_client_scores).
INSERT INTO public.farmer_recommendations(farmer_id,customer_user_id) VALUES ('$OUTRO_VEND','$CLIENTE');
SQL
echo "  seeds inseridos"

# helper: roda SQL como `authenticated` com um uid.
# ⚠️ `SET` e NÃO `SET LOCAL`: cada invocação do psql é uma sessão nova em autocommit, onde
# `SET LOCAL` não tem efeito (só avisa) — e sem o SET ROLE o assert rodaria como `postgres`,
# que BYPASSA RLS e pintaria tudo de verde falsamente (spec §4.5). `-q` tira as tags "SET"
# da saída capturada. O uid vai antes do ROLE porque depois só se volta com RESET ROLE.
as_user() { # $1=uid  $2=sql
  P -tA -q <<SQL
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
}
# helper: conta linhas visíveis
vis() { as_user "$1" "SELECT count(*) FROM $2;"; }
# helper: tenta escrever; ecoa OK ou DENIED (RLS nega INSERT com "violates row-level security")
try_write() { # $1=uid $2=sql
  local out
  if out=$(P -tA -q <<SQL 2>&1
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
  ); then echo "OK"; else
    case "$out" in
      *"row-level security"*|*"violates row-level"*|*42501*|*"permission denied"*) echo "DENIED" ;;
      *) echo "ERRO_INESPERADO: $out" ;;
    esac
  fi
}
# sanidade do próprio harness: se o SET ROLE não pegar, TODO assert de RLS é teatro.
GUARD=$(as_user "$MASTER" "SELECT current_user;")
[ "$GUARD" = "authenticated" ] || { echo "❌ HARNESS INVÁLIDO: SET ROLE não pegou (current_user=$GUARD) — asserts de RLS seriam falso-verde"; exit 1; }
echo "  guard: asserts rodam como '$GUARD' (não superuser) ✅"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (RLS real: SET ROLE authenticated + GUC)
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 4a: o furo que a E2 fecha (gerencial PERDE money-path) ──"

eq "N1 gerencial NÃO escreve preço (cliente_tier_preco INSERT)" \
   "$(try_write "$GERENCIAL" "INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','B');")" "DENIED"

eq "N2 gerencial NÃO altera preço (cliente_tier_preco UPDATE)" \
   "$(as_user "$GERENCIAL" "UPDATE public.cliente_tier_preco SET tier='C'; SELECT count(*) FROM public.cliente_tier_preco WHERE tier='C';")" "0"

eq "N3 gerencial NÃO aprova crédito (venda_excecao_credito INSERT)" \
   "$(try_write "$GERENCIAL" "INSERT INTO public.venda_excecao_credito(aprovado_por,motivo) VALUES ('$GERENCIAL','x');")" "DENIED"

eq "N4 gerencial NÃO lê custo (cmc_ledger)"      "$(vis "$GERENCIAL" public.cmc_ledger)"          "0"
eq "N5 gerencial NÃO lê markup (markup_policy)"  "$(vis "$GERENCIAL" public.markup_policy)"       "0"
eq "N6 gerencial NÃO lê compras (motor_run)"     "$(vis "$GERENCIAL" public.reposicao_motor_run)" "0"

echo ""
echo "── ZONA 4b: estratégico lê custo, mas não escreve money ──"
eq "P1 estrategico LÊ custo (cmc_ledger)"       "$(vis "$ESTRATEG" public.cmc_ledger)"     "1"
eq "P2 estrategico LÊ markup"                   "$(vis "$ESTRATEG" public.markup_policy)"  "1"
eq "N7 estrategico NÃO escreve preço" \
   "$(try_write "$ESTRATEG" "INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','B');")" "DENIED"
eq "N8 estrategico NÃO lê compras (desacoplado)" "$(vis "$ESTRATEG" public.reposicao_motor_run)" "0"

echo ""
echo "── ZONA 4c: master preserva tudo (ninguém perdeu acesso) ──"
eq "P3 master LÊ custo"     "$(vis "$MASTER" public.cmc_ledger)"          "1"
eq "P4 master LÊ markup"    "$(vis "$MASTER" public.markup_policy)"       "1"
eq "P5 master LÊ compras"   "$(vis "$MASTER" public.reposicao_motor_run)" "1"
eq "P6 master ESCREVE preço" \
   "$(try_write "$MASTER" "INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','B');")" "OK"
eq "P7 master APROVA crédito" \
   "$(try_write "$MASTER" "INSERT INTO public.venda_excecao_credito(aprovado_por,motivo) VALUES ('$MASTER','ok');")" "OK"

echo ""
echo "── ZONA 4d: condições próprias PRESERVADAS (a reescrita não perdeu cláusula) ──"
# ⚠️ As duas famílias de policy têm cláusulas próprias DIFERENTES, e a reescrita tinha que
# preservar cada uma como era. Provamos as duas para pegar cópia-e-cola entre elas:
#   · farmer_client_scores  SELECT = gate OR carteira_visivel_para          (por CARTEIRA)
#   · farmer_recommendations SELECT = gate OR farmer_id=uid OR carteira…    (por CARTEIRA **ou** AUTORIA)
eq "C1 vendedor vê os scores dos clientes DA CARTEIRA dele" "$(vis "$VENDEDOR" public.farmer_client_scores)" "2"
eq "C2 outro_vend NÃO vê score (não é dono da carteira; esta tabela não abre por autoria)" \
   "$(vis "$OUTRO_VEND" public.farmer_client_scores)" "0"
eq "C2b mas em farmer_recommendations ele VÊ a própria (cláusula farmer_id preservada)" \
   "$(vis "$OUTRO_VEND" public.farmer_recommendations)" "1"
eq "C3 gerencial vê TODOS os scores (cap_carteira_ler mantida)" "$(vis "$GERENCIAL" public.farmer_client_scores)" "2"
eq "C4 vendedor ESCREVE o próprio score" \
   "$(try_write "$VENDEDOR" "INSERT INTO public.farmer_client_scores(farmer_id,customer_user_id,score) VALUES ('$VENDEDOR','$CLIENTE',5);")" "OK"
eq "C5 vendedor NÃO escreve score de OUTRO vendedor" \
   "$(try_write "$VENDEDOR" "INSERT INTO public.farmer_client_scores(farmer_id,customer_user_id,score) VALUES ('$OUTRO_VEND','$CLIENTE',5);")" "DENIED"
eq "C6 gerencial ainda lê radar (capability operacional mantida)" \
   "$(as_user "$GERENCIAL" "SELECT CASE WHEN has_table_privilege('radar_empresas','SELECT') THEN 'OK' END;")" "OK"

echo ""
echo "── ZONA 4e: capabilities e contrato ──"
eq "V1 authz_contract_version = 2" "$(Pq -c 'SELECT public.authz_contract_version();')" "2"
eq "V2 6 capabilities em private"  "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname LIKE 'cap\\_%';")" "6"
eq "V3 zero resíduo do gate único nas tabelas tratadas" \
   "$(Pq -c "SELECT count(*) FROM pg_policies WHERE (COALESCE(qual,'')||COALESCE(with_check,'')) ILIKE '%pode_ver_carteira_completa%';")" "0"
eq "V4 anon SEM execute em cap_custo_ler" \
   "$(Pq -c "SELECT has_function_privilege('anon','private.cap_custo_ler(uuid)','EXECUTE');")" "f"
eq "V5 authenticated COM execute em cap_carteira_ler" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','private.cap_carteira_ler(uuid)','EXECUTE');")" "t"
eq "V6 uid inexistente não recebe capability (fail-closed)" \
   "$(Pq -c "SELECT private.cap_custo_ler('99999999-9999-9999-9999-999999999999');")" "f"
eq "V7 uid NULL não recebe capability" \
   "$(Pq -c "SELECT COALESCE(private.cap_preco_escrever(NULL), false);")" "f"

echo ""
echo "── ZONA 4f: as 2 RPCs SECDEF de custo executam (bug late-bound) ──"
# Lei #1: plpgsql só falha ao EXECUTAR. Chamamos de verdade, como master.
RPC1=$(as_user "$MASTER" "SELECT skus_total FROM public.fin_estimar_estoque_omie('oben');" 2>&1 || echo "ERRO")
eq "R1 fin_estimar_estoque_omie EXECUTA (master)" "$RPC1" "0"
RPC2=$(as_user "$MASTER" "SELECT count(*) FROM public.medir_abaixo_piso_tier(90);" 2>&1 || echo "ERRO")
eq "R2 medir_abaixo_piso_tier EXECUTA (master)" "$RPC2" "0"
# negativo com SQLSTATE esperada + re-raise (Lei #2)
# ⚠️ `SET` e não `SET LOCAL` (mesma armadilha dos helpers, apanhada pelo Codex): fora de
# transação explícita o `SET LOCAL` não pega, e o assert negaria por uid NULO em vez de negar
# por capability — falso-verde que parece verde-bom.
# O guard abaixo mede o contexto pelo helper já validado (um SELECT), em vez de grepar um
# RAISE NOTICE: mensagem emitida antes de uma exceção capturada não sobrevive à captura.
R3G=$(P -tA -q <<SQL 2>&1 || true
SET test.uid = '$GERENCIAL';
SET ROLE authenticated;
SELECT current_user::text||'|'||COALESCE(auth.uid()::text,'NULL');
SQL
)
eq "R3-guard o assert roda como authenticated + uid do gerencial" "$R3G" "authenticated|$GERENCIAL"

R3=$(P -tA <<SQL 2>&1 || true
SET test.uid = '$GERENCIAL';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM * FROM public.medir_abaixo_piso_tier(90);
  RAISE NOTICE 'SENTINELA_PASSOU_INDEVIDO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_NEGOU_CERTO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R3" in
  *SENTINELA_NEGOU_CERTO*) ok "R3 medir_abaixo_piso_tier NEGA gerencial com 42501" ;;
  *SENTINELA_PASSOU_INDEVIDO*) bad "R3 gerencial executou a RPC de custo (furo aberto)" ;;
  *) bad "R3 erro inesperado: $R3" ;;
esac

# R4..R7 — as outras duas RPCs de custo. Este é o achado BLOQUEADOR da revisão adversária:
# elas não negam com RAISE — elas devolvem os números de custo NULOS ou preenchidos conforme
# `v_pode_num`. Um teste que só checasse "executa sem erro" passaria com o furo aberto.
CMC_COCKPIT() { as_user "$1" "SELECT COALESCE(public.get_preco_cockpit('[{}]'::jsonb) -> 0 ->> 'cmc', 'NULO');"; }
CMC_DEFASAG() { as_user "$1" "SELECT COALESCE(public.get_defasagem_cliente('[{}]'::jsonb, '$CLIENTE') -> 0 ->> 'c_now', 'NULO');"; }

eq "R4 get_preco_cockpit NÃO devolve cmc ao gerencial"        "$(CMC_COCKPIT "$GERENCIAL")" "NULO"
eq "R5 get_preco_cockpit devolve cmc ao master (não regrediu)" "$(CMC_COCKPIT "$MASTER")"    "42.50"
eq "R6 get_defasagem_cliente NÃO devolve custo ao gerencial"   "$(CMC_DEFASAG "$GERENCIAL")" "NULO"
eq "R7 get_defasagem_cliente devolve custo ao estrategico"     "$(CMC_DEFASAG "$ESTRATEG")"  "42.50"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota e EXIGE vermelho
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 5: falsificação (sabotar → exigir vermelho) ──"

# F1 — cap_preco_escrever passa a aceitar gerencial. N1 deve QUEBRAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_preco_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.pode_ver_carteira_completa(_uid), false) $f$;  -- SABOTADO
SQL
if [ "$(try_write "$GERENCIAL" "INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','Z');")" = "OK" ]; then
  ok "F1 sabotagem de cap_preco_escrever REABRIU o furo → N1 tem dente"
else
  bad "F1 sabotei cap_preco_escrever e N1 seguiu negando — assert FRACO"
fi
# Restaura CIRURGICAMENTE (só a função sabotada). Re-aplicar a migration inteira aqui NÃO
# funcionaria: a precondição dela aborta de propósito porque já semeamos um papel gerencial.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_preco_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
SQL
eq "F1r restaurado: gerencial volta a ser negado" \
   "$(try_write "$GERENCIAL" "INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier) VALUES ('oben','$CLIENTE','Z');")" "DENIED"

# F2 — cap_custo_ler passa a aceitar gerencial. N4 deve QUEBRAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.pode_ver_carteira_completa(_uid), false) $f$;  -- SABOTADO
SQL
if [ "$(vis "$GERENCIAL" public.cmc_ledger)" = "1" ]; then
  ok "F2 sabotagem de cap_custo_ler VAZOU custo p/ gerencial → N4 tem dente"
else
  bad "F2 sabotei cap_custo_ler e N4 seguiu negando — assert FRACO"
fi
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid,'master'::public.app_role)
    OR (public.has_role(_uid,'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
                     AND cr.commercial_role IN ('estrategico','super_admin')))), false);
$f$;
SQL
eq "F2r restaurado: gerencial volta a não ver custo" "$(vis "$GERENCIAL" public.cmc_ledger)" "0"

# F5 — a MESMA sabotagem tem de vazar também pela RPC (o caminho que não passa por policy).
# Se F2 fica vermelho e F5 verde, é sinal de que a RPC não está usando a capability de verdade.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.pode_ver_carteira_completa(_uid), false) $f$;  -- SABOTADO
SQL
if [ "$(CMC_COCKPIT "$GERENCIAL")" = "42.50" ]; then
  ok "F5 sabotagem de cap_custo_ler VAZOU cmc pela RPC → R4 tem dente"
else
  bad "F5 sabotei cap_custo_ler e a RPC seguiu negando — R4 é FRACO (a RPC não usa a capability)"
fi
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid,'master'::public.app_role)
    OR (public.has_role(_uid,'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
                     AND cr.commercial_role IN ('estrategico','super_admin')))), false);
$f$;
SQL
eq "F5r restaurado: RPC volta a negar cmc ao gerencial" "$(CMC_COCKPIT "$GERENCIAL")" "NULO"

# F6 — a armadilha do `FOR ALL`: em PG, DELETE consulta só o USING. Apertando a capability de
# ESCRITA para master-only, o gerencial tem de perder o DELETE. Com o desenho antigo
# (USING = cap_carteira_ler), ele continuaria apagando pela cláusula de LEITURA.
P -q -c "INSERT INTO public.selfservice_cliente_allowlist(customer_user_id) VALUES ('$CLIENTE');"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
SQL
APAGOU=$(as_user "$GERENCIAL" "DELETE FROM public.selfservice_cliente_allowlist; SELECT count(*) FROM public.selfservice_cliente_allowlist;")
eq "F6 escrita apertada ⇒ gerencial NÃO apaga allowlist (DELETE usa cap_carteira_escrever)" "$APAGOU" "1"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid,'master'::public.app_role)
    OR (public.has_role(_uid,'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
                     AND cr.commercial_role IN ('gerencial','estrategico','super_admin')))), false);
$f$;
SQL
eq "F6r restaurado: gerencial volta a poder apagar" \
   "$(as_user "$GERENCIAL" "DELETE FROM public.selfservice_cliente_allowlist; SELECT count(*) FROM public.selfservice_cliente_allowlist;")" "0"

# F3 — remove a condição própria do SELECT de scores. C1/C2 devem QUEBRAR.
P -q <<'SQL'
DROP POLICY IF EXISTS fcs_select_carteira ON public.farmer_client_scores;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));  -- SABOTADO: perdeu carteira_visivel_para
SQL
if [ "$(vis "$VENDEDOR" public.farmer_client_scores)" = "0" ]; then
  ok "F3 remover a condição própria CEGOU o vendedor → C1 tem dente"
else
  bad "F3 sabotei a policy e C1 seguiu verde — assert FRACO"
fi
P -q <<'SQL'
DROP POLICY IF EXISTS fcs_select_carteira ON public.farmer_client_scores;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid())))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));
SQL
eq "F3r restaurado: vendedor volta a ver a carteira dele" "$(vis "$VENDEDOR" public.farmer_client_scores)" "3"

# F4 — versão do contrato regride. V1 deve QUEBRAR (o frontend cairia fail-closed).
P -q -c "CREATE OR REPLACE FUNCTION public.authz_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE AS \$f\$ SELECT 1 \$f\$;"
if [ "$(Pq -c 'SELECT public.authz_contract_version();')" = "1" ]; then
  ok "F4 versão regredida é observável → V1 tem dente (frontend cai fail-closed)"
else
  bad "F4 sabotei a versão e V1 não mudou — assert FRACO"
fi
P -q -c "CREATE OR REPLACE FUNCTION public.authz_contract_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO '' AS \$f\$ SELECT 2 \$f\$;"
eq "F4r restaurado: contrato volta a v2" "$(Pq -c 'SELECT public.authz_contract_version();')" "2"

# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
