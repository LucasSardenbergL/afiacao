-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ HOTFIX — 4 callers órfãos do FU7 (#1421): public.<helper> → private.<helper> ║
-- ║ [money-path / autorização] — quebra VIVA em produção                        ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
-- O #1421 (`20260718150000_fu7_helpers_rls_schema_privado.sql`, mergeado 2026-07-18
-- 16:57 UTC) moveu `carteira_visivel_para` e `is_super_admin` de `public` p/ `private`
-- (FU7 — fechar o oráculo de RLS exposto via PostgREST). Ele atualizou **as 8 policies**
-- que dependem do helper, mas **não os callers PL/pgSQL**, que chamam com prefixo
-- `public.` EXPLÍCITO — e não existe wrapper de compatibilidade em `public`.
--
-- É a armadilha late-bound canônica do repo (CLAUDE.md): `CREATE OR REPLACE`/`SET SCHEMA`
-- passam sem validar o corpo das funções que referenciam o objeto movido; elas só quebram
-- ao EXECUTAR, com `42883 undefined_function`. Nem o CI nem o harness do #1421 veem
-- (aquele testa o helper movido, não quem o chama).
--
-- ── Inventário MEDIDO em prod (2026-07-18, varredura pg_proc + pg_policies + pg_views
--    + cron.job por regex `public\.(carteira_visivel_para|is_super_admin)`) ────────────
--   1. public.criar_plano_tatico          → gate de carteira do caller autenticado
--   2. public.registrar_resultado_plano   → idem
--   3. public.registrar_contato_rota      → gate de carteira p/ registrar ligação em rota
--   4. public.protect_master_config       → trigger que protege master_cpf/master_cnpj
--   (zero policies, zero views, zero crons — as 8 policies já foram corrigidas pelo #1421.)
--
-- ── Severidade por função ───────────────────────────────────────────────────────────
--   1–3 falham ABERTO-EM-USABILIDADE, fechado-em-segurança: a exceção 42883 aborta a
--       operação ⇒ nada é gravado indevidamente, mas o fluxo do vendedor QUEBRA
--       (gerar plano tático, registrar resultado pós-call, registrar contato de rota).
--   4   falha FECHADA: só alcança o `is_super_admin` quando a key é master_cpf/master_cnpj,
--       então bloqueia a alteração — inclusive a do super_admin legítimo. Sem risco de
--       escalação (a proteção do achado de privilege-escalation, database.md §4, segue de pé).
--
-- ⚠️ NÃO criar wrapper `public.carteira_visivel_para` — reexporia o oráculo ao PostgREST
--    e desfaria exatamente o que o #1421 fechou. A correção é no CALLER, uma por uma.
--
-- Corpos preservados VERBATIM do `pg_get_functiondef` de prod (pré-flight 2026-07-18),
-- com a ÚNICA alteração sendo o schema do helper. Sem mudança de lógica, gate ou grant.
--
-- ⚠️ Provada em PG17 local com falsificação: db/test-fu7-callers-orfaos.sh
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. criar_plano_tatico — v3 do #1422, só o schema do helper muda
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
  _eligible   boolean;
  _rec        public.farmer_tactical_plans;
  _new_id     uuid;
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

-- ────────────────────────────────────────────────────────────────────────────
-- 2. registrar_resultado_plano — v3 do #1422, só o schema do helper muda
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
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. registrar_contato_rota — corpo verbatim de prod, só o schema do helper muda
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_contato_rota(
  p_customer_user_id uuid,
  p_status           text,
  p_data_rota        date,
  p_bucket           text DEFAULT NULL::text,
  p_valor            numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_existing uuid; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_uid AND ur.role IN ('employee','master')) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  IF p_customer_user_id IS NULL THEN RAISE EXCEPTION 'customer_user_id required'; END IF;
  IF p_data_rota IS NULL THEN RAISE EXCEPTION 'data_rota required'; END IF;
  IF p_status NOT IN ('convertido','respondido','sem_resposta','opt_out') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;
  -- staff responde "é staff?", não "pode afetar ESTE cliente?" — exige visibilidade de carteira.
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)
          OR private.carteira_visivel_para(p_customer_user_id, v_uid)) THEN
    RAISE EXCEPTION 'forbidden: customer not visible';
  END IF;
  -- serializa o dedupe por chave lógica (evita race do SELECT→INSERT em double-click concorrente).
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_uid::text||':'||p_customer_user_id::text||':'||p_data_rota::text||':'||p_status||':ligacao', 0));
  -- dedupe idempotente: mesmo vendedor+cliente+rota+status nos últimos 2 min → devolve o existente.
  SELECT id INTO v_existing FROM public.route_contact_log
   WHERE farmer_id = v_uid AND customer_user_id = p_customer_user_id
     AND data_rota = p_data_rota AND status = p_status AND canal = 'ligacao'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;
  INSERT INTO public.route_contact_log (data_rota, customer_user_id, farmer_id, canal, valor_da_ligacao, bucket, status)
  VALUES (p_data_rota, p_customer_user_id, v_uid, 'ligacao', p_valor, p_bucket, p_status)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. protect_master_config — corpo verbatim de prod, só o schema do helper muda
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_master_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Se a key sendo alterada é sensível (master_cpf/master_cnpj),
  -- exigir que quem está alterando seja super_admin.
  IF (TG_OP IN ('UPDATE', 'DELETE'))
     AND (OLD.key IN ('master_cpf', 'master_cnpj'))
     AND NOT private.is_super_admin(auth.uid())
  THEN
    RAISE EXCEPTION 'Somente super admin pode alterar master_cpf ou master_cnpj';
  END IF;

  -- Também bloqueia INSERT de uma key 'master_cpf' ou 'master_cnpj' se ela
  -- já existe (evita contornar com DELETE + INSERT separados).
  IF TG_OP = 'INSERT'
     AND NEW.key IN ('master_cpf', 'master_cnpj')
     AND EXISTS (SELECT 1 FROM public.company_config WHERE key = NEW.key)
     AND NOT private.is_super_admin(auth.uid())
  THEN
    RAISE EXCEPTION 'Somente super admin pode redefinir master_cpf ou master_cnpj';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMIT;
