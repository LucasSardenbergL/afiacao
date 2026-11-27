-- ============================================================================================
-- SENSOR — funil do Novo Pedido (/sales/new), COM denominador. Read-only. (Rodada 3, onda 2, PR 9.1)
--
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -F'|' -tA -f db/sensor-novo-pedido-funil.sql
--
-- Pergunta: das jornadas que ABRIRAM a tela, quantas chegaram a cada etapa (cliente → 1º item → envio
-- tentado → envio confirmado), onde caem, por que o envio falha, quanto tempo leva (p50), e o confirmado
-- do sensor bate com o PV que o servidor gravou (sales_orders.checkout_id)?
--
-- Fonte: public.analytics_outbox (ledger, eventos `novo_pedido.*`, emissor src/hooks/unifiedOrder/sensor-funil.ts).
-- Unidade = JORNADA (props->>'jornada': uuid aleatório por pedido em montagem). O ledger DEDUPA por
-- titular × evento × chave × dia UTC.
-- ⚠️ Retenção curta: linha drenada é purgada ~7 dias depois (purgar_em). Fora da janela NÃO HÁ DADO —
-- ausente ≠ zero. Rode toda semana e guarde a saída no PR/histórico se precisar de série.
-- ⚠️ Taxa sem denominador sai NULL (nunca 0 nem 100%). Sob a lente "Ver como" o front não grava.
-- ⚠️ Quando medir: só com ≥1 jornada de alguém que NÃO é master (secao=denominador). Só o founder
-- testando = "sem dado de uso", não sinal de fase (docs/historico/fase-sem-sinal.md).
-- ============================================================================================

WITH ev AS (
  SELECT o.user_id, o.evento, o.props, o.ocorrido_em, o.props->>'jornada' AS jornada
  FROM public.analytics_outbox o
  WHERE o.evento LIKE 'novo\_pedido.%' AND o.props ? 'jornada'
)
SELECT 'janela' AS secao,
       coalesce(min(ocorrido_em)::date::text, 'sem dado') AS ini,
       coalesce(max(ocorrido_em)::date::text, 'sem dado') AS fim,
       count(DISTINCT jornada) AS jornadas,
       count(DISTINCT user_id) AS titulares
FROM ev;

-- 1) DENOMINADOR: jornadas iniciadas por papel e modo. master = founder/teste.
WITH ev AS (
  SELECT o.user_id, o.evento, o.props, o.props->>'jornada' AS jornada
  FROM public.analytics_outbox o
  WHERE o.evento = 'novo_pedido.iniciado' AND o.props ? 'jornada'
), papel AS (
  SELECT user_id, min(role::text) AS role FROM public.user_roles GROUP BY user_id
)
SELECT 'denominador' AS secao, coalesce(p.role, 'sem_role') AS role, coalesce(ev.props->>'modo', '?') AS modo,
       count(DISTINCT ev.user_id) AS titulares, count(DISTINCT ev.jornada) AS jornadas
FROM ev LEFT JOIN papel p USING (user_id)
GROUP BY 2, 3 ORDER BY 2, 3;

-- 2) FUNIL por etapa: jornadas que chegaram + % sobre a etapa anterior (NULL quando a anterior = 0).
WITH ev AS (
  SELECT o.evento, o.props->>'jornada' AS jornada
  FROM public.analytics_outbox o
  WHERE o.evento LIKE 'novo\_pedido.%' AND o.props ? 'jornada'
), etapas(ordem, etapa, evento) AS (
  VALUES (1, 'iniciado', 'novo_pedido.iniciado'), (2, 'cliente', 'novo_pedido.cliente_escolhido'),
         (3, 'primeiro_item', 'novo_pedido.primeiro_item'), (4, 'envio_tentado', 'novo_pedido.envio_tentado'),
         (5, 'envio_confirmado', 'novo_pedido.envio_confirmado')
), n AS (
  SELECT e.ordem, e.etapa, (SELECT count(DISTINCT jornada) FROM ev WHERE ev.evento = e.evento) AS jornadas
  FROM etapas e
)
SELECT 'funil' AS secao, ordem, etapa, jornadas,
       lag(jornadas) OVER (ORDER BY ordem) AS jornadas_etapa_anterior,
       round(100.0 * jornadas / nullif(lag(jornadas) OVER (ORDER BY ordem), 0), 1) AS pct_da_anterior,
       (lag(jornadas) OVER (ORDER BY ordem)) - jornadas AS queda
FROM n ORDER BY ordem;

-- 3) POR QUE o envio falha: classe × tentativas (denominador = todas as tentativas da janela).
WITH t AS (
  SELECT count(*) AS tentativas FROM public.analytics_outbox WHERE evento = 'novo_pedido.envio_tentado'
)
SELECT 'falha' AS secao, coalesce(o.props->>'classe', '?') AS classe, coalesce(o.props->>'motivo', '') AS motivo,
       count(*) AS tentativas_com_falha, t.tentativas,
       round(100.0 * count(*) / nullif(t.tentativas, 0), 1) AS pct_das_tentativas
FROM public.analytics_outbox o CROSS JOIN t
WHERE o.evento = 'novo_pedido.envio_falhou'
GROUP BY 2, 3, t.tentativas ORDER BY 4 DESC, 2;

-- 4) TEMPO (p50/p90, minutos) da abertura e do 1º item até a 1ª conta confirmada, por jornada.
WITH ev AS (
  SELECT o.evento, o.ocorrido_em, o.props->>'jornada' AS jornada
  FROM public.analytics_outbox o
  WHERE o.evento IN ('novo_pedido.iniciado', 'novo_pedido.primeiro_item', 'novo_pedido.envio_confirmado')
    AND o.props ? 'jornada'
), j AS (
  SELECT jornada,
         min(ocorrido_em) FILTER (WHERE evento = 'novo_pedido.iniciado') AS t_ini,
         min(ocorrido_em) FILTER (WHERE evento = 'novo_pedido.primeiro_item') AS t_item,
         min(ocorrido_em) FILTER (WHERE evento = 'novo_pedido.envio_confirmado') AS t_conf
  FROM ev GROUP BY jornada
)
SELECT 'tempo' AS secao, trecho, count(m) AS jornadas,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY m))::numeric, 1) AS p50_min,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY m))::numeric, 1) AS p90_min
FROM (
  SELECT 'abertura->confirmado' AS trecho, extract(epoch FROM t_conf - t_ini) / 60 AS m FROM j WHERE t_conf IS NOT NULL AND t_ini IS NOT NULL
  UNION ALL
  SELECT 'primeiro_item->confirmado', extract(epoch FROM t_conf - t_item) / 60 FROM j WHERE t_conf IS NOT NULL AND t_item IS NOT NULL
) x
GROUP BY trecho ORDER BY trecho;

-- 5) POR CONTA: jornadas que tentaram a conta × que a confirmaram (envio parcial multi-conta aparece aqui).
WITH tent AS (
  SELECT DISTINCT o.props->>'jornada' AS jornada, c AS conta
  FROM public.analytics_outbox o, regexp_split_to_table(coalesce(o.props->>'contas', ''), '\+') AS c
  WHERE o.evento = 'novo_pedido.envio_tentado' AND c <> ''
), conf AS (
  SELECT DISTINCT o.props->>'jornada' AS jornada, o.props->>'conta' AS conta
  FROM public.analytics_outbox o WHERE o.evento = 'novo_pedido.envio_confirmado'
)
SELECT 'conta' AS secao, tent.conta, count(*) AS jornadas_tentaram,
       count(conf.jornada) AS jornadas_confirmaram,
       round(100.0 * count(conf.jornada) / nullif(count(*), 0), 1) AS pct
FROM tent LEFT JOIN conf USING (jornada, conta)
GROUP BY tent.conta ORDER BY tent.conta;

-- 6) IA e RASCUNHO: jornadas que usaram + itens (soma de props.n) adicionados/descartados.
SELECT 'uso' AS secao, replace(o.evento, 'novo_pedido.', '') AS acao,
       count(DISTINCT o.props->>'jornada') AS jornadas, count(*) AS ocorrencias,
       sum((o.props->>'n')::int) FILTER (WHERE o.props->>'n' ~ '^[0-9]+$') AS itens
FROM public.analytics_outbox o
WHERE o.evento IN ('novo_pedido.ia_analise_pedida', 'novo_pedido.ia_itens_adicionados', 'novo_pedido.ia_itens_descartados',
                   'novo_pedido.rascunho_restaurado', 'novo_pedido.rascunho_descartado')
GROUP BY 2 ORDER BY 2;

-- 7) PONTE com o servidor: "confirmado" do sensor tem PV gravado (mesmo checkout_id e conta, com omie_pedido_id)?
--    Divergência aqui = o sensor (ou o envio) mente. Afiação é OS, não PV: fica fora.
WITH conf AS (
  SELECT DISTINCT o.props->>'checkout_id' AS checkout_id, o.props->>'conta' AS conta
  FROM public.analytics_outbox o
  WHERE o.evento = 'novo_pedido.envio_confirmado' AND o.props->>'conta' IN ('oben', 'colacor')
    AND o.props->>'checkout_id' ~ '^[0-9a-f-]{36}$'
)
SELECT 'ponte_servidor' AS secao, count(*) AS confirmados_sensor,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.sales_orders s
         WHERE s.checkout_id = conf.checkout_id::uuid AND s.account = conf.conta AND s.omie_pedido_id IS NOT NULL
       )) AS com_pv_no_servidor
FROM conf;

SELECT 'FIM_FUNIL_OK' AS secao;
