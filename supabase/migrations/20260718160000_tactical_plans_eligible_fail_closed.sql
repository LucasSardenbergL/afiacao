-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ Plano tático: máscara `eligible` fail-closed na FRONTEIRA DE ESCRITA       ║
-- ║ + policy SELECT carteira-scoped  [money-path / autorização]                ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
-- Follow-up do #1416 (enumerado em docs/agent/database.md §4 "Follow-up de segurança")
-- e adjacente ao #1398 (carteira_visivel_para passou a filtrar eligible).
--
-- O FURO (latente, medido em prod 2026-07-18 — `farmer_tactical_plans` = 0 linhas):
--   O caminho INTERATIVO já estava fechado — `criar_plano_tatico` chama
--   `carteira_visivel_para`, que filtra `eligible IS TRUE` desde o #1398.
--   O caminho BATCH não: `tactical-plans-batch` pagina `farmer_client_scores` via
--   SERVICE_ROLE (bypassa RLS, sem filtro de elegibilidade) → `generate-tactical-plan`
--   self-contained → `criar_plano_tatico` como service_role, onde o `IF NOT _is_service`
--   PULA o gate e o `SELECT ... FOR UPDATE` resolve o dono SEM olhar `eligible`.
--   Efeito se o cron for ligado: materializa planos táticos COM CONTEÚDO (estratégia de
--   abordagem, objeções, bundles, margens) de até **1459** clientes mascarados, numa
--   tabela que qualquer employee lê — re-expondo o vínculo que a máscara existe p/ esconder.
--
-- Por que ainda é 0: o cron do batch NUNCA foi agendado (`cron.job` não tem job
-- 'tactical'; o setup do pg_cron ficou como passo manual no topo da edge). É risco
-- ARMADO, não vazamento vivo — e por isso esta é a janela BARATA de fechar: com a
-- tabela vazia, estreitar a policy não esconde nenhum plano de ninguém.
--
-- ── As quatro mudanças (todas na ESCRITA; a leitura ficou de fora — ver §follow-up) ──
-- (1) `criar_plano_tatico` v3: gate `eligible` fail-closed NA RPC, para TODO caller
--     (inclusive service_role/cron e master).
--     ⚠️ Vale para o MASTER também: `master-as-auditor` (spec §8-FU4) autoriza LER o
--     quarantine, não MATERIALIZAR conteúdo novo dentro dele. O master é dono de 2093
--     dos 2112 pares mascarados (fornecedores excluídos), p/ quem plano tático de venda
--     é semanticamente absurdo. `IS NOT TRUE` (não `= false`) fecha também o NULL —
--     defesa contra o FU6 (`eligible DEFAULT true` é fail-open p/ writer futuro).
--     Mensagem/ERRCODE DISTINTOS de "sem dono": diagnóstico honesto (o cliente TEM
--     dono; está mascarado). Tudo o mais da v2 preservado verbatim — FOR UPDATE do
--     race-check (#1037/#1043), `_expected_owner` obrigatório, whitelist do payload.
--     Pré-flight `pg_get_functiondef` prod×repo 2026-07-18: IDÊNTICOS.
--
-- (2) `registrar_resultado_plano` v3: mesmo gate. [achado 5 do Codex xhigh]
--     Meu argumento inicial p/ deixá-la fora era CIRCULAR ("fechada a materialização não
--     existe plano de mascarado p/ atualizar") — e o próprio harness o refuta: um plano
--     criado com eligible=true e MASCARADO DEPOIS existe (assert F1). Sem este gate,
--     master e service_role gravam `actual_margin`/`call_result` — resultado comercial,
--     money-path — num plano de cliente mascarado.
--
-- (3) REVOKE INSERT/UPDATE/DELETE + trigger fail-closed. [achado 1 do Codex xhigh — o
--     furo estrutural que eu tinha errado] A premissa "a RPC é a fronteira única porque
--     não há policy de INSERT" é FALSA para `service_role`: medido em prod hoje,
--     `has_table_privilege(service_role,…,'INSERT')` = **t** e `rolbypassrls` = **t** ⇒
--     uma edge futura com `admin.from('farmer_tactical_plans').insert(...)` pula (1),
--     (2) e o filtro do batch. Duas barreiras, porque cobrem vias diferentes:
--       · REVOKE   → fecha service_role/authenticated/anon via PostgREST (o caso real).
--       · TRIGGER  → fecha o que o REVOKE não alcança: qualquer função SECURITY DEFINER
--                    futura, que roda como `postgres` e mantém o privilégio. É a única
--                    fronteira que TODA via de INSERT cruza (money-path §5).
--     Medido: nenhuma edge escreve direto hoje (a única referência a la tabela em
--     `supabase/functions/` é um SELECT de idempotência) ⇒ o REVOKE não quebra nada.
--     As RPCs seguem escrevendo: são SECDEF com owner `postgres`, que mantém o grant.
--     O trigger também trava `carteira_assignments` (FOR UPDATE) ⇒ fecha a corrida
--     "eligible vira false entre a checagem e o INSERT" mesmo p/ quem não usa a RPC.
--
-- ── O que NÃO está aqui, de propósito (enumerado, não esquecido) ─────────────────
-- A policy SELECT segue **broad-staff** (`tactical_plans_select_staff`: master OR
-- employee). Eu tinha desenhado o estreitamento p/ carteira-scoped nesta migration e
-- **recuei** — o Codex xhigh (achado 4) mostrou um custo money-path que eu não modelara:
-- a policy carteira-scoped segue a carteira ATUAL, então um plano cujo cliente foi
-- REATRIBUÍDO (A→B) some para A na RLS **e** some do `calculateScores(A)`
-- (useFarmerPerformance) — a métrica histórica de performance/aderência de A muda
-- RETROATIVAMENTE, e passa a variar conforme QUEM a calcula (o master, que bypassa,
-- vê outro número). Trocar um vazamento latente por uma métrica de avaliação instável
-- é mau negócio, ainda mais quando (1)+(3) já impedem que exista linha de mascarado
-- para vazar. Fica como follow-up com desenho próprio (estado explícito de
-- invalidação por reatribuição + histórico por agregação/snapshot, não por RLS viva).
--
-- ⚠️ Provada em PG17 local com falsificação: db/test-tactical-plans-eligible-fail-closed.sh
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- (1) criar_plano_tatico v3 — gate `eligible` fail-closed na fronteira de escrita
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
  -- v3: `eligible` sai do MESMO SELECT travado — ler a máscara fora do lock reabriria o
  -- race pelo outro lado (mascarar concorrente entre a checagem e o INSERT).
  SELECT a.owner_user_id, a.eligible INTO _owner, _eligible
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer_user_id
  FOR UPDATE;

  IF _owner IS NULL THEN
    RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id;
  END IF;

  -- [v3 — máscara eligible] Fail-closed para TODO caller, inclusive service_role (cron/batch)
  -- e master. O gate `carteira_visivel_para` acima já cobre o autenticado não-master desde o
  -- #1398; este é a fronteira que fecha o caminho BATCH, que pula aquele gate por desenho.
  -- `IS NOT TRUE` cobre NULL (fail-closed) além de false.
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

COMMENT ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) IS
  'Insere farmer_tactical_plan; posse re-resolvida server-side de carteira_assignments com FOR UPDATE (race fechado); gate carteira_visivel_para OR service_role; _expected_owner obrigatório p/ autenticado; RECUSA cliente mascarado (eligible IS NOT TRUE) para TODO caller, inclusive service_role/cron e master. Fronteira de escrita.';

-- Privilégios (idempotente — re-afirma o estado do #1037/#1043; CREATE OR REPLACE preserva,
-- mas re-emitir torna a migration auto-suficiente se re-colada no SQL Editor).
REVOKE ALL ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.criar_plano_tatico(uuid, uuid, jsonb) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- (2) registrar_resultado_plano v3 — mesmo gate (resultado comercial é money-path)
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
    IF NOT public.carteira_visivel_para(_customer, _uid) THEN
      RAISE EXCEPTION 'Plano fora da sua carteira' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- [v3 — máscara eligible] Um plano criado enquanto o cliente era elegível e MASCARADO
  -- DEPOIS continua existindo; sem este gate, master (braço master do carteira_visivel_para)
  -- e service_role gravariam actual_margin/call_result — resultado comercial de cliente
  -- mascarado, que alimenta efetividade/avaliação. Fail-closed p/ todo caller.
  SELECT a.eligible INTO _eligible
  FROM public.carteira_assignments a
  WHERE a.customer_user_id = _customer;

  IF _eligible IS NOT TRUE THEN
    RAISE EXCEPTION 'Cliente do plano % está mascarado na carteira (eligible) — resultado não é registrado', _plan_id
      USING ERRCODE = '42501';
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
  'Grava resultado pós-call; gate carteira_visivel_para OR service_role; RECUSA cliente mascarado (eligible IS NOT TRUE) p/ todo caller; recusa se status=concluido (resultado imutável após conclusão).';

REVOKE ALL ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_resultado_plano(uuid, boolean, text, numeric, integer, text, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- (3) A tabela deixa de ser escrevível fora das RPCs — REVOKE + trigger
-- ────────────────────────────────────────────────────────────────────────────
-- REVOKE por NOME: `FROM PUBLIC` não tira anon/authenticated no Supabase (eles têm grant
-- explícito por default privilege — database.md §4). SELECT é PRESERVADO (o front lê).
REVOKE INSERT, UPDATE, DELETE ON public.farmer_tactical_plans
  FROM PUBLIC, anon, authenticated, service_role;

-- Segunda barreira: alcança o que o REVOKE não alcança (função SECURITY DEFINER futura
-- roda como `postgres` e mantém o privilégio). É a fronteira que TODO INSERT cruza.
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
$function$;

COMMENT ON FUNCTION public.tactical_plan_recusa_cliente_mascarado() IS
  'Trigger BEFORE INSERT em farmer_tactical_plans: recusa cliente mascarado (eligible IS NOT TRUE), inclusive sem assignment. Barreira final — alcança escrita de função SECURITY DEFINER futura, que roda como postgres e o REVOKE não pega.';

DROP TRIGGER IF EXISTS trg_tactical_plan_recusa_mascarado ON public.farmer_tactical_plans;
CREATE TRIGGER trg_tactical_plan_recusa_mascarado
  BEFORE INSERT ON public.farmer_tactical_plans
  FOR EACH ROW EXECUTE FUNCTION public.tactical_plan_recusa_cliente_mascarado();

COMMIT;
