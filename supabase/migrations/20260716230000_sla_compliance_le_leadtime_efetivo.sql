-- Fase 0-bis — a quarentena da leitura alcança o SLA de fornecedor.
--
-- CONTEXTO: a Fase 0 (20260716180000) criou v_sku_leadtime_efetivo (1 linha por
-- empresa+NFe+SKU, regra "concorda-ou-NULL") e repontou v_sku_leadtime_estatisticas
-- para ela. Auditoria desta sessão (pg_depend + prosrc na PROD, 2026-07-16): a Fase 0
-- protegeu UM consumidor. v_sku_sla_compliance continuou lendo a tabela CRUA e carrega
-- o MESMO defeito que a Fase 0 corrigiu na view irmã.
--
-- O DEFEITO AQUI (auditado em prod, OBEN, 2026-07-16):
--   lt_observado faz avg/stddev_samp/percentile_cont/count(*) sobre as LINHAS. Uma NFe
--   que fatura N pedidos gera N cópias do mesmo item ⇒ a maioria dos SKUs com histórico
--   tem n_observacoes inflado e desvio errado, e — o que decide — uma fração material
--   deles cruza o gate `n_observacoes >= 3` com UMA observação replicada. O status_sla
--   desses sai de 'poucos_dados' para um veredito (cumprindo/limite/violando/critico)
--   calculado sobre confiança FABRICADA: cópias idênticas têm variância nula.
--
-- A CORREÇÃO: trocar a fonte das duas CTEs para v_sku_leadtime_efetivo. Nada mais.
-- A regra de colapso e o "ausente != zero" já vivem na view efetiva (Fase 0); aqui só
-- deixamos de ler por cima dela.
--
-- ⚠️ MUDA O QUE A TELA MOSTRA (é a correção, não efeito colateral):
--   Os SKUs de gate fabricado caem para status_sla='poucos_dados'. Eles nunca tiveram 3
--   recebimentos reais — a tela prometia um veredito de SLA que o dado não sustenta.
--   Degradação honesta: "poucos_dados" > um "cumprindo" inventado.
--
-- ⚠️ NULLS FIRST no Top-5 (achado do Codex xhigh, confirmado no PG17 e na prod):
--   `ORDER BY t4_data_recebimento DESC` é NULLS FIRST por default no Postgres. A view
--   efetiva emite t4=NULL quando as cópias divergem, e existem em prod linhas com
--   lt_bruto VÁLIDO mas t4 NULL. Um repontamento ingênuo colocaria justamente as
--   observações de data indeterminada no topo do row_number() e elas virariam "as 5
--   mais recentes" — contaminando `tendencia` (melhorando/piorando/estavel).
--   Fix: `t4_data_recebimento IS NOT NULL` no WHERE do ranked. "As 5 mais recentes"
--   exige saber a data; sem data, a observação não concorre a recência (ela continua
--   contando em lt_observado, que não depende de ordenação).
--
-- Prova: db/test-sla-compliance-leadtime-efetivo.sh (PG17, asserts + falsificação).
-- Pré-flight: pg_get_viewdef da PROD conferido via psql-ro — o corpo abaixo é o de prod
-- com as 2 trocas de fonte + o NULLS. Ordem das 22 colunas preservada VERBATIM
-- (CREATE OR REPLACE VIEW não reordena: docs/agent/database.md §5).

CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS
  WITH lt_observado AS (
          -- FONTE: v_sku_leadtime_efetivo (era sku_leadtime_history). count(*) aqui
          -- passa a contar NFe, não linha — é o gate `>= 3` do status_sla.
          SELECT v_sku_leadtime_efetivo.empresa::text AS empresa,
             v_sku_leadtime_efetivo.sku_codigo_omie::text AS sku_codigo_omie,
             avg(v_sku_leadtime_efetivo.lt_bruto_dias_uteis) AS lt_medio_observado,
             stddev_samp(v_sku_leadtime_efetivo.lt_bruto_dias_uteis) AS lt_desvio_observado,
             percentile_cont(0.50::double precision) WITHIN GROUP (ORDER BY (v_sku_leadtime_efetivo.lt_bruto_dias_uteis::double precision)) AS lt_mediana_observada,
             percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (v_sku_leadtime_efetivo.lt_bruto_dias_uteis::double precision)) AS lt_p95_observado,
             min(v_sku_leadtime_efetivo.lt_bruto_dias_uteis) AS lt_min,
             max(v_sku_leadtime_efetivo.lt_bruto_dias_uteis) AS lt_max,
             count(*) AS n_observacoes,
             max(v_sku_leadtime_efetivo.t4_data_recebimento::date) AS ultimo_recebimento,
             avg(v_sku_leadtime_efetivo.lt_faturamento_dias_uteis) AS lt_faturamento_medio,
             avg(v_sku_leadtime_efetivo.lt_logistica_dias_uteis) AS lt_logistica_medio
            FROM v_sku_leadtime_efetivo
           WHERE v_sku_leadtime_efetivo.lt_bruto_dias_uteis IS NOT NULL
           GROUP BY (v_sku_leadtime_efetivo.empresa::text), (v_sku_leadtime_efetivo.sku_codigo_omie::text)
         ), lt_recente AS (
          SELECT ranked.empresa::text AS empresa,
             ranked.sku_codigo_omie::text AS sku_codigo_omie,
             avg(ranked.lt_bruto_dias_uteis) AS lt_medio_recente,
             count(*) AS n_recentes
            FROM ( SELECT slh.empresa,
                     slh.sku_codigo_omie,
                     slh.lt_bruto_dias_uteis,
                     -- A projeção original listava id/tracking_id/created_at/updated_at, que
                     -- a view efetiva não expõe (ela agrega — a identidade agora é
                     -- (empresa, NFe, SKU)). Nenhuma delas era usada no resultado: só
                     -- empresa, sku_codigo_omie, lt_bruto_dias_uteis e rn.
                     row_number() OVER (PARTITION BY slh.empresa, slh.sku_codigo_omie ORDER BY slh.t4_data_recebimento DESC) AS rn
                    FROM v_sku_leadtime_efetivo slh
                   WHERE slh.lt_bruto_dias_uteis IS NOT NULL
                     AND slh.t4_data_recebimento IS NOT NULL) ranked
           WHERE ranked.rn <= 5
           GROUP BY (ranked.empresa::text), (ranked.sku_codigo_omie::text)
         )
  SELECT sp.empresa,
     sp.sku_codigo_omie::text AS sku_codigo_omie,
     sp.sku_descricao,
     sp.fornecedor_nome,
     sg.grupo_codigo,
     lts.lt_total_teorico_dias_uteis AS lt_teorico,
     round(lo.lt_medio_observado, 2) AS lt_observado_medio,
     round(lo.lt_desvio_observado, 2) AS lt_observado_desvio,
     round(lo.lt_mediana_observada::numeric, 1) AS lt_observado_mediana,
     round(lo.lt_p95_observado::numeric, 1) AS lt_observado_p95,
     lo.lt_min,
     lo.lt_max,
     lo.n_observacoes,
     lo.ultimo_recebimento,
     round(lo.lt_faturamento_medio, 2) AS lt_faturamento_medio,
     round(lo.lt_logistica_medio, 2) AS lt_logistica_medio,
     round(lr.lt_medio_recente, 2) AS lt_recente_medio,
     lr.n_recentes,
     round(lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric, 2) AS desvio_absoluto,
     round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1) AS desvio_perc,
         CASE
             WHEN lr.lt_medio_recente IS NULL OR lo.lt_medio_observado IS NULL THEN 'sem_dados'::text
             WHEN lr.lt_medio_recente < (lo.lt_medio_observado * 0.9) THEN 'melhorando'::text
             WHEN lr.lt_medio_recente > (lo.lt_medio_observado * 1.1) THEN 'piorando'::text
             ELSE 'estavel'::text
         END AS tendencia,
         CASE
             WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'sem_sla_teorico'::text
             WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 'poucos_dados'::text
             WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 'cumprindo'::text
             WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 'limite'::text
             WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.50) THEN 'violando'::text
             ELSE 'critico'::text
         END AS status_sla
    FROM sku_parametros sp
      LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
      LEFT JOIN v_sku_lt_teorico lts ON lts.empresa = sp.empresa AND lts.sku_codigo_omie = sp.sku_codigo_omie::text
      LEFT JOIN lt_observado lo ON lo.empresa = sp.empresa AND lo.sku_codigo_omie = sp.sku_codigo_omie::text
      LEFT JOIN lt_recente lr ON lr.empresa = sp.empresa AND lr.sku_codigo_omie = sp.sku_codigo_omie::text
   ORDER BY (
         CASE
             WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 5
             WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 4
             WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 3
             WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 2
             ELSE 1
         END), (round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1)) DESC NULLS LAST;

COMMENT ON VIEW public.v_sku_sla_compliance IS
  'SLA de leadtime por SKU. Lê v_sku_leadtime_efetivo (NÃO a tabela crua): n_observacoes '
  'conta NFe, não linha — uma NFe que fatura N pedidos gera N cópias do item e cruzaria o '
  'gate `>= 3` do status_sla com desvio zero (confiança fabricada). O Top-5 de lt_recente '
  'exige t4 conhecido: ORDER BY t4 DESC é NULLS FIRST no Postgres, e a view efetiva emite '
  't4 NULL quando as cópias divergem — sem o filtro, a observação de data indeterminada '
  'viraria "a mais recente" e falsearia a tendencia.';
