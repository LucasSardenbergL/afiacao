#!/usr/bin/env bash
# Prova PG17 do DEMONSTRATIVO DE CONTRIBUIÇÃO (venda por cliente, rodada 2, entrega 3) — migration
# 20261113130000_venda_contribuicao_cliente: `private.venda_contribuicao_linhas` (o motor) e
# `public.venda_contribuicao` (a porta, só master). Registro: docs/historico/venda-contribuicao-cliente.md.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  AGATE      master lê; employee COM papel estratégico (cap_custo_ler = true) → 42501; farmer, cliente e
#              sem sessão → 42501
#  AACL       anon não executa a porta; authenticated não executa o motor (catálogo)
#  APARAM     janela, limite e ordem inválidos → 22023
#  ACARD      uma linha por order_items.id (inclusive 2 linhas do mesmo SKU no mesmo pedido e item sem piso)
#  ADESC      receita líquida = bruto − desconto da linha
#  ANAOAPUR   desconto NULL ⇒ receita NULL e contribuição NULL (nunca a receita cheia)
#  AINVALIDO  desconto maior que o bruto ⇒ 'invalido', receita NULL
#  ACUSTODATA CMC da posição anterior ≤ dia do pedido (nem a posição futura, nem o custo atual)
#  ACUSTOVELHO posição com 45+ dias ⇒ custo atual MARCADO
#  ASEMCUSTO  sem custo ⇒ custo e contribuição NULL (nunca 0)
#  APRAZO     S = Σ vᵢ(1+r)^(−dᵢ/365)/Σvᵢ com pesos por VALOR; custo do prazo e prazo médio
#  ATAXA      colacor sem configuração ⇒ 'taxa_ausente' (prazo médio conhecido, custo NULL); paridade da taxa
#              do motor com public.fin_regua_custo_capital
#  AAMBIG     título que casa com 2 pedidos ⇒ 'ambiguo', MESMO com o outro pedido fora da janela pedida
#  AVALOR     Σ títulos ≠ total ⇒ 'valor_nao_bate'
#  ACLIENTE   título de outro cliente Omie ⇒ 'cliente_nao_confere'
#  ASEMTIT    pedido sem número ⇒ 'sem_titulo'
#  APISO      abaixo do piso pelo preço LÍQUIDO; gap = piso×qtd − receita; item sem política: piso NULL
#  AJANELA    12m = 365 datas e 90d = 90 datas, inclusivas
#  ACANON     o alias ativo soma no comprador canônico
#  APONTE     receita − custo − prazo da INTERSEÇÃO = contribuição; total = Σ das linhas
#  ANULL      linha de eixo sem nenhuma linha computável ⇒ contribuição JSON null
#  APAGINA    páginas cobrem o eixo inteiro, sem repetição, na ordem estável
#  AORDEM     desconto_desc põe o maior desconto primeiro
#  AVENDEDOR  eixo vendedor responde indisponível
#  AVALIDA    a query de validação pós-apply (db/valida-venda-contribuicao.sql) dá 6 ✅ contra a migration real
#
#   bash db/test-venda-contribuicao.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-contribuicao.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-contribuicao.sh             # tem de ficar VERMELHA
#   bash db/test-venda-contribuicao.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261113130000_venda_contribuicao_cliente.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca.
  SABOTAGENS="gate_so_cap:AGATE desconto_ignorado:ADESC desconto_null_zero:ANAOAPUR custo_zero:ASEMCUSTO snapshot_futuro:ACUSTODATA sem_idade:ACUSTOVELHO peso_igual:APRAZO tolerancia_off:AVALOR exclusividade_na_janela:AAMBIG cliente_off:ACLIENTE piso_inner_join:ACARD piso_bruto:APISO janela_errada:AJANELA alias_ignorado:ACANON acl_aberta:POST!POS_3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-contribuicao.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-contribuicao" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "FALHA $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "FALHA $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "OK $s: vermelha em [$marca]"
    else
      echo "FALHA $s: vermelha, mas NAO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5647}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-contribuicao.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  gate_so_cap)        sabotar "  IF NOT public.has_role((SELECT auth.uid()), 'master'::public.app_role) THEN" \
                              "  IF false THEN" ;;
  desconto_ignorado)  sabotar "CASE WHEN c.ds = 'apurado' THEN c.rb - c.dv END" "CASE WHEN c.ds = 'apurado' THEN c.rb END" ;;
  desconto_null_zero) sabotar "oi.desconto_valor                                             AS dv" \
                              "COALESCE(oi.desconto_valor, 0)                                AS dv" ;;
  custo_zero)         sabotar "COALESCE(c.cmc_data, c.custo_atual)                              AS cu" \
                              "COALESCE(c.cmc_data, c.custo_atual, 0)                           AS cu" ;;
  snapshot_futuro)    sabotar "           AND s.data_posicao <= v.data_pedido" "           AND true" ;;
  sem_idade)          sabotar "           AND s.data_posicao >  v.data_pedido - 45" "           AND true" ;;
  peso_igual)         sabotar "sum(t.v * power(1 + tx.r, -t.d / 365.0)) / nullif(sum(t.v), 0)" "avg(power(1 + tx.r, -t.d / 365.0))" ;;
  tolerancia_off)     sabotar "OR abs(sum(t.v) - p.total_pedido) > greatest(1, 0.005 * p.total_pedido)" "OR false" ;;
  exclusividade_na_janela) sabotar "AND EXISTS (SELECT 1 FROM pedido p
                    WHERE p.empresa = so.account AND p.np = btrim(so.omie_numero_pedido))" \
                              "AND so.id IN (SELECT p.sales_order_id FROM pedido p)" ;;
  cliente_off)        sabotar "WHEN bool_or(NOT t.cliente_ok)" "WHEN false" ;;
  piso_inner_join)    sabotar "LEFT JOIN LATERAL public.resolve_markup_policy" "JOIN LATERAL public.resolve_markup_policy" ;;
  piso_bruto)         sabotar "THEN l.rl / l.qtd < l.cu * (1 + l.piso / 100) END" "THEN l.preco < l.cu * (1 + l.piso / 100) END" ;;
  janela_errada)      sabotar "CASE p_janela WHEN '12m' THEN 364 ELSE 89 END" "CASE p_janela WHEN '12m' THEN 365 ELSE 90 END" ;;
  alias_ignorado)     sabotar "COALESCE(a.canonical_user_id, so.customer_user_id)            AS comprador_id" \
                              "so.customer_user_id                                           AS comprador_id" ;;
  acl_aberta)         sabotar "REVOKE ALL ON FUNCTION public.venda_contribuicao(text, text, text, text, integer, integer) FROM anon;" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { # $1 = uid ('' = sem sessão: JWT sem sub), $2 = SQL — executa como authenticated com o sub do JWT
  if [ -z "$1" ]; then printf "SET ROLE authenticated; SET request.jwt.claims = '{}'; %s" "$2"; return; fi
  printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\":\"%s\"}'; %s" "$1" "$2"
}

M=00000000-0000-0000-0000-0000000000ee   # master (founder)
E=00000000-0000-0000-0000-0000000000e5   # employee com papel ESTRATÉGICO: cap_custo_ler = true, não é master
V=00000000-0000-0000-0000-0000000000f1   # farmer
C=00000000-0000-0000-0000-0000000000c9   # cliente
K1=00000000-0000-0000-0000-0000000000a1; K1A=00000000-0000-0000-0000-0000000000a2   # K1A = alias fiscal de K1
K2=00000000-0000-0000-0000-0000000000b1; K3=00000000-0000-0000-0000-0000000000b3

# ── Esquema mínimo com as MESMAS colunas de prod (psql-ro, 2026-11-12) ──────────────────────────────────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: função nova em public NASCE aberta (database.md §4).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- Corpo do auth.uid() do Supabase (lê request.jwt.claim.sub OU o sub de request.jwt.claims).
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                  (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL UNIQUE, commercial_role text NOT NULL);
-- private.cap_custo_ler: corpo de PROD (pg_get_functiondef, 2026-11-12).
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$function\$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('estrategico','super_admin')
        )
      )
    ), false);
\$function\$;
REVOKE ALL ON FUNCTION private.cap_custo_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_custo_ler(uuid) TO authenticated, service_role;
CREATE TABLE public.profiles (user_id uuid, name text, razao_social text);

CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, status text,
  deleted_at timestamptz, account text, omie_numero_pedido text, total numeric, order_date_kpi date,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, customer_user_id uuid,
  omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric);
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive');
CREATE TABLE public.cmc_snapshot (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text NOT NULL,
  omie_codigo_produto bigint NOT NULL, data_posicao date NOT NULL,
  cmc numeric NOT NULL CHECK (cmc > 0 AND cmc <> 'NaN' AND cmc < 'Infinity' AND cmc <= 10000000),
  UNIQUE (account, omie_codigo_produto, data_posicao));
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint,
  account text, familia text, descricao text, UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.product_costs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid UNIQUE,
  cost_price numeric, cost_final numeric);
CREATE TABLE public.cliente_tier_preco (company text, customer_user_id uuid, tier text, PRIMARY KEY (company, customer_user_id));
CREATE TABLE public.markup_policy (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, escopo text, familia text,
  sku_codigo bigint, piso_markup numeric, meta_markup numeric, tier text);
-- resolve_markup_policy: corpo de PROD (pg_get_functiondef, 2026-11-12).
CREATE OR REPLACE FUNCTION public.resolve_markup_policy(p_empresa text, p_codigo bigint, p_familia text, p_tier text DEFAULT NULL::text)
 RETURNS TABLE(piso_markup numeric, meta_markup numeric) LANGUAGE sql STABLE SET search_path TO 'public'
AS \$function\$
  WITH produto AS (
    SELECT mp.piso_markup, mp.meta_markup FROM public.markup_policy mp
    WHERE mp.account = lower(p_empresa) AND mp.tier IS NULL
      AND ((mp.escopo='sku' AND mp.sku_codigo=p_codigo) OR (mp.escopo='familia' AND p_familia IS NOT NULL AND mp.familia=p_familia) OR (mp.escopo='conta'))
    ORDER BY CASE mp.escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END LIMIT 1
  ),
  por_tier AS (
    SELECT mp.piso_markup, mp.meta_markup FROM public.markup_policy mp
    WHERE mp.account = lower(p_empresa) AND p_tier IS NOT NULL AND mp.tier=p_tier
      AND ((mp.escopo='sku' AND mp.sku_codigo=p_codigo) OR (mp.escopo='familia' AND p_familia IS NOT NULL AND mp.familia=p_familia) OR (mp.escopo='conta'))
    ORDER BY CASE mp.escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END LIMIT 1
  )
  SELECT GREATEST((SELECT piso_markup FROM produto),(SELECT piso_markup FROM por_tier)) AS piso_markup,
         GREATEST((SELECT meta_markup FROM produto),(SELECT meta_markup FROM por_tier)) AS meta_markup
  WHERE (SELECT piso_markup FROM produto) IS NOT NULL OR (SELECT piso_markup FROM por_tier) IS NOT NULL;
\$function\$;
CREATE TABLE public.fin_contas_receber (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, numero_pedido text,
  omie_codigo_cliente bigint, data_emissao date, data_vencimento date, valor_documento numeric, status_titulo text);
CREATE TABLE public.omie_customer_account_map (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, account text,
  omie_codigo_cliente bigint, UNIQUE (user_id, account), UNIQUE (omie_codigo_cliente, account));
CREATE TABLE public.empresa_configuracao_custos (empresa text, selic_anual numeric, spread_oportunidade numeric);
-- fin_regua_custo_capital: corpo da migration 20260704190000 (a fonte canônica da taxa).
CREATE OR REPLACE FUNCTION public.fin_regua_custo_capital(p_empresa text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS \$\$
DECLARE v_selic numeric; v_spread numeric; v_r numeric;
BEGIN
  IF NOT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
       OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden: requer staff' USING ERRCODE = '42501';
  END IF;
  SELECT selic_anual, spread_oportunidade INTO v_selic, v_spread
    FROM public.empresa_configuracao_custos WHERE upper(empresa) = upper(p_empresa) LIMIT 1;
  IF v_selic IS NULL OR v_spread IS NULL THEN RETURN NULL; END IF;
  IF v_selic < 0 OR v_selic > 100 OR v_spread < 0 OR v_spread > 100 THEN RETURN NULL; END IF;
  v_r := (v_selic + v_spread) / 100.0;
  IF NOT (v_r > 0 AND v_r < 1) THEN RETURN NULL; END IF;
  RETURN v_r;
END;
\$\$;

INSERT INTO public.user_roles VALUES ('$M','master'), ('$E','employee'), ('$V','employee'), ('$C','customer');
INSERT INTO public.commercial_roles VALUES ('$E','estrategico'), ('$V','farmer');
INSERT INTO public.profiles VALUES ('$K1','Contato Um','Marcenaria Um'), ('$K2','Industria Dois',''), ('$K3','Moveis Tres',NULL);
SQL

# ── Apply (postcondição DO \$post\$ roda aqui) ────────────────────────────────────────────────────────────────
P -q -f "$MIG_USADA"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
D="$(Pq -c "SELECT '$HOJE'::date - 30")"

# ── Cenário ─────────────────────────────────────────────────────────────────────────────────────────────────
#  O1  oben K1, dia D, nº 500: I1 1001×10 a 100 com desconto 50 (CMC da data 40; atual 50; posição futura 99)
#                              I2 1002×2 a 25 (posição de 50 dias ⇒ custo atual 30; abaixo do piso)
#                              I5 1001×1 a 100 (2ª linha do MESMO SKU)
#      títulos 770 em 30d e 330 em 90d (pesos DIFERENTES), cliente Omie 9001 = o de K1
#  O2  oben K1A (alias ativo de K1), D−5, nº 501: I3 1001 com desconto NULL; I4 1003 sem custo nenhum;
#      título 200 à vista, cliente 9002 = o de K1A
#  O3  colacor K2, D, nº 500 (mesmo número do O1, OUTRA empresa): I6 2001×5 a 40; título 200 em 30d;
#      colacor sem taxa de capital e sem política de markup
#  O4/O5 oben K3, D−100 e D−39, nº 700: UM título emitido em D−40 cabe na janela dos DOIS ⇒ ambíguo
#  O6  oben K2, D, nº 800: total 300, título 250 ⇒ valor não bate
#  O7  oben K2, D−2, nº 801: título de outro cliente Omie ⇒ cliente não confere
#  O8  oben K2, HOJE−400 (fora dos 12m)        O9  oben K2 cancelado (fora do universo)
#  O10 oben K2, D−1, sem número: I10 1001×1 a 10 ⇒ sem título; abaixo do piso
#  O11 oben K2, D−3, nº 802: desconto 15 > bruto 10 ⇒ inválido
#  O12 oben K2, HOJE−364 (dentro do 12m) · O13 HOJE−365 (fora) · O14 HOJE−89 (dentro do 90d) · O15 HOJE−90 (fora)
P -q <<SQL
INSERT INTO public.customer_canonical_alias VALUES ('$K1A', '$K1', 'active');
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente) VALUES
  ('$K1','oben',9001), ('$K1A','oben',9002), ('$K2','oben',9004), ('$K2','colacor',8004), ('$K3','oben',9003);
INSERT INTO public.empresa_configuracao_custos VALUES ('OBEN', 14.75, 3.00);
INSERT INTO public.markup_policy (account, escopo, piso_markup, meta_markup, tier) VALUES ('oben','conta',30,NULL,NULL);
INSERT INTO public.omie_products (omie_codigo_produto, account, familia, descricao) VALUES
  (1001,'oben','Seladora','SELADORA X'), (1002,'oben','Verniz','VERNIZ Y'), (1003,'oben','Verniz','VERNIZ SEM CUSTO'),
  (1004,'oben','Diversos','DIVERSO'), (2001,'colacor','Tinta','TINTA Z');
INSERT INTO public.product_costs (product_id, cost_final, cost_price)
  SELECT id, CASE omie_codigo_produto WHEN 1001 THEN 50 WHEN 2001 THEN 20 WHEN 1004 THEN 10 END,
             CASE omie_codigo_produto WHEN 1002 THEN 30 END
    FROM public.omie_products WHERE omie_codigo_produto IN (1001,1002,1004,2001);
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('vendas',1001,'$D'::date - 10, 40), ('vendas',1001,'$D'::date + 5, 99), ('vendas',1002,'$D'::date - 50, 12);

CREATE TEMP TABLE ped (n text PRIMARY KEY, id uuid DEFAULT gen_random_uuid());
INSERT INTO ped (n) VALUES ('O1'),('O2'),('O3'),('O4'),('O5'),('O6'),('O7'),('O8'),('O9'),('O10'),('O11'),('O12'),('O13'),('O14'),('O15');
INSERT INTO public.sales_orders (id, customer_user_id, status, account, omie_numero_pedido, total, order_date_kpi)
SELECT p.id, v.cli::uuid, v.st, v.acc, v.np, v.tot, v.dia FROM ped p JOIN (VALUES
  ('O1','$K1','faturado','oben','500',1100,'$D'::date),
  ('O2','$K1A','importado','oben',' 501 ',200,'$D'::date - 5),
  ('O3','$K2','faturado','colacor','500',200,'$D'::date),
  ('O4','$K3','faturado','oben','700',40,'$D'::date - 100),
  ('O5','$K3','faturado','oben','700',40,'$D'::date - 39),
  ('O6','$K2','faturado','oben','800',300,'$D'::date),
  ('O7','$K2','faturado','oben','801',20,'$D'::date - 2),
  ('O8','$K2','faturado','oben','900',10,'$HOJE'::date - 400),
  ('O9','$K2','cancelado','oben','901',10,'$D'::date),
  ('O10','$K2','separacao','oben',NULL,10,'$D'::date - 1),
  ('O11','$K2','faturado','oben','802',10,'$D'::date - 3),
  ('O12','$K2','faturado','oben',NULL,10,'$HOJE'::date - 364),
  ('O13','$K2','faturado','oben',NULL,10,'$HOJE'::date - 365),
  ('O14','$K2','faturado','oben',NULL,10,'$HOJE'::date - 89),
  ('O15','$K2','faturado','oben',NULL,10,'$HOJE'::date - 90)
) v(n, cli, st, acc, np, tot, dia) ON v.n = p.n;

CREATE TEMP TABLE item (n text PRIMARY KEY, id uuid DEFAULT gen_random_uuid());
INSERT INTO item (n) VALUES ('I1'),('I2'),('I3'),('I4'),('I5'),('I6'),('I7'),('I8'),('I9'),('I10'),('I11'),('I12'),('I13'),('I14'),('I15'),('I16'),('I17');
INSERT INTO public.order_items (id, sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
SELECT i.id, p.id, v.sku, v.q, v.pr, v.dv FROM item i JOIN (VALUES
  ('I1','O1',1001,10,100,50), ('I2','O1',1002,2,25,0), ('I5','O1',1001,1,100,0),
  ('I3','O2',1001,1,100,NULL), ('I4','O2',1003,1,100,0),
  ('I6','O3',2001,5,40,0),
  ('I7','O4',1004,1,40,0), ('I8','O5',1004,1,40,0),
  ('I9','O6',1002,10,30,0),
  ('I11','O7',1004,1,20,0),
  ('I12','O8',1001,1,10,0), ('I13','O9',1001,1,10,0),
  ('I10','O10',1001,1,10,0),
  ('I14','O11',1004,1,10,15),
  ('I15','O12',1004,1,10,0), ('I16','O13',1004,1,10,0), ('I17','O14',1004,1,10,0)
) v(n, ped, sku, q, pr, dv) ON v.n = i.n JOIN ped p ON p.n = v.ped;
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
SELECT id, 1004, 1, 10, 0 FROM ped WHERE n = 'O15';

INSERT INTO public.fin_contas_receber (company, numero_pedido, omie_codigo_cliente, data_emissao, data_vencimento, valor_documento, status_titulo) VALUES
  ('oben',   '500', 9001, '$D', '$D'::date + 30, 770, 'RECEBIDO'),
  ('oben',   '500', 9001, '$D', '$D'::date + 90, 330, 'A VENCER'),
  ('oben',   '500', 9001, '$D', '$D'::date + 30, 999, 'CANCELADO'),
  ('oben',   '501', 9002, '$D'::date - 5, '$D'::date - 5, 200, 'RECEBIDO'),
  ('colacor','500', 8004, '$D', '$D'::date + 30, 200, 'A VENCER'),
  ('oben',   '700', 9003, '$D'::date - 40, '$D'::date - 10, 40, 'RECEBIDO'),
  ('oben',   '800', 9004, '$D', '$D'::date + 28, 250, 'A VENCER'),
  ('oben',   '801', 7777, '$D'::date - 2, '$D'::date + 28, 20, 'A VENCER'),
  ('oben',   '802', 9004, '$D'::date - 3, '$D'::date - 3, 10, 'RECEBIDO');
SQL

# As tabelas temporárias morreram com a sessão do heredoc: ids recuperados pelos dados.
pid() { Pq -c "SELECT so.id FROM public.sales_orders so WHERE so.order_date_kpi = $1 AND so.account = '$2' AND coalesce(btrim(so.omie_numero_pedido),'-') = '$3' LIMIT 1"; }

motor() { # $1 = "desde, ate", $2 = expressão sobre as linhas x, $3 = filtro
  Pq -c "SELECT $2 FROM private.venda_contribuicao_linhas($1) x WHERE ${3:-true}"
}
M12="'$HOJE'::date - 364, '$HOJE'::date"
rpc() { # $1 = args, $2 = expressão sobre j
  Pq -c "$(como "$M" "SELECT $2 FROM (SELECT public.venda_contribuicao($1) AS j) x;")"
}

# AGATE
eq "AGATE master le" "$(rpc "'12m','empresa'" "j->>'indisponivel'")" "false"
eq "AGATE employee estrategico (cap_custo_ler) -> 42501" "$(estado "$(como "$E" "SELECT public.venda_contribuicao();")")" "42501"
eq "AGATE farmer -> 42501" "$(estado "$(como "$V" "SELECT public.venda_contribuicao();")")" "42501"
eq "AGATE cliente -> 42501" "$(estado "$(como "$C" "SELECT public.venda_contribuicao();")")" "42501"
eq "AGATE sem sessao -> 42501" "$(estado "$(como "" "SELECT public.venda_contribuicao();")")" "42501"

# AACL (catálogo)
eq "AACL anon nao executa a porta" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.venda_contribuicao(text,text,text,text,integer,integer)', 'EXECUTE')")" "f"
eq "AACL authenticated nao executa o motor" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'private.venda_contribuicao_linhas(date,date)', 'EXECUTE')")" "f"
eq "AACL motor sem PUBLIC" \
   "$(Pq -c "SELECT has_function_privilege('public', 'private.venda_contribuicao_linhas(date,date)', 'EXECUTE')")" "f"

# APARAM
eq "APARAM janela invalida -> 22023" "$(estado "$(como "$M" "SELECT public.venda_contribuicao('6m');")")" "22023"
eq "APARAM limite 0 -> 22023" "$(estado "$(como "$M" "SELECT public.venda_contribuicao('12m','cliente',NULL,'contribuicao_asc',0,0);")")" "22023"
eq "APARAM limite 201 -> 22023" "$(estado "$(como "$M" "SELECT public.venda_contribuicao('12m','cliente',NULL,'contribuicao_asc',201,0);")")" "22023"
eq "APARAM ordem invalida -> 22023" "$(estado "$(como "$M" "SELECT public.venda_contribuicao('12m','cliente',NULL,'lucro');")")" "22023"

# ACARD — universo 12m: I1 I2 I5 I3 I4 I6 I7 I8 I9 I11 I10 I14 I15 I17 + o item do O15 = 15 (fora: O8, O9, O13)
eq "ACARD linhas = itens distintos = 15 (inclui item colacor sem politica)" \
   "$(motor "$M12" "count(*) || '/' || count(DISTINCT order_item_id)")" "15/15"
eq "ACARD duas linhas do mesmo SKU no mesmo pedido" \
   "$(motor "$M12" "count(*)" "x.omie_codigo_produto = 1001 AND x.omie_numero_pedido = '500'")" "2"

O1="'$(pid "'$D'::date" oben 500)'"
# ADESC
eq "ADESC receita liquida de I1 = 1000 - 50" \
   "$(motor "$M12" "receita_bruta || ' ' || desconto || ' ' || receita_liquida" "x.sales_order_id = $O1 AND x.quantidade = 10")" "1000 50 950"
# ANAOAPUR
eq "ANAOAPUR desconto NULL: status, receita e contribuicao NULL" \
   "$(motor "$M12" "desconto_status || ' ' || (receita_liquida IS NULL) || ' ' || (contribuicao IS NULL)" "x.omie_numero_pedido = '501' AND x.omie_codigo_produto = 1001")" "nao_apurado true true"
# AINVALIDO
eq "AINVALIDO desconto > bruto" \
   "$(motor "$M12" "desconto_status || ' ' || (receita_liquida IS NULL)" "x.omie_numero_pedido = '802'")" "invalido true"
# ACUSTODATA
eq "ACUSTODATA I1 usa a posicao D-10 (40), nao a futura (99) nem a atual (50)" \
   "$(motor "$M12" "custo_unit || ' ' || custo_fonte || ' ' || (custo_posicao = '$D'::date - 10)" "x.sales_order_id = $O1 AND x.quantidade = 10")" "40 cmc_data true"
# ACUSTOVELHO
eq "ACUSTOVELHO I2 com posicao de 50 dias cai no atual marcado (30)" \
   "$(motor "$M12" "custo_unit || ' ' || custo_fonte || ' ' || (custo_posicao IS NULL)" "x.sales_order_id = $O1 AND x.omie_codigo_produto = 1002")" "30 atual true"
# ASEMCUSTO
eq "ASEMCUSTO I4: custo, custo_total e contribuicao NULL; fonte NULL" \
   "$(motor "$M12" "(custo_unit IS NULL) || ' ' || (custo_total IS NULL) || ' ' || (contribuicao IS NULL) || ' ' || (custo_fonte IS NULL)" "x.omie_codigo_produto = 1003")" "true true true true"

# APRAZO (O1: 770 a 30d + 330 a 90d, r = 0,1775). Esperado calculado por fora.
ESP_FATOR="$(Pq -c "SELECT round((770*power(1.1775, -30/365.0) + 330*power(1.1775, -90/365.0)) / 1100, 10)")"
eq "APRAZO status e fator do O1 (pesos por valor)" \
   "$(motor "$M12" "DISTINCT prazo_status || ' ' || round(fator_pv, 10)" "x.sales_order_id = $O1")" "ok $ESP_FATOR"
eq "APRAZO prazo medio ponderado = (770*30+330*90)/1100" \
   "$(motor "$M12" "DISTINCT round(prazo_medio_dias, 4)" "x.sales_order_id = $O1")" "$(Pq -c "SELECT round((770*30+330*90)/1100.0, 4)")"
eq "APRAZO custo do prazo do O1 = 1100 x (1 - S)" \
   "$(motor "$M12" "round(sum(custo_prazo), 6)" "x.sales_order_id = $O1")" "$(Pq -c "SELECT round(1100 * (1 - (770*power(1.1775, -30/365.0) + 330*power(1.1775, -90/365.0)) / 1100), 6)")"
eq "APRAZO a vista (O2): fator 1, custo do prazo 0 na linha com receita" \
   "$(motor "$M12" "prazo_status || ' ' || round(fator_pv, 6) || ' ' || round(custo_prazo, 6)" "x.omie_codigo_produto = 1003")" "ok 1.000000 0.000000"

# ATAXA
eq "ATAXA colacor sem config: taxa_ausente, prazo medio 30, custo do prazo NULL" \
   "$(motor "$M12" "prazo_status || ' ' || round(prazo_medio_dias) || ' ' || (custo_prazo IS NULL) || ' ' || (contribuicao IS NULL)" "x.empresa = 'colacor'")" "taxa_ausente 30 true true"
eq "ATAXA paridade: o motor usa a MESMA taxa de fin_regua_custo_capital (via fator do O1)" \
   "$(Pq -c "$(como "$M" "SELECT round(power(1 + public.fin_regua_custo_capital('oben'), -30/365.0) * 770/1100 + power(1 + public.fin_regua_custo_capital('oben'), -90/365.0) * 330/1100, 10)")")" "$ESP_FATOR"
eq "ATAXA porta expoe a taxa: oben 0.1775, colacor null" \
   "$(rpc "'12m','empresa'" "round((j->'taxa_capital'->>'oben')::numeric, 4) || ' ' || jsonb_typeof(j->'taxa_capital'->'colacor')")" "0.1775 null"

# AAMBIG
eq "AAMBIG 12m: os dois pedidos do titulo compartilhado ficam ambiguos" \
   "$(motor "$M12" "string_agg(DISTINCT prazo_status, ',')" "x.omie_numero_pedido = '700'")" "ambiguo"
eq "AAMBIG 90d: o O5 segue ambiguo com o O4 FORA da janela pedida" \
   "$(motor "'$HOJE'::date - 89, '$HOJE'::date" "string_agg(DISTINCT prazo_status, ',') || ' ' || count(*)" "x.omie_numero_pedido = '700'")" "ambiguo 1"
# AVALOR / ACLIENTE / ASEMTIT
eq "AVALOR titulo 250 para total 300" "$(motor "$M12" "DISTINCT prazo_status" "x.omie_numero_pedido = '800'")" "valor_nao_bate"
eq "ACLIENTE titulo de outro cliente Omie" "$(motor "$M12" "DISTINCT prazo_status" "x.omie_numero_pedido = '801'")" "cliente_nao_confere"
eq "ASEMTIT pedido sem numero" "$(motor "$M12" "DISTINCT prazo_status" "x.data_pedido = '$D'::date - 1")" "sem_titulo"
eq "ASEMTIT o CANCELADO nao entra na soma do O1 (senao valor nao bateria)" \
   "$(motor "$M12" "DISTINCT prazo_status" "x.sales_order_id = $O1")" "ok"

# APISO
eq "APISO I2 abaixo do piso: 25 < 30x1,3; gap = 39x2 - 50 = 28" \
   "$(motor "$M12" "abaixo_piso || ' ' || round(gap_piso, 4)" "x.sales_order_id = $O1 AND x.omie_codigo_produto = 1002")" "true 28.0000"
eq "APISO I1 pelo preco LIQUIDO 95 >= 52: nao abaixo, gap 0" \
   "$(motor "$M12" "abaixo_piso || ' ' || round(gap_piso, 4)" "x.sales_order_id = $O1 AND x.quantidade = 10")" "false 0.0000"
eq "APISO I10 abaixo: gap = 40x1,3 - 10 = 42" \
   "$(motor "$M12" "abaixo_piso || ' ' || round(gap_piso, 4)" "x.data_pedido = '$D'::date - 1")" "true 42.0000"
eq "APISO preco liquido decide: 20 com desconto 10 fica abaixo de 13 (o bruto 20 nao ficaria)" \
   "$(Pq -c "UPDATE public.order_items SET unit_price = 20, desconto_valor = 10 WHERE omie_codigo_produto = 1004 AND sales_order_id = (SELECT id FROM public.sales_orders WHERE omie_numero_pedido = '801'); SELECT 1" >/dev/null; motor "$M12" "abaixo_piso" "x.omie_numero_pedido = '801'")" "t"
eq "APISO item colacor sem politica: piso, abaixo e gap NULL, linha presente" \
   "$(motor "$M12" "count(*) || ' ' || bool_and(piso_markup IS NULL AND abaixo_piso IS NULL AND gap_piso IS NULL)" "x.empresa = 'colacor'")" "1 true"

# AJANELA
eq "AJANELA 12m: desde = hoje - 364; O12 dentro, O13 fora" \
   "$(rpc "'12m','pedido','oben','receita_desc',200,0" "(j->>'desde')::date = '$HOJE'::date - 364")$(motor "'$HOJE'::date - 364, '$HOJE'::date" "count(*)" "x.data_pedido IN ('$HOJE'::date - 364, '$HOJE'::date - 365)")" "t1"
eq "AJANELA 90d: desde = hoje - 89; O14 dentro, O15 fora (pela porta)" \
   "$(rpc "'90d','pedido','oben','receita_desc',200,0" "((j->>'desde')::date = '$HOJE'::date - 89) || ' ' || (SELECT count(*) FROM jsonb_array_elements(j->'linhas') e WHERE (e->'detalhe'->>'data')::date IN ('$HOJE'::date - 89, '$HOJE'::date - 90))")" "true 1"

# ACANON
eq "ACANON K1 soma o pedido do alias K1A: 2 pedidos, rotulo do canonico" \
   "$(rpc "'12m','cliente'" "(SELECT (e->>'pedidos') || ' ' || (e->>'rotulo') FROM jsonb_array_elements(j->'linhas') e WHERE e->>'chave' = '$K1')")" "2 Marcenaria Um"

# APONTE
PONTE="$(rpc "'12m','empresa'" "abs((j->'total'->>'receita_contribuicao')::numeric - (j->'total'->>'custo_contribuicao')::numeric - (j->'total'->>'custo_prazo_contribuicao')::numeric - (j->'total'->>'contribuicao')::numeric) <= 0.02")"
eq "APONTE receita - custo - prazo da intersecao = contribuicao (+-0,02 de arredondamento)" "$PONTE" "t"
eq "APONTE total da porta = soma das linhas do motor" \
   "$(rpc "'12m','empresa'" "(j->'total'->>'contribuicao')::numeric")" "$(motor "$M12" "round(sum(contribuicao), 2)")"
eq "APONTE cobertura de custo por fonte no total: data 4 / atual 10 / sem 1" \
   "$(rpc "'12m','empresa'" "concat_ws('/', j->'total'->>'itens_custo_data', j->'total'->>'itens_custo_atual', j->'total'->>'itens_sem_custo')")" "4/10/1"

# ANULL
eq "ANULL K3 (so pedidos ambiguos): contribuicao e custo_prazo JSON null, margem conhecida" \
   "$(rpc "'12m','cliente'" "(SELECT jsonb_typeof(e->'contribuicao') || ' ' || jsonb_typeof(e->'custo_prazo') || ' ' || (e->>'margem_bruta') FROM jsonb_array_elements(j->'linhas') e WHERE e->>'chave' = '$K3')")" "null null 60.00"

# APAGINA
TOTAL_PED="$(rpc "'12m','pedido'" "j->>'total_linhas'")"
PAGS="$(for off in 0 3 6 9 12; do rpc "'12m','pedido',NULL,'contribuicao_asc',3,$off" "(SELECT string_agg(e->>'chave', ',' ORDER BY ord) FROM jsonb_array_elements(j->'linhas') WITH ORDINALITY t(e, ord))"; done | tr '\n' ',' )"
TUDO="$(rpc "'12m','pedido',NULL,'contribuicao_asc',200,0" "(SELECT string_agg(e->>'chave', ',' ORDER BY ord) FROM jsonb_array_elements(j->'linhas') WITH ORDINALITY t(e, ord))")"
eq "APAGINA 12m tem 12 pedidos" "$TOTAL_PED" "12"
eq "APAGINA paginas de 3 reproduzem a lista inteira na mesma ordem" "$(printf '%s' "$PAGS" | sed 's/,,*/,/g; s/,$//')" "$TUDO"

# AORDEM
eq "AORDEM desconto_desc: o O1 (desconto 50) primeiro" \
   "$(rpc "'12m','pedido',NULL,'desconto_desc',1,0" "j->'linhas'->0->>'chave' = $O1::text || '' AND (j->'linhas'->0->>'desconto')::numeric = 50")" "t"

# AVENDEDOR
eq "AVENDEDOR indisponivel" "$(rpc "'12m','vendedor'" "j->>'indisponivel'")" "true"

# AVALIDA — a query de validação entregue ao founder (db/valida-venda-contribuicao.sql) roda AQUI contra a
# migration real: 6 ✅ (o validador também é código — database.md §4 "O VALIDADOR mente").
eq "AVALIDA validador pos-apply: 6 de 6 itens ok" \
   "$(Pq -f "$REPO_ROOT/db/valida-venda-contribuicao.sql" | grep -c '✅')" "6"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-contribuicao"
