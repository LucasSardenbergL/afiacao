#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — P0: fechar 5 views security_invoker=off (vazamento comercial)  ║
# ║  Migração: supabase/migrations/20260708190000_fechar_views_invoker_off_p0.sql  ║
# ║  Rode:  bash db/test-views-invoker-off-p0.sh > /tmp/t-views-p0.log 2>&1; echo $? ║
# ║                                                                                ║
# ║  Mecanismo (security_invoker): view ON lê as relações que referencia DIRETO    ║
# ║  como o CALLER; OFF, como o owner (postgres → bypassa RLS). NÃO propaga         ║
# ║  transitivamente → a FOLHA (v_venda_items_history_efetivo) é o elo que fecha    ║
# ║  venda_items_history p/ as 4 views que a consomem.                             ║
# ║                                                                                ║
# ║  Invariante (auth): pós-fix, anon é BARRADO (42501, revoke) e customer vê 0     ║
# ║  (invoker=on herda RLS staff-only); staff (employee) continua vendo.            ║
# ║  Baseline mede o vazamento REAL pré-fix. Falsifica: F1 folha off → volta a      ║
# ║  vazar; F3 re-grant anon → revoke sem dente.                                    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="views-invoker-p0"
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
gt0() { if [ "${2:-0}" -gt 0 ] 2>/dev/null; then ok "$1 (=$2 >0)"; else bad "$1 — esperado >0, veio [$2]"; fi; }

STAFF='11111111-1111-1111-1111-111111111111'
CUST='22222222-2222-2222-2222-222222222222'
# count como authenticated com um uid dado
cnt()      { Pq -c "SET test.uid='$1'; SET test.role='authenticated'; SET ROLE authenticated; SELECT count(*) FROM public.$2;" | tail -1; }
# count como anon (só válido enquanto anon tiver grant — usado no baseline pré-fix)
anon_cnt() { Pq -c "SET ROLE anon; SELECT count(*) FROM public.$1;" 2>/dev/null | tail -1; }
# prova que anon NÃO consegue executar SELECT (REVOKE efetivo → 42501). Sentinela anti-teatro.
anon_deny() {  # $1=view  $2=label
  local out
  out=$(P -tA 2>&1 <<SQL || true
SET ROLE anon;
DO \$\$ BEGIN
  PERFORM 1 FROM public.$1 LIMIT 1;
  RAISE EXCEPTION 'ANON_SELECTED';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$out" in
    *REVOKE_OK*)     ok  "$2 (anon barrado 42501)";;
    *ANON_SELECTED*) bad "$2 — anon AINDA executa SELECT na view (revoke sem efeito)";;
    *)               bad "$2 — inesperado: $out";;
  esac
}

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — SCHEMA: tabelas-base reais (RLS real) + views reais em estado OFF (= prod pré-fix)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;

CREATE TABLE public.venda_items_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text, nfe_chave_acesso text, nfe_numero text, nfe_serie text, data_emissao date,
  cliente_codigo_omie bigint, cliente_razao_social text, cliente_cnpj_cpf text, cliente_uf text, cliente_cidade text,
  sku_codigo_omie bigint, sku_codigo text, sku_descricao text, sku_ncm text, sku_unidade text,
  quantidade numeric, valor_unitario numeric, valor_total numeric, cfop text, raw_data jsonb, created_at timestamptz DEFAULT now());
ALTER TABLE public.venda_items_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_venda_items_history_select ON public.venda_items_history FOR SELECT TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee'))));

CREATE TABLE public.sku_substituicao (id bigserial PRIMARY KEY, empresa text, sku_codigo_antigo text, sku_codigo_novo text, acao_parametros text, status text);
ALTER TABLE public.sku_substituicao ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sku_substituicao_select ON public.sku_substituicao FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, habilitado_reposicao_automatica boolean, ponto_pedido numeric, estoque_maximo numeric);
ALTER TABLE public.sku_parametros ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sku_parametros_select ON public.sku_parametros FOR SELECT TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee'))));

CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, tipo_produto text, metadata jsonb DEFAULT '{}'::jsonb, valor_unitario numeric);
ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage products" ON public.omie_products FOR ALL TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee'))));

CREATE TABLE public._src_psug (
  empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text, fornecedor_habilitado boolean,
  classe_abc_proposta text, classe_xyz_proposta text, classe_consolidada text, demanda_media_diaria numeric,
  lead_time_medio numeric, lt_total_teorico_dias_uteis numeric, demanda_sigma_diario numeric, coef_variacao_ordem numeric,
  dias_com_movimento integer, lead_time_desvio numeric, lt_p95_dias numeric, fonte_leadtime text, z_aplicado numeric,
  preco_item_eoq numeric, preco_compra_real numeric, preco_venda_medio numeric, fonte_preco text,
  custo_pedido_aplicado numeric, custo_capital_efetivo_perc numeric, valor_total_90d numeric, valor_total_180d numeric,
  calculado_em timestamptz, status_sugestao text, grupo_codigo text);
ALTER TABLE public._src_psug ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_src_psug_select ON public._src_psug FOR SELECT TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'master') OR has_role((SELECT auth.uid()),'employee'))));
SQL

# Views com CORPOS REAIS (pg_get_viewdef de prod), em estado OFF (default) = prod pré-fix.
P -q <<'SQL'
CREATE VIEW public.v_venda_items_history_efetivo AS
 SELECT v.id, v.empresa, v.nfe_chave_acesso, v.nfe_numero, v.nfe_serie, v.data_emissao,
    v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
    COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,
    v.sku_codigo, v.sku_descricao, v.sku_ncm, v.sku_unidade, v.quantidade, v.valor_unitario,
    v.valor_total, v.cfop, v.raw_data, v.created_at
   FROM venda_items_history v
     LEFT JOIN sku_substituicao s ON s.empresa = v.empresa AND s.sku_codigo_antigo = v.sku_codigo_omie::text
        AND s.status = 'aplicada'::text AND s.acao_parametros = 'consolidar_demanda'::text AND s.sku_codigo_novo ~ '^\d+$'::text;

CREATE VIEW public.v_sku_demanda_estatisticas AS
 WITH vendas_por_ordem AS (
         SELECT venda_items_history.empresa, venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao, max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso, venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem, sum(venda_items_history.valor_total) AS valor_ordem
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '90 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.nfe_chave_acesso, venda_items_history.data_emissao
        ), stats AS (
         SELECT vendas_por_ordem.empresa, vendas_por_ordem.sku_codigo_omie,
            max(vendas_por_ordem.sku_descricao) AS sku_descricao, max(vendas_por_ordem.sku_unidade) AS sku_unidade,
            count(DISTINCT vendas_por_ordem.nfe_chave_acesso) AS num_ordens,
            sum(vendas_por_ordem.qtde_ordem) AS demanda_total_90d, sum(vendas_por_ordem.valor_ordem) AS valor_total_90d,
            round(avg(vendas_por_ordem.qtde_ordem), 4) AS qtde_media_por_ordem, round(stddev(vendas_por_ordem.qtde_ordem), 4) AS qtde_desvio_por_ordem,
            max(vendas_por_ordem.data_emissao) AS ultima_venda_data, round(sum(vendas_por_ordem.qtde_ordem) / 90.0, 4) AS demanda_media_diaria,
                CASE WHEN avg(vendas_por_ordem.qtde_ordem) > 0::numeric AND count(*) >= 2 THEN round(stddev(vendas_por_ordem.qtde_ordem) / avg(vendas_por_ordem.qtde_ordem), 4) ELSE NULL::numeric END AS coef_variacao_ordem
           FROM vendas_por_ordem GROUP BY vendas_por_ordem.empresa, vendas_por_ordem.sku_codigo_omie
        )
 SELECT empresa, sku_codigo_omie, sku_descricao, sku_unidade, num_ordens, demanda_total_90d, valor_total_90d,
    qtde_media_por_ordem, qtde_desvio_por_ordem, demanda_media_diaria, coef_variacao_ordem, ultima_venda_data
   FROM stats;

CREATE VIEW public.v_sku_demanda_rajada AS
 WITH datas_serie AS (
         SELECT generate_series(CURRENT_DATE - '179 days'::interval, CURRENT_DATE::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa, venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao, max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia, sum(venda_items_history.valor_total) AS valor_dia
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.data_emissao
        ), serie_completa AS (
         SELECT s.empresa, s.sku_codigo_omie, s.sku_descricao, s.sku_unidade, d.dt,
            COALESCE(v.qtde_dia, 0::numeric) AS qtde_dia, COALESCE(v.valor_dia, 0::numeric) AS valor_dia
           FROM skus_ativos s CROSS JOIN datas_serie d
             LEFT JOIN vendas_diarias v ON s.empresa = v.empresa AND s.sku_codigo_omie = v.sku_codigo_omie AND d.dt = v.dt
        )
 SELECT empresa, sku_codigo_omie, max(sku_descricao) AS sku_descricao, max(sku_unidade) AS sku_unidade,
    round(avg(qtde_dia), 4) AS demanda_media_diaria, round(stddev(qtde_dia), 4) AS demanda_desvio_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p90_diario,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p95_diario,
    round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p99_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p90_quando_vende,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p95_quando_vende,
    max(qtde_dia) AS pico_maximo_dia, count(*) FILTER (WHERE qtde_dia > 0::numeric) AS dias_com_movimento,
    sum(qtde_dia) AS qtde_total_180d, round(sum(valor_dia), 2) AS valor_total_180d
   FROM serie_completa GROUP BY empresa, sku_codigo_omie;

CREATE VIEW public.v_sku_sigma_demanda AS
 WITH datas AS (
         SELECT generate_series(CURRENT_DATE - '180 days'::interval, CURRENT_DATE - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa, venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt, sum(venda_items_history.quantidade) AS qtde
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text), venda_items_history.data_emissao
        ), serie AS (
         SELECT v.empresa, v.sku_codigo_omie, d.dt, COALESCE(sum(vd.qtde), 0::numeric) AS qtde
           FROM ( SELECT DISTINCT vendas_diarias.empresa, vendas_diarias.sku_codigo_omie FROM vendas_diarias) v
             CROSS JOIN datas d
             LEFT JOIN vendas_diarias vd ON vd.empresa = v.empresa AND vd.sku_codigo_omie = v.sku_codigo_omie AND vd.dt = d.dt
          GROUP BY v.empresa, v.sku_codigo_omie, d.dt
        )
 SELECT empresa, sku_codigo_omie, round(stddev_samp(qtde), 4) AS sigma_demanda_diaria, round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie GROUP BY empresa, sku_codigo_omie;

CREATE VIEW public.v_sku_parametros_sugeridos WITH (security_invoker=on) AS SELECT * FROM public._src_psug;

CREATE VIEW public.v_sku_candidatos_primeira_compra AS
 WITH recorrencia_180d AS (
         SELECT vih.empresa, vih.sku_codigo_omie,
            count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
            count(DISTINCT to_char(vih.data_emissao::timestamp with time zone, 'YYYY-MM'::text)) AS meses_180d,
            count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
            CURRENT_DATE - max(vih.data_emissao) AS dias_desde_ultima
           FROM v_venda_items_history_efetivo vih
          WHERE vih.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND vih.quantidade > 0::numeric
          GROUP BY vih.empresa, vih.sku_codigo_omie
        ), elegiveis AS (
         SELECT v.empresa, v.sku_codigo_omie, v.sku_descricao, v.fornecedor_nome, v.fornecedor_habilitado,
            sp.habilitado_reposicao_automatica AS ja_habilitado, v.classe_abc_proposta, v.classe_xyz_proposta, v.classe_consolidada,
            v.demanda_media_diaria AS d, v.lead_time_medio AS lt, v.lt_total_teorico_dias_uteis, v.demanda_sigma_diario,
            v.coef_variacao_ordem, v.dias_com_movimento, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime, v.z_aplicado,
            v.preco_item_eoq, v.preco_compra_real, v.preco_venda_medio, v.fonte_preco, v.custo_pedido_aplicado,
            v.custo_capital_efetivo_perc, v.valor_total_90d, v.valor_total_180d, v.calculado_em,
            r.nfs_180d, r.meses_180d, r.clientes_180d, r.dias_desde_ultima,
                CASE v.classe_abc_proposta WHEN 'A'::text THEN 30 WHEN 'B'::text THEN 21 ELSE 14 END AS cap_dias,
                CASE WHEN v.preco_item_eoq > 0::numeric AND v.custo_capital_efetivo_perc > 0::numeric AND v.demanda_media_diaria > 0::numeric
                     THEN ceil(sqrt(2.0 * (v.demanda_media_diaria * 252::numeric) * v.custo_pedido_aplicado / (v.custo_capital_efetivo_perc / 100.0 * v.preco_item_eoq)))
                     ELSE 1::numeric END AS qc_eoq
           FROM v_sku_parametros_sugeridos v
             JOIN recorrencia_180d r ON r.empresa = v.empresa AND r.sku_codigo_omie = v.sku_codigo_omie
             JOIN sku_parametros sp ON sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
             LEFT JOIN omie_products op ON op.omie_codigo_produto::text = v.sku_codigo_omie::text AND op.account = lower(v.empresa)
          WHERE v.status_sugestao = 'AGUARDANDO_SEGUNDA_ORDEM'::text AND v.demanda_media_diaria > 0::numeric AND v.lead_time_medio IS NOT NULL
            AND v.fornecedor_nome IS NOT NULL AND v.fornecedor_habilitado IS TRUE AND v.preco_item_eoq > 0::numeric AND v.classe_abc_proposta IS NOT NULL
            AND (v.grupo_codigo IS NOT NULL OR v.fornecedor_nome <> 'RENNER SAYERLACK S/A'::text) AND r.meses_180d >= 2 AND r.nfs_180d >= 2
            AND r.dias_desde_ultima <= 60 AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL
            AND COALESCE(op.tipo_produto, op.metadata ->> 'tipo_produto'::text, ''::text) <> '04'::text
        ), calc AS (
         SELECT elegiveis.*, ceil(elegiveis.d * elegiveis.cap_dias::numeric) AS cap_cobertura, ceil(elegiveis.d * elegiveis.lt) AS dem_lt
           FROM elegiveis
        )
 SELECT empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, fornecedor_habilitado, classe_abc_proposta, classe_xyz_proposta,
    classe_consolidada, d AS demanda_media_diaria, lt AS lead_time_medio, lt_total_teorico_dias_uteis, demanda_sigma_diario,
    coef_variacao_ordem, dias_com_movimento, lead_time_desvio, lt_p95_dias, fonte_leadtime, z_aplicado, preco_item_eoq,
    preco_compra_real, preco_venda_medio, fonte_preco, valor_total_90d, valor_total_180d, calculado_em,
    'CANDIDATO_PRIMEIRA_COMPRA'::text AS status_sugestao, nfs_180d AS recorrencia_nfs_180d, meses_180d AS recorrencia_meses_180d,
    clientes_180d AS recorrencia_clientes_180d, dias_desde_ultima AS dias_desde_ultima_venda, cap_dias AS primeira_compra_cap_dias,
    GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_qtde,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) AS primeira_compra_ponto_pedido,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) + GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_estoque_maximo,
    ja_habilitado
   FROM calc;

GRANT SELECT ON public.venda_items_history, public.sku_substituicao, public.sku_parametros, public.omie_products, public._src_psug TO anon, authenticated;
GRANT SELECT ON public.v_venda_items_history_efetivo, public.v_sku_demanda_estatisticas, public.v_sku_demanda_rajada,
               public.v_sku_sigma_demanda, public.v_sku_parametros_sugeridos, public.v_sku_candidatos_primeira_compra TO anon, authenticated;
GRANT SELECT ON public.v_sku_demanda_estatisticas TO PUBLIC;  -- simula grant-drift p/ dar dente ao REVOKE PUBLIC (achado Codex P4)
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO anon, authenticated;
SQL
echo "── schema + views (OFF) criados = estado pré-fix de prod ──"

PREOFF=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v' AND c.relname IN ('v_venda_items_history_efetivo','v_sku_demanda_estatisticas','v_sku_demanda_rajada','v_sku_sigma_demanda','v_sku_candidatos_primeira_compra') AND coalesce(array_to_string(c.reloptions,','),'') !~* 'security_invoker=(on|true)';")
eq "PRE: 5 views nascem invoker=off" "$PREOFF" "5"
PREANON=$(Pq -c "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='anon' AND privilege_type='SELECT' AND table_name IN ('v_venda_items_history_efetivo','v_sku_demanda_estatisticas','v_sku_demanda_rajada','v_sku_sigma_demanda','v_sku_candidatos_primeira_compra');")
eq "PRE: anon TEM SELECT nas 5 (baseline p/ falsificar revoke)" "$PREANON" "5"

# ══════════════════════════════════════════════════════════════════════════════
# SEED (como postgres, ANTES da migração — p/ medir baseline pré-fix)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee'),('22222222-2222-2222-2222-222222222222','customer');
INSERT INTO public.venda_items_history(empresa, nfe_chave_acesso, data_emissao, cliente_cnpj_cpf, sku_codigo_omie, sku_descricao, sku_unidade, quantidade, valor_unitario, valor_total, cfop) VALUES
  ('oben','NFE-AAA', CURRENT_DATE - 3,  '11.111.111/0001-11', 9001, 'CATALISADOR X', 'UN', 5, 100, 500, '5102'),
  ('oben','NFE-BBB', CURRENT_DATE - 40, '22.222.222/0001-22', 9001, 'CATALISADOR X', 'UN', 4, 100, 400, '5102');
INSERT INTO public.sku_parametros(empresa, sku_codigo_omie, habilitado_reposicao_automatica, ponto_pedido, estoque_maximo) VALUES ('oben', 9001, false, NULL, NULL);
INSERT INTO public.omie_products(omie_codigo_produto, account, tipo_produto, metadata, valor_unitario) VALUES (9001, 'oben', '00', '{}'::jsonb, 100);
INSERT INTO public._src_psug(empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, fornecedor_habilitado,
  classe_abc_proposta, classe_xyz_proposta, classe_consolidada, demanda_media_diaria, lead_time_medio,
  lt_total_teorico_dias_uteis, demanda_sigma_diario, coef_variacao_ordem, dias_com_movimento, lead_time_desvio,
  lt_p95_dias, fonte_leadtime, z_aplicado, preco_item_eoq, preco_compra_real, preco_venda_medio, fonte_preco,
  custo_pedido_aplicado, custo_capital_efetivo_perc, valor_total_90d, valor_total_180d, calculado_em, status_sugestao, grupo_codigo)
 VALUES ('oben', 9001, 'CATALISADOR X', 'ACME LTDA', true, 'A', 'Y', 'CATALISADORES', 0.5, 7,
  9, 0.3, 0.4, 12, 1.2, 9, 'historico', 1.65, 25.50, 12.30, 40.00, 'cmc', 50, 2.0, 900, 1800, now(), 'AGUARDANDO_SEGUNDA_ORDEM', NULL);
SQL
echo "── seed ok ──"

# ── BASELINE: o que VAZA hoje (views OFF, exceto v_sku_parametros_sugeridos ON) ──
echo "── BASELINE pré-fix (informativo — mede o vazamento REAL) ──"
echo "   staff   → demanda_estatisticas: $(cnt "$STAFF" v_sku_demanda_estatisticas)  (sempre vê)"
echo "   CUSTOMER→ folha:                $(cnt "$CUST" v_venda_items_history_efetivo)  (>0 = VAZA: folha off lê venda_items_history como postgres)"
echo "   CUSTOMER→ demanda_estatisticas: $(cnt "$CUST" v_sku_demanda_estatisticas)  (>0 = VAZA via folha off)"
echo "   CUSTOMER→ candidatos:           $(cnt "$CUST" v_sku_candidatos_primeira_compra)  (0 provável: fonte v_sku_parametros_sugeridos já ON filtra o INNER JOIN)"
echo "   ANON    → demanda_estatisticas: $(anon_cnt v_sku_demanda_estatisticas)  (>0 = VAZA p/ anon não-autenticado)"

# ══════════════════════════════════════════════════════════════════════════════
# APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260708190000_fechar_views_invoker_off_p0.sql"
P -q -f "$MIG"
echo "── migration aplicada: $(basename "$MIG") ──"

# ══════════════════════════════════════════════════════════════════════════════
# ASSERTS pós-fix
# ══════════════════════════════════════════════════════════════════════════════
echo "── (A) POSITIVO: staff (employee) continua vendo ──"
gt0 "A1 folha (staff)"                  "$(cnt "$STAFF" v_venda_items_history_efetivo)"
gt0 "A2 demanda_estatisticas (staff)"   "$(cnt "$STAFF" v_sku_demanda_estatisticas)"
gt0 "A3 demanda_rajada (staff)"         "$(cnt "$STAFF" v_sku_demanda_rajada)"
gt0 "A4 sigma_demanda (staff)"          "$(cnt "$STAFF" v_sku_sigma_demanda)"
eq  "A5 candidatos (staff)"             "$(cnt "$STAFF" v_sku_candidatos_primeira_compra)" "1"

echo "── (B) NEGATIVO: customer autenticado vê 0 (invoker=on herda RLS staff-only) ──"
eq "B1 folha (customer)"                "$(cnt "$CUST" v_venda_items_history_efetivo)" "0"
eq "B2 demanda_estatisticas (customer)" "$(cnt "$CUST" v_sku_demanda_estatisticas)" "0"
eq "B3 demanda_rajada (customer)"       "$(cnt "$CUST" v_sku_demanda_rajada)" "0"
eq "B4 sigma_demanda (customer)"        "$(cnt "$CUST" v_sku_sigma_demanda)" "0"
eq "B5 candidatos (customer)"           "$(cnt "$CUST" v_sku_candidatos_primeira_compra)" "0"

echo "── (C) ANON: barrado na porta (42501, via REVOKE) ──"
anon_deny v_venda_items_history_efetivo    "C1 folha"
anon_deny v_sku_demanda_estatisticas       "C2 demanda_estatisticas"
anon_deny v_sku_demanda_rajada             "C3 demanda_rajada"
anon_deny v_sku_sigma_demanda              "C4 sigma_demanda"
anon_deny v_sku_candidatos_primeira_compra "C5 candidatos"

echo "── (D) CATÁLOGO pós-fix: 5 views invoker=on + anon/PUBLIC sem SELECT (responde Codex P3/P4) ──"
V5="('v_venda_items_history_efetivo','v_sku_demanda_estatisticas','v_sku_demanda_rajada','v_sku_sigma_demanda','v_sku_candidatos_primeira_compra')"
D1=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v' AND c.relname IN $V5 AND coalesce(array_to_string(c.reloptions,','),'') ~* 'security_invoker=(on|true)';")
eq "D1 as 5 views invoker=on (catálogo, não só comportamento)" "$D1" "5"
D2=$(Pq -c "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='anon' AND privilege_type='SELECT' AND table_name IN $V5;")
eq "D2 anon SEM SELECT nas 5 (revoke anon)" "$D2" "0"
D3=$(Pq -c "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND privilege_type='SELECT' AND table_name='v_sku_demanda_estatisticas';")
eq "D3 PUBLIC SEM SELECT (revoke PUBLIC matou o grant-drift semeado)" "$D3" "0"

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"
# F1: folha OFF → venda_items_history volta a ser lida como postgres → demanda vaza p/ customer.
P -q -c "ALTER VIEW public.v_venda_items_history_efetivo SET (security_invoker=off);"
F1=$(cnt "$CUST" v_sku_demanda_estatisticas)
if [ "${F1:-0}" -gt 0 ] 2>/dev/null; then ok "F1 folha off → customer vê $F1 (assert B2 teria ficado VERMELHO → folha ON é o elo)"; else bad "F1 — folha off NÃO reproduziu vazamento (assert B2 sem dente?)"; fi
P -q -c "ALTER VIEW public.v_venda_items_history_efetivo SET (security_invoker=on);"

# OBS (educativo): topo OFF + folha ON → customer vê 0 (confirma que a FOLHA é o elo, não o topo).
P -q -c "ALTER VIEW public.v_sku_demanda_estatisticas SET (security_invoker=off);"
OBS=$(cnt "$CUST" v_sku_demanda_estatisticas)
eq "OBS topo off + folha on → customer 0 (folha governa venda_items_history)" "$OBS" "0"
P -q -c "ALTER VIEW public.v_sku_demanda_estatisticas SET (security_invoker=on);"

# F3: re-GRANT anon na CADEIA (view + folha) → o REVOKE perde o dente (anon volta a executar).
# Descoberta: com invoker=on, ler a view exige grant TAMBÉM na folha (lida como o caller) → o
# REVOKE anon da FOLHA sozinho já barra anon em toda a cadeia. Por isso re-conceder só a view de
# topo NÃO reabre (anon bate na folha revogada) — a falsificação tem de re-conceder view+folha.
P -q -c "GRANT SELECT ON public.v_sku_demanda_estatisticas, public.v_venda_items_history_efetivo TO anon;"
F3=$(P -tA 2>&1 <<'SQL' || true
SET ROLE anon;
DO $$ BEGIN PERFORM 1 FROM public.v_sku_demanda_estatisticas LIMIT 1; RAISE NOTICE 'ANON_SELECTED_AGAIN'; EXCEPTION WHEN insufficient_privilege THEN RAISE EXCEPTION 'STILL_DENIED'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$F3" in *ANON_SELECTED_AGAIN*) ok "F3 re-grant anon (view+folha) → anon executa SELECT (revoke tinha dente)";; *) bad "F3 — re-grant não reabriu: $F3";; esac
P -q -c "REVOKE SELECT ON public.v_sku_demanda_estatisticas, public.v_venda_items_history_efetivo FROM anon;"

# Pós-restauração: invariante de volta ao verde?
eq "POS demanda_estatisticas (customer) restaurado" "$(cnt "$CUST" v_sku_demanda_estatisticas)" "0"
anon_deny v_sku_demanda_estatisticas "POS anon barrado restaurado"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
