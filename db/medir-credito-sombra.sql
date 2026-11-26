-- Medição do gate v2 em MODO SOMBRA (crédito-IA PR 5) — rode por psql-ro:
--   ~/.config/afiacao/psql-ro -X -f db/medir-credito-sombra.sql
-- Critério do programa (roteiro, linha do PR 5): 2+ semanas de distribuição de faixas. Esta query É o
-- "quando medir". A distribuição conta PV (última versão), nunca a carga inicial.
-- Leitura: falso 🟢 é o risco; 🟡 por prazo desconhecido é esperado (importado não traz parcela;
-- Colacor sem catálogo) — a coluna "sem_prazo" mostra o que sobraria se o prazo fosse aceito.
\pset footer off

\echo '── 0. critério das 2 semanas (histórico IMUTÁVEL de decisões e lotes, não a última versão) ──'
-- passa só com: ≥ 14 d desde a 1ª decisão nova, nenhum buraco > 1 h entre lotes ok nos últimos 14 d,
-- último lote há < 30 min, e nenhum PV de venda elegível sem observação (decisão ou tentativa).
WITH lotes AS (
  SELECT terminado_em, terminado_em - lag(terminado_em) OVER (ORDER BY terminado_em) AS gap
    FROM public.credito_sombra_lote WHERE status = 'ok' AND terminado_em > now() - interval '14 days'
), dec AS (
  SELECT min(avaliado_em) AS primeira, count(*) AS decisoes,
         count(DISTINCT (avaliado_em AT TIME ZONE 'America/Sao_Paulo')::date) AS dias_com_decisao
    FROM public.credito_sombra_decisao WHERE NOT carga_inicial
), sem_obs AS (
  SELECT count(*) AS n FROM public.sales_orders s
    LEFT JOIN public.credito_sombra_carga k ON k.sales_order_id = s.id
   WHERE s.account IN ('oben','colacor') AND s.status NOT IN ('cancelado','rascunho','pendente','orcamento')
     AND (k.sales_order_id IS NULL OR k.situacao <> 'historico')
     AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_decisao d WHERE d.sales_order_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_tentativa t WHERE t.sales_order_id = s.id)
)
SELECT (SELECT ativado_em FROM public.credito_sombra_marco) AS ativado_em,
       dec.primeira, dec.decisoes, dec.dias_com_decisao,
       (SELECT count(*) FROM lotes) AS lotes_ok_14d,
       (SELECT max(gap) FROM lotes) AS maior_buraco_entre_lotes,
       (SELECT now() - max(terminado_em) FROM lotes) AS desde_ultimo_lote,
       sem_obs.n AS pvs_sem_observacao,
       (dec.primeira <= now() - interval '14 days'
        AND COALESCE((SELECT max(gap) FROM lotes), interval '99 days') <= interval '1 hour'
        AND (SELECT now() - max(terminado_em) FROM lotes) < interval '30 minutes'
        AND sem_obs.n = 0) AS criterio_2_semanas
  FROM dec, sem_obs;

\echo '── 1. distribuição de faixas (PV atual, sem carga) por empresa × origem ──'
SELECT company, origem, faixa, count(*) AS pvs, round(sum(valor_brl)) AS brl,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY company, origem), 1) AS pct
  FROM public.credito_sombra_pv_atual WHERE NOT carga_inicial
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo '── 2. faixa por motivo (o que alimenta a fila 🟡 do PR 6) ──'
SELECT faixa, motivo, count(*) AS pvs, round(sum(valor_brl)) AS brl
  FROM public.credito_sombra_pv_atual WHERE NOT carga_inicial
 GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '── 3. se o prazo fosse aceito (calibração; nunca é decisão) ──'
SELECT company, origem, (prazo_dias IS NULL) AS prazo_desconhecido, faixa_sem_prazo, motivo_sem_prazo,
       count(*) AS pvs, round(sum(valor_brl)) AS brl
  FROM public.credito_sombra_pv_atual WHERE NOT carga_inicial
 GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 6 DESC;

\echo '── 4. concordância v2 × piso atual (PR 1): o piso bloquearia? ──'
SELECT faixa, (piso ->> 'bloqueado')::boolean AS piso_bloqueia, count(*) AS pvs, round(sum(valor_brl)) AS brl
  FROM public.credito_sombra_pv_atual WHERE NOT carga_inicial
 GROUP BY 1, 2 ORDER BY 1, 2;
-- 🔴 com piso_bloqueia=false = PAGTO PARCIAL/fronteira que o piso não vê; 🟢 com piso_bloqueia=true
-- seria falha (impossível pela ordem de decisão — se aparecer, é incidente).

\echo '── 5. coorte: status do PV na 1ª observação (faturado = retrospectivo, não pré-venda) ──'
WITH primeira AS (
  SELECT DISTINCT ON (sales_order_id, company) sales_order_id, company, status_pedido
    FROM public.credito_sombra_decisao ORDER BY sales_order_id, company, avaliado_em, id)
SELECT p.status_pedido AS status_1a_observacao, a.faixa, count(*) AS pvs, round(sum(a.valor_brl)) AS brl
  FROM public.credito_sombra_pv_atual a JOIN primeira p USING (sales_order_id, company)
 WHERE NOT a.carga_inicial
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo '── 6. tempo até decisão ──'
-- sombra, app: revisão registrada → decisão sombra (p50/p90, min)
SELECT 'sombra_app' AS etapa, count(*) AS n,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.avaliado_em - r.criada_em))::numeric / 60, 1) AS p50_min,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM d.avaliado_em - r.criada_em))::numeric / 60, 1) AS p90_min
  FROM public.credito_sombra_decisao d
  JOIN public.credito_operacao_revisao r ON r.id::text = d.versao
 WHERE d.origem = 'app'
UNION ALL
-- fila 🟡 (efetiva): solicitação → decisão do Lucas. Vazia até o PR 6 ligar o enforcement.
SELECT 'fila_lucas', count(*),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.decidida_em - s.created_at))::numeric / 60, 1),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM s.decidida_em - s.created_at))::numeric / 60, 1)
  FROM public.credito_solicitacao s WHERE s.decidida_em IS NOT NULL;
-- importado: a hora real de criação não existe (created_at = data comercial às 12h UTC); o atraso
-- do lote fica limitado pela cadência (pull 2 h + lote 10 min).

\echo '── 7. saúde da sombra ──'
SELECT * FROM public.credito_sombra_saude;
SELECT resultado, count(*), max(criada_em) FROM public.credito_sombra_tentativa GROUP BY 1;

\echo '── 8. reserva de PV faturado ainda não coberta por título (decide a regra de transferência do PR 6) ──'
-- 'sem_titulo' = nenhum título vinculado ainda (ou vínculo não comprovável); 'parcial' = títulos cobrem parte
SELECT rs.company,
       CASE WHEN COALESCE(private_titulos.v, 0) = 0 THEN 'sem_titulo' ELSE 'parcial' END AS cobertura,
       count(*) AS n, round(sum(rs.valor_brl - COALESCE(private_titulos.v, 0))) AS residual_brl,
       round(avg(extract(epoch FROM now() - rs.created_at) / 86400)::numeric, 1) AS idade_media_d,
       count(DISTINCT rs.grupo_user_id) AS grupos
  FROM public.credito_sombra_reserva rs
  JOIN public.sales_orders s ON s.id = rs.sales_order_id
  LEFT JOIN LATERAL (
    SELECT sum(t.valor_documento) AS v FROM (
      SELECT DISTINCT ON (f.omie_codigo_lancamento) f.valor_documento FROM public.fin_contas_receber f
       WHERE f.company = rs.company AND f.omie_codigo_cliente = rs.omie_codigo_cliente
         AND f.numero_pedido = s.omie_numero_pedido AND f.status_titulo IS DISTINCT FROM 'CANCELADO'
       ORDER BY f.omie_codigo_lancamento, f.updated_at DESC NULLS LAST) t) private_titulos ON true
 WHERE rs.status = 'ativa' AND s.status = 'faturado'
 GROUP BY 1, 2 ORDER BY 1, 2;
