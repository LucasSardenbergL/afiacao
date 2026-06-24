-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ RPCs de ESCRITA de plano tático — fronteira de posse + autorização          ║
-- ║ [money-path / autz] — follow-up do #1028 (farmer_id = DONO da carteira)     ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
-- Contexto: a RLS de farmer_tactical_plans é staff-vê-tudo ("Staff can manage
-- tactical plans" = ALL, master OR employee, SEM escopo por farmer_id). A escrita
-- era 100% client-side, o que abre dois gaps (achados /codex challenge):
--   #1  recordResult faz UPDATE .eq('id', planId) puro → qualquer staff com o UUID
--       grava resultado de plano de carteira que NÃO enxerga.
--   #2  generatePlan lê ownerId=score.farmer_id ANTES da IA (segundos) e insere
--       farmer_id=ownerId depois, sem re-checar — se a carteira é reatribuída
--       (carteira_assignments) durante a geração, grava o DONO STALE.
--
-- Estas RPCs SECURITY DEFINER passam a ser a fronteira de escrita:
--   • gate de autorização na borda: carteira_visivel_para(customer, auth.uid())
--     (OU service_role, p/ o cron generate-tactical-plan);
--   • a POSSE (farmer_id) é re-resolvida server-side de carteira_assignments
--     (UNIQUE por cliente = dono atômico) — o client deixa de controlá-la;
--   • precisão>recall: se o dono divergir do esperado (race) ou inexistir, ABORTA.
--
-- ESTA migration é ADITIVA (PR1): só cria as RPCs. O split da RLS que REVOGA a
-- escrita direta do client (tornando estas RPCs a ÚNICA porta) vem no PR2, junto
-- com o port do hook — senão quebraria o generatePlan/recordResult atuais, que
-- ainda fazem insert/update direto até serem portados.
--
-- ⚠️ Gate por perfil → dá 42501 no SQL Editor do Lovable e no psql-ro (sessão sem
--    auth.uid()). É o comportamento correto (database.md §5): a RPC é p/ o app.
-- ⚠️ Provada localmente: db/test-rpc-tactical-plan-posse-segura.sh (PG17 + falsificação).

-- ────────────────────────────────────────────────────────────────────────────
-- RPC 1 — criar_plano_tatico: insere o plano com posse autoritativa do servidor.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(
  _customer_user_id uuid,
  _expected_owner   uuid,    -- dono que o chamador resolveu (p/ detectar reatribuição no meio); NULL = não exige
  _payload          jsonb    -- campos de DADOS do plano (farmer_id/customer/status são ignorados se vierem)
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid        uuid    := auth.uid();
  -- COALESCE: auth.role() NULL (sessão sem JWT) → (NULL = 'service_role') é NULL, e IF NOT NULL
  -- NÃO entra no gate → puláva a autorização inteira. NULL tem de virar false (não-service).
  _is_service boolean := COALESCE(auth.role() = 'service_role', false);
  _owner      uuid;
  _rec        public.farmer_tactical_plans;
  _new_id     uuid;
BEGIN
  -- Gate de fronteira: o cron (service_role) passa; senão exige sessão autenticada
  -- que ENXERGUE a carteira do cliente (dono, cobridor ativo, ou master).
  IF NOT _is_service THEN
    IF _uid IS NULL THEN
      RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
    END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id, _uid) THEN
      RAISE EXCEPTION 'Cliente fora da sua carteira' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Posse autoritativa: re-resolve o dono ATUAL na transação (fonte de verdade =
  -- carteira_assignments, UNIQUE(customer_user_id) → no máximo 1 dono).
  SELECT a.owner_user_id INTO _owner
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer_user_id;

  IF _owner IS NULL THEN
    -- precisão>recall: sem dono, não fabricamos posse nem caímos pro executor.
    RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id;
  END IF;

  -- Race de reatribuição: se o dono mudou desde a leitura do client, o cluster/bundle
  -- do payload ficaram incoerentes → ABORTA (o client regenera). NULL = client não exige.
  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN
    RAISE EXCEPTION 'Carteira do cliente % foi reatribuída durante a geração (dono atual diverge do esperado)', _customer_user_id;
  END IF;

  -- Popula um record tipado a partir do payload (casts da tabela). Grava só a
  -- WHITELIST de campos de DADOS — farmer_id/customer_user_id/status/id são do servidor.
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
  'Insere farmer_tactical_plan com posse (farmer_id) re-resolvida server-side de carteira_assignments; gate carteira_visivel_para OR service_role; aborta em race de reatribuição ou cliente sem dono. Fronteira de escrita (RLS é staff-vê-tudo).';

-- ────────────────────────────────────────────────────────────────────────────
-- RPC 2 — registrar_resultado_plano: grava o resultado pós-call com gate de carteira.
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
  _is_service boolean := COALESCE(auth.role() = 'service_role', false);  -- NULL→false (ver criar_plano_tatico)
  _customer   uuid;
BEGIN
  -- O plano define o cliente cuja carteira o chamador precisa enxergar.
  SELECT p.customer_user_id INTO _customer
  FROM public.farmer_tactical_plans p
  WHERE p.id = _plan_id;

  IF _customer IS NULL THEN
    RAISE EXCEPTION 'Plano % inexistente', _plan_id;
  END IF;

  -- Gate: cron passa; senão exige sessão que enxergue a carteira do cliente do plano.
  -- Fecha o #1: staff com o UUID de plano alheio NÃO grava resultado se não vê a carteira.
  IF NOT _is_service THEN
    IF _uid IS NULL THEN
      RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
    END IF;
    IF NOT public.carteira_visivel_para(_customer, _uid) THEN
      RAISE EXCEPTION 'Plano fora da sua carteira' USING ERRCODE = '42501';
    END IF;
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
  'Grava resultado pós-call do plano tático; gate carteira_visivel_para(cliente do plano, auth.uid()) OR service_role. Fecha o gap de UPDATE por id puro sob RLS staff-vê-tudo.';

-- ────────────────────────────────────────────────────────────────────────────
-- Privilégios: gate interno protege, mas revogamos anon e PUBLIC por higiene
-- (database.md §5: REVOKE FROM PUBLIC não tira anon/authenticated — nomear).
-- ────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) TO authenticated, service_role;
