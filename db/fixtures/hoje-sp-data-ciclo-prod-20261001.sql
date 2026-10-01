-- O que a PROD tinha em 2026-10-01 (psql-ro, 02:23Z, pg_get_viewdef(oid, true) / pg_get_functiondef) para a
-- prova da 20261001023000_hoje_sp_familia_data_ciclo.sql — byte a byte, em 4 partes:
--
--   1. a DERIVA do snapshot: as 14 colunas de pedido_compra_sugerido / pedido_compra_item criadas depois de
--      2026-09-05 (o snapshot é dessa data). PL/pgSQL é late-bound: sem elas o motor só falha EXECUTANDO
--      (medido: `fator_embalagem_portal ... does not exist` no INSERT dos itens). Tipos e DEFAULTs da prod;
--      0 colunas com tipo divergente entre prod e snapshot;
--   2. as 18 views de que as 2 views da família dependem (o fecho por pg_depend, a mais funda primeiro), no
--      texto VIVO — 6 delas leem o relógio e já são as da fase 2 (dia de SP), que o snapshot não tem;
--   3. as PREDECESSORAS: v_promocao_avaliacao_hoje, v_oportunidade_economica_hoje, as 6 funções e o DEFAULT
--      de pedido_compra_sugerido.data_ciclo;
--   4. nada mais: o resto vem do schema-snapshot.
--
-- db/test-hoje-sp-data-ciclo.sh confere o md5 EXATO de cada view (pg_get_viewdef) e de cada função (prosrc e
-- argumentos) contra o da prod (P01-P10). Carregue com `pg_catalog` DEPOIS de `public` no search_path (a prova
-- o faz): views e DEFAULTs de parâmetro amarram o now() no CREATE, e a prova os quer no relógio controlado.

ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS aprovacao_selo_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS aprovacao_selo text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_em timestamp with time zone,
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS aprovacao_selo_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS aprovacao_selo text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_evidencia text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_motivo text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_por text,
  ADD COLUMN IF NOT EXISTS disparo_claim_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS disparo_claim_por text,
  ADD COLUMN IF NOT EXISTS portal_recusa_motivo text,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_em timestamp with time zone,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_protocolo text,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado numeric;
ALTER TABLE public.pedido_compra_item
  ADD COLUMN IF NOT EXISTS fator_embalagem_portal numeric,
  ADD COLUMN IF NOT EXISTS fator_portal_aprovado numeric,
  ADD COLUMN IF NOT EXISTS sku_portal_aprovado text;

CREATE OR REPLACE VIEW public.vw_pcp_malha_itens
  WITH (security_invoker = true)
  AS
 SELECT s.omie_codigo_produto AS pai_codigo,
    NULLIF(COALESCE((i.value -> 'ident'::text) ->> 'idProdMalha'::text, (i.value -> 'ident'::text) ->> 'idMalha'::text, i.value ->> 'idProdMalha'::text), ''::text)::bigint AS componente_id,
    COALESCE((i.value -> 'ident'::text) ->> 'codProdMalha'::text, i.value ->> 'codProdMalha'::text) AS componente_codigo_txt,
    COALESCE((i.value -> 'ident'::text) ->> 'descrProdMalha'::text, i.value ->> 'descrProdMalha'::text) AS componente_descricao_omie,
    fn_pcp_num(COALESCE(i.value ->> 'quantProdMalha'::text, i.value ->> 'quantidade'::text)) AS quantidade,
    upper(COALESCE(i.value ->> 'unidProdMalha'::text, i.value ->> 'unidade'::text)) AS unidade,
    fn_pcp_num(i.value ->> 'percPerdaProdMalha'::text) AS perc_perda
   FROM pcp_malha_staging s
     CROSS JOIN LATERAL jsonb_array_elements(
        CASE
            WHEN jsonb_typeof(s.payload -> 'itens'::text) = 'array'::text AND jsonb_array_length(s.payload -> 'itens'::text) > 0 THEN s.payload -> 'itens'::text
            WHEN jsonb_typeof(s.payload -> 'itensMalha'::text) = 'array'::text THEN s.payload -> 'itensMalha'::text
            ELSE '[]'::jsonb
        END) i(value);

CREATE OR REPLACE VIEW public.vw_pcp_malha_componentes
  WITH (security_invoker = true)
  AS
 SELECT m.pai_codigo,
    m.quantidade,
    m.unidade,
    m.perc_perda,
    COALESCE(byid.omie_codigo_produto, bycod.omie_codigo_produto) AS componente_codigo,
    COALESCE(byid.descricao, bycod.descricao, m.componente_descricao_omie) AS componente_descricao,
    COALESCE(byid.familia, bycod.familia) AS componente_familia
   FROM vw_pcp_malha_itens m
     LEFT JOIN omie_products byid ON byid.omie_codigo_produto = m.componente_id AND byid.account = 'colacor'::text
     LEFT JOIN LATERAL ( SELECT bp.omie_codigo_produto,
            bp.descricao,
            bp.familia
           FROM omie_products bp
          WHERE m.componente_id IS NULL AND bp.codigo = m.componente_codigo_txt AND bp.account = 'colacor'::text
          ORDER BY bp.omie_codigo_produto
         LIMIT 1) bycod ON true;

CREATE OR REPLACE VIEW public.v_pcp_malha_oben_cand
  WITH (security_invoker = true)
  AS
 WITH oben_ativo AS (
         SELECT omie_products.codigo,
            count(*) AS n,
            min(omie_products.omie_codigo_produto) AS omie
           FROM omie_products
          WHERE omie_products.account = 'oben'::text AND omie_products.ativo AND omie_products.codigo IS NOT NULL AND btrim(omie_products.codigo) <> ''::text
          GROUP BY omie_products.codigo
        ), col AS (
         SELECT omie_products.omie_codigo_produto,
            omie_products.codigo
           FROM omie_products
          WHERE omie_products.account = 'colacor'::text AND omie_products.codigo IS NOT NULL AND btrim(omie_products.codigo) <> ''::text
        ), efetivo AS (
         SELECT sku_substituicao.sku_codigo_antigo::bigint AS antigo,
            sku_substituicao.sku_codigo_novo::bigint AS novo
           FROM sku_substituicao
          WHERE sku_substituicao.empresa = 'OBEN'::text AND sku_substituicao.status = 'aplicada'::text AND sku_substituicao.acao_parametros = 'consolidar_demanda'::text AND sku_substituicao.sku_codigo_novo ~ '^\d{1,18}$'::text AND sku_substituicao.sku_codigo_antigo ~ '^\d{1,18}$'::text
        )
 SELECT m.pai_codigo,
    m.componente_codigo,
    m.quantidade,
    m.unidade AS un_ficha,
    COALESCE(m.perc_perda, 0::numeric) AS perc_perda,
    pob.n AS n_pai_oben,
    cob.n AS n_comp_oben,
    COALESCE(ep.novo, pob.omie) AS pai_oben,
    COALESCE(ec.novo, cob.omie) AS comp_oben,
    cfin.unidade AS un_estoque,
    cfin.ativo AS comp_ativo,
    pcol.codigo AS pai_codigo_prd,
    ccol.codigo AS comp_codigo_prd
   FROM vw_pcp_malha_componentes m
     LEFT JOIN col pcol ON pcol.omie_codigo_produto = m.pai_codigo
     LEFT JOIN col ccol ON ccol.omie_codigo_produto = m.componente_codigo
     LEFT JOIN oben_ativo pob ON pob.codigo = pcol.codigo
     LEFT JOIN oben_ativo cob ON cob.codigo = ccol.codigo
     LEFT JOIN efetivo ep ON ep.antigo = pob.omie
     LEFT JOIN efetivo ec ON ec.antigo = cob.omie
     LEFT JOIN omie_products cfin ON cfin.omie_codigo_produto = COALESCE(ec.novo, cob.omie) AND cfin.account = 'oben'::text;

CREATE OR REPLACE VIEW public.v_pcp_malha_oben
  WITH (security_invoker = true)
  AS
 SELECT pai_oben,
    comp_oben,
    min(quantidade) AS quantidade,
    min(un_ficha) AS unidade
   FROM v_pcp_malha_oben_cand c
  WHERE n_pai_oben = 1 AND n_comp_oben = 1 AND pai_oben IS NOT NULL AND comp_oben IS NOT NULL AND pai_oben <> comp_oben AND quantidade > 0::numeric AND perc_perda = 0::numeric AND btrim(upper(un_ficha)) = btrim(upper(un_estoque)) AND comp_ativo
  GROUP BY pai_oben, comp_oben
 HAVING count(DISTINCT quantidade) = 1 AND count(DISTINCT componente_codigo) = 1;

CREATE OR REPLACE VIEW public.v_venda_items_history_efetivo
  WITH (security_invoker = on)
  AS
 SELECT v.id,
    v.empresa,
    v.nfe_chave_acesso,
    v.nfe_numero,
    v.nfe_serie,
    v.data_emissao,
    v.cliente_codigo_omie,
    v.cliente_razao_social,
    v.cliente_cnpj_cpf,
    v.cliente_uf,
    v.cliente_cidade,
    COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,
    v.sku_codigo,
    v.sku_descricao,
    v.sku_ncm,
    v.sku_unidade,
    v.quantidade,
    v.valor_unitario,
    v.valor_total,
    v.cfop,
    v.raw_data,
    v.created_at
   FROM venda_items_history v
     LEFT JOIN sku_substituicao s ON s.empresa = v.empresa AND s.sku_codigo_antigo = v.sku_codigo_omie::text AND s.status = 'aplicada'::text AND s.acao_parametros = 'consolidar_demanda'::text AND s.sku_codigo_novo ~ '^\d+$'::text;

CREATE OR REPLACE VIEW public.v_sku_demanda_efetiva
  WITH (security_invoker = true)
  AS
 SELECT v_venda_items_history_efetivo.id,
    v_venda_items_history_efetivo.empresa,
    v_venda_items_history_efetivo.nfe_chave_acesso,
    v_venda_items_history_efetivo.nfe_numero,
    v_venda_items_history_efetivo.nfe_serie,
    v_venda_items_history_efetivo.data_emissao,
    v_venda_items_history_efetivo.cliente_codigo_omie,
    v_venda_items_history_efetivo.cliente_razao_social,
    v_venda_items_history_efetivo.cliente_cnpj_cpf,
    v_venda_items_history_efetivo.cliente_uf,
    v_venda_items_history_efetivo.cliente_cidade,
    v_venda_items_history_efetivo.sku_codigo_omie,
    v_venda_items_history_efetivo.sku_codigo,
    v_venda_items_history_efetivo.sku_descricao,
    v_venda_items_history_efetivo.sku_ncm,
    v_venda_items_history_efetivo.sku_unidade,
    v_venda_items_history_efetivo.quantidade,
    v_venda_items_history_efetivo.valor_unitario,
    v_venda_items_history_efetivo.valor_total,
    v_venda_items_history_efetivo.cfop,
    v_venda_items_history_efetivo.raw_data,
    v_venda_items_history_efetivo.created_at
   FROM v_venda_items_history_efetivo
UNION ALL
 SELECT md5((v.id::text || ':'::text) || mo.comp_oben::text)::uuid AS id,
    v.empresa,
    v.nfe_chave_acesso,
    v.nfe_numero,
    v.nfe_serie,
    v.data_emissao,
    v.cliente_codigo_omie,
    v.cliente_razao_social,
    v.cliente_cnpj_cpf,
    v.cliente_uf,
    v.cliente_cidade,
    mo.comp_oben AS sku_codigo_omie,
    ins.codigo AS sku_codigo,
    ins.descricao AS sku_descricao,
    ins.ncm AS sku_ncm,
    ins.unidade AS sku_unidade,
    v.quantidade * mo.quantidade AS quantidade,
    NULL::numeric AS valor_unitario,
    NULL::numeric AS valor_total,
    v.cfop,
    v.raw_data,
    v.created_at
   FROM v_venda_items_history_efetivo v
     JOIN v_pcp_malha_oben mo ON mo.pai_oben = v.sku_codigo_omie
     JOIN omie_products ins ON ins.omie_codigo_produto = mo.comp_oben AND ins.account = 'oben'::text
  WHERE v.empresa = 'OBEN'::text AND v.quantidade > 0::numeric AND (v.cfop = ANY (ARRAY['5101'::text, '5102'::text, '5107'::text, '5108'::text, '6101'::text, '6102'::text, '6107'::text, '6108'::text]));

CREATE OR REPLACE VIEW public.v_sku_leadtime_history_normal
  WITH (security_invoker = on)
  AS
 SELECT id,
    tracking_id,
    empresa,
    sku_codigo_omie,
    sku_codigo,
    sku_descricao,
    sku_unidade,
    sku_ncm,
    fornecedor_codigo_omie,
    fornecedor_nome,
    grupo_leadtime,
    quantidade_pedida,
    quantidade_recebida,
    valor_unitario,
    valor_total,
    t1_data_pedido,
    t2_data_faturamento,
    t3_data_cte,
    t4_data_recebimento,
    lt_bruto_dias_uteis,
    lt_faturamento_dias_uteis,
    lt_logistica_dias_uteis,
    created_at,
    updated_at,
    origem_compra
   FROM sku_leadtime_history
  WHERE origem_compra = 'normal'::text;

CREATE OR REPLACE VIEW public.v_fornecedor_lt_logistica_total
  WITH (security_invoker = on)
  AS
 SELECT empresa,
    fornecedor_nome,
    count(*) AS num_etapas,
    sum(
        CASE lt_unidade
            WHEN 'uteis'::text THEN lt_dias
            WHEN 'corridos'::text THEN ceil(lt_dias::numeric * 0.7)::integer
            ELSE lt_dias
        END) AS lt_logistica_total_dias_uteis,
    string_agg(parceiro_nome, ' → '::text ORDER BY ordem) AS cadeia_descricao
   FROM fornecedor_cadeia_logistica
  WHERE ativo = true AND (valido_ate IS NULL OR valido_ate >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date)
  GROUP BY empresa, fornecedor_nome;

CREATE OR REPLACE VIEW public.v_sku_demanda_estatisticas
  WITH (security_invoker = on)
  AS
 WITH vendas_por_ordem AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso,
            venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem,
            sum(venda_items_history.valor_total) AS valor_ordem
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '90 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.nfe_chave_acesso, venda_items_history.data_emissao
        ), stats AS (
         SELECT vendas_por_ordem.empresa,
            vendas_por_ordem.sku_codigo_omie,
            max(vendas_por_ordem.sku_descricao) AS sku_descricao,
            max(vendas_por_ordem.sku_unidade) AS sku_unidade,
            count(DISTINCT vendas_por_ordem.nfe_chave_acesso) AS num_ordens,
            sum(vendas_por_ordem.qtde_ordem) AS demanda_total_90d,
            sum(vendas_por_ordem.valor_ordem) AS valor_total_90d,
            round(avg(vendas_por_ordem.qtde_ordem), 4) AS qtde_media_por_ordem,
            round(stddev(vendas_por_ordem.qtde_ordem), 4) AS qtde_desvio_por_ordem,
            max(vendas_por_ordem.data_emissao) AS ultima_venda_data,
            round(sum(vendas_por_ordem.qtde_ordem) / 90.0, 4) AS demanda_media_diaria,
                CASE
                    WHEN avg(vendas_por_ordem.qtde_ordem) > 0::numeric AND count(*) >= 2 THEN round(stddev(vendas_por_ordem.qtde_ordem) / avg(vendas_por_ordem.qtde_ordem), 4)
                    ELSE NULL::numeric
                END AS coef_variacao_ordem
           FROM vendas_por_ordem
          GROUP BY vendas_por_ordem.empresa, vendas_por_ordem.sku_codigo_omie
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    sku_unidade,
    num_ordens,
    demanda_total_90d,
    valor_total_90d,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    demanda_media_diaria,
    coef_variacao_ordem,
    ultima_venda_data
   FROM stats;

CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo
  WITH (security_invoker = on)
  AS
 WITH base AS (
         SELECT h.empresa,
            h.sku_codigo_omie,
            COALESCE(pot.nfe_chave_acesso, 'tracking:'::text || h.tracking_id::text) AS dedup_key,
            pot.nfe_chave_acesso,
            h.sku_codigo,
            h.sku_descricao,
            h.sku_unidade,
            h.sku_ncm,
            h.fornecedor_codigo_omie,
            h.fornecedor_nome,
            h.grupo_leadtime,
            h.quantidade_pedida,
            h.quantidade_recebida,
            h.valor_unitario,
            h.valor_total,
            h.t1_data_pedido,
            h.t2_data_faturamento,
            h.t3_data_cte,
            h.t4_data_recebimento,
            h.lt_bruto_dias_uteis,
            h.lt_faturamento_dias_uteis,
            h.lt_logistica_dias_uteis,
            h.origem_compra
           FROM v_sku_leadtime_history_normal h
             LEFT JOIN purchase_orders_tracking pot ON pot.id = h.tracking_id
        )
 SELECT empresa,
    sku_codigo_omie,
    dedup_key,
    max(nfe_chave_acesso) AS nfe_chave_acesso,
    count(*) AS n_copias_origem,
    count(*) > 1 AS veio_de_duplicata,
    max(sku_codigo) AS sku_codigo,
    max(sku_descricao) AS sku_descricao,
    max(sku_unidade) AS sku_unidade,
    max(sku_ncm) AS sku_ncm,
    max(fornecedor_nome) AS fornecedor_nome,
    max(grupo_leadtime) AS grupo_leadtime,
    max(origem_compra) AS origem_compra,
        CASE
            WHEN count(fornecedor_codigo_omie) = count(*) AND count(DISTINCT fornecedor_codigo_omie) = 1 THEN min(fornecedor_codigo_omie)
            ELSE NULL::bigint
        END AS fornecedor_codigo_omie,
        CASE
            WHEN count(quantidade_pedida) = count(*) AND count(DISTINCT quantidade_pedida) = 1 THEN min(quantidade_pedida)
            ELSE NULL::numeric
        END AS quantidade_pedida,
        CASE
            WHEN count(quantidade_recebida) = count(*) AND count(DISTINCT quantidade_recebida) = 1 THEN min(quantidade_recebida)
            ELSE NULL::numeric
        END AS quantidade_recebida,
        CASE
            WHEN count(valor_unitario) = count(*) AND count(DISTINCT valor_unitario) = 1 THEN min(valor_unitario)
            ELSE NULL::numeric
        END AS valor_unitario,
        CASE
            WHEN count(valor_total) = count(*) AND count(DISTINCT valor_total) = 1 THEN min(valor_total)
            ELSE NULL::numeric
        END AS valor_total,
        CASE
            WHEN count(t1_data_pedido) = count(*) AND count(DISTINCT t1_data_pedido) = 1 THEN min(t1_data_pedido)
            ELSE NULL::timestamp with time zone
        END AS t1_data_pedido,
        CASE
            WHEN count(t2_data_faturamento) = count(*) AND count(DISTINCT t2_data_faturamento) = 1 THEN min(t2_data_faturamento)
            ELSE NULL::timestamp with time zone
        END AS t2_data_faturamento,
        CASE
            WHEN count(t3_data_cte) = count(*) AND count(DISTINCT t3_data_cte) = 1 THEN min(t3_data_cte)
            ELSE NULL::timestamp with time zone
        END AS t3_data_cte,
        CASE
            WHEN count(t4_data_recebimento) = count(*) AND count(DISTINCT t4_data_recebimento) = 1 THEN min(t4_data_recebimento)
            ELSE NULL::timestamp with time zone
        END AS t4_data_recebimento,
        CASE
            WHEN count(lt_bruto_dias_uteis) = count(*) AND count(DISTINCT lt_bruto_dias_uteis) = 1 THEN min(lt_bruto_dias_uteis)
            ELSE NULL::integer
        END AS lt_bruto_dias_uteis,
        CASE
            WHEN count(lt_faturamento_dias_uteis) = count(*) AND count(DISTINCT lt_faturamento_dias_uteis) = 1 THEN min(lt_faturamento_dias_uteis)
            ELSE NULL::integer
        END AS lt_faturamento_dias_uteis,
        CASE
            WHEN count(lt_logistica_dias_uteis) = count(*) AND count(DISTINCT lt_logistica_dias_uteis) = 1 THEN min(lt_logistica_dias_uteis)
            ELSE NULL::integer
        END AS lt_logistica_dias_uteis
   FROM base b
  GROUP BY empresa, dedup_key, sku_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_classificacao_abc_xyz
  WITH (security_invoker = on)
  AS
 WITH base_demanda AS (
         SELECT v_sku_demanda_estatisticas.empresa,
            v_sku_demanda_estatisticas.sku_codigo_omie,
            v_sku_demanda_estatisticas.sku_descricao,
            v_sku_demanda_estatisticas.num_ordens,
            v_sku_demanda_estatisticas.demanda_media_diaria,
            v_sku_demanda_estatisticas.qtde_media_por_ordem,
            v_sku_demanda_estatisticas.qtde_desvio_por_ordem,
            v_sku_demanda_estatisticas.coef_variacao_ordem,
            v_sku_demanda_estatisticas.valor_total_90d
           FROM v_sku_demanda_estatisticas
        ), abc_base AS (
         SELECT base_demanda.empresa,
            base_demanda.sku_codigo_omie,
            base_demanda.sku_descricao,
            base_demanda.num_ordens,
            base_demanda.demanda_media_diaria,
            base_demanda.qtde_media_por_ordem,
            base_demanda.qtde_desvio_por_ordem,
            base_demanda.coef_variacao_ordem,
            base_demanda.valor_total_90d,
            sum(base_demanda.valor_total_90d) OVER (PARTITION BY base_demanda.empresa ORDER BY base_demanda.valor_total_90d DESC) AS acumulado,
            sum(base_demanda.valor_total_90d) OVER (PARTITION BY base_demanda.empresa) AS total_geral
           FROM base_demanda
        ), abc_classificada AS (
         SELECT abc_base.empresa,
            abc_base.sku_codigo_omie,
            abc_base.sku_descricao,
            abc_base.num_ordens,
            abc_base.demanda_media_diaria,
            abc_base.qtde_media_por_ordem,
            abc_base.qtde_desvio_por_ordem,
            abc_base.coef_variacao_ordem,
            abc_base.valor_total_90d,
            abc_base.acumulado,
            abc_base.total_geral,
                CASE
                    WHEN abc_base.total_geral IS NULL OR abc_base.total_geral = 0::numeric THEN 'C'::text
                    WHEN (abc_base.acumulado / NULLIF(abc_base.total_geral, 0::numeric)) <= 0.80 THEN 'A'::text
                    WHEN (abc_base.acumulado / NULLIF(abc_base.total_geral, 0::numeric)) <= 0.95 THEN 'B'::text
                    ELSE 'C'::text
                END AS classe_abc_proposta
           FROM abc_base
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    num_ordens,
    valor_total_90d,
    demanda_media_diaria,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    coef_variacao_ordem,
    classe_abc_proposta,
        CASE
            WHEN num_ordens < 2 THEN 'Z'::text
            WHEN coef_variacao_ordem IS NULL THEN 'Z'::text
            WHEN coef_variacao_ordem < 0.4 THEN 'X'::text
            WHEN coef_variacao_ordem < 0.8 THEN 'Y'::text
            ELSE 'Z'::text
        END AS classe_xyz_proposta,
    classe_abc_proposta ||
        CASE
            WHEN num_ordens < 2 THEN 'Z'::text
            WHEN coef_variacao_ordem IS NULL THEN 'Z'::text
            WHEN coef_variacao_ordem < 0.4 THEN 'X'::text
            WHEN coef_variacao_ordem < 0.8 THEN 'Y'::text
            ELSE 'Z'::text
        END AS classe_consolidada_proposta
   FROM abc_classificada;

CREATE OR REPLACE VIEW public.v_sku_demanda_rajada
  WITH (security_invoker = on)
  AS
 WITH datas_serie AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '179 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.data_emissao
        ), serie_completa AS (
         SELECT s.empresa,
            s.sku_codigo_omie,
            s.sku_descricao,
            s.sku_unidade,
            d.dt,
            COALESCE(v.qtde_dia, 0::numeric) AS qtde_dia,
            COALESCE(v.valor_dia, 0::numeric) AS valor_dia
           FROM skus_ativos s
             CROSS JOIN datas_serie d
             LEFT JOIN vendas_diarias v ON s.empresa = v.empresa AND s.sku_codigo_omie = v.sku_codigo_omie AND d.dt = v.dt
        )
 SELECT empresa,
    sku_codigo_omie,
    max(sku_descricao) AS sku_descricao,
    max(sku_unidade) AS sku_unidade,
    round(avg(qtde_dia), 4) AS demanda_media_diaria,
    round(stddev(qtde_dia), 4) AS demanda_desvio_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p90_diario,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p95_diario,
    round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p99_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p90_quando_vende,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p95_quando_vende,
    max(qtde_dia) AS pico_maximo_dia,
    count(*) FILTER (WHERE qtde_dia > 0::numeric) AS dias_com_movimento,
    sum(qtde_dia) AS qtde_total_180d,
    round(sum(valor_dia), 2) AS valor_total_180d
   FROM serie_completa
  GROUP BY empresa, sku_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_leadtime_estatisticas
  WITH (security_invoker = on)
  AS
 WITH stats AS (
         SELECT h.empresa::text AS empresa,
            h.sku_codigo_omie,
            max(h.sku_descricao) AS sku_descricao,
            max(h.fornecedor_codigo_omie) AS fornecedor_codigo_omie,
            max(h.fornecedor_nome) AS fornecedor_nome,
            count(*) FILTER (WHERE h.lt_bruto_dias_uteis IS NOT NULL) AS lt_n_observacoes,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_sku_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_sku_desvio,
            percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_p95_dias
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.sku_codigo_omie
        ), fornecedor_stats AS (
         SELECT h.empresa::text AS empresa,
            h.fornecedor_codigo_omie,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_desvio,
            count(*) AS lt_fornecedor_n_observacoes
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.fornecedor_codigo_omie
        )
 SELECT s.empresa,
    s.sku_codigo_omie,
    s.sku_descricao,
    s.fornecedor_codigo_omie,
    s.fornecedor_nome,
    s.lt_n_observacoes,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_medio
            ELSE f.lt_fornecedor_medio
        END AS lt_medio_dias_uteis,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_desvio
            ELSE f.lt_fornecedor_desvio
        END AS lt_desvio_padrao_dias,
    s.lt_p95_dias,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN 'SKU'::text
            ELSE 'FORNECEDOR'::text
        END AS fonte_leadtime,
    f.lt_fornecedor_desvio,
    f.lt_fornecedor_n_observacoes
   FROM stats s
     LEFT JOIN fornecedor_stats f ON s.empresa = f.empresa AND s.fornecedor_codigo_omie = f.fornecedor_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_lt_teorico
  WITH (security_invoker = on)
  AS
 SELECT sg.empresa,
    sg.sku_codigo_omie,
    sg.grupo_codigo,
    gp.lt_producao_dias,
    gp.lt_producao_unidade,
    COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint) AS lt_logistica_dias,
    'uteis'::text AS lt_logistica_unidade,
    llt.cadeia_descricao,
    llt.num_etapas AS num_etapas_logistica,
        CASE gp.lt_producao_unidade
            WHEN 'uteis'::text THEN gp.lt_producao_dias + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
            WHEN 'corridos'::text THEN ceil(gp.lt_producao_dias::numeric * 0.7)::integer + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
            ELSE gp.lt_producao_dias + COALESCE(llt.lt_logistica_total_dias_uteis, 0::bigint)
        END AS lt_total_teorico_dias_uteis,
    gp.horario_corte
   FROM sku_grupo_producao sg
     JOIN sku_parametros sp ON sp.empresa = sg.empresa AND sp.sku_codigo_omie::text = sg.sku_codigo_omie
     JOIN fornecedor_grupo_producao gp ON gp.empresa = sg.empresa AND gp.grupo_codigo = sg.grupo_codigo AND gp.fornecedor_nome = sp.fornecedor_nome
     LEFT JOIN v_fornecedor_lt_logistica_total llt ON llt.empresa = sg.empresa AND llt.fornecedor_nome = sp.fornecedor_nome;

CREATE OR REPLACE VIEW public.v_sku_sigma_demanda
  WITH (security_invoker = on)
  AS
 WITH datas AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text), venda_items_history.data_emissao
        ), serie AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            d.dt,
            COALESCE(sum(vd.qtde), 0::numeric) AS qtde
           FROM ( SELECT DISTINCT vendas_diarias.empresa,
                    vendas_diarias.sku_codigo_omie
                   FROM vendas_diarias) v
             CROSS JOIN datas d
             LEFT JOIN vendas_diarias vd ON vd.empresa = v.empresa AND vd.sku_codigo_omie = v.sku_codigo_omie AND vd.dt = d.dt
          GROUP BY v.empresa, v.sku_codigo_omie, d.dt
        )
 SELECT empresa,
    sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;

CREATE OR REPLACE VIEW public.v_promocao_item_efetivo
  WITH (security_invoker = on)
  AS
 SELECT id,
    campanha_id,
    sku_codigo_fornecedor,
    sku_codigo_omie,
    desconto_perc AS desconto_base,
    desconto_extra_perc AS desconto_extra,
    LEAST(99::numeric, desconto_perc + COALESCE(desconto_extra_perc, 0::numeric)) AS desconto_efetivo,
    COALESCE(desconto_extra_perc, 0::numeric) > 0::numeric AS tem_negociacao_extra,
    desconto_extra_negociado_em,
    desconto_extra_negociado_por,
    desconto_extra_observacoes,
    desconto_extra_email_referencia,
    volume_minimo,
    confirmado,
    ativo
   FROM promocao_item pi;

CREATE OR REPLACE VIEW public.v_sku_aumento_vigente
  WITH (security_invoker = on)
  AS
 SELECT DISTINCT op.account AS empresa_lower,
    op.omie_codigo_produto AS sku_codigo_omie,
    op.descricao AS sku_descricao,
    op.familia,
    fa.id AS aumento_id,
    fa.fornecedor_nome,
    fa.nome AS aumento_nome,
    COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) AS data_vigencia_efetiva,
    fai.aumento_perc,
    fai.categoria_fornecedor,
    fai.id AS aumento_item_id,
    fa.estado AS aumento_estado
   FROM fornecedor_aumento_anunciado fa
     JOIN fornecedor_aumento_item fai ON fai.aumento_id = fa.id
     JOIN categoria_aumento_familia_mapeamento m ON m.aumento_item_id = fai.id
     JOIN omie_products op ON op.familia = m.familia_omie AND lower(op.account) = lower(fa.empresa) AND COALESCE(op.ativo, true) = true AND (m.sku_codigo_omie_especifico IS NULL OR op.omie_codigo_produto = m.sku_codigo_omie_especifico)
  WHERE (fa.estado = ANY (ARRAY['ativo'::text, 'vigente'::text])) AND fai.ativo = true AND fai.confirmado = true AND COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '7 days'::interval);

CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos
  WITH (security_invoker = on)
  AS
 WITH minimo_operacional AS (
         SELECT 'A'::text AS letra_abc,
            2 AS min_op
        UNION ALL
         SELECT 'B'::text AS text,
            1
        UNION ALL
         SELECT 'C'::text AS text,
            0
        ), config_efetiva AS (
         SELECT empresa_configuracao_custos.empresa,
            (empresa_configuracao_custos.selic_anual + empresa_configuracao_custos.spread_oportunidade + empresa_configuracao_custos.armazenagem_fisica) / 100.0 AS cm_anual,
                CASE
                    WHEN empresa_configuracao_custos.modo_pedido = 'api'::text THEN empresa_configuracao_custos.custo_pedido_api
                    ELSE empresa_configuracao_custos.custo_pedido_manual
                END AS cp,
            empresa_configuracao_custos.z_classe_a,
            empresa_configuracao_custos.z_classe_b,
            empresa_configuracao_custos.z_classe_c,
            empresa_configuracao_custos.modo_pedido
           FROM empresa_configuracao_custos
        ), precos_compra AS (
         SELECT v_sku_leadtime_efetivo.empresa::text AS empresa,
            v_sku_leadtime_efetivo.sku_codigo_omie::text AS sku_codigo_omie,
            avg(v_sku_leadtime_efetivo.valor_total / NULLIF(v_sku_leadtime_efetivo.quantidade_recebida, 0::numeric)) AS preco_compra_real,
            count(*) AS n_compras
           FROM v_sku_leadtime_efetivo
          WHERE v_sku_leadtime_efetivo.quantidade_recebida > 0::numeric AND v_sku_leadtime_efetivo.valor_total > 0::numeric
          GROUP BY (v_sku_leadtime_efetivo.empresa::text), (v_sku_leadtime_efetivo.sku_codigo_omie::text)
        ), precos_venda AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            avg(venda_items_history.valor_total / NULLIF(venda_items_history.quantidade, 0::numeric)) AS preco_venda_medio
           FROM venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AND venda_items_history.quantidade > 0::numeric
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text)
        ), precos_cmc AS (
         SELECT DISTINCT ON (m.empresa, m.sku_codigo_omie) m.empresa,
            m.sku_codigo_omie,
            m.cmc
           FROM ( SELECT
                        CASE
                            WHEN ip.account = ANY (ARRAY['vendas'::text, 'oben'::text]) THEN 'OBEN'::text
                            WHEN ip.account = ANY (ARRAY['colacor_vendas'::text, 'colacor'::text]) THEN 'COLACOR'::text
                            WHEN ip.account = ANY (ARRAY['servicos'::text, 'colacor_sc'::text]) THEN 'COLACOR_SC'::text
                            ELSE NULL::text
                        END AS empresa,
                    ip.omie_codigo_produto::text AS sku_codigo_omie,
                    ip.cmc,
                    ip.synced_at
                   FROM inventory_position ip
                  WHERE ip.cmc > 0::numeric) m
          WHERE m.empresa IS NOT NULL
          ORDER BY m.empresa, m.sku_codigo_omie, (m.cmc > 0::numeric) DESC, m.synced_at DESC NULLS LAST
        ), base AS (
         SELECT c.empresa,
            c.sku_codigo_omie,
            c.sku_descricao,
            c.valor_total_90d,
            c.num_ordens,
            c.demanda_media_diaria AS d,
            c.qtde_media_por_ordem,
            c.qtde_desvio_por_ordem,
            c.coef_variacao_ordem,
            c.classe_abc_proposta,
            c.classe_xyz_proposta,
            c.classe_consolidada_proposta AS classe,
            r.p90_diario,
            r.p95_diario,
            r.p99_diario,
            r.p90_quando_vende,
            r.p95_quando_vende,
            r.pico_maximo_dia,
            r.dias_com_movimento,
            r.valor_total_180d,
            COALESCE(sd.sigma_demanda_diaria, c.demanda_media_diaria * 0.5) AS sigma_d,
            GREATEST(lts.lt_total_teorico_dias_uteis::numeric, lt.lt_medio_dias_uteis) AS lt,
            COALESCE(lt.lt_desvio_padrao_dias, lt.lt_fornecedor_desvio, COALESCE(lts.lt_total_teorico_dias_uteis, 10::bigint)::numeric * 0.3) AS sigma_lt,
            lts.lt_total_teorico_dias_uteis,
            lt.lt_medio_dias_uteis AS lt_historico_medio,
                CASE
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL AND lt.lt_medio_dias_uteis IS NULL THEN 'sem_dados'::text
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'historico_medio'::text
                    WHEN lt.lt_medio_dias_uteis IS NULL THEN 'sla_teorico'::text
                    WHEN lt.lt_medio_dias_uteis > lts.lt_total_teorico_dias_uteis::numeric THEN 'historico_sobrepos_teorico'::text
                    ELSE 'sla_teorico'::text
                END AS fonte_lt,
            lts.grupo_codigo,
            lt.lt_p95_dias,
            lt.fonte_leadtime,
            COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome) AS fornecedor_nome,
                CASE
                    WHEN lt.fornecedor_nome IS NOT NULL THEN 'historico_compras'::text
                    WHEN fgp.fornecedor_nome IS NOT NULL THEN 'grupo_producao'::text
                    ELSE NULL::text
                END AS fonte_fornecedor,
            pv.preco_venda_medio,
            pc.preco_compra_real,
            pc.n_compras,
            COALESCE(NULLIF(( SELECT pcc.cmc
                   FROM precos_cmc pcc
                  WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric), pc.preco_compra_real, pv.preco_venda_medio * 0.55) AS preco_item_eoq,
                CASE
                    WHEN NULLIF(( SELECT pcc.cmc
                       FROM precos_cmc pcc
                      WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric) IS NOT NULL THEN 'cmc'::text
                    WHEN pc.preco_compra_real IS NOT NULL THEN 'compra_real'::text
                    WHEN pv.preco_venda_medio IS NOT NULL THEN 'venda_estimado'::text
                    ELSE 'sem_preco'::text
                END AS fonte_preco,
            COALESCE(fh.habilitado, false) AS fornecedor_habilitado,
            cfg.cm_anual,
            cfg.cp,
            cfg.z_classe_a,
            cfg.z_classe_b,
            cfg.z_classe_c,
            cfg.modo_pedido,
            mop.min_op AS minimo_operacional,
                CASE c.classe_abc_proposta
                    WHEN 'A'::text THEN cfg.z_classe_a
                    WHEN 'B'::text THEN cfg.z_classe_b
                    ELSE cfg.z_classe_c
                END AS z_aplicado
           FROM v_sku_classificacao_abc_xyz c
             LEFT JOIN v_sku_demanda_rajada r ON c.empresa = r.empresa AND c.sku_codigo_omie = r.sku_codigo_omie
             LEFT JOIN v_sku_leadtime_estatisticas lt ON c.empresa = lt.empresa AND c.sku_codigo_omie = lt.sku_codigo_omie
             LEFT JOIN v_sku_lt_teorico lts ON c.empresa = lts.empresa AND c.sku_codigo_omie::text = lts.sku_codigo_omie
             LEFT JOIN v_sku_sigma_demanda sd ON c.empresa = sd.empresa AND c.sku_codigo_omie::text = sd.sku_codigo_omie
             LEFT JOIN precos_venda pv ON c.empresa = pv.empresa AND c.sku_codigo_omie::text = pv.sku_codigo_omie
             LEFT JOIN precos_compra pc ON c.empresa = pc.empresa AND c.sku_codigo_omie::text = pc.sku_codigo_omie
             LEFT JOIN config_efetiva cfg ON c.empresa = cfg.empresa
             LEFT JOIN minimo_operacional mop ON c.classe_abc_proposta = mop.letra_abc
             LEFT JOIN fornecedor_grupo_producao fgp ON fgp.empresa = c.empresa AND fgp.grupo_codigo = lts.grupo_codigo
             LEFT JOIN fornecedor_habilitado_reposicao fh ON c.empresa = fh.empresa AND fh.fornecedor_nome = COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome)
        ), com_calculos AS (
         SELECT base.empresa,
            base.sku_codigo_omie,
            base.sku_descricao,
            base.valor_total_90d,
            base.num_ordens,
            base.d,
            base.qtde_media_por_ordem,
            base.qtde_desvio_por_ordem,
            base.coef_variacao_ordem,
            base.classe_abc_proposta,
            base.classe_xyz_proposta,
            base.classe,
            base.p90_diario,
            base.p95_diario,
            base.p99_diario,
            base.p90_quando_vende,
            base.p95_quando_vende,
            base.pico_maximo_dia,
            base.dias_com_movimento,
            base.valor_total_180d,
            base.sigma_d,
            base.lt,
            base.sigma_lt,
            base.lt_total_teorico_dias_uteis,
            base.lt_historico_medio,
            base.fonte_lt,
            base.grupo_codigo,
            base.lt_p95_dias,
            base.fonte_leadtime,
            base.fornecedor_nome,
            base.fonte_fornecedor,
            base.preco_venda_medio,
            base.preco_compra_real,
            base.n_compras,
            base.preco_item_eoq,
            base.fonte_preco,
            base.fornecedor_habilitado,
            base.cm_anual,
            base.cp,
            base.z_classe_a,
            base.z_classe_b,
            base.z_classe_c,
            base.modo_pedido,
            base.minimo_operacional,
            base.z_aplicado,
            sqrt(COALESCE(base.lt, 10::numeric) * power(COALESCE(base.sigma_d, 0::numeric), 2::numeric) + power(COALESCE(base.d, 0::numeric), 2::numeric) * power(COALESCE(base.sigma_lt, 0::numeric), 2::numeric)) AS sigma_lt_d,
                CASE
                    WHEN base.num_ordens < 2 THEN 'AGUARDANDO_SEGUNDA_ORDEM'::text
                    WHEN base.lt IS NULL THEN 'SEM_LEADTIME_DEFINIDO'::text
                    WHEN base.fornecedor_nome IS NULL THEN 'SEM_FORNECEDOR_IDENTIFICADO'::text
                    WHEN NOT base.fornecedor_habilitado THEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text
                    WHEN base.grupo_codigo IS NULL AND base.fornecedor_nome = 'RENNER SAYERLACK S/A'::text THEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text
                    WHEN base.preco_item_eoq IS NULL OR base.preco_item_eoq = 0::numeric THEN 'SEM_PRECO'::text
                    ELSE 'OK'::text
                END AS status_sugestao
           FROM base
        ), com_formulas AS (
         SELECT com_calculos.empresa,
            com_calculos.sku_codigo_omie,
            com_calculos.sku_descricao,
            com_calculos.valor_total_90d,
            com_calculos.num_ordens,
            com_calculos.d,
            com_calculos.qtde_media_por_ordem,
            com_calculos.qtde_desvio_por_ordem,
            com_calculos.coef_variacao_ordem,
            com_calculos.classe_abc_proposta,
            com_calculos.classe_xyz_proposta,
            com_calculos.classe,
            com_calculos.p90_diario,
            com_calculos.p95_diario,
            com_calculos.p99_diario,
            com_calculos.p90_quando_vende,
            com_calculos.p95_quando_vende,
            com_calculos.pico_maximo_dia,
            com_calculos.dias_com_movimento,
            com_calculos.valor_total_180d,
            com_calculos.sigma_d,
            com_calculos.lt,
            com_calculos.sigma_lt,
            com_calculos.lt_total_teorico_dias_uteis,
            com_calculos.lt_historico_medio,
            com_calculos.fonte_lt,
            com_calculos.grupo_codigo,
            com_calculos.lt_p95_dias,
            com_calculos.fonte_leadtime,
            com_calculos.fornecedor_nome,
            com_calculos.fonte_fornecedor,
            com_calculos.preco_venda_medio,
            com_calculos.preco_compra_real,
            com_calculos.n_compras,
            com_calculos.preco_item_eoq,
            com_calculos.fonte_preco,
            com_calculos.fornecedor_habilitado,
            com_calculos.cm_anual,
            com_calculos.cp,
            com_calculos.z_classe_a,
            com_calculos.z_classe_b,
            com_calculos.z_classe_c,
            com_calculos.modo_pedido,
            com_calculos.minimo_operacional,
            com_calculos.z_aplicado,
            com_calculos.sigma_lt_d,
            com_calculos.status_sugestao,
            ceil(com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS ss_calculado,
            ceil(COALESCE(com_calculos.d, 0::numeric) * COALESCE(com_calculos.lt, 10::numeric) + com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS pp_calculado,
                CASE
                    WHEN com_calculos.preco_item_eoq > 0::numeric AND com_calculos.cm_anual > 0::numeric AND com_calculos.d > 0::numeric THEN ceil(sqrt(2.0 * (COALESCE(com_calculos.d, 0::numeric) * 252::numeric) * com_calculos.cp / (com_calculos.cm_anual * com_calculos.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq
           FROM com_calculos
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    fornecedor_habilitado,
    fonte_fornecedor,
    grupo_codigo,
    classe_abc_proposta,
    classe_xyz_proposta,
    classe AS classe_consolidada,
    num_ordens,
    d AS demanda_media_diaria,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    coef_variacao_ordem,
    p90_diario,
    p95_diario,
    p99_diario,
    p90_quando_vende,
    p95_quando_vende,
    pico_maximo_dia,
    dias_com_movimento,
    valor_total_180d,
    sigma_d AS demanda_sigma_diario,
    lt AS lead_time_medio,
    lt_total_teorico_dias_uteis,
    lt_historico_medio,
    fonte_lt,
    sigma_lt AS lead_time_desvio,
    lt_p95_dias,
    fonte_leadtime,
    sigma_lt_d,
    z_aplicado,
    minimo_operacional,
    preco_venda_medio,
    preco_compra_real,
    preco_item_eoq,
    fonte_preco,
    n_compras,
    cm_anual * 100::numeric AS custo_capital_efetivo_perc,
    cp AS custo_pedido_aplicado,
    modo_pedido,
    status_sugestao,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric)
            ELSE NULL::numeric
        END AS estoque_minimo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric)
            ELSE NULL::numeric
        END AS ponto_pedido_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS qtde_compra_ciclo_sugerida,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric) + GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS estoque_maximo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text AND d > 0::numeric THEN ceil(GREATEST(qc_eoq, 1::numeric) / d)::integer
            ELSE NULL::integer
        END AS cobertura_alvo_dias,
    COALESCE(valor_total_90d, valor_total_180d) AS valor_total_90d,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS calculado_em,
        CASE
            WHEN status_sugestao = 'OK'::text THEN ss_calculado
            ELSE NULL::numeric
        END AS estoque_seguranca_sugerido
   FROM com_formulas
  ORDER BY (
        CASE status_sugestao
            WHEN 'OK'::text THEN 1
            WHEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text THEN 2
            WHEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text THEN 3
            WHEN 'SEM_LEADTIME_DEFINIDO'::text THEN 4
            WHEN 'SEM_PRECO'::text THEN 5
            ELSE 6
        END), valor_total_180d DESC NULLS LAST;

CREATE OR REPLACE VIEW public.v_promocao_avaliacao_hoje
  WITH (security_invoker = on)
  AS
 WITH campanhas_ativas AS (
         SELECT pc.id AS campanha_id,
            pc.empresa,
            pc.fornecedor_nome,
            pc.nome AS campanha_nome,
            pc.data_inicio,
            pc.data_fim,
            pc.tipo_origem
           FROM promocao_campanha pc
          WHERE pc.estado = 'ativa'::text AND CURRENT_DATE >= pc.data_inicio AND CURRENT_DATE <= pc.data_fim
        ), itens_ativos AS (
         SELECT ca.campanha_id,
            ca.empresa,
            ca.fornecedor_nome,
            ca.campanha_nome,
            ca.data_inicio,
            ca.data_fim,
            ca.tipo_origem,
            pi.id AS item_id,
            pi.sku_codigo_fornecedor,
            pi.sku_codigo_omie,
            ef.desconto_efetivo AS desconto_perc,
            ef.desconto_base,
            ef.desconto_extra,
            ef.tem_negociacao_extra,
            pi.volume_minimo,
            pi.confirmado
           FROM campanhas_ativas ca
             JOIN promocao_item pi ON pi.campanha_id = ca.campanha_id
             JOIN v_promocao_item_efetivo ef ON ef.id = pi.id
          WHERE pi.ativo = true AND pi.confirmado = true AND pi.sku_codigo_omie IS NOT NULL
        ), com_parametros AS (
         SELECT ia.campanha_id,
            ia.empresa,
            ia.fornecedor_nome,
            ia.campanha_nome,
            ia.data_inicio,
            ia.data_fim,
            ia.tipo_origem,
            ia.item_id,
            ia.sku_codigo_fornecedor,
            ia.sku_codigo_omie,
            ia.desconto_perc,
            ia.desconto_base,
            ia.desconto_extra,
            ia.tem_negociacao_extra,
            ia.volume_minimo,
            ia.confirmado,
            sp.sku_descricao,
            sp.demanda_media_diaria AS d,
            vps.qtde_compra_ciclo_sugerida AS qtde_base,
            vps.custo_capital_efetivo_perc,
            vps.preco_item_eoq,
                CASE
                    WHEN ia.volume_minimo IS NULL THEN 'flat'::text
                    ELSE 'forward_buying'::text
                END AS modo_aplicacao
           FROM itens_ativos ia
             JOIN sku_parametros sp ON sp.empresa = ia.empresa AND sp.sku_codigo_omie = ia.sku_codigo_omie AND sp.ativo = true
             LEFT JOIN v_sku_parametros_sugeridos vps ON vps.empresa = sp.empresa AND vps.sku_codigo_omie = sp.sku_codigo_omie
        ), com_calculos AS (
         SELECT cp.campanha_id,
            cp.empresa,
            cp.fornecedor_nome,
            cp.campanha_nome,
            cp.data_inicio,
            cp.data_fim,
            cp.tipo_origem,
            cp.item_id,
            cp.sku_codigo_fornecedor,
            cp.sku_codigo_omie,
            cp.desconto_perc,
            cp.desconto_base,
            cp.desconto_extra,
            cp.tem_negociacao_extra,
            cp.volume_minimo,
            cp.confirmado,
            cp.sku_descricao,
            cp.d,
            cp.qtde_base,
            cp.custo_capital_efetivo_perc,
            cp.preco_item_eoq,
            cp.modo_aplicacao,
                CASE
                    WHEN cp.modo_aplicacao = 'flat'::text THEN cp.qtde_base
                    ELSE GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric))
                END AS qtde_com_desconto,
                CASE
                    WHEN cp.modo_aplicacao = 'flat'::text THEN 0::numeric
                    ELSE GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)
                END AS qtde_extra,
                CASE
                    WHEN cp.modo_aplicacao = 'forward_buying'::text AND cp.d > 0::numeric THEN round((GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)) / cp.d, 1)
                    ELSE 0::numeric
                END AS dias_extra_estoque,
                CASE
                    WHEN cp.modo_aplicacao = 'forward_buying'::text AND cp.d > 0::numeric THEN round(cp.custo_capital_efetivo_perc * ((GREATEST(COALESCE(cp.qtde_base, 0::numeric), COALESCE(cp.volume_minimo, 0::numeric)) - COALESCE(cp.qtde_base, 0::numeric)) / cp.d) / 365::numeric, 3)
                    ELSE 0::numeric
                END AS custo_capital_periodo_perc
           FROM com_parametros cp
        ), com_economia AS (
         SELECT com_calculos.campanha_id,
            com_calculos.empresa,
            com_calculos.fornecedor_nome,
            com_calculos.campanha_nome,
            com_calculos.data_inicio,
            com_calculos.data_fim,
            com_calculos.tipo_origem,
            com_calculos.item_id,
            com_calculos.sku_codigo_fornecedor,
            com_calculos.sku_codigo_omie,
            com_calculos.desconto_perc,
            com_calculos.desconto_base,
            com_calculos.desconto_extra,
            com_calculos.tem_negociacao_extra,
            com_calculos.volume_minimo,
            com_calculos.confirmado,
            com_calculos.sku_descricao,
            com_calculos.d,
            com_calculos.qtde_base,
            com_calculos.custo_capital_efetivo_perc,
            com_calculos.preco_item_eoq,
            com_calculos.modo_aplicacao,
            com_calculos.qtde_com_desconto,
            com_calculos.qtde_extra,
            com_calculos.dias_extra_estoque,
            com_calculos.custo_capital_periodo_perc,
            round(com_calculos.desconto_perc - com_calculos.custo_capital_periodo_perc, 2) AS economia_liquida_perc,
                CASE
                    WHEN com_calculos.preco_item_eoq IS NOT NULL THEN round(com_calculos.qtde_com_desconto * com_calculos.preco_item_eoq * com_calculos.desconto_perc / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_bruta_valor,
                CASE
                    WHEN com_calculos.preco_item_eoq IS NOT NULL THEN round(com_calculos.qtde_com_desconto * com_calculos.preco_item_eoq * (com_calculos.desconto_perc - com_calculos.custo_capital_periodo_perc) / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_liquida_valor
           FROM com_calculos
        )
 SELECT DISTINCT ON (empresa, sku_codigo_omie) campanha_id,
    campanha_nome,
    tipo_origem,
    data_inicio,
    data_fim,
    item_id,
    sku_codigo_fornecedor,
    sku_codigo_omie,
    sku_descricao,
    empresa,
    fornecedor_nome,
    modo_aplicacao,
    desconto_perc,
    desconto_base,
    desconto_extra,
    tem_negociacao_extra,
    volume_minimo,
    qtde_base,
    qtde_com_desconto,
    qtde_extra,
    dias_extra_estoque,
    custo_capital_periodo_perc,
    economia_liquida_perc,
    economia_bruta_valor,
    economia_liquida_valor
   FROM com_economia
  WHERE modo_aplicacao = 'flat'::text OR modo_aplicacao = 'forward_buying'::text AND economia_liquida_perc > 0::numeric
  ORDER BY empresa, sku_codigo_omie, economia_liquida_valor DESC NULLS LAST, desconto_perc DESC;

CREATE OR REPLACE VIEW public.v_oportunidade_economica_hoje
  WITH (security_invoker = on)
  AS
 WITH promo_por_sku AS (
         SELECT pc.empresa,
            pc.id AS campanha_id,
            pc.nome AS campanha_nome,
            pc.data_corte_pedido,
            pc.data_corte_faturamento,
            pi.id AS item_id,
            pi.sku_codigo_omie,
            pi.volume_minimo,
            ef.desconto_efetivo AS desconto_promo_perc,
            ef.tem_negociacao_extra,
                CASE
                    WHEN pi.volume_minimo IS NULL THEN 'flat'::text
                    ELSE 'forward_buying'::text
                END AS modo_promo
           FROM promocao_campanha pc
             JOIN promocao_item pi ON pi.campanha_id = pc.id
             JOIN v_promocao_item_efetivo ef ON ef.id = pi.id
          WHERE pc.estado = 'ativa'::text AND CURRENT_DATE >= pc.data_inicio AND CURRENT_DATE <= pc.data_fim AND pi.ativo = true AND pi.confirmado = true AND pi.sku_codigo_omie IS NOT NULL
        ), aumento_por_sku AS (
         SELECT lower(v_sku_aumento_vigente.empresa_lower) AS empresa_lower,
            v_sku_aumento_vigente.sku_codigo_omie,
            v_sku_aumento_vigente.aumento_id,
            v_sku_aumento_vigente.aumento_nome,
            v_sku_aumento_vigente.data_vigencia_efetiva,
            max(v_sku_aumento_vigente.aumento_perc) AS aumento_perc_max,
            jsonb_agg(jsonb_build_object('aumento_id', v_sku_aumento_vigente.aumento_id, 'categoria', v_sku_aumento_vigente.categoria_fornecedor, 'perc', v_sku_aumento_vigente.aumento_perc, 'vigencia', v_sku_aumento_vigente.data_vigencia_efetiva)) AS aumentos_detalhes
           FROM v_sku_aumento_vigente
          GROUP BY v_sku_aumento_vigente.empresa_lower, v_sku_aumento_vigente.sku_codigo_omie, v_sku_aumento_vigente.aumento_id, v_sku_aumento_vigente.aumento_nome, v_sku_aumento_vigente.data_vigencia_efetiva
        ), aumento_agregado_sku AS (
         SELECT aumento_por_sku.empresa_lower,
            aumento_por_sku.sku_codigo_omie,
            max(aumento_por_sku.aumento_perc_max) AS aumento_evitado_perc,
            min(aumento_por_sku.data_vigencia_efetiva) AS proxima_vigencia_aumento,
            jsonb_agg(aumento_por_sku.aumentos_detalhes) AS aumentos_json
           FROM aumento_por_sku
          GROUP BY aumento_por_sku.empresa_lower, aumento_por_sku.sku_codigo_omie
        ), base AS (
         SELECT sp.empresa,
            sp.sku_codigo_omie,
            sp.sku_descricao,
            sp.demanda_media_diaria AS d,
            sp.fornecedor_nome,
            vps.qtde_compra_ciclo_sugerida AS qtde_base,
            vps.custo_capital_efetivo_perc,
            vps.preco_item_eoq,
            p.campanha_id,
            p.campanha_nome,
            p.item_id AS promo_item_id,
            p.volume_minimo AS promo_volume_minimo,
            p.desconto_promo_perc,
            p.tem_negociacao_extra,
            p.modo_promo,
            p.data_corte_pedido AS promo_data_corte_pedido,
            p.data_corte_faturamento AS promo_data_corte_faturamento,
            a.aumento_evitado_perc,
            a.proxima_vigencia_aumento,
            a.aumentos_json
           FROM sku_parametros sp
             LEFT JOIN v_sku_parametros_sugeridos vps ON vps.empresa = sp.empresa AND vps.sku_codigo_omie = sp.sku_codigo_omie
             LEFT JOIN promo_por_sku p ON p.empresa = sp.empresa AND p.sku_codigo_omie = sp.sku_codigo_omie
             LEFT JOIN aumento_agregado_sku a ON lower(sp.empresa) = a.empresa_lower AND sp.sku_codigo_omie = a.sku_codigo_omie
          WHERE sp.ativo = true AND (p.item_id IS NOT NULL OR a.aumento_evitado_perc IS NOT NULL)
        ), com_decisao AS (
         SELECT base.empresa,
            base.sku_codigo_omie,
            base.sku_descricao,
            base.d,
            base.fornecedor_nome,
            base.qtde_base,
            base.custo_capital_efetivo_perc,
            base.preco_item_eoq,
            base.campanha_id,
            base.campanha_nome,
            base.promo_item_id,
            base.promo_volume_minimo,
            base.desconto_promo_perc,
            base.tem_negociacao_extra,
            base.modo_promo,
            base.promo_data_corte_pedido,
            base.promo_data_corte_faturamento,
            base.aumento_evitado_perc,
            base.proxima_vigencia_aumento,
            base.aumentos_json,
            COALESCE(base.desconto_promo_perc, 0::numeric) + COALESCE(base.aumento_evitado_perc, 0::numeric) AS desconto_total_perc,
            LEAST((base.proxima_vigencia_aumento - '1 day'::interval)::date, base.promo_data_corte_pedido) AS data_limite_acao,
                CASE
                    WHEN base.promo_item_id IS NOT NULL AND base.aumento_evitado_perc IS NOT NULL THEN 'promo_e_aumento'::text
                    WHEN base.promo_item_id IS NOT NULL THEN
                    CASE
                        WHEN base.modo_promo = 'flat'::text THEN 'promo_flat'::text
                        ELSE 'promo_volume'::text
                    END
                    ELSE 'aumento_apenas'::text
                END AS cenario
           FROM base
        ), com_calculos AS (
         SELECT com_decisao.empresa,
            com_decisao.sku_codigo_omie,
            com_decisao.sku_descricao,
            com_decisao.d,
            com_decisao.fornecedor_nome,
            com_decisao.qtde_base,
            com_decisao.custo_capital_efetivo_perc,
            com_decisao.preco_item_eoq,
            com_decisao.campanha_id,
            com_decisao.campanha_nome,
            com_decisao.promo_item_id,
            com_decisao.promo_volume_minimo,
            com_decisao.desconto_promo_perc,
            com_decisao.tem_negociacao_extra,
            com_decisao.modo_promo,
            com_decisao.promo_data_corte_pedido,
            com_decisao.promo_data_corte_faturamento,
            com_decisao.aumento_evitado_perc,
            com_decisao.proxima_vigencia_aumento,
            com_decisao.aumentos_json,
            com_decisao.desconto_total_perc,
            com_decisao.data_limite_acao,
            com_decisao.cenario,
                CASE
                    WHEN com_decisao.data_limite_acao IS NULL THEN NULL::integer
                    ELSE GREATEST(0, com_decisao.data_limite_acao - CURRENT_DATE)
                END AS dias_ate_limite,
                CASE
                    WHEN com_decisao.cenario = 'promo_flat'::text THEN com_decisao.qtde_base
                    WHEN com_decisao.cenario = 'promo_volume'::text THEN GREATEST(COALESCE(com_decisao.qtde_base, 0::numeric), COALESCE(com_decisao.promo_volume_minimo, 0::numeric))
                    WHEN com_decisao.cenario = ANY (ARRAY['aumento_apenas'::text, 'promo_e_aumento'::text]) THEN ceil(com_decisao.d * ((date_trunc('month'::text, com_decisao.proxima_vigencia_aumento::timestamp with time zone) + '2 mons'::interval - '1 day'::interval)::date - CURRENT_DATE)::numeric)
                    ELSE com_decisao.qtde_base
                END AS qtde_oportunidade,
                CASE
                    WHEN com_decisao.preco_item_eoq IS NOT NULL AND com_decisao.d > 0::numeric THEN round(
                    CASE
                        WHEN com_decisao.cenario = 'promo_flat'::text THEN com_decisao.qtde_base
                        WHEN com_decisao.cenario = 'promo_volume'::text THEN GREATEST(COALESCE(com_decisao.qtde_base, 0::numeric), COALESCE(com_decisao.promo_volume_minimo, 0::numeric))
                        WHEN com_decisao.cenario = ANY (ARRAY['aumento_apenas'::text, 'promo_e_aumento'::text]) THEN ceil(com_decisao.d * ((date_trunc('month'::text, com_decisao.proxima_vigencia_aumento::timestamp with time zone) + '2 mons'::interval - '1 day'::interval)::date - CURRENT_DATE)::numeric)
                        ELSE com_decisao.qtde_base
                    END * com_decisao.preco_item_eoq * com_decisao.desconto_total_perc / 100::numeric, 2)
                    ELSE NULL::numeric
                END AS economia_bruta_estimada
           FROM com_decisao
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    cenario,
    desconto_total_perc,
    desconto_promo_perc,
    aumento_evitado_perc,
    tem_negociacao_extra,
    campanha_id,
    campanha_nome,
    promo_item_id,
    modo_promo,
    promo_data_corte_pedido,
    promo_data_corte_faturamento,
    proxima_vigencia_aumento,
    aumentos_json,
    data_limite_acao,
    dias_ate_limite,
    d AS demanda_diaria,
    qtde_base,
    qtde_oportunidade,
    preco_item_eoq,
    economia_bruta_estimada,
    custo_capital_efetivo_perc
   FROM com_calculos
  ORDER BY economia_bruta_estimada DESC NULLS LAST;

CREATE OR REPLACE FUNCTION public.aplicar_promocoes_no_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(itens_flat_aplicados integer, itens_forward_buying_aplicados integer, pedidos_afetados integer, economia_total_estimada numeric, pedidos_bloqueados_por_delta integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_flat int := 0;
  v_fb int := 0;
  v_pedidos int := 0;
  v_economia numeric := 0;
  v_bloqueados int := 0;
BEGIN
  -- ========== MODO FLAT: desconto no preço, quantidade inalterada ==========
  WITH aplicados_flat AS (
    UPDATE pedido_compra_item pci
    SET preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        valor_linha = pci.qtde_final * (pci.preco_unitario * (1 - av.desconto_perc / 100)),
        modo_promocao = 'flat',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = pci.qtde_final * pci.preco_unitario * av.desconto_perc / 100
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2] vigência na data do pedido
      AND av.modo_aplicacao = 'flat'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.modo_promocao IS NULL                                    -- idempotência
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_flat FROM aplicados_flat;

  -- ========== MODO FORWARD BUYING: infla quantidade (nunca rebaixa) ==========
  WITH aplicados_fb AS (
    UPDATE pedido_compra_item pci
    SET qtde_sem_promocao = pci.qtde_final,                            -- [H6] baseline real
        qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final),   -- [H6] nunca rebaixa o mínimo/ajuste
        valor_linha = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * (1 - av.desconto_perc / 100),
        preco_sem_desconto = pci.preco_unitario,
        preco_unitario = pci.preco_unitario * (1 - av.desconto_perc / 100),
        modo_promocao = 'forward_buying',
        promocao_item_id = av.item_id,
        desconto_perc_aplicado = av.desconto_perc,
        economia_estimada_valor = GREATEST(av.qtde_com_desconto, pci.qtde_final) * pci.preco_unitario * av.desconto_perc / 100  -- [H6]
    FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs, promocao_campanha pc
    WHERE pcs.id = pci.pedido_id
      AND pc.id = av.campanha_id                                       -- [H2]
      AND pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim        -- [H2]
      AND av.modo_aplicacao = 'forward_buying'
      AND av.empresa = p_empresa
      AND pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status = 'pendente_aprovacao'
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND pcs.fornecedor_nome = av.fornecedor_nome                     -- [H1]
      AND pci.sku_codigo_omie = av.sku_codigo_omie::text               -- [H3]
      AND pci.ajustado_humano IS NOT TRUE                              -- [H4]
      AND pci.modo_promocao IS NULL
      AND av.qtde_com_desconto > 0 AND av.qtde_com_desconto < 'Infinity'::numeric  -- [H7]
      AND pci.qtde_final > 0 AND pci.qtde_final < 'Infinity'::numeric   -- [H7b]
      AND pci.qtde_final >= COALESCE(av.qtde_base, 0)                  -- [H7]
    RETURNING pci.id, pci.pedido_id, pci.economia_estimada_valor
  )
  SELECT COUNT(*) INTO v_fb FROM aplicados_fb;

  -- Conta pedidos afetados e soma economia (estado do ciclo)
  SELECT COUNT(DISTINCT pedido_id), COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_pedidos, v_economia
  FROM pedido_compra_item
  WHERE pedido_id IN (
      SELECT id FROM pedido_compra_sugerido
      WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND tipo_ciclo = 'normal'  -- [H5]
    )
    AND modo_promocao IS NOT NULL;

  -- Recalcula valor_total dos pedidos afetados
  UPDATE pedido_compra_sugerido pcs
  SET valor_total = (
      SELECT COALESCE(SUM(valor_linha), 0)
      FROM pedido_compra_item
      WHERE pedido_id = pcs.id
    )
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.status = 'pendente_aprovacao'
    AND pcs.tipo_ciclo = 'normal'                                      -- [H5]
    AND EXISTS (
      SELECT 1 FROM pedido_compra_item pci
      WHERE pci.pedido_id = pcs.id AND pci.modo_promocao IS NOT NULL
    );

  -- Reavalia guardrail de delta — só para pedidos inflados por forward_buying
  WITH reavaliacao AS (
    UPDATE pedido_compra_sugerido pcs
    SET delta_vs_anterior_perc = CASE
          WHEN pcs.pedido_anterior_valor > 0
          THEN ROUND(((pcs.valor_total - pcs.pedido_anterior_valor) / pcs.pedido_anterior_valor * 100)::numeric, 1)
          ELSE NULL END,
        status = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'bloqueado_guardrail'
          ELSE pcs.status END,
        mensagem_bloqueio = CASE
          WHEN pcs.pedido_anterior_valor > 0
            AND pcs.valor_total / NULLIF(pcs.pedido_anterior_valor, 0) > 1 + (
              (SELECT fh.delta_max_perc FROM fornecedor_habilitado_reposicao fh
               WHERE fh.empresa = pcs.empresa AND fh.fornecedor_nome = pcs.fornecedor_nome) / 100.0
            )
          THEN 'Variação acima do delta máximo — forward buying promocional inflou pedido, revisar'
          ELSE pcs.mensagem_bloqueio END
    WHERE pcs.empresa = p_empresa
      AND pcs.data_ciclo = p_data_ciclo
      AND pcs.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
      AND pcs.tipo_ciclo = 'normal'                                    -- [H5]
      AND EXISTS (
        SELECT 1 FROM pedido_compra_item pci
        WHERE pci.pedido_id = pcs.id AND pci.modo_promocao = 'forward_buying'
      )
    RETURNING id, status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'bloqueado_guardrail') INTO v_bloqueados FROM reavaliacao;

  RETURN QUERY SELECT v_flat, v_fb, v_pedidos, v_economia, v_bloqueados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atualizar_parametros_numericos_skus(p_empresa text, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  atualizados int := 0;
  v_mult numeric := COALESCE((SELECT value::numeric FROM public.company_config WHERE key='param_auto_fusivel_mult'), 3);
BEGIN
  PERFORM set_config('app.param_auto', CASE WHEN p_run_id IS NULL THEN 'manual' ELSE 'auto' END, true);

  DROP TABLE IF EXISTS tmp_param_decidido;
  CREATE TEMP TABLE tmp_param_decidido ON COMMIT DROP AS
  WITH base AS (
    SELECT sp.id, sp.empresa, sp.sku_codigo_omie,
           sp.ponto_pedido AS pp_antes, sp.estoque_minimo AS min_antes, sp.estoque_maximo AS max_antes,
           sp.estoque_seguranca AS ss_antes, sp.cobertura_alvo_dias AS cob_antes,
           sp.habilitado_reposicao_automatica AS habilitado,
           COALESCE(sp.tipo_reposicao,'automatica') AS tipo,
           v.sku_descricao, v.fornecedor_nome,
           v.estoque_minimo_sugerido AS min_sug, v.ponto_pedido_sugerido AS pp_sug,
           v.estoque_maximo_sugerido AS max_sug, v.estoque_seguranca_sugerido AS ss_sug,
           v.cobertura_alvo_dias AS cob_sug,
           v.demanda_media_diaria, v.demanda_sigma_diario, v.coef_variacao_ordem, v.num_ordens,
           v.valor_total_90d, v.lead_time_medio, v.lead_time_desvio, v.lt_p95_dias, v.fonte_leadtime,
           v.z_aplicado, v.classe_consolidada,
           pin.ponto_pedido_rejeitado, pin.estoque_maximo_rejeitado
    FROM public.sku_parametros sp
    JOIN public.v_sku_parametros_sugeridos v
      ON v.empresa = sp.empresa AND v.sku_codigo_omie = sp.sku_codigo_omie
    LEFT JOIN public.reposicao_param_pin pin
      ON pin.empresa = sp.empresa AND pin.sku_codigo_omie = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
  )
  SELECT b.*,
    CASE
      WHEN b.pp_sug IS NULL OR b.max_sug IS NULL OR b.min_sug IS NULL
           OR b.ss_sug IS NULL OR b.cob_sug IS NULL THEN 'sem_mudanca'
      WHEN b.pp_sug = 'NaN'::numeric OR b.max_sug = 'NaN'::numeric OR b.min_sug = 'NaN'::numeric
           OR b.ss_sug = 'NaN'::numeric OR b.cob_sug = 'NaN'::numeric
           OR b.min_sug < 0 OR b.pp_sug < 0 OR b.max_sug < 0 OR b.ss_sug < 0
           OR b.max_sug < b.pp_sug OR b.pp_sug < b.min_sug OR b.cob_sug <= 0 THEN 'bloqueado_validacao'
      WHEN b.max_antes IS NULL OR b.max_antes <= 0 THEN 'bloqueado_validacao'
      WHEN b.ponto_pedido_rejeitado IS NOT NULL
           AND round(b.pp_sug) = round(b.ponto_pedido_rejeitado)
           AND round(b.max_sug) = round(b.estoque_maximo_rejeitado) THEN 'pinado'
      WHEN round(b.pp_sug) = round(b.pp_antes) AND round(b.max_sug) = round(b.max_antes) THEN 'sem_mudanca'
      WHEN b.max_antes > 0 AND round(b.max_sug) > v_mult * round(b.max_antes) THEN 'segurado'
      ELSE 'aplicado'
    END AS status
  FROM base b;

  UPDATE public.sku_parametros sp SET
    sku_descricao = COALESCE(d.sku_descricao, sp.sku_descricao),
    fornecedor_nome = COALESCE(d.fornecedor_nome, sp.fornecedor_nome),
    demanda_media_diaria = d.demanda_media_diaria,
    demanda_desvio_padrao = d.demanda_sigma_diario,
    demanda_coef_variacao = d.coef_variacao_ordem,
    demanda_dias_com_movimento = d.num_ordens,
    valor_vendido_90d = d.valor_total_90d,
    lt_medio_dias_uteis = d.lead_time_medio,
    lt_desvio_padrao_dias = d.lead_time_desvio,
    lt_p95_dias = d.lt_p95_dias,
    fonte_leadtime = d.fonte_leadtime,
    z_score = d.z_aplicado,
    estoque_seguranca   = CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE sp.estoque_seguranca END,
    ponto_pedido        = CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE sp.ponto_pedido END,
    estoque_minimo      = CASE WHEN d.status='aplicado' THEN d.min_sug ELSE sp.estoque_minimo END,
    cobertura_alvo_dias = CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE sp.cobertura_alvo_dias END,
    estoque_maximo      = CASE WHEN d.status='aplicado' THEN d.max_sug ELSE sp.estoque_maximo END,
    ultima_atualizacao_calculo = NOW()
  FROM tmp_param_decidido d WHERE sp.id = d.id;

  SELECT count(*) FILTER (WHERE status='aplicado') INTO atualizados FROM tmp_param_decidido;

  DELETE FROM public.reposicao_param_pin p
  USING tmp_param_decidido d
  WHERE p.empresa = d.empresa AND p.sku_codigo_omie = d.sku_codigo_omie::text
    AND d.status = 'aplicado' AND d.ponto_pedido_rejeitado IS NOT NULL;

  IF p_run_id IS NOT NULL THEN
    INSERT INTO public.reposicao_param_auto_log (
      run_id, empresa, sku_codigo_omie, sku_descricao, status,
      ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
      estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
      cobertura_antes, cobertura_depois,
      ponto_pedido_sugerido, estoque_maximo_sugerido,   -- NOVO: o que o cálculo propôs (p/ segurado = o barrado)
      demanda_media_diaria, lt_medio_dias_uteis, classe_consolidada, z_score
    )
    SELECT p_run_id, d.empresa, d.sku_codigo_omie::text, d.sku_descricao, d.status,
      d.pp_antes,  CASE WHEN d.status='aplicado' THEN d.pp_sug  ELSE d.pp_antes END,
      d.min_antes, CASE WHEN d.status='aplicado' THEN d.min_sug ELSE d.min_antes END,
      d.max_antes, CASE WHEN d.status='aplicado' THEN d.max_sug ELSE d.max_antes END,
      d.ss_antes,  CASE WHEN d.status='aplicado' THEN d.ss_sug  ELSE d.ss_antes END,
      d.cob_antes, CASE WHEN d.status='aplicado' THEN d.cob_sug ELSE d.cob_antes END,
      d.pp_sug, d.max_sug,   -- NOVO: sugerido cru (independe do status; p/ segurado NÃO é depois=antes)
      d.demanda_media_diaria, d.lead_time_medio, d.classe_consolidada, d.z_aplicado
    FROM tmp_param_decidido d
    WHERE d.status IN ('aplicado','segurado','pinado','bloqueado_validacao')
      AND d.habilitado = true AND d.tipo = 'automatica';

    WITH em_transito AS (
      SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
      FROM public.pedido_compra_item pci
      JOIN public.pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
      WHERE pcs2.empresa = p_empresa
        AND pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')  -- [SIMULADO] PO real do dry_run
        AND pcs2.data_ciclo >= (CURRENT_DATE - INTERVAL '7 days')
      GROUP BY pcs2.empresa, pci.sku_codigo_omie
    ),
    posicao AS (
      SELECT l.id AS log_id,
             (COALESCE(sea.estoque_fisico,0) + COALESCE(sea.estoque_pendente_entrada,0)
                + COALESCE(et.qtde,0)) AS pos,
             ip.custo, ip.custo_fonte
      FROM public.reposicao_param_auto_log l
      LEFT JOIN public.sku_estoque_atual sea
        ON sea.empresa = l.empresa AND sea.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN em_transito et
        ON et.empresa = l.empresa AND et.sku_codigo_omie = l.sku_codigo_omie
      LEFT JOIN LATERAL (
        SELECT CASE WHEN ip0.cmc > 0 THEN ip0.cmc
                    WHEN ip0.preco_medio > 0 THEN ip0.preco_medio
                    ELSE NULL END AS custo,
               CASE WHEN ip0.cmc > 0 THEN 'cmc'
                    WHEN ip0.preco_medio > 0 THEN 'preco_medio'
                    ELSE NULL END AS custo_fonte
        FROM public.inventory_position ip0
        WHERE ip0.omie_codigo_produto::text = l.sku_codigo_omie
          AND ip0.account = lower(p_empresa)
        LIMIT 1
      ) ip ON true
      WHERE l.run_id = p_run_id
        AND l.status IN ('aplicado','segurado')
    )
    UPDATE public.reposicao_param_auto_log l SET
      custo_unitario   = p.custo,
      custo_fonte      = p.custo_fonte,
      qtde_compra_antes  = CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END,
      qtde_compra_depois = CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END,
      impacto_rs = CASE WHEN p.custo IS NULL THEN NULL ELSE
        ( (CASE WHEN p.pos <= l.ponto_pedido_depois THEN GREATEST(0, l.estoque_maximo_depois - p.pos) ELSE 0 END)
        - (CASE WHEN p.pos <= l.ponto_pedido_antes  THEN GREATEST(0, l.estoque_maximo_antes  - p.pos) ELSE 0 END)
        ) * p.custo END
    FROM posicao p
    WHERE l.id = p.log_id;
  END IF;

  RETURN atualizados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ciclo_oportunidade_do_dia(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(executou boolean, motivo text, pedidos_gerados integer, skus_incluidos integer, economia_estimada numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_campanhas_hoje int;
  v_aumentos_hoje int;
  v_result record;
  v_motivo text := '';
  v_inicio timestamptz := clock_timestamp();
BEGIN
  SELECT COUNT(*) INTO v_campanhas_hoje
  FROM promocao_campanha
  WHERE empresa = p_empresa
    AND estado = 'ativa'
    AND data_corte_pedido = p_data_ciclo
    AND permite_pedido_oportunidade = true;

  SELECT COUNT(*) INTO v_aumentos_hoje
  FROM fornecedor_aumento_anunciado
  WHERE empresa = p_empresa
    AND estado IN ('ativo', 'vigente')
    AND data_vigencia = p_data_ciclo + INTERVAL '1 day';

  IF v_campanhas_hoje = 0 AND v_aumentos_hoje = 0 THEN
    PERFORM public._registrar_ciclo_oportunidade(v_inicio,
      jsonb_build_object('executou', false, 'motivo', 'sem_eventos_hoje', 'empresa', p_empresa));
    RETURN QUERY SELECT false, 'sem_eventos_hoje'::text, 0, 0, 0::numeric;
    RETURN;
  END IF;

  v_motivo := CASE
    WHEN v_campanhas_hoje > 0 AND v_aumentos_hoje > 0 THEN 'promo_e_aumento'
    WHEN v_campanhas_hoje > 0 THEN 'corte_promocao'
    ELSE 'vespera_aumento'
  END;

  SELECT * INTO v_result
  FROM gerar_pedidos_oportunidade_ciclo(p_empresa, p_data_ciclo)
  LIMIT 1;

  INSERT INTO fornecedor_alerta (
    empresa, tipo, severidade, titulo, mensagem
  ) VALUES (
    p_empresa, 'oportunidade_calculada', 'atencao',
    'Ciclo oportunidade gerado: ' || v_motivo,
    format('Foram gerados %s pedidos cobrindo %s SKUs com economia bruta estimada de R$ %s. Revisar em /admin/reposicao/pedidos.',
           v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total)
  );

  PERFORM public._registrar_ciclo_oportunidade(v_inicio,
    jsonb_build_object('executou', true, 'motivo', v_motivo, 'empresa', p_empresa,
                       'pedidos_gerados', v_result.pedidos_gerados,
                       'skus_incluidos', v_result.skus_incluidos,
                       'economia_estimada', v_result.valor_total));

  RETURN QUERY SELECT true, v_motivo, v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE, p_cenarios text[] DEFAULT ARRAY['promo_flat'::text, 'promo_volume'::text, 'promo_e_aumento'::text, 'aumento_apenas'::text])
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total numeric, economia_bruta numeric, cenarios_cobertos text[])
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pedidos int := 0;
  v_skus int := 0;
  v_valor numeric := 0;
  v_economia numeric := 0;
  v_cenarios_encontrados text[];
BEGIN
  -- Remove pedidos oportunidade pendentes do mesmo ciclo (idempotente)
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa
    AND data_ciclo = p_data_ciclo
    AND tipo_ciclo LIKE 'oportunidade_%'
    AND status = 'pendente_aprovacao';

  -- Identifica cenários presentes
  SELECT array_agg(DISTINCT cenario) INTO v_cenarios_encontrados
  FROM v_oportunidade_economica_hoje
  WHERE empresa = p_empresa
    AND cenario = ANY(p_cenarios)
    AND economia_bruta_estimada > 0;

  -- Gera um pedido por (fornecedor, cenário_tipo)
  -- cenário_tipo: 'promo' (inclui flat, volume, promo_e_aumento) ou 'aumento'
  WITH oportunidades AS (
    SELECT *,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN 'oportunidade_promo'
        ELSE 'oportunidade_aumento'
      END AS tipo_ciclo_dest,
      CASE
        WHEN cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
          THEN campanha_id
        ELSE NULL
      END AS evento_promo_id,
      CASE
        WHEN cenario = 'aumento_apenas'
          THEN (aumentos_json -> 0 -> 0 ->> 'aumento_id')::bigint
        ELSE NULL
      END AS evento_aumento_id
    FROM v_oportunidade_economica_hoje voeh
    WHERE voeh.empresa = p_empresa
      AND voeh.cenario = ANY(p_cenarios)
      AND voeh.economia_bruta_estimada > 0
      AND voeh.qtde_oportunidade > 0
      -- [SIMETRIA-NORMAL] não oferecer SKU que JÁ está em pedido NORMAL economicamente ativo
      -- (espelha o NOT EXISTS 4/4 da RPC normal, na direção inversa — anti compra dupla).
      AND NOT EXISTS (
            SELECT 1
            FROM pedido_compra_item pcin
            JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
            WHERE pcsn.empresa = p_empresa
              AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
              AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
              -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
              -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
              -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
              -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
              -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
              -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
              -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
              -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
              -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
              -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
              AND NOT (
                    pcsn.status = 'aprovado_aguardando_disparo'
                AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
                AND pcsn.portal_protocolo IS NULL
                AND pcsn.omie_pedido_compra_numero IS NULL
              )
              AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
              AND pcin.sku_codigo_omie = voeh.sku_codigo_omie::text
          )
  ),
  pedidos_criados AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_corte_planejado, valor_total, num_skus, status,
      tipo_ciclo, origem_evento_id, origem_evento_tipo
    )
    SELECT
      o.empresa,
      o.fornecedor_nome,
      NULL,  -- oportunidade não respeita grupo; é um pedido único por fornecedor
      p_data_ciclo,
      (p_data_ciclo + TIME '18:00')::timestamptz,
      SUM(o.qtde_oportunidade * o.preco_item_eoq),
      COUNT(*),
      'pendente_aprovacao',
      o.tipo_ciclo_dest,
      COALESCE(o.evento_promo_id, o.evento_aumento_id),
      CASE WHEN o.evento_promo_id IS NOT NULL THEN 'campanha_promocao' ELSE 'aumento_anunciado' END
    FROM oportunidades o
    GROUP BY o.empresa, o.fornecedor_nome, o.tipo_ciclo_dest, o.evento_promo_id, o.evento_aumento_id
    RETURNING id, fornecedor_nome, tipo_ciclo, origem_evento_id, origem_evento_tipo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao,
    estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    modo_promocao, promocao_item_id, preco_sem_desconto, desconto_perc_aplicado,
    economia_estimada_valor
  )
  SELECT
    pc.id,
    o.sku_codigo_omie,
    o.sku_descricao,
    NULL, NULL, NULL,  -- não aplicável em oportunidade
    o.qtde_oportunidade,
    o.qtde_oportunidade,
    o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    o.qtde_oportunidade * o.preco_item_eoq * (1 - o.desconto_total_perc / 100),
    false,
    CASE
      WHEN o.cenario IN ('promo_flat') THEN 'flat'
      WHEN o.cenario IN ('promo_volume', 'promo_e_aumento') THEN 'forward_buying'
      ELSE NULL
    END,
    o.promo_item_id,
    o.preco_item_eoq,
    o.desconto_total_perc,
    o.economia_bruta_estimada
  FROM v_oportunidade_economica_hoje o
  JOIN pedidos_criados pc ON (
    pc.fornecedor_nome = o.fornecedor_nome
    AND pc.tipo_ciclo = CASE
      WHEN o.cenario IN ('promo_flat', 'promo_volume', 'promo_e_aumento')
        THEN 'oportunidade_promo'
      ELSE 'oportunidade_aumento'
    END
  )
  WHERE o.empresa = p_empresa
    AND o.cenario = ANY(p_cenarios)
    AND o.economia_bruta_estimada > 0
    AND o.qtde_oportunidade > 0
    -- [SIMETRIA-NORMAL] mesmo filtro do CTE — o INSERT de itens re-lê a view; sem o espelho,
    -- um SKU excluído do header entraria como item de pedido criado por outros SKUs.
    AND NOT EXISTS (
          SELECT 1
          FROM pedido_compra_item pcin
          JOIN pedido_compra_sugerido pcsn ON pcsn.id = pcin.pedido_id
          WHERE pcsn.empresa = p_empresa
            AND COALESCE(pcsn.tipo_ciclo, 'normal') = 'normal'
            AND pcsn.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio','disparado','concluido_recebido')
            -- [FANTASMA] espelha a guarda da RPC normal (migration 20260802120000, pedido #1276):
            -- erro TERMINAL do portal significa que NADA foi colocado no fornecedor, logo NAO ha
            -- compra para duplicar — e bloquear a oferta so queima a economia da promocao/aumento.
            -- Fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou n. do pedido
            -- no Omie) para o pedido seguir bloqueando. Comprar duas vezes queima caixa; aqui o
            -- downside e MAIOR que na RPC normal, porque a qtde de oportunidade e antecipada.
            -- IS NOT DISTINCT FROM, nao "=": negacao e NULL-blind. Com "=" e a coluna NULL o
            -- predicado inteiro vira NULL, NOT(NULL) e NULL, e o pedido SAUDAVEL desaparece do
            -- NOT EXISTS — destravando a oferta de TODO SKU em pedido aprovado (compra dupla em
            -- escala, nao so no caso fantasma). Pego pelo db/test-oportunidade-erro-terminal.sh.
            AND NOT (
                  pcsn.status = 'aprovado_aguardando_disparo'
              AND pcsn.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
              AND pcsn.portal_protocolo IS NULL
              AND pcsn.omie_pedido_compra_numero IS NULL
            )
            AND pcsn.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
            AND pcin.sku_codigo_omie = o.sku_codigo_omie::text
        );

  -- Agrega retorno
  -- [FIX-AMBIGUIDADE] o corpo do snapshot fazia SUM(valor_total) sem qualificar — colide com a
  -- coluna OUT homônima do RETURNS TABLE → "column reference valor_total is ambiguous" em
  -- RUNTIME (late-bound; o CREATE passa). Como o wrapper ciclo_oportunidade_do_dia só chama
  -- esta função em dia de corte de campanha/véspera de aumento, a falha era SILENCIOSA e
  -- ocorria exatamente nos dias com evento (rollback no cron — pedido de oportunidade nunca
  -- nascia). Mesmo modo-de-falha do incidente aplicar_promocoes (§10). Pego pelo PG17 que
  -- EXECUTA a função, não só a cria.
  SELECT
    COUNT(*),
    COALESCE(SUM(pcs0.num_skus), 0),
    COALESCE(SUM(pcs0.valor_total), 0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido pcs0
  WHERE pcs0.empresa = p_empresa
    AND pcs0.data_ciclo = p_data_ciclo
    AND pcs0.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs0.status = 'pendente_aprovacao';

  SELECT COALESCE(SUM(economia_estimada_valor), 0)
  INTO v_economia
  FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.empresa = p_empresa
    AND pcs.data_ciclo = p_data_ciclo
    AND pcs.tipo_ciclo LIKE 'oportunidade_%'
    AND pcs.status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_economia, v_cenarios_encontrados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
  v_stale_dias INT := 45;  -- motor confia no preço-app por N dias (painel usa 24h; manual precisa folga). Config abaixo.
  v_run_id uuid := gen_random_uuid();  -- [GATE estoque-não-confirmado] carimba os suprimidos desta execução no log
  -- [TETO cobertura] NULL = classe sem teto (cap desligado). Flag por empresa nasce false; dias só valem com a flag.
  v_teto_ativo boolean := false;
  v_teto_b numeric := NULL;
  v_teto_c numeric := NULL;
BEGIN
  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- Janela de frescor do preço-app que o motor aceita p/ trocar a embalagem (decisão B da spec). Global.
  SELECT COALESCE((SELECT NULLIF(btrim(value), '')::int
                   FROM company_config WHERE key = 'embalagem_preco_motor_stale_dias' LIMIT 1), 45)
    INTO v_stale_dias;

  -- [TETO cobertura] Config POR EMPRESA, fail-off: flag ausente/≠true → cap desligado; dias com parse blindado
  -- (regex antes do cast — valor lixo NUNCA aborta o recálculo, só desliga o teto daquela classe). '0' → NULL.
  SELECT COALESCE((SELECT lower(btrim(value)) = 'true' FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_ativa' LIMIT 1), false)
    INTO v_teto_ativo;
  IF v_teto_ativo THEN
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_b' LIMIT 1), 0)
      INTO v_teto_b;
    SELECT NULLIF((SELECT CASE WHEN btrim(value) ~ '^[0-9]+$' THEN btrim(value)::numeric END
                   FROM company_config
                   WHERE key = 'reposicao_teto_cobertura_' || lower(p_empresa) || '_dias_c' LIMIT 1), 0)
      INTO v_teto_c;
  END IF;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte).
  UPDATE pedido_compra_sugerido
  SET status = 'expirado_sem_aprovacao', atualizado_em = now()
  WHERE empresa = p_empresa
    AND data_ciclo < p_data_ciclo
    AND status = 'pendente_aprovacao'
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  -- [INTRADAY 3/4] limpeza do dia: só ciclo NORMAL (preserva oportunidade/promoção pendentes) e
  -- INCLUI bloqueado_guardrail do dia (re-avaliado a cada rodada; anti compra dupla).
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        -- [SIMULADO] 'disparado_simulado' É pedido real: o dry_run da edge chama IncluirPedCompra no Omie.
        -- Fora desta lista ele sumia do "a caminho" (o 2º ramo exige nº Omie NULL) → compra dupla.
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')
         -- [FANTASMA] Erro TERMINAL do portal NÃO é estoque a caminho. 'erro_nao_retentavel' só é alcançado
         -- com efetivarAttempted=false — o resultado AMBÍGUO tem estado PRÓPRIO (aceito_portal_sem_protocolo
         -- / indeterminado_requer_conciliacao), então este status significa "nada foi colocado no fornecedor".
         -- Contá-lo inflava o estoque efetivo e SUPRIMIA a recompra por 7 dias (pedido #1276: 4 SKUs no ou
         -- abaixo do ponto de pedido ficaram 7 dias sem sugestão, 3 deles classe A).
         -- As 3 guardas são fail-CLOSED: basta UM sinal de que algo chegou (protocolo do portal ou nº do
         -- pedido no Omie) para seguir contando. Subcomprar é recuperável; comprar duas vezes queima caixa.
         -- IS NOT DISTINCT FROM, não "=": negação é NULL-blind. Com "=" e status_envio_portal NULL o
         -- predicado interno vira NULL, NOT(NULL) é NULL, e o pedido SAUDÁVEL some desta CTE — o motor
         -- recompraria TODO SKU em pedido aprovado ainda não disparado (compra dupla em escala, não só no
         -- caso fantasma). Com IS NOT DISTINCT FROM, NULL dá false → NOT(false) → segue contando.
         -- Pego pelo db/test-em-transito-erro-terminal.sh (S7 + falsificação F5).
         AND NOT (
           pcs2.status = 'aprovado_aguardando_disparo'
           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'
           AND pcs2.portal_protocolo IS NULL
           AND pcs2.omie_pedido_compra_numero IS NULL
         ))
        OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  -- [DEDUP-NFE] 1 obs por (empresa, NFe, SKU); antes: 1 por LINHA de sku_leadtime_history, o que
  -- ponderava o AVG pela multiplicidade (NFe que fatura N pedidos regravava o item N×).
  -- [2 CONSUMIDORES] O filtro de preço saiu do WHERE e virou FILTER na agregação — de propósito.
  -- Esta CTE serve a DOIS consumidores, que fazem perguntas DIFERENTES:
  --   · preco_unitario → "quanto custou?"  ⇒ agrega só a obs precificável (FILTER). Sem nenhuma
  --     ⇒ NULL, e o COALESCE(cmc, …) decide. Ausente ≠ zero.
  --   · n (lido SÓ como `pm.n IS NULL` ⇒ primeira_compra) → "já foi comprado?" ⇒ conta TODA obs.
  --     COMPRAR ≠ SABER QUANTO CUSTOU. Com o filtro no WHERE, a obs cuja quantidade a view NULLa
  --     (cópias divergem) derrubaria o SKU INTEIRO da CTE ⇒ o badge mentiria "primeira compra"
  --     num SKU já comprado. Não é hipótese: medido ZERO no pré-flight e DOIS poucas horas
  --     depois, na MESMA sessão — o resíduo se move (o sync grava). Com o FILTER, o conjunto de
  --     primeira_compra fica IDÊNTICO ao de hoje (medido nos dois sentidos: nenhum SKU entra,
  --     nenhum sai), enquanto o preço passa a ser o deduplicado. É o único ponto em que esta
  --     migration se afasta do "trocar só o FROM" — e é o que a impede de trocar viés por mentira.
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0))
             FILTER (WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0) AS preco_unitario,
           COUNT(*) AS n
    FROM v_sku_leadtime_efetivo slh
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  -- ── EMBALAGEM (novo) ─────────────────────────────────────────────────────────────────────
  -- Membros ativos dos grupos de equivalência (empresa = lower).
  equiv AS (
    SELECT grupo_id, sku_codigo_omie::text AS sku, fator_para_base
    FROM sku_embalagem_equivalencia
    WHERE empresa = lower(p_empresa) AND ativo = TRUE AND fator_para_base > 0
  ),
  -- Só grupos com >= 2 membros têm decisão de embalagem.
  equiv_grupos AS (
    SELECT grupo_id FROM equiv GROUP BY grupo_id HAVING count(*) >= 2
  ),
  -- Preço-app mais recente por SKU (empresa = lower), líquido e > 0.
  preco_app AS (
    SELECT DISTINCT ON (sku_codigo_omie) sku_codigo_omie::text AS sku, preco, capturado_em
    FROM sku_preco_fornecedor_capturado
    WHERE empresa = lower(p_empresa) AND status = 'ok' AND preco > 0
    ORDER BY sku_codigo_omie, capturado_em DESC
  ),
  -- Portal-map ativo por SKU (empresa = upper). Sem map → não dá pra emitir ao portal → inelegível.
  portal_map AS (
    SELECT DISTINCT sku_omie::text AS sku
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE AND sku_portal IS NOT NULL AND btrim(sku_portal) <> ''
  ),
  -- [EMBALAGEM PORTAL] fator_conversao = unidades do PORTAL por unidade do OMIE (0,2 = litro → balde 5 L).
  -- Só fator ATIVO, finito e > 0, DIFERENTE de 1, chaveado por (empresa, fornecedor, sku) — a UNIQUE da tabela.
  -- O join adiante exige fornecedor_nome = o da linha (sp.fornecedor_nome): precisão > recall — de-para de
  -- OUTRO fornecedor nunca decide a embalagem desta compra. Fator ≤ 0/NaN/Infinity é ignorado aqui (status quo em L);
  -- a edge, que tem efeito externo, é quem lança (fail-closed na fronteira).
  portal_fator AS (
    SELECT sku_omie::text AS sku, fornecedor_nome, fator_conversao AS fator
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE
      AND fator_conversao IS NOT NULL AND fator_conversao > 0 AND fator_conversao <> 1
      AND fator_conversao < 1e9   -- UMA guarda de finitude: NaN e Infinity ordenam ACIMA de todo número em numeric (NaN > 0 é TRUE)
  ),
  -- [P0-a] Saldo físico do Omie por SKU (account-aware; 1 linha/SKU, a mais recente). As 2 fontes de estoque
  -- DIVERGEM: inventory_position tem alguns galões (WP87/WP04), sku_estoque_atual tem outros (WP01). GREATEST
  -- (adiante) pega o galão real de onde estiver.
  inv_saldo AS (
    SELECT DISTINCT ON (omie_codigo_produto) omie_codigo_produto::text AS sku, saldo
    FROM inventory_position
    WHERE account = ANY (CASE lower(p_empresa)
            WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
            WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
            WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
            ELSE ARRAY[lower(p_empresa)] END)
    ORDER BY omie_codigo_produto, synced_at DESC NULLS LAST
  ),
  -- [P1-f] Membro ELEGÍVEL p/ a decisão: preço-app FRESCO + portal-map + CATÁLOGO OK (ativo, tipo≠04, família
  -- comprável, ativo_no_omie) — os MESMOS filtros que protegem a âncora, agora também no SKU que pode ser escolhido.
  membro_elegivel AS (
    SELECT e.grupo_id, e.sku, e.fator_para_base, pa.preco,
           (pa.preco / e.fator_para_base) AS custo_base
    FROM equiv e
    JOIN equiv_grupos eg ON eg.grupo_id = e.grupo_id
    JOIN preco_app pa ON pa.sku = e.sku AND pa.capturado_em >= now() - make_interval(days => v_stale_dias)
    JOIN portal_map pm ON pm.sku = e.sku
    JOIN omie_products opm ON opm.omie_codigo_produto::text = e.sku AND opm.account = lower(p_empresa)
    LEFT JOIN sku_status_omie ssom ON ssom.empresa = p_empresa AND ssom.sku_codigo_omie = e.sku
    LEFT JOIN familia_nao_comprada fncm ON fncm.empresa = p_empresa AND fncm.familia = opm.familia
    WHERE COALESCE(opm.ativo, TRUE) = TRUE
      AND COALESCE(ssom.ativo_no_omie, TRUE) = TRUE
      AND fncm.id IS NULL
      AND COALESCE(opm.tipo_produto, opm.metadata->>'tipo_produto', '') <> '04'
      AND COALESCE(opm.descricao, '') NOT ILIKE '%450ML'   -- [P1-f] os MESMOS filtros de catálogo da âncora
      AND COALESCE(opm.descricao, '') NOT ILIKE '%405ML'
  ),
  -- Melhor embalagem do grupo (menor custo_base; empate → embalagem maior).
  embalagem_escolhida AS (
    SELECT DISTINCT ON (grupo_id)
           grupo_id, sku AS sku_escolhido, fator_para_base AS fator_escolhido,
           preco AS preco_escolhido, custo_base AS custo_base_escolhido
    FROM membro_elegivel
    ORDER BY grupo_id, custo_base ASC, fator_para_base DESC
  ),
  -- [P0-a/P0-b] Estoque consolidado por grupo (escala unidades-âncora):
  --   físico = Σ GREATEST(inv.saldo, sea.estoque_fisico)   ← pega o galão real de onde estiver
  --   a caminho = Σ [pendente(sea) + em_transito × fator]  ← galão em voo conta em unidades-base (2 GL = 8), não cru
  grupo_estoque AS (
    SELECT e.grupo_id,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0)))                              AS fisico_grupo,
           SUM(COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)           AS acaminho_grupo,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0))
               + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)         AS estoque_grupo,
           -- [GATE estoque-não-confirmado] grupo NÃO-CONFIRMADO se QUALQUER membro ATIVO tem seed (cold_start_seed)
           -- sem inventory_position — pode ter saldo real que mudaria a decisão. NÃO conta "sem linha de sea" (galão
           -- legitimamente vive sem sea próprio; o estoque vem de outro membro — só a LINHA isolada gateia sea ausente).
           -- inv por PRESENÇA da linha (não saldo, que pode ser NULL — Codex P1, casa a LINHA); membro INATIVO no Omie
           -- NÃO vota — senão um galão descontinuado seed-only envenenaria o grupo ativo p/ sempre (Codex P1).
           bool_or(COALESCE(sea.fonte_sync, '') = 'cold_start_seed'
                   AND inv.sku IS NULL
                   AND COALESCE(ssg.ativo_no_omie, true) = true)                                               AS grupo_nao_confirmado
    FROM equiv e
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = p_empresa AND sea.sku_codigo_omie = e.sku
    LEFT JOIN inv_saldo inv        ON inv.sku = e.sku
    LEFT JOIN em_transito et       ON et.sku_codigo_omie = e.sku
    LEFT JOIN sku_status_omie ssg  ON ssg.empresa = p_empresa AND ssg.sku_codigo_omie = e.sku  -- [GATE] inativo não vota
    GROUP BY e.grupo_id
  ),
  -- ── BASE: 1 linha por ÂNCORA (SKU com sku_parametros, i.e. o quartinho) que dispara ──────────
  sku_base AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS ancora_sku, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo, sp.minimo_forcado_manual,
           -- [TETO cobertura] demanda + teto da classe EFETIVA (forcada→abc; hoje forcada é 100% NULL em prod).
           -- teto NULL = linha sem cap (classe A, classe ausente, ou flag/config desligada).
           sp.demanda_media_diaria AS demanda_diaria_linha,
           substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1) AS classe_abc_efetiva,
           CASE substring(COALESCE(NULLIF(btrim(sp.classe_forcada), ''), sp.classe_abc::text) FROM 1 FOR 1)
             WHEN 'B' THEN v_teto_b WHEN 'C' THEN v_teto_c ELSE NULL END AS teto_dias_linha,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico_proprio,
           (COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS acaminho_proprio,
           ea.grupo_id AS equiv_grupo,
           ge.estoque_grupo, ge.fisico_grupo, ge.acaminho_grupo,
           -- estoque efetivo: do GRUPO quando a âncora pertence a um grupo; senão o próprio (no-op p/ a maioria).
           COALESCE(ge.estoque_grupo,
                    COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
           ee.sku_escolhido, ee.fator_escolhido, ee.preco_escolhido, ee.custo_base_escolhido,
           me_anc.custo_base AS ancora_custo_base,  -- NULL = âncora não-elegível → estrito (não troca)
           -- custo da linha p/ a ÂNCORA: cmc account-aware, senão preço médio histórico, senão NULL.
           -- [PRECO-AUSENTE] ausente≠zero — NÃO fabrica R$0 (o gate de auto-aprovação e o disparo já barram custo desconhecido).
           COALESCE(
             ( SELECT ipc.cmc FROM inventory_position ipc
               WHERE ipc.omie_codigo_produto::text = sp.sku_codigo_omie::text
                 AND ipc.account = ANY (CASE lower(p_empresa)
                       WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
                       WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
                       WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
                       ELSE ARRAY[lower(p_empresa)] END)
                 AND ipc.cmc > 0
               ORDER BY ipc.synced_at DESC NULLS LAST
               LIMIT 1 ),
             pm.preco_unitario) AS preco_unitario_ancora,   -- [PRECO-AUSENTE] sem fallback 0
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc,
           -- [GATE estoque-não-confirmado] confirmação por LINHA (SKU isolado): seed-only OU sem linha de estoque
           -- (Codex P1: sea AUSENTE é estoque desconhecido, não zero confirmado), sem inventory_position.
           -- inv via isl = inv_saldo (account-aware ['vendas','oben']), NÃO o ip órfão (account=lower(empresa) só):
           -- o estoque da OBEN vive em 'vendas'; PRESENÇA da linha de inv (isl.sku), p/ casar o gate de grupo.
           ((sea.sku_codigo_omie IS NULL OR COALESCE(sea.fonte_sync, '') = 'cold_start_seed') AND isl.sku IS NULL) AS linha_nao_confirmada,
           ge.grupo_nao_confirmado,
           sea.fonte_sync AS linha_fonte_sync,
           pf.fator AS fator_portal   -- [EMBALAGEM PORTAL] NULL = sem de-para com fator ≠ 1 p/ este fornecedor
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN inv_saldo isl ON isl.sku = sp.sku_codigo_omie::text   -- [GATE] confirmação por inventory_position (account-aware)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    -- equivalência da âncora + estoque consolidado + escolha de embalagem (NULL p/ SKU sem grupo).
    LEFT JOIN equiv ea ON ea.sku = sp.sku_codigo_omie::text
    LEFT JOIN grupo_estoque ge ON ge.grupo_id = ea.grupo_id
    LEFT JOIN embalagem_escolhida ee ON ee.grupo_id = ea.grupo_id
    LEFT JOIN membro_elegivel me_anc ON me_anc.grupo_id = ea.grupo_id AND me_anc.sku = sp.sku_codigo_omie::text
    LEFT JOIN portal_fator pf ON pf.sku = sp.sku_codigo_omie::text AND pf.fornecedor_nome = sp.fornecedor_nome
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      AND COALESCE((
            SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
            FROM omie_products op04
            WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
              AND op04.account = lower(p_empresa)
            LIMIT 1
          ), '') <> '04'
      -- [P1-c] A âncora NÃO pode ser um galão (membro fator>1 de um grupo): senão um GL com ponto/max viraria
      -- âncora E seria escolhido por outro membro → 2 linhas do mesmo GL (uma com custo CMC/0). A âncora é
      -- sempre a unidade-base (fator 1). (Hoje no-op: galões têm ponto/max NULL; isto blinda o futuro.)
      AND NOT EXISTS (
            SELECT 1 FROM equiv eg2
            WHERE eg2.sku = sp.sku_codigo_omie::text AND eg2.fator_para_base > 1
          )
      -- [INTRADAY 4/4] o anti-dup de oportunidade foi MOVIDO p/ depois da decisão (skus_necessitando), porque
      -- precisa olhar o SKU FINAL (âncora OU galão escolhido), não o candidato — senão bloquearia o quartinho
      -- mantido por causa de uma oportunidade do galão que nem vai ser comprado. [P1-d, refinado pós-re-Codex]
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      -- GATILHO consolidado: estoque do GRUPO (ou próprio) <= ponto_pedido da âncora.
      AND COALESCE(ge.estoque_grupo,
                   COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) <= sp.ponto_pedido
  ),
  -- ── DECISÃO: troca p/ galão só se ESTRITAMENTE mais barato/base e a âncora também é elegível ──
  -- [EMBALAGEM PORTAL] esta CTE decide em unidades-Omie (L) ou em embalagens do grupo; o múltiplo do portal
  -- entra na CTE seguinte (skus_necessitando), que é a que os INSERTs leem.
  skus_decididos AS (
    SELECT b.empresa,
           CASE WHEN trocou THEN b.sku_escolhido ELSE b.ancora_sku END AS sku_codigo_omie,
           CASE WHEN trocou
                THEN COALESCE((SELECT op2.descricao FROM omie_products op2
                               WHERE op2.omie_codigo_produto::text = b.sku_escolhido
                                 AND op2.account = lower(p_empresa) LIMIT 1), b.sku_descricao)
                ELSE b.sku_descricao END AS sku_descricao,
           b.fornecedor_nome, b.grupo_codigo, b.ponto_pedido, b.estoque_maximo,
           COALESCE(b.fisico_grupo, b.estoque_fisico_proprio)  AS estoque_fisico,
           COALESCE(b.acaminho_grupo, b.acaminho_proprio)      AS estoque_a_caminho,
           b.estoque_efetivo,
           ceil(b.estoque_maximo - b.estoque_efetivo) AS qtde_sugerida,  -- gate >0 (unidades-âncora)
           -- nº de embalagens do SKU escolhido: galão = ceil(necessidade / fator); quartinho = lógica atual.
           -- [P1-e] minimo_forcado_manual (unidades-âncora) aplicado como piso ANTES de dividir pelo fator.
           -- [TETO cobertura] só o ramo ELSE recebe o cap (trocou ⇒ tem grupo ⇒ cap NULL; min_forcado ⇒ cap NULL).
           -- LEAST na necessidade-âncora ANTES do ceil; cap 0 zera a linha (sai do pedido via skus_inseriveis + log).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.fator_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual))
             ELSE ceil(LEAST(b.estoque_maximo - b.estoque_efetivo,
                             COALESCE(b.cap_teto_ancora, b.estoque_maximo - b.estoque_efetivo)))
           END AS qtde_final,
           -- [TETO cobertura] o que a linha compraria SEM o cap (mesma unidade de qtde_final — embalagens no galão):
           -- rastro p/ item/log; capada ⇔ qtde_final < qtde_sem_teto (comparação nos consumidores).
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.fator_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual))
             ELSE ceil(b.estoque_maximo - b.estoque_efetivo)
           END AS qtde_sem_teto,
           b.cap_teto_ancora, b.teto_dias_linha, b.demanda_diaria_linha, b.classe_abc_efetiva,
           -- custo da linha: galão → preço-app (R$/embalagem, nunca 0); quartinho → cmc atual.
           CASE WHEN trocou THEN b.preco_escolhido ELSE b.preco_unitario_ancora END AS preco_unitario,
           b.primeira_compra, b.horario_corte_pedido, b.valor_maximo_mensal, b.delta_max_perc,
           -- [GATE estoque-não-confirmado] espelha estoque_efetivo=COALESCE(grupo,linha): decisão pelo grupo usa a
           -- confirmação do grupo; pela linha, a da linha. Suprime quando a fonte é só seed (ausente≠zero, precisão>recall).
           COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido,
           CASE WHEN b.grupo_nao_confirmado THEN 'grupo_membro_seed_only'
                WHEN b.linha_nao_confirmada THEN 'linha_seed_only'
                ELSE NULL END AS motivo,
           b.linha_fonte_sync,
           b.fator_embalagem
    FROM (
      SELECT b0.*,
             -- [EMBALAGEM PORTAL] só SKU SEM grupo de equivalência: no grupo, qtde_final já é nº de embalagens
             -- (QT↔GL) e o de-para dos concentrados tem fator 1 — aplicar aqui compraria N× a mais.
             CASE WHEN b0.equiv_grupo IS NULL THEN b0.fator_portal ELSE NULL END AS fator_embalagem,
             ( b0.sku_escolhido IS NOT NULL
               AND b0.sku_escolhido <> b0.ancora_sku
               AND b0.ancora_custo_base IS NOT NULL                 -- âncora elegível (comparável)
               AND b0.custo_base_escolhido < b0.ancora_custo_base   -- galão estritamente mais barato/base
             ) AS trocou,
             -- [TETO cobertura] cap em unidades-âncora; NULL = sem cap. Elegível só SEM grupo de embalagem
             -- (estoque consolidado QT+GL ÷ demanda só da âncora subcontaria → subcompra; Codex P1) e SEM
             -- minimo_forcado_manual (decisão humana vence). Piso de SERVIÇO ceil(pp − estoque): o cap corta o
             -- lote ACIMA do ponto de pedido, nunca a proteção — pp=1/estoque=1 compra 0 (mata o dente 1↔2),
             -- pp alto segue reposto até o pp (sem ruptura). Nunca negativo: no gatilho, estoque ≤ pp.
             CASE
               WHEN b0.teto_dias_linha IS NOT NULL
                AND b0.equiv_grupo IS NULL
                AND COALESCE(b0.minimo_forcado_manual, 0) <= 0
                AND COALESCE(b0.demanda_diaria_linha, 0) > 0
               THEN GREATEST(
                      floor(b0.teto_dias_linha * b0.demanda_diaria_linha - b0.estoque_efetivo),
                      GREATEST(0, ceil(b0.ponto_pedido - b0.estoque_efetivo))
                    )
               ELSE NULL
             END AS cap_teto_ancora
      FROM sku_base b0
    ) b
    -- [P1-d] [INTRADAY 4/4] anti-dup de oportunidade sobre o SKU FINAL (o que SERÁ gravado: âncora ou galão).
    -- Aqui já se sabe "trocou", então não bloqueia o quartinho mantido por uma oportunidade do galão não-usado.
    WHERE NOT EXISTS (
      SELECT 1
      FROM pedido_compra_item pci9
      JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
      WHERE pcs9.empresa = b.empresa
        AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
        AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
        AND pci9.sku_codigo_omie = CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END
    )
  ),
  -- ── [EMBALAGEM PORTAL] múltiplo da embalagem do fornecedor, ANTES da aprovação ──────────────────
  -- SKU em LITRO no Omie comprado em BALDE (fator 0,2): 36 L → ceil(7,2) = 8 BB → 40 L. É o número que a
  -- edge enviar-pedido-portal-sayerlack gravaria de qualquer forma no envio (qtdeFisicaOmie(qtdePortal()));
  -- antecipar faz o comprador aprovar o que será comprado. Fórmula espelho do helper qtde-portal.ts:
  --   trim_scale(round(GREATEST(1, ceil(round(q × fator, 6))) / fator, 6))   -- trim_scale: grava 40, não 40.000000
  -- GREATEST(1, …) = o max(1, …) de qtdePortal: necessidade > 0 nunca vira ZERO embalagens (fator minúsculo faria
  -- round(q×f,6)=0 → ceil 0 → a linha sumiria do pedido em silêncio — Codex P1-5). Domínio: 1/fator tem de ser
  -- inteiro em unidades Omie (0,2 → 5 L); com 1/3,6 o resultado 3,6 L seria integerizado depois e a edge leria
  -- 4 L como 2 galões (7,2 L) — só cadastre fator cujo inverso é inteiro.
  -- round6 ANTES do ceil: 36 × (1/3,6) em numeric = 10,000000000000000000008 → ceil 11 = um galão a mais,
  -- sem desfazer. round6 DEPOIS: 3 ÷ 0,3333333333333333 = 9,0000000000000009 → 9 (paridade com o TS).
  -- qtde_sem_teto recebe a MESMA conversão: capada ⇔ qtde_final < qtde_sem_teto compara na MESMA unidade
  -- (cap 27 L→30 L vs 36 L→40 L segue capada; cap 36→40 vs 38→40 deixa de sê-lo porque FISICAMENTE são os
  -- mesmos 8 baldes — o cap não mudou a compra). Linha capada a ZERO fica 0 (o CASE exige > 0).
  -- qtde_sugerida NÃO muda (rastro em L; a tela mostra "36 → 40" com a causa certa via fator_embalagem_portal).
  skus_necessitando AS (
    SELECT sd.empresa, sd.sku_codigo_omie, sd.sku_descricao, sd.fornecedor_nome, sd.grupo_codigo,
           sd.ponto_pedido, sd.estoque_maximo, sd.estoque_fisico, sd.estoque_a_caminho, sd.estoque_efetivo,
           sd.qtde_sugerida,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_final * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_final END AS qtde_final,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_sem_teto > 0
                THEN trim_scale(round(GREATEST(1, ceil(round(sd.qtde_sem_teto * sd.fator_embalagem, 6))) / sd.fator_embalagem, 6))
                ELSE sd.qtde_sem_teto END AS qtde_sem_teto,
           sd.cap_teto_ancora, sd.teto_dias_linha, sd.demanda_diaria_linha, sd.classe_abc_efetiva,
           sd.preco_unitario, sd.primeira_compra, sd.horario_corte_pedido, sd.valor_maximo_mensal, sd.delta_max_perc,
           sd.suprimido, sd.motivo, sd.linha_fonte_sync,
           CASE WHEN sd.fator_embalagem IS NOT NULL AND sd.qtde_final > 0 THEN sd.fator_embalagem ELSE NULL END
             AS fator_embalagem_portal
    FROM skus_decididos sd
  ),
  -- [GATE estoque-não-confirmado] LOG dos suprimidos ANTES de inserir o pedido — senão vira subcompra silenciosa.
  log_ins AS (
    INSERT INTO public.reposicao_estoque_nao_confirmado_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, motivo, estoque_efetivo, ponto_pedido, fonte_sync)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.motivo,
           sn.estoque_efetivo, sn.ponto_pedido, sn.linha_fonte_sync
    FROM skus_necessitando sn
    WHERE sn.suprimido AND sn.qtde_sugerida > 0
    RETURNING 1
  ),
  -- [TETO cobertura] LOG de toda linha REDUZIDA pelo cap (parcial ou a zero) — capado_zero sai do pedido, e sem
  -- este rastro seria subcompra silenciosa (mesma lição do gate acima). Suprimido NÃO loga aqui (o gate de
  -- estoque já cobre; estoque declarado não-confiável não sustenta um 2º diagnóstico — Codex P2).
  log_teto_ins AS (
    INSERT INTO public.reposicao_teto_cobertura_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, classe_abc, teto_dias, demanda_diaria,
       estoque_efetivo, ponto_pedido, estoque_maximo, cap_teto_ancora, qtde_sem_teto, qtde_final, motivo)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.classe_abc_efetiva,
           sn.teto_dias_linha, sn.demanda_diaria_linha, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
           sn.cap_teto_ancora, sn.qtde_sem_teto, sn.qtde_final,
           CASE WHEN sn.qtde_final <= 0 THEN 'capado_zero' ELSE 'capado_parcial' END
    FROM skus_necessitando sn
    WHERE NOT sn.suprimido AND sn.qtde_sugerida > 0 AND sn.qtde_final < sn.qtde_sem_teto
    RETURNING 1
  ),
  -- [TETO cobertura] Filtro ÚNICO dos dois INSERTs (Codex P0: divergência entre cabeçalho e item geraria pedido
  -- vazio ou item qtde 0). qtde_final>0 é novo: linha capada a zero fica só no log.
  skus_inseriveis AS (
    SELECT * FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0 AND sn.qtde_final > 0 AND NOT sn.suprimido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
           COALESCE(SUM(sn.qtde_final * sn.preco_unitario), 0), COUNT(*),   -- [PRECO-AUSENTE] valor_total é NOT NULL; item.valor_linha segue NULL (honesto)
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_inseriveis sn
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    estoque_fisico, estoque_a_caminho, qtde_sem_teto, teto_cobertura_aplicado, fator_embalagem_portal
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra,
         sn.estoque_fisico, sn.estoque_a_caminho, sn.qtde_sem_teto, (sn.qtde_final < sn.qtde_sem_teto),
         sn.fator_embalagem_portal
  FROM skus_inseriveis sn
  JOIN pedidos_por_fornecedor_grupo pfg
    -- [GRUPO-NULL] a MESMA partição do GROUP BY acima (que separa NULL de ''). COALESCE(...,'') fundia os
    -- dois: com um SKU de grupo NULL e outro de grupo '' no mesmo fornecedor, cada item casava com os 2
    -- cabeçalhos (4 itens / 16 un em vez de 2 / 8).
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  -- [FILA estoque-não-confirmado] carimba ESTE run (limpo OU com supressão) em reposicao_motor_run, p/ a fila da
  -- tela ancorar no ÚLTIMO recálculo — não no último recálculo QUE TEVE supressão. Um run limpo não grava no log de
  -- suprimidos → sem este marcador a mensagem "N fora da compra" grudava por até 24h após o sync já ter confirmado o
  -- estoque (Codex 2026-07-08: é bug de FONTE-DE-VERDADE, não de render). Aditivo, FORA dos CTEs de decisão; mesmo
  -- role/caminho do INSERT no log acima (authenticated já escreve lá, RLS INSERT WITH CHECK true) → NÃO aborta a compra.
  INSERT INTO public.reposicao_motor_run (run_id, empresa, data_ciclo, pedidos_gerados, skus_incluidos, suprimidos_n, capados_n)
  VALUES (v_run_id, p_empresa, p_data_ciclo, v_pedidos, v_skus,
          (SELECT count(*) FROM public.reposicao_estoque_nao_confirmado_log WHERE run_id = v_run_id),
          (SELECT count(*) FROM public.reposicao_teto_cobertura_log WHERE run_id = v_run_id));

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
 RETURNS TABLE(pedido_id bigint, omie_codigo_pedido text, data_ciclo date, idade_dias integer, na_janela_7d boolean, valor_total numeric, itens_sem_valor integer, visto_status text, po_no_espelho boolean, fornecedor_nome text, canal_usado text, portal_protocolo text, status_envio_portal text, resposta_canal jsonb, tem_protocolo boolean, tem_status_portal boolean, tem_resposta_canal boolean, tem_canal boolean, algum_sinal_de_canal boolean, marcador_run_id uuid, marcador_seq bigint, marcador_finalizado_em timestamp with time zone, apurado_em timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     -- ⚠️ IS NOT TRUE, não NOT(...): pode_ver_carteira_completa() era TRI-STATE (o gate ANTERIOR;
     -- private.cap_compras_ler faz COALESCE e nunca devolve NULL, entao IS NOT TRUE fica como defesa em
     -- profundidade). Para um `employee` SEM linha em commercial_roles ela retornava NULL, e `NOT NULL` =
     -- NULL — o IF não entrava e a SECURITY DEFINER ENTREGAVA TUDO (protocolo, fornecedor, JSON cru).
     -- Bypass real (Codex v11), e viola o fail-closed do CLAUDE.md. IS NOT TRUE trata NULL como negado e
     -- preserva o uid NULL do cron, que é barrado antes pelo primeiro AND.
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Sem marcador → CROSS JOIN vazio →
    -- retorna VAZIO. Fail-closed: sem base de verdade não se classifica ninguém como ausente.
    -- `finalizado_em` entra aqui para o guard temporal do WHERE (ver abaixo).
    -- ⚠️ SEM LIMITE DE FRESCOR, DE PROPÓSITO: filtrar marcador velho aqui trocaria a lista incompleta
    -- por uma lista VAZIA — o mesmo silêncio, com menos informação. O frescor vira DADO EXPOSTO
    -- (marcador_finalizado_em/apurado_em) e quem julga é o consumidor, que pode dizer "cego há Xh".
    SELECT r.run_id, r.seq, r.finalizado_em
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      p.resposta_canal,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      -- O carimbo do marcador QUE PRODUZIU ESTA LINHA. Vem daqui, e não de uma segunda consulta, para
      -- que a idade seja a da apuração que gerou a lista: entre duas leituras independentes um run
      -- pode ser promovido, e o consumidor diria "fresco" sobre uma lista velha — falso-negativo de
      -- frescor, exatamente o lado errado para errar num alerta de money-path.
      m.finalizado_em AS marcador_finalizado_em,
      -- ⚠️ sum() IGNORA NULL: itens (100.00, NULL) davam 100.00, apresentando SUBTOTAL como total apurado —
      -- fabricação de número, o que o money-path.md proíbe ("ausente ≠ zero"). Agora o total só existe se
      -- TODOS os itens têm valor; senão NULL, e itens_sem_valor diz por quê (Codex v8).
      (SELECT CASE WHEN count(*) FILTER (WHERE i.valor_linha IS NULL) = 0
                   THEN sum(i.valor_linha) END
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      (SELECT count(*) FILTER (WHERE i.valor_linha IS NULL)
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id)::integer AS itens_sem_valor,
      -- ⚠️ NULL (não FALSE) quando a identidade é ILEGÍVEL: `EXISTS(... = NULL)` retorna false, e a RPC
      -- estaria AFIRMANDO ausência no espelho sem sequer conseguir identificar o PO (Codex v7).
      -- "Não apurei" ≠ "não há" — a mesma distinção de visto_status='identidade_nao_interpretavel'.
      CASE WHEN public.reposicao__po_id(p.omie_pedido_compra_id) IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          -- identidade NUMÉRICA canônica (reposicao__po_id): '00101' e '101' são o MESMO PO; whitespace de
          -- borda tolerado, interno invalida; fora do range de bigint → NULL em vez de derrubar a RPC.
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) END AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** ('OBEN'); as outras tabelas usam o ENUM empresa_reposicao.
    -- text = enum direto é erro de TIPO em runtime (PL/pgSQL late-bound: o CREATE passa, quebra ao EXECUTAR).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      -- CANDIDATO = o PO não foi visto no marcador atual (carimbado por run ANTERIOR ou NUNCA carimbado).
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
      -- ⚠️ GUARD TEMPORAL: um run que TERMINOU antes de o PO existir não testemunha NADA sobre ele.
      -- O carimbo de `last_seen` só sai no run COMPLETO (1×/dia); todo PO criado depois dele ficava
      -- "não visto" por até ~22h e virava alerta de conferência manual (prod 13/08: 4 de 4 candidatos,
      -- média histórica de 11,0h por pedido). Sem este guard o detector acusa o próprio atraso.
      --
      -- Deliberadamente CONSERVADOR nos dois lados:
      --   • `IS NULL` → segue candidato: sem data de registro não dá para provar impossibilidade, e a
      --     comparação devolveria NULL, que o AND descartaria em SILÊNCIO (supressão acidental).
      --   • `<=` (não `<`) mantém candidato o PO registrado DURANTE a coleta — ele pode legitimamente
      --     não ter entrado na varredura. Suprime-se o impossível, nunca o duvidoso.
      --
      -- ⚠️ O CUSTO DESTE GUARD, agora VISÍVEL em vez de silencioso: se o marcador congelar, este mesmo
      -- predicado esconde todo PO nascido depois dele — indefinidamente. Não dá para consertar aqui
      -- (afrouxar reintroduz os 11,0h/pedido de alerta falso). Conserta-se EXPONDO a idade do marcador,
      -- que é o que as colunas novas fazem.
      -- ⚠️ 14/08/2026: este predicado passou a ler o limite CAUSAL. Os comentários ACIMA que citam
      -- omie_registrado_em descrevem a versão ANTERIOR (#1718) e ficaram para contexto.
      -- Migration 20260814022626 · prova db/test-po-inexistente-antes-de.sh
      AND (p.omie_po_inexistente_antes_de IS NULL OR p.omie_po_inexistente_antes_de <= m.finalizado_em)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito só soma disparados dos últimos 7d. Idade = PRIORIDADE, não verdade.
    -- NOME FACTUAL: a RPC apura a JANELA, nao o dano (um aprovado_aguardando_disparo de 3 dias sem canal
    -- nenhum recebia dano_ativo=true so pela idade — Codex v9). Quem decide se ha dano e o consumidor.
    (b.idade_dias BETWEEN 0 AND 7) AS na_janela_7d,
    b.valor_total,
    b.itens_sem_valor,
    -- ⚠️ identidade ILEGÍVEL não é "nunca visto": o LEFT JOIN não pôde nem comparar. Afirmar ausência aqui
    -- era falha ABERTA (Codex v6 P1) — e o assert J3 chegava a FIXAR esse falso-positivo como esperado.
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      -- 'sem_registro_last_seen', não 'nunca_carimbado': a RPC prova a ausência ATUAL da linha, não que o PO
      -- nunca foi visto — a linha pode ter sido apagada/reconstruída (Codex v10). "Nunca" é afirmação de
      -- histórico, e histórico esta RPC não consulta.
      WHEN b.visto_run_id IS NULL                                THEN 'sem_registro_last_seen'
      -- 'outro_run', não 'anterior': a RPC só prova `run_id <> marcador`. O outro run pode ser POSTERIOR
      -- (seq maior, ainda não promovido a marcador) ou um UUID sem linha na tabela de runs (Codex v11).
      -- Afirmar "anterior" seria temporalidade não apurada.
      ELSE 'visto_em_outro_run'
    END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- 🔑 SEM REGEX SEMÂNTICA (Codex v9). Quatro rodadas seguidas acharam um valor que enganava o rótulo:
    -- 'su cesso' virava sucesso por coerção de whitespace; 'sem sucesso' casava a regex; e a guarda de
    -- negação criou falso-NEGATIVO ('login: sucesso' — o `in` casa no fim de "log-IN") e falso-POSITIVO
    -- ('não houve sucesso' — o [^a-z]* não atravessa "houve"). Interpretar texto LIVRE de terceiro por regex
    -- não converge, e o rótulo não decide nada desde que a coluna `rota` morreu na v4.
    -- Ficam só FATOS BINÁRIOS incontestáveis. O humano/PR3 lê os campos crus (portal_protocolo,
    -- status_envio_portal, resposta_canal, canal_usado) e interpreta com o contexto que a RPC não tem.
    b.portal_protocolo,
    b.status_envio_portal,
    b.resposta_canal,
    (public.reposicao__trim(b.portal_protocolo) <> '')    AS tem_protocolo,
    (public.reposicao__trim(b.status_envio_portal) <> '') AS tem_status_portal,
    -- ⚠️ JSON null ('null'::jsonb) NÃO é SQL NULL: `IS NOT NULL` dava true e a RPC afirmava resposta
    -- existente onde não há nenhuma (Codex v10).
    (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null') AS tem_resposta_canal,
    (public.reposicao__trim(b.canal_usado) <> '')         AS tem_canal,
    -- "há algum indício de que o fornecedor foi acionado?" — OR simples, sem inferência.
    (public.reposicao__trim(b.portal_protocolo) <> ''
      OR public.reposicao__trim(b.status_envio_portal) <> ''
      OR (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null')
      OR public.reposicao__trim(b.canal_usado) <> '')     AS algum_sinal_de_canal,
    b.marcador_run_id,
    b.marcador_seq,
    b.marcador_finalizado_em,
    -- O "agora" do BANCO, para que a idade do marcador seja uma subtração entre dois pontos do MESMO
    -- relógio. Ver o cabeçalho: ancorar um dos lados no relógio do cliente entrega o alerta ao skew da
    -- máquina do usuário. `now()` é STABLE (o timestamp da transação) — legítimo aqui, e a RPC já o usa
    -- acima em `idade_dias`.
    now() AS apurado_em
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$function$;

ALTER TABLE public.pedido_compra_sugerido ALTER COLUMN data_ciclo SET DEFAULT CURRENT_DATE;
