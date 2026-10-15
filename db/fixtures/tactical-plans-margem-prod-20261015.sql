-- Corpos de PROD (pg_get_functiondef via psql-ro, 2026-10-15) dos writers/helpers que a prova
-- db/test-tactical-plans-margem.sh usa como pré-requisito. Não são o objeto sob teste: provam que
-- o fecho NÃO quebra os writers (criar_plano_tatico grava; registrar_resultado_plano conclui).

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$
;

CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _uid IS NOT NULL
    AND (
      COALESCE(public.has_role(_uid, 'master'::app_role), false)
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        WHERE a.customer_user_id = _customer_user_id
          AND a.owner_user_id = _uid
          AND a.eligible IS TRUE
      )
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
        WHERE a.customer_user_id = _customer_user_id
          AND a.eligible IS TRUE
          AND c.covering_user_id = _uid
          AND c.active
          AND (c.valid_until IS NULL OR c.valid_until > now())
      )
    );
$function$
;

CREATE OR REPLACE FUNCTION public.tactical_plan_recusa_cliente_mascarado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _eligible boolean;
BEGIN
  -- FOR UPDATE: fecha a corrida "eligible vira false entre a checagem e o INSERT" também
  -- para quem NÃO passa pela criar_plano_tatico (que já tem o seu próprio lock).
  SELECT a.eligible INTO _eligible
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = NEW.customer_user_id
  FOR UPDATE;

  IF _eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Cliente % está mascarado na carteira (eligible) — plano tático não é materializado', NEW.customer_user_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_resultado_plano(_plan_id uuid, _plan_followed boolean, _call_result text, _actual_margin numeric, _call_duration_seconds integer, _objection_type text DEFAULT NULL::text, _notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid        uuid    := auth.uid();
  _is_service boolean := COALESCE(auth.role() = 'service_role', false);
  _customer   uuid;
  _status     text;
  _eligible   boolean;
BEGIN
  SELECT p.customer_user_id, p.status INTO _customer, _status
  FROM public.farmer_tactical_plans p
  WHERE p.id = _plan_id;

  IF _customer IS NULL THEN
    RAISE EXCEPTION 'Plano % inexistente', _plan_id;
  END IF;

  IF NOT _is_service THEN
    IF _uid IS NULL THEN
      RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
    END IF;
    IF NOT private.carteira_visivel_para(_customer, _uid) THEN
      RAISE EXCEPTION 'Plano fora da sua carteira' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- [#1422 — máscara eligible] plano criado elegível e mascarado DEPOIS não recebe resultado.
  SELECT a.eligible INTO _eligible
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer;

  IF _eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Cliente do plano % está mascarado na carteira (eligible) — resultado não é registrado', _plan_id
      USING ERRCODE = '42501';
  END IF;

  -- [Codex #5] resultado de plano JÁ concluído não é reescrito.
  IF _status = 'concluido' THEN
    RAISE EXCEPTION 'Plano % já concluído — resultado não pode ser reescrito', _plan_id;
  END IF;

  UPDATE public.farmer_tactical_plans
  SET plan_followed         = _plan_followed,
      call_result           = _call_result,
      actual_margin         = _actual_margin,
      call_duration_seconds = _call_duration_seconds,
      objection_type        = _objection_type,
      notes                 = _notes,
      status                = 'concluido',
      completed_at          = now(),
      updated_at            = now()
  WHERE id = _plan_id;
END;
$function$
;
