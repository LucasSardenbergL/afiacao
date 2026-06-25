-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ Hardening das RPCs de plano tático — achados do /codex challenge (#1037/#1043)║
-- ║ [autz / money-path] — PR3                                                    ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
-- O /codex challenge à fronteira (RPCs + split + edge + port) confirmou o núcleo
-- limpo (whitelist do payload, escrita direta negada pós-split) MAS apontou 3
-- refinos nas RPCs. Esta migration recria as 2 RPCs com:
--   [#3 P1] criar_plano_tatico: SELECT owner → INSERT era racy sob READ COMMITTED
--           (reatribuição concorrente podia commitar entre o SELECT e o INSERT,
--           gravando o dono antigo). FOR UPDATE trava a linha de carteira_assignments
--           → a reatribuição espera o commit deste INSERT. Fecha o race que sobrava
--           (o #1037 já o reduziu de segundos[client] p/ sub-ms[transação]).
--   [#4 P2] criar_plano_tatico: _expected_owner era NULLABLE numa RPC com EXECUTE
--           p/ authenticated → um chamador podia passar NULL e pular o race-check.
--           Agora é OBRIGATÓRIO p/ chamador autenticado (service_role/cron segue
--           opcional: o batch já passa o farmerId).
--   [#5 P2] registrar_resultado_plano: UPDATE só por id permitia REESCREVER o
--           resultado (actual_margin/call_result) de um plano JÁ concluído. Agora
--           recusa se status='concluido' (money-path: resultado não é reescrito).
-- (Os achados #1/#2 — edge selfContained/batch deixando staff acionar via
--  service_role — são fechados nas edges generate-tactical-plan/tactical-plans-batch,
--  não aqui. O #6 — snapshot com a policy ALL antiga — é regen pelo Lovable.)
--
-- ⚠️ Provada localmente: db/test-tactical-plan-rpc-hardening.sh (PG17 + falsificação).

-- ────────────────────────────────────────────────────────────────────────────
-- RPC 1 — criar_plano_tatico (v2: FOR UPDATE + _expected_owner obrigatório)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(
  _customer_user_id uuid,
  _expected_owner   uuid,
  _payload          jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid        uuid    := auth.uid();
  _is_service boolean := COALESCE(auth.role() = 'service_role', false);
  _owner      uuid;
  _rec        public.farmer_tactical_plans;
  _new_id     uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN
      RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
    END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id, _uid) THEN
      RAISE EXCEPTION 'Cliente fora da sua carteira' USING ERRCODE = '42501';
    END IF;
    -- [Codex #4] chamador autenticado NÃO pode pular o race-check passando NULL.
    IF _expected_owner IS NULL THEN
      RAISE EXCEPTION 'expected_owner é obrigatório para chamador autenticado (race-check da posse)';
    END IF;
  END IF;

  -- [Codex #3] FOR UPDATE: trava a linha de carteira_assignments deste cliente até o
  -- commit. Uma reatribuição concorrente (UPDATE carteira_assignments) espera o lock,
  -- então o dono resolvido aqui é o dono no instante do INSERT (race SELECT→INSERT fechado).
  SELECT a.owner_user_id INTO _owner
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer_user_id
  FOR UPDATE;

  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id;
  END IF;

  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN
    RAISE EXCEPTION 'Carteira do cliente % foi reatribuída durante a geração (dono atual diverge do esperado)', _customer_user_id;
  END IF;

  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload);

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

  RETURN _new_id;
END;
$function$;

COMMENT ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) IS
  'Insere farmer_tactical_plan; posse re-resolvida server-side de carteira_assignments com FOR UPDATE (race fechado); gate carteira_visivel_para OR service_role; _expected_owner obrigatório p/ autenticado. Fronteira de escrita.';

-- ────────────────────────────────────────────────────────────────────────────
-- RPC 2 — registrar_resultado_plano (v2: não reescreve plano concluído)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_resultado_plano(
  _plan_id               uuid,
  _plan_followed         boolean,
  _call_result           text,
  _actual_margin         numeric,
  _call_duration_seconds integer,
  _objection_type        text DEFAULT NULL,
  _notes                 text DEFAULT NULL
)
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
    IF NOT public.carteira_visivel_para(_customer, _uid) THEN
      RAISE EXCEPTION 'Plano fora da sua carteira' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- [Codex #5] resultado de plano JÁ concluído não é reescrito (money-path: actual_margin
  -- de um plano fechado é imutável; re-registro silencioso adulteraria a efetividade).
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
$function$;

COMMENT ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) IS
  'Grava resultado pós-call; gate carteira_visivel_para OR service_role; recusa se status=concluido (resultado imutável após conclusão).';

-- Privilégios (idempotente — re-aplica o estado do #1037).
REVOKE ALL ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) TO authenticated, service_role;
