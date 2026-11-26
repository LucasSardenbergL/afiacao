-- Medição do gate v2 em MODO SOMBRA (crédito-IA PR 5) — rode por psql-ro:
--   ~/.config/afiacao/psql-ro -X -f db/medir-credito-sombra.sql
-- Critério do programa (roteiro, linha do PR 5): 2+ semanas de distribuição de faixas. Esta query É o
-- "quando medir": a seção 0 diz se já há 14 dias civis (SP) com decisão nova, e a seção 7 se a
-- sombra está saudável. A distribuição conta PV (última versão), nunca a carga inicial.
-- Leitura: falso 🟢 é o risco; 🟡 por prazo desconhecido é esperado (importado não traz parcela;
-- Colacor sem catálogo) — a coluna "sem_prazo" mostra o que sobraria se o prazo fosse aceito.
\pset footer off

\echo '── 0. cobertura: dias civis com decisão nova desde o marco (critério: ≥ 14) ──'
SELECT m.ativado_em,
       count(DISTINCT (d.avaliado_em AT TIME ZONE 'America/Sao_Paulo')::date) AS dias_com_decisao,
       count(DISTINCT d.sales_order_id) AS pvs,
       round(sum(d.valor_brl)) AS brl,
       (count(DISTINCT (d.avaliado_em AT TIME ZONE 'America/Sao_Paulo')::date) >= 14) AS criterio_2_semanas
  FROM public.credito_sombra_marco m
  LEFT JOIN public.credito_sombra_pv_atual d ON NOT d.carga_inicial
 GROUP BY m.ativado_em;

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
SELECT status_pedido, faixa, count(*) AS pvs, round(sum(valor_brl)) AS brl
  FROM public.credito_sombra_pv_atual WHERE NOT carga_inicial
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

\echo '── 8. reserva de PV faturado ainda sem título (decide a regra de transferência do PR 6) ──'
SELECT rs.company, count(*) AS n, round(sum(rs.valor_brl)) AS brl,
       round(avg(extract(epoch FROM now() - rs.created_at) / 86400)::numeric, 1) AS idade_media_d,
       count(DISTINCT rs.grupo_user_id) AS grupos
  FROM public.credito_sombra_reserva rs JOIN public.sales_orders s ON s.id = rs.sales_order_id
 WHERE rs.status = 'ativa' AND s.status = 'faturado'
 GROUP BY 1;
