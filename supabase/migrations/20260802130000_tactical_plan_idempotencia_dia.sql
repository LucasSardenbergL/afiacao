-- ============================================================================
-- Plano tático: idempotência ESTRUTURAL do dia operacional + colunas de bundle honestas
--
-- Achado do challenge /codex (gpt-5.6-sol, xhigh) durante o #1618; pré-existente, ficou
-- fora daquele PR de propósito. Confirmado ainda aberto em prod em 2026-07-31.
--
-- ── P2 #1 — check-then-insert permite plano duplicado E cobrança dupla de IA ───────────
--
-- A checagem "já há plano gerado hoje?" vive na EDGE (generate-tactical-plan/index.ts) e
-- roda ANTES da chamada cara à Anthropic. A RPC `criar_plano_tatico` trava a carteira
-- (`SELECT … FROM carteira_assignments … FOR UPDATE`) mas NÃO repete o teste de
-- existência, e não havia índice único. Logo:
--
--   batch A: consulta → 0 planos            batch B: consulta → 0 planos
--   batch A: chama a IA (paga)              batch B: chama a IA (paga)
--   batch A: RPC → pega o lock → INSERT     batch B: espera o lock → INSERT
--   ⇒ dois planos 'gerado' no mesmo dia para o mesmo cliente, duas chamadas cobradas.
--
-- Já aconteceu: 2026-07-21/22, 30 duplicatas. O #1544 corrigiu o EIXO DO DIA (a janela era
-- `>= 00:00 UTC` e o dia de quem usa é BRT — ver _shared/dia-operacional.ts), mas deixou a
-- forma check-then-insert de pé. As 30 linhas excedentes seguem no banco (medido via
-- psql-ro 2026-07-31: 30 grupos, 30 excedentes, TODOS no dia BRT 2026-07-21).
--
-- DUAS defesas, e queremos as duas:
--   (1) ÍNDICE ÚNICO PARCIAL — invariante estrutural, vale para qualquer writer futuro;
--   (2) RE-TESTE DENTRO DA RPC, depois do `FOR UPDATE` — o lock de `carteira_assignments`
--       serializa os concorrentes do MESMO cliente, então o perdedor enxerga a linha já
--       commitada (READ COMMITTED: o SELECT após a espera usa snapshot novo) e recusa com
--       mensagem própria, em vez de estourar 23505 cru que o lote contaria como erro.
--   + o `EXCEPTION WHEN unique_violation` traduz o caminho que escapar de (2) para a mesma
--     mensagem — a tabela tem exatamente DOIS índices únicos (a PK de uuid e este), então
--     não há outra violação para mascarar.
--
-- CHAVE = (farmer_id, customer_user_id, dia operacional BRT, plan_type). `plan_type` entra
-- de propósito: o cron sempre pede 'estrategico' (tactical-plans-batch), então o cenário de
-- cobrança dupla continua barrado; deixá-lo FORA proibiria a vendedora de gerar um plano
-- 'essencial' para um cliente que o cron já cobriu naquele dia — restrição nova que ninguém
-- pediu. O pré-teste da edge é mais estrito (ignora plan_type) e assim permanece: ele é
-- atalho para economizar a chamada de IA, não o invariante.
--
-- DIA OPERACIONAL = offset FIXO de −3h, e não `AT TIME ZONE 'America/Sao_Paulo'`: é o que
-- `inicioDiaOperacional` (_shared/dia-operacional.ts) faz, e paridade por construção vale
-- mais que fidelidade a uma regra de horário de verão que o Brasil não observa desde 2019
-- (Decreto 9.772/2019). Se o país reinstituir DST, os dois lados continuam concordando.
-- Volatilidade conferida em prod: `timezone(text, timestamptz)`=IMMUTABLE,
-- `timestamp - interval`=IMMUTABLE, `date(timestamp)`=IMMUTABLE ⇒ a expressão é indexável.
-- (Já `timestamptz - interval` é STABLE — por isso o `AT TIME ZONE 'UTC'` vem PRIMEIRO.)
--
-- RECORTE DO ÍNDICE (`>= 2026-07-22`): as 30 duplicatas do incidente são anteriores e um
-- `CREATE UNIQUE INDEX` sobre elas FALHARIA. Passivo não obriga a adiar a trava nem a
-- apagar histórico (deleção exige prova positiva; aqui não há nenhuma a favor): o recorte
-- deixa o incidente intacto e a invariante vale de 22/07 em diante. Mesmo padrão do
-- `UNIQUE(run_key, …) WHERE run_key IS NOT NULL` de fin_projecao_snapshots (money-path §11).
--
-- ── P2 #2 — números do bundle: "não há bundle" gravado como medição ───────────────────
--
-- As quatro colunas têm `DEFAULT 0`, e os dois writers mandavam `Number(x ?? 0)` /
-- `best_individual_lie: 0`. Medido em prod (psql-ro, 2026-07-31): **339 de 339 planos**
-- com bundle_lie = bundle_probability = bundle_incremental_margin = 0, **0 nulos**,
-- **0 positivos**, e **nenhum** com `bundle_recommendation_id`. Ou seja: 100% dos zeros
-- são "não havia bundle" com cara de número apurado, e o card mostra "LIE R$ 0,00" para a
-- base inteira. O lado TS é corrigido no mesmo PR (helper `numerosDoBundle` nos dois
-- writers + `parsePlan` na leitura); aqui fecham as duas pontas de banco:
--   • DROP DEFAULT — o `DEFAULT 0` é a "arma carregada" do money-path §2 (rótulo com
--     default constante não é fato). Hoje ele nunca dispara porque a RPC lista as colunas
--     com valor explícito, mas qualquer writer futuro que as omita voltaria a fabricar 0.
--   • BACKFILL das linhas provadamente fabricadas. A prova é POSITIVA, não estimativa:
--     os writers gravam `bundle_recommendation_id` e os três números do MESMO objeto, logo
--     `bundle_recommendation_id IS NULL` ⇒ não havia bundle ⇒ os três zeros vieram do
--     `?? 0`. E `best_individual_lie` era `0` literal no código para TODOS os casos —
--     nenhuma linha do repo o calcula.
--
-- ⚠️ MIGRATION MANUAL — nome custom não é auto-aplicado pelo Lovable (docs/agent/database.md).
-- Provada em PostgreSQL 17 local com falsificação: db/test-tactical-plan-idempotencia.sh
-- ============================================================================

-- ── 1. Colunas de bundle: sem DEFAULT constante ──────────────────────────────
ALTER TABLE public.farmer_tactical_plans ALTER COLUMN bundle_lie                DROP DEFAULT;
ALTER TABLE public.farmer_tactical_plans ALTER COLUMN bundle_probability        DROP DEFAULT;
ALTER TABLE public.farmer_tactical_plans ALTER COLUMN bundle_incremental_margin DROP DEFAULT;
ALTER TABLE public.farmer_tactical_plans ALTER COLUMN best_individual_lie       DROP DEFAULT;

COMMENT ON COLUMN public.farmer_tactical_plans.bundle_lie IS
  'LIE do bundle prioritário no instante da geração. NULL = não havia bundle (ou a origem não estava medida). NUNCA 0 por omissão — 0 é veredito apurado.';
COMMENT ON COLUMN public.farmer_tactical_plans.bundle_probability IS
  'Probabilidade do bundle (0-100). NULL = não havia bundle / não medido.';
COMMENT ON COLUMN public.farmer_tactical_plans.bundle_incremental_margin IS
  'Margem incremental do bundle. NULL = não havia bundle / não medido.';
COMMENT ON COLUMN public.farmer_tactical_plans.best_individual_lie IS
  'Melhor LIE individual. Nenhum writer do repo o calcula — sempre NULL até que exista um.';

-- ── 2. Backfill do 0 provadamente fabricado ──────────────────────────────────
-- Idempotente: re-rodar não encontra mais linhas. Só toca linhas em que o 0 NÃO pode ter
-- vindo de medição. Não há trigger de UPDATE nesta tabela (só BEFORE INSERT).
UPDATE public.farmer_tactical_plans
   SET bundle_lie                = NULL,
       bundle_probability        = NULL,
       bundle_incremental_margin = NULL
 WHERE bundle_recommendation_id IS NULL
   AND (bundle_lie = 0 OR bundle_probability = 0 OR bundle_incremental_margin = 0);

UPDATE public.farmer_tactical_plans
   SET best_individual_lie = NULL
 WHERE best_individual_lie IS NOT NULL;

-- ── 3. Índice único parcial: 1 plano 'gerado' por (dono, cliente, dia BRT, tipo) ──
CREATE UNIQUE INDEX IF NOT EXISTS ux_farmer_tactical_plans_dia_operacional
    ON public.farmer_tactical_plans (
      farmer_id,
      customer_user_id,
      (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date),
      (COALESCE(plan_type, 'essencial'))
    )
 WHERE status = 'gerado'
   AND (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date) >= DATE '2026-07-22';

COMMENT ON INDEX public.ux_farmer_tactical_plans_dia_operacional IS
  'Idempotência do plano tático por dia operacional BRT (UTC-3 fixo, paridade com _shared/dia-operacional.ts). Recorte >= 2026-07-22 preserva as 30 duplicatas do incidente de 2026-07-21 sem abrir mão da invariante daqui em diante.';

-- ── 4. RPC: re-teste de existência DEPOIS do lock ────────────────────────────
-- Corpo transcrito de `pg_get_functiondef` da PRODUÇÃO em 2026-07-31 (o repo pode divergir
-- do que foi aplicado à mão; a última a recriar vence — docs/agent/database.md). Única
-- mudança: o bloco [#1618-followup] + o INSERT dentro de BEGIN/EXCEPTION.
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
  _dia_hoje   date;
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
  -- usa um snapshot posterior à espera pelo lock). Chave IDÊNTICA à do índice único
  -- ux_farmer_tactical_plans_dia_operacional — divergir faria a RPC autorizar o que o
  -- índice depois recusaria com 23505 cru.
  _dia_hoje := ((now() AT TIME ZONE 'UTC') - interval '3 hours')::date;

  IF EXISTS (
    SELECT 1 FROM public.farmer_tactical_plans p
     WHERE p.farmer_id = _owner
       AND p.customer_user_id = _customer_user_id
       AND p.status = 'gerado'
       AND COALESCE(p.plan_type, 'essencial') = COALESCE(_rec.plan_type, 'essencial')
       AND (((p.created_at AT TIME ZONE 'UTC') - interval '3 hours')::date) = _dia_hoje
  ) THEN
    RAISE EXCEPTION 'Já existe plano tático gerado hoje para este cliente (dia operacional BRT)'
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
    RAISE EXCEPTION 'Já existe plano tático gerado hoje para este cliente (dia operacional BRT)'
      USING ERRCODE = '23505';
  END;

  RETURN _new_id;
END;
$function$;
