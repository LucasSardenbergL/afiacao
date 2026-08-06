-- Fase 0-quinquies — a CTE de PREÇO DE COMPRA da view de parâmetros passa a ler a fonte
-- deduplicada por NFe.
--
-- CONTEXTO: uma NFe que fatura N pedidos gera N cópias do mesmo item em
-- sku_leadtime_history (writer corrigido em #1345; o passivo é resíduo finito que não
-- cresce). Quem agrega sobre as LINHAS pondera a estatística pela multiplicidade. A
-- leitura vem sendo quarentenada consumidor a consumidor via v_sku_leadtime_efetivo
-- (1 linha por (empresa, NFe, SKU)): #1343 cobriu v_sku_leadtime_estatisticas, #1354
-- cobriu v_sku_sla_compliance + os leitores React, #1357 cobriu a stack de outliers,
-- #1366 cobre a CTE `preco_medio` do motor de pedidos. Esta cobre a CTE GÊMEA
-- `precos_compra` desta view — a última leitura crua não-dormente.
--
-- Ela escapou de #1343/#1354/#1357 porque a receita de auditoria varria `prosrc ILIKE`,
-- e prosrc só existe em pg_proc: enxerga FUNÇÃO, não VIEW. A receita corrigida (3
-- varreduras: pg_proc.prosrc + pg_get_viewdef + grep no src/ sem head) está no
-- sync-registry.md e foi o que achou esta CTE.
--
-- O defeito: AVG(valor_total / qtde_recebida) e COUNT(*) sobre as LINHAS. A NFe duplicada
-- N× pesa N× na média e infla a contagem. Corrigido trocando a fonte da CTE — e SÓ isso:
-- o corpo restante é byte-a-byte o da prod (conferido via pg_get_viewdef antes do
-- REPLACE). A view normal aparecia exatamente 6× no corpo, todas dentro desta CTE.
--
-- ─── HONESTIDADE SOBRE O GANHO: aqui NÃO é zero — mas também não é a quantidade comprada ─
-- Medido na prod antes do apply (psql-ro, 2026-07-16), simulando a view nas duas fontes:
--   • O que MUDA e o usuário VÊ: preco_compra_real muda em ~48% dos SKUs com histórico
--     (pior caso na casa dos 25%+ de erro), e n_compras muda em ~81% deles. Estas duas são
--     colunas de SAÍDA lidas direto pela tela (SkuDetailSheet exibe o preço, o markup
--     preco_venda/preco_compra e o literal "baseado em N compras"; AlertaDrillSheet exibe o
--     preço; a fila de Negociação Paralela ordena o Top-3 por gasto_anual = preço × consumo).
--     NÃO há cmc-first entre elas e o olho do usuário — a cortina que zera o ganho do #1366
--     não existe deste lado. "baseado em N compras" contando cópias de NFe é confiança
--     fabricada, a mesma família do #1343.
--   • O que NÃO muda: a quantidade a comprar. Medido: preco_item_eoq muda em 2 SKUs e
--     ZERO SKUs mudam qtde_compra_ciclo_sugerida. O EOQ é cmc-first (a esmagadora maioria
--     dos SKUs ancora no cmc), só uma minoria cai no fallback preco_compra_real, e nessa
--     minoria o erro que sobra é pequeno — o preço entra sob sqrt() e sai por ceil(),
--     que absorve o resto.
-- Ou seja: esta migration conserta números que o app MOSTRA hoje e a ordenação de uma fila
-- de negociação; ela NÃO muda quanto se compra. Não inflar o ganho é parte do conserto.
--
-- ─── REGRA DE COLAPSO: repontar NÃO é trocar o FROM ───────────────────────────────────
-- A view efetiva emite NULL onde as cópias divergem ("concorda-ou-NULL"). Decidido campo a
-- campo, MEDINDO — só os 4 campos que esta CTE lê importam:
--   • valor_total → as cópias SEMPRE concordam (medido: nenhum par perde o campo).
--   • quantidade_recebida → um punhado de pares perde o campo (divergem na quantidade,
--     concordam no valor). Esses pares saem da CTE pelo `> 0` (NULL > 0 é NULL). Não é
--     sumiço silencioso: é a única leitura honesta. Sabemos o valor mas não a quantidade
--     ⇒ o preço unitário daquela NFe é genuinamente incognoscível; eleger um representante
--     fabricaria precisão. Ausente ≠ zero.
--   • empresa / sku_codigo_omie → chaves do GROUP BY, nunca nulas na view (dedup_key é
--     garantidamente não-nulo). Tipos idênticos aos da view normal; o ::text de saída é
--     preservado. A repontagem não introduz cast novo.
--
-- ─── OS QUATRO CONSUMIDORES DA CTE (o #1366 tinha dois; aqui são quatro) ──────────────
--   1. preco_compra_real → coluna de saída, SEM cortina. É o ganho principal.
--   2. n_compras → coluna de saída, SEM cortina. Passa a contar NFe, não linha.
--   3. preco_item_eoq = COALESCE(cmc, pc.preco_compra_real, preco_venda*0.55) → cmc-first.
--      Medido: muda em 2 SKUs, e ZERO mudam a quantidade sugerida. Imaterial.
--   4. fonte_preco = CASE ... WHEN pc.preco_compra_real IS NOT NULL THEN 'compra_real' →
--      SEM proteção nenhuma. Este era o risco real, análogo ao `primeira_compra` do #1366:
--      se o colapso derrubasse um SKU INTEIRO da CTE, fonte_preco degradaria p/
--      'venda_estimado' (preço estimado por 55% do preço de venda) ou 'sem_preco', e o
--      status_sugestao viraria 'SEM_PRECO' — apagando a sugestão INTEIRA daquele SKU
--      (mínimo, ponto de pedido, qtde de ciclo, máximo, cobertura). Medido: NENHUM SKU
--      some da CTE (os pares que perdem quantidade_recebida sempre têm irmãos sobreviventes
--      no mesmo SKU). Zero viradas de fonte_preco e zero de status_sugestao.
--      ⚠️ Risco latente aceito e registrado: a medição é um retrato. Se o resíduo mudar e a
--      ÚNICA observação de um SKU perder quantidade_recebida, aquele SKU cairia p/
--      'venda_estimado' — degradação honesta e sinalizada na tela pelo badge de fonte, não
--      número fabricado. Por isso NÃO se justifica machinery de guarda aqui.
--
-- ─── ESCOPO: aqui o filtro origem_compra='normal' NÃO vem de brinde (≠ #1366) ─────────
-- v_sku_leadtime_efetivo lê v_sku_leadtime_history_normal, e esta CTE JÁ lia a normal.
-- Logo a repontagem preserva o escopo exatamente: compras de oportunidade seguem fora,
-- como já estavam. (No #1366 a CTE lia a tabela CRUA e por isso GANHA o filtro; aqui não
-- há mudança de escopo — só de granularidade: linha → NFe.)
--
-- ─── DEPENDENTES (baseline medido na prod antes do apply) ─────────────────────────────
-- 3 views dependem desta: v_oportunidade_economica_hoje e v_promocao_avaliacao_hoje (ambas
-- VAZIAS hoje) e v_sku_candidatos_primeira_compra (poucas linhas, TODAS ancoradas em cmc,
-- nenhuma via compra_real ⇒ imunes). Todas consomem preco_item_eoq, que muda em 2 SKUs.
--
-- Prova: db/test-precos-compra-leadtime-efetivo.sh (PG17, asserts + falsificação).
-- Pré-flight: pg_get_viewdef da PROD conferido via psql-ro — o corpo abaixo é o de prod
-- com as 6 trocas de fonte e NADA mais. Ordem das 51 colunas preservada VERBATIM
-- (CREATE OR REPLACE VIEW não reordena: docs/agent/database.md §5).

CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos
WITH (security_invoker = on) AS
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
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND venda_items_history.quantidade > 0::numeric
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
    CURRENT_DATE AS calculado_em,
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
