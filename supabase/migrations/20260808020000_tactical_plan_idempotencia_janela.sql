-- ============================================================
-- criar_plano_tatico — a idempotência passa do DIA para a JANELA da fila (PTPL, fase 2)
--
-- PROBLEMA (medido em prod via psql-ro, 2026-08-08):
--   A trava perguntava "já gerei para este cliente HOJE?" (dia operacional BRT). Ela
--   consertou as 30 duplicatas do MESMO dia do incidente 2026-07-21/22, mas deixava o
--   cliente voltar a ser candidato na madrugada seguinte. Com o batch rodando todo dia,
--   isso virou uma cópia por dia:
--     · 533 planos gerados desde 21/07 para apenas 80 clientes DISTINTOS
--     · fila viva: 169 planos `gerado` para 35 clientes — 14 deles com 7 cópias cada,
--       uma por dia da janela (a vendedora abre a tela e vê o mesmo cliente 7 vezes)
--     · em 07/08, 23 dos 25 planos do dia eram regeração; em 05/08 e 31/07, 25 de 25
--     · dos 174 clientes que passam o gate de R$/h, 97 NUNCA receberam plano — a cota
--       diária inteira ia para repetição, e o resto da carteira nunca era alcançado
--
-- A pergunta certa não é "já gerei hoje?" e sim "este cliente já está na fila de alguém?".
-- Enquanto o plano estiver aberto, outro plano para o mesmo cliente só produz cópia.
-- Quando ele sai (expirado pelo cron `expirar-planos-taticos` da fase 1, ou concluído),
-- o cliente volta a ser candidato — é isso que faz a fila CIRCULAR em vez de entupir.
--
-- RELAÇÃO COM O ÍNDICE ÚNICO `ux_farmer_tactical_plans_dia_operacional`: a janela CONTÉM
-- o dia, então esta RPC passa a ser estritamente MAIS restritiva que o índice. O sentido
-- importa — a versão anterior avisava que divergir faria a RPC "autorizar o que o índice
-- depois recusaria com 23505 cru". Aqui a divergência é no sentido seguro: tudo que a RPC
-- autoriza, o índice também autoriza. O índice segue como rede final para corridas do
-- mesmo dia e NÃO precisa mudar.
--
-- JANELA = 7 dias, o mesmo número de outros TRÊS lugares. Ao mudar, mude todos:
--   · src/hooks/useTacticalPlan.ts:238            JANELA_FILA_DIAS (o recorte da tela)
--   · supabase/functions/_shared/tactical-fila.ts JANELA_FILA_DIAS (o filtro do batch)
--   · expirar_planos_taticos(_dias => 7)          o cron que expira
-- Janela AQUI maior que a da tela = cliente sai de vista mas segue bloqueado (buraco
-- silencioso). Menor = a duplicata volta.
--
-- Preflight feito: `pg_get_functiondef` da PROD lido em 2026-08-08 antes de escrever este
-- REPLACE (apply manual diverge do repo — docs/agent/database.md). Esta versão é a de
-- produção com o bloco de idempotência trocado; nenhuma outra linha foi alterada.
-- ============================================================

CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid, _expected_owner uuid, _payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid        uuid    := auth.uid();
  _is_service boolean := COALESCE(auth.role() = 'service_role', false);
  _owner      uuid;
  _eligible   boolean;
  _rec        public.farmer_tactical_plans;
  _new_id     uuid;
  -- Janela da fila. `constant` porque não é configurável em runtime: mudá-la sem mudar as
  -- outras três pontas produz buraco ou duplicata (ver cabeçalho).
  _janela_dias constant integer := 7;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN
      RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
    END IF;
    IF NOT private.carteira_visivel_para(_customer_user_id, _uid) THEN
      RAISE EXCEPTION 'Cliente fora da sua carteira' USING ERRCODE = '42501';
    END IF;
    -- [Codex #4] chamador autenticado NÃO pode pular o race-check passando NULL.
    IF _expected_owner IS NULL THEN
      RAISE EXCEPTION 'expected_owner é obrigatório para chamador autenticado (race-check da posse)';
    END IF;
  END IF;

  -- [Codex #3] FOR UPDATE: trava a linha de carteira_assignments deste cliente até o commit.
  -- [#1422] `eligible` sai do MESMO SELECT travado — ler a máscara fora do lock reabriria o
  -- race pelo outro lado (mascarar concorrente entre a checagem e o INSERT).
  SELECT a.owner_user_id, a.eligible INTO _owner, _eligible
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer_user_id
  FOR UPDATE;

  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id;
  END IF;

  -- [#1422 — máscara eligible] Fail-closed p/ TODO caller, inclusive service_role e master.
  IF _eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Cliente % está mascarado na carteira (eligible) — plano tático não é materializado', _customer_user_id
      USING ERRCODE = '42501';
  END IF;

  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN
    RAISE EXCEPTION 'Carteira do cliente % foi reatribuída durante a geração (dono atual diverge do esperado)', _customer_user_id;
  END IF;

  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload);

  -- [#1618-followup — idempotência] O teste de existência do caller é check-then-insert e
  -- roda ANTES da chamada paga à IA: dois batches simultâneos passam os dois. Aqui já
  -- seguramos o lock de carteira_assignments deste cliente, então os concorrentes estão
  -- serializados e o perdedor enxerga a linha do vencedor (READ COMMITTED: este SELECT
  -- usa um snapshot posterior à espera pelo lock).
  --
  -- [fase 2] A chave passou do DIA para a JANELA: qualquer plano ABERTO do mesmo cliente,
  -- dentro dos últimos _janela_dias, bloqueia. Ver o cabeçalho para a medição.
  --
  -- COALESCE(..., now()): `generated_at` e `created_at` são nullable (default now()), e
  -- `coluna >= x` com NULL é NULL — numa TRAVA isso é fail-OPEN, e o plano de data
  -- desconhecida deixaria de bloquear em silêncio. Com o COALESCE, data ausente conta como
  -- agora, ou seja, dentro da janela: o caso indecidível RECUSA em vez de autorizar.
  -- (Hoje 0 de 533 linhas têm qualquer uma das duas nula — o guard é para não depender disso.)
  IF EXISTS (
    SELECT 1 FROM public.farmer_tactical_plans p
     WHERE p.farmer_id = _owner
       AND p.customer_user_id = _customer_user_id
       AND p.status = 'gerado'
       AND COALESCE(p.plan_type, 'essencial') = COALESCE(_rec.plan_type, 'essencial')
       AND COALESCE(p.generated_at, p.created_at, now()) >= now() - make_interval(days => _janela_dias)
  ) THEN
    RAISE EXCEPTION 'Já existe plano tático aberto na fila para este cliente (janela de % dias)', _janela_dias
      USING ERRCODE = '23505';
  END IF;

  BEGIN
    INSERT INTO public.farmer_tactical_plans (
      farmer_id, customer_user_id, status,
      bundle_recommendation_id, health_score, churn_risk, mix_gap,
      current_margin_pct, cluster_avg_margin_pct, expansion_potential,
      strategic_objective, customer_profile, plan_type,
      top_bundle, second_bundle, bundle_lie, bundle_probability, bundle_incremental_margin,
      best_individual_lie, diagnostic_questions, implication_question, offer_transition,
      probable_objections, approach_strategy, approach_strategy_b,
      ltv_projection, expected_result, operational_risks
    ) VALUES (
      _owner, _customer_user_id, 'gerado',
      _rec.bundle_recommendation_id, _rec.health_score, _rec.churn_risk, _rec.mix_gap,
      _rec.current_margin_pct, _rec.cluster_avg_margin_pct, _rec.expansion_potential,
      COALESCE(_rec.strategic_objective, 'expansao_mix'),
      COALESCE(_rec.customer_profile, 'misto'),
      COALESCE(_rec.plan_type, 'essencial'),
      COALESCE(_rec.top_bundle, '{}'::jsonb), COALESCE(_rec.second_bundle, '{}'::jsonb),
      _rec.bundle_lie, _rec.bundle_probability, _rec.bundle_incremental_margin,
      _rec.best_individual_lie,
      COALESCE(_rec.diagnostic_questions, '[]'::jsonb), _rec.implication_question, _rec.offer_transition,
      COALESCE(_rec.probable_objections, '[]'::jsonb), _rec.approach_strategy, _rec.approach_strategy_b,
      _rec.ltv_projection, _rec.expected_result, COALESCE(_rec.operational_risks, '[]'::jsonb)
    )
    RETURNING id INTO _new_id;
  EXCEPTION WHEN unique_violation THEN
    -- Rede final: qualquer caminho que escape do EXISTS acima (writer futuro, corrida que o
    -- lock não cubra) fala a MESMA língua, e o caller a lê como skip em vez de erro de infra.
    -- O índice único só cobre o DIA, então esta mensagem continua sendo a do caso "mesmo dia";
    -- o predicado da edge (ehJaNaFilaDaRpc) casa as duas redações.
    RAISE EXCEPTION 'Já existe plano tático aberto na fila para este cliente (janela de % dias)', _janela_dias
      USING ERRCODE = '23505';
  END;

  RETURN _new_id;
END;
$function$;

-- A RPC é a FRONTEIRA (SECURITY DEFINER bypassa RLS). O grant permanece como estava: o
-- chamador autenticado passa pelo gate de carteira no topo da função; service_role/cron
-- entra pelo ramo `_is_service`. Este REPLACE não altera privilégio nenhum — e, por não
-- mudar a assinatura, não cria sobrecarga que deixasse a versão velha viva em paralelo.
