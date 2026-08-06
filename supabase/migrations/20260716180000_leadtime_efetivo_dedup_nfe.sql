-- Fase 0 — quarentena na leitura: leadtime deixa de contar linha e passa a contar NFe.
--
-- PROBLEMA (medido em prod 2026-07-16, OBEN):
--   Uma NFe que fatura N pedidos de compra produz N linhas em purchase_orders_tracking
--   com a MESMA nfe_chave_acesso. A edge omie-sync-sku-items grava TODOS os itens do
--   recebimento sob o tracking_id da linha que estava iterando, então o par (NFe, SKU)
--   aparece sob N tracking_id. A multiplicidade É o nº de linhas que dividem a chave.
--
--   Efeito no money-path: v_sku_leadtime_estatisticas faz count(*)/avg/stddev/p95 sobre
--   as LINHAS. O gate `lt_n_observacoes >= 3` decide entre leadtime do SKU e média do
--   fornecedor — e uma única observação replicada 3× CRUZA o gate com desvio-padrão ZERO
--   (cópias idênticas ⇒ variância nula). Isso é confiança estatística FABRICADA, e a
--   reposição compra em cima dela.
--
-- ESTA MIGRATION NÃO corrige o writer (a edge segue duplicando) nem o passivo. Ela
-- QUARENTENA a leitura: os consumidores passam a ver 1 observação por NFe. É a Fase 0
-- de um programa; o writer é a Fase 1 e o modelo receipt-first a Fase 2.
--
-- REGRA DE COLAPSO — "concorda-ou-NULL", campo a campo:
--   As N cópias de um par (NFe, SKU) NÃO são idênticas: cada uma foi escrita com o t1 do
--   pedido que estava iterando, e t2/t4 vêm da linha disparadora (que preserva o valor
--   pré-existente do pedido via `??`). Auditado em prod: t1, t2 e t4 divergem entre as
--   cópias numa fração material dos pares — t2 com spread de até ~2 SEMANAS, o que é
--   ordens de grandeza acima do leadtime típico. valor_total, fornecedor e as colunas
--   descritivas nunca divergem.
--   Onde as cópias divergem, exatamente uma está certa e não sabemos qual → NULL.
--   Escolher representante (min/max/arbitrário) fabricaria precisão que não temos: com N
--   cópias, acertar por sorteio tem chance 1/N. Colunas descritivas → max(), que é o que
--   a própria v_sku_leadtime_estatisticas já fazia.
--
-- ⚠️ MUDA O COMPORTAMENTO DO MOTOR: uma parcela grande dos SKUs hoje classificados como
--    fonte 'SKU' migra para fonte 'FORNECEDOR' (perdem o gate `>=3`). É a correção, não
--    efeito colateral — eles nunca tiveram 3 observações reais. Dimensione ANTES do apply
--    com a query de validação do PR e reavalie o motor depois.
--
-- Prova: db/test-leadtime-efetivo-dedup-nfe.sh (PG17, asserts + falsificação).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) A view efetiva: 1 linha por (empresa, NFe, SKU)
-- ─────────────────────────────────────────────────────────────────────────────
-- security_invoker=on: a FOLHA é o elo (docs/agent/database.md §4). Esta view lê
-- purchase_orders_tracking DIRETO, então ela é a folha daquela tabela e precisa do
-- invoker=on para a RLS valer para o caller. v_sku_leadtime_history_normal já é
-- invoker=on e cuida de sku_leadtime_history.
CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo
WITH (security_invoker = on) AS
WITH base AS (
  SELECT
    h.empresa,
    h.sku_codigo_omie,
    -- Chave de colapso = a NFe. Sem chave a linha vira o próprio grupo: passa intacta em
    -- vez de sumir. LEFT JOIN pela mesma razão — tracking ausente não pode derrubar
    -- leadtime silenciosamente. (Auditado: hoje nenhuma linha cai nesses dois casos; a
    -- guarda é contra o futuro, e custa nada.)
    COALESCE(pot.nfe_chave_acesso, 'tracking:' || h.tracking_id::text) AS dedup_key,
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
  FROM public.v_sku_leadtime_history_normal h
  LEFT JOIN public.purchase_orders_tracking pot ON pot.id = h.tracking_id
)
SELECT
  b.empresa,
  b.sku_codigo_omie,
  b.dedup_key,
  max(b.nfe_chave_acesso)                       AS nfe_chave_acesso,
  count(*)                                      AS n_copias_origem,
  (count(*) > 1)                                AS veio_de_duplicata,

  -- Descritivas: auditado, nunca divergem entre cópias. max() espelha o que a stats já fazia.
  max(b.sku_codigo)                             AS sku_codigo,
  max(b.sku_descricao)                          AS sku_descricao,
  max(b.sku_unidade)                            AS sku_unidade,
  max(b.sku_ncm)                                AS sku_ncm,
  max(b.fornecedor_nome)                        AS fornecedor_nome,
  max(b.grupo_leadtime)                         AS grupo_leadtime,
  max(b.origem_compra)                          AS origem_compra,

  -- Identificador que AGRUPA a estatística do fornecedor → estrito (não pode ser
  -- adivinhado; divergiu, o par não entra em nenhum bucket de fornecedor).
  CASE WHEN count(b.fornecedor_codigo_omie) = count(*)
        AND count(DISTINCT b.fornecedor_codigo_omie) = 1
       THEN min(b.fornecedor_codigo_omie) END   AS fornecedor_codigo_omie,

  -- Métricas e datas: concorda-ou-NULL. `count(col) = count(*)` exige que NENHUMA cópia
  -- seja NULL (count(col) ignora NULL); `count(DISTINCT col) = 1` exige que todas
  -- concordem. Qualquer desacordo ou ausência ⇒ NULL. Ausente ≠ zero.
  CASE WHEN count(b.quantidade_pedida) = count(*)
        AND count(DISTINCT b.quantidade_pedida) = 1
       THEN min(b.quantidade_pedida) END        AS quantidade_pedida,
  CASE WHEN count(b.quantidade_recebida) = count(*)
        AND count(DISTINCT b.quantidade_recebida) = 1
       THEN min(b.quantidade_recebida) END      AS quantidade_recebida,
  CASE WHEN count(b.valor_unitario) = count(*)
        AND count(DISTINCT b.valor_unitario) = 1
       THEN min(b.valor_unitario) END           AS valor_unitario,
  CASE WHEN count(b.valor_total) = count(*)
        AND count(DISTINCT b.valor_total) = 1
       THEN min(b.valor_total) END              AS valor_total,
  CASE WHEN count(b.t1_data_pedido) = count(*)
        AND count(DISTINCT b.t1_data_pedido) = 1
       THEN min(b.t1_data_pedido) END           AS t1_data_pedido,
  CASE WHEN count(b.t2_data_faturamento) = count(*)
        AND count(DISTINCT b.t2_data_faturamento) = 1
       THEN min(b.t2_data_faturamento) END      AS t2_data_faturamento,
  CASE WHEN count(b.t3_data_cte) = count(*)
        AND count(DISTINCT b.t3_data_cte) = 1
       THEN min(b.t3_data_cte) END              AS t3_data_cte,
  CASE WHEN count(b.t4_data_recebimento) = count(*)
        AND count(DISTINCT b.t4_data_recebimento) = 1
       THEN min(b.t4_data_recebimento) END      AS t4_data_recebimento,
  CASE WHEN count(b.lt_bruto_dias_uteis) = count(*)
        AND count(DISTINCT b.lt_bruto_dias_uteis) = 1
       THEN min(b.lt_bruto_dias_uteis) END      AS lt_bruto_dias_uteis,
  CASE WHEN count(b.lt_faturamento_dias_uteis) = count(*)
        AND count(DISTINCT b.lt_faturamento_dias_uteis) = 1
       THEN min(b.lt_faturamento_dias_uteis) END AS lt_faturamento_dias_uteis,
  CASE WHEN count(b.lt_logistica_dias_uteis) = count(*)
        AND count(DISTINCT b.lt_logistica_dias_uteis) = 1
       THEN min(b.lt_logistica_dias_uteis) END  AS lt_logistica_dias_uteis
FROM base b
GROUP BY b.empresa, b.dedup_key, b.sku_codigo_omie;

COMMENT ON VIEW public.v_sku_leadtime_efetivo IS
  'Leadtime deduplicado: 1 linha por (empresa, NFe, SKU). Uma NFe que fatura N pedidos '
  'gera N cópias do mesmo item em sku_leadtime_history (writer: omie-sync-sku-items). '
  'Aqui elas colapsam; onde as cópias divergem o campo vira NULL (não sabemos qual está '
  'certa — ausente != zero). Consuma ESTA view para estatística/contagem, nunca a tabela '
  'crua nem v_sku_leadtime_history_normal.';

-- Projeta preço de compra (valor_unitario/valor_total). Lição do P0 #1246
-- (docs/agent/database.md §4): view de reposição legível por anon vazava custo/margem.
-- authenticated fica: staff é authenticated e a RLS de sku_leadtime_history (staff-only)
-- filtra o customer via a cadeia invoker=on.
REVOKE SELECT ON public.v_sku_leadtime_efetivo FROM anon, PUBLIC;
GRANT SELECT ON public.v_sku_leadtime_efetivo TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) A estatística passa a ler a view efetiva
-- ─────────────────────────────────────────────────────────────────────────────
-- Única mudança: a fonte das duas CTEs (v_sku_leadtime_history_normal → efetivo).
-- As 12 colunas de saída e a ordem são IDÊNTICAS às da prod em 2026-07-16
-- (CREATE OR REPLACE VIEW só acrescenta coluna no fim; reordenar dá
-- "cannot change name of view column"). Conferido via pg_get_viewdef antes do REPLACE.
CREATE OR REPLACE VIEW public.v_sku_leadtime_estatisticas
WITH (security_invoker = on) AS
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
          WHERE h.t2_data_faturamento >= (CURRENT_DATE - '180 days'::interval) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.sku_codigo_omie
        ), fornecedor_stats AS (
         SELECT h.empresa::text AS empresa,
            h.fornecedor_codigo_omie,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_desvio,
            count(*) AS lt_fornecedor_n_observacoes
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (CURRENT_DATE - '180 days'::interval) AND h.lt_bruto_dias_uteis IS NOT NULL
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
