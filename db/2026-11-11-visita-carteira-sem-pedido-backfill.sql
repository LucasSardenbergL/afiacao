-- Visita (plano v8, D13): corrige JÁ as linhas de customer_visit_scores de quem nunca comprou, sem esperar o drain
-- de 500/dia. Para o `bun run db:aplicar` (sem envelope: a transação é do executor). Idempotente e fail-closed.
--
-- A regra nova (edge visit-score-recalc-client v1.1-carteira-sem-pedido, espelho em src/lib/visit-scoring/missions.ts):
-- quem nunca comprou e não é lead declarado sai com recuperação 0, relacionamento 0 e prospecção 10 (o piso da
-- carteira), missão prospecção, visit_score 10. Antes: prospecção 70 (+20 pela data do import) e recuperação 50
-- (churn 100), o que punha o importado sem pedido acima de quem compra. Medido em 11/11: 9.664 linhas nesse caso.
--
-- O alvo é um SUBCONJUNTO conservador do que a edge chamaria de "nunca comprou" (em dúvida, não toca: a linha fica
-- para o drain recalcular com a regra da edge):
--   - nenhuma linha em sales_orders, de status nenhum, apagada ou não (a edge conta só venda viva; aqui qualquer
--     linha basta para pular);
--   - sales_history_status fora de ('ativo','stale') — ou sem linha em farmer_client_scores;
--   - profiles.is_prospect não verdadeiro (o lead declarado segue com base 70 e não entra aqui);
--   - expansão sem insumo (expansao_score, expansion_score e revenue_potential nulos): com insumo a expansão poderia
--     vencer o argmax, e isso é conta da edge;
--   - cliente não marcado excluir_da_carteira (a edge não grava score para ele).
--
-- TRAVA: a última atestação da edge no ledger tem de ser a v1.1. Com a edge velha no ar, o drain das 07:00 regravaria
-- 90 em quem está na fila, e o backfill viraria uma correção pela metade.
DO $trava$
DECLARE
  v_versao text;
BEGIN
  SELECT a.versao INTO v_versao
    FROM public.deploy_atestacoes a
   WHERE a.edge = 'visit-score-recalc-client'
   ORDER BY a.observado_em DESC
   LIMIT 1;
  IF v_versao IS DISTINCT FROM 'v1.1-carteira-sem-pedido' THEN
    RAISE EXCEPTION 'TRAVA: visit-score-recalc-client atestada em % — deploy + sonda da v1.1-carteira-sem-pedido antes',
      coalesce(v_versao, '(nenhuma atestação)');
  END IF;
END
$trava$;

UPDATE public.customer_visit_scores cvs
   SET recuperacao_score    = 0,
       relacionamento_score = 0,
       prospeccao_score     = 10,
       visit_score          = 10,
       primary_mission      = 'prospeccao',
       score_breakdown      = coalesce(cvs.score_breakdown, '{}'::jsonb)
         || jsonb_build_object(
              'mission_scores', coalesce(cvs.score_breakdown -> 'mission_scores', '{}'::jsonb)
                || jsonb_build_object(
                     'recuperacao',    jsonb_build_object('score', 0,  'insumosAusentes', '[]'::jsonb),
                     'relacionamento', jsonb_build_object('score', 0,  'insumosAusentes', '[]'::jsonb),
                     'prospeccao',     jsonb_build_object('score', 10, 'insumosAusentes', '[]'::jsonb)),
              'insumos_ausentes', '[]'::jsonb,
              'backfill', jsonb_build_object('regra', 'd13-carteira-sem-pedido',
                                             'versao_edge', 'v1.1-carteira-sem-pedido',
                                             'em', now())),
       updated_at           = now()
  FROM public.customer_visit_scores alvo
  LEFT JOIN public.farmer_client_scores fcs ON fcs.customer_user_id = alvo.customer_user_id
  LEFT JOIN public.profiles p ON p.user_id = alvo.customer_user_id
 WHERE cvs.id = alvo.id
   AND NOT EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.customer_user_id = alvo.customer_user_id)
   AND coalesce(fcs.sales_history_status, '') NOT IN ('ativo', 'stale')
   AND p.is_prospect IS NOT TRUE
   AND alvo.expansao_score IS NULL
   AND fcs.expansion_score IS NULL
   AND fcs.revenue_potential IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc
                    WHERE cc.user_id = alvo.customer_user_id AND cc.excluir_da_carteira)
   AND (alvo.visit_score, alvo.primary_mission::text, alvo.recuperacao_score, alvo.relacionamento_score,
        alvo.prospeccao_score)
       IS DISTINCT FROM (10::numeric, 'prospeccao', 0::numeric, 0::numeric, 10::numeric);

DO $post$
DECLARE
  v_resta   bigint;
  v_errado  bigint;
  v_marcado bigint;
BEGIN
  -- 1. Nenhuma linha do alvo ficou com o score velho.
  SELECT count(*) INTO v_resta
    FROM public.customer_visit_scores alvo
    LEFT JOIN public.farmer_client_scores fcs ON fcs.customer_user_id = alvo.customer_user_id
    LEFT JOIN public.profiles p ON p.user_id = alvo.customer_user_id
   WHERE NOT EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.customer_user_id = alvo.customer_user_id)
     AND coalesce(fcs.sales_history_status, '') NOT IN ('ativo', 'stale')
     AND p.is_prospect IS NOT TRUE
     AND alvo.expansao_score IS NULL
     AND fcs.expansion_score IS NULL
     AND fcs.revenue_potential IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc
                      WHERE cc.user_id = alvo.customer_user_id AND cc.excluir_da_carteira)
     AND (alvo.visit_score, alvo.primary_mission::text, alvo.recuperacao_score, alvo.relacionamento_score,
          alvo.prospeccao_score)
         IS DISTINCT FROM (10::numeric, 'prospeccao', 0::numeric, 0::numeric, 10::numeric);
  IF v_resta IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'POST: % linha(s) de quem nunca comprou ainda com o score velho', v_resta;
  END IF;

  -- 2. Nenhuma linha marcada pelo backfill é de quem compra ou de lead (testemunha do predicado, por outro caminho:
  --    o histórico OU qualquer pedido OU is_prospect).
  SELECT count(*) INTO v_errado
    FROM public.customer_visit_scores c
   WHERE c.score_breakdown -> 'backfill' ->> 'regra' = 'd13-carteira-sem-pedido'
     AND (EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.customer_user_id = c.customer_user_id)
          OR EXISTS (SELECT 1 FROM public.farmer_client_scores f
                      WHERE f.customer_user_id = c.customer_user_id AND f.sales_history_status IN ('ativo', 'stale'))
          OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = c.customer_user_id AND p.is_prospect));
  IF v_errado IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'POST: % linha(s) de comprador ou lead marcadas pelo backfill', v_errado;
  END IF;

  SELECT count(*) INTO v_marcado
    FROM public.customer_visit_scores c
   WHERE c.score_breakdown -> 'backfill' ->> 'regra' = 'd13-carteira-sem-pedido';
  RAISE NOTICE 'D13_BACKFILL_OK marcadas=% (acumulado, inclui rodadas anteriores)', v_marcado;
END
$post$;
