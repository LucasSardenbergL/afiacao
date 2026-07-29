-- ============================================================================================
-- calculate-scores — LEASE anti-sobreposição (fecha o last-writer-wins do snapshot)
-- ============================================================================================
-- FURO (achado por challenge adversarial /codex 2026-07-22 durante o #1567; herdado do desenho,
-- NÃO introduzido por ele). O writer `calculate-scores` monta o payload de apply_score_updates a
-- partir do SNAPSHOT lido no INÍCIO do run (`select('*')` em farmer_client_scores) e o envia no FIM.
-- Não há exclusão mútua entre o cron, um retry após timeout e um disparo manual de staff. Com dois
-- runs sobrepostos:
--   1. Run B lê a linha (itens_com_custo=77, itens_sem_custo=88, gross_margin_pct=99)
--   2. get_customer_margin_summary FALHA no run B → marginRefreshFatal → o overlay é PULADO e o
--      payload segue carregando o snapshot VELHO
--   3. Run A (saudável) grava os valores novos (3/37, margem 53)
--   4. Run B termina DEPOIS e reenvia 77/88/99 → RESTAURA o valor velho
-- O comentário no código dizia "UPDATE regrava o mesmo valor = no-op" — verdade SÓ sem concorrência.
--
-- ALCANCE: não é só a cobertura de custo. Mesmo padrão hoje em gross_margin_pct, m_score,
-- days_since_last_purchase, avg_monthly_spend_180d, category_count e health_score/churn_risk
-- derivados — um run degradado restaura margem e recência velhas sobre um run saudável.
--
-- ⚠️ O caso ruim é AUTO-AGRAVANTE, não improvável: o modo de falha típico da RPC de margem é
-- TIMEOUT (57014), e o run que dá timeout é justamente o MAIS LENTO — ou seja, "o degradado termina
-- depois do saudável" é o desfecho ESPERADO da corrida, não o azar raro.
--
-- EXPOSIÇÃO MEDIDA EM PROD (psql-ro, 2026-07-23):
--   • cron `daily-calculate-scores` 0 6 * * * (timeout_milliseconds := 150000)
--   • disparo MANUAL de staff em src/pages/IntelligenceDashboard.tsx (invoke direto). O `disabled`
--     do botão é local à aba — não protege entre abas/usuários nem contra cron × manual.
--   • health_score_history (append-only), 30 dias: 1 run/dia, EXCETO 2026-07-21 com TRÊS runs
--     (06:00, 21:47, 22:04) — dois manuais em rajada de 17min no dia do deploy da margem.
--   • duração de um run ≈ 17s (cron às 06:00:00, history começa 06:00:13 e dura ~4s) = a janela.
--
-- POR QUE LEASE E NÃO ADVISORY LOCK: `pg_advisory_lock` de SESSÃO via PostgREST NÃO serve — o pool
-- não dá afinidade de conexão, então o lock vaza/solta em conexão reciclada. Lição já paga e
-- documentada em 20260713160000_carteira_rebuild_lease.sql. `pg_advisory_xact_lock` também não
-- resolve: cada chamada PostgREST é a sua própria transação, e o lease precisa atravessar N chamadas
-- (claim → leituras → RPCs → apply em chunks de 500). Solução idiomática do repo: LEASE row-based em
-- sync_state, espelhando claim/finalizar_carteira_rebuild verbatim.
--
-- FENCING POR PLATAFORMA (o run vivo NUNCA perde o lease): o edge do Supabase é morto pelo
-- wall-clock (150s Free / 400s pago, não-configurável). TTL 15min (900s) > 400s ⇒ o run antigo já
-- morreu pela plataforma antes de o TTL expirar. Defesa extra: finalizar_calculate_scores só grava
-- se o run AINDA é dono.
-- ⚠️ MONEY-PATH — provado em PG17 (db/test-calculate-scores-lease.sh) com concorrência real, os dois
--    sentidos de commit (saudável × degradado), RLS e falsificação.

-- claim: reivindica o lease 'syncing' SE livre (não-'syncing', ou 'syncing' velho >15min = run morto).
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING é UMA instrução com lock de linha → só UM
-- concorrente reivindica; o outro vê o WHERE falso → RETURNING vazio → false (e a edge pula o run).
-- ⚠️ O ON CONFLICT infere por (entity_type, account): a PROD tem DOIS unique indexes redundantes
-- nessas colunas (idx_sync_state_entity_account e sync_state_entity_account_uq, conferidos por
-- psql-ro 2026-07-23) e NENHUMA constraint em pg_constraint — olhar só pg_constraint esconderia a
-- chave (armadilha do CLAUDE.md). A inferência por colunas casa com qualquer um dos dois.
CREATE OR REPLACE FUNCTION public.claim_calculate_scores(p_run_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_run_id = '' THEN RAISE EXCEPTION 'p_run_id vazio' USING ERRCODE = '22004'; END IF;
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('calculate_scores', 'global', 'syncing', now(), 0,
          jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), now())
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status = 'syncing', last_sync_at = now(), total_synced = 0,
        metadata = jsonb_build_object('run_id', p_run_id, 'fase', 'inicio'), updated_at = now()
    WHERE sync_state.status IS DISTINCT FROM 'syncing'
       OR sync_state.last_sync_at IS NULL
       OR sync_state.last_sync_at < now() - interval '15 minutes'  -- TTL > teto de wall-clock do edge
       -- RE-CLAIM DO MESMO RUN (idempotência — achado do challenge /codex): se o banco CONFIRMA o
       -- claim mas a resposta HTTP se perde, o retry com o mesmo run_id receberia false e deixaria o
       -- lease preso até o TTL. Como p_run_id é um crypto.randomUUID() por invocação, dois runs
       -- DISTINTOS nunca colidem nesta cláusula — ela só reconhece o dono voltando.
       OR (sync_state.metadata->>'run_id') = p_run_id
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END $$;

REVOKE ALL ON FUNCTION public.claim_calculate_scores(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_calculate_scores(text) TO service_role;

COMMENT ON FUNCTION public.claim_calculate_scores(text) IS
  'Lease do recompute de scores (edge calculate-scores). true = este run e dono e pode ler o snapshot '
  'e escrever; false = ja ha run em andamento, PULE (idempotente: o proximo cron converge). O claim tem '
  'de vir ANTES do select do snapshot — reivindicar depois da leitura deixaria a corrida aberta pela '
  'porta de tras (o payload ja carregaria valores de fora da exclusao). TTL 15min > wall-clock do edge.';

-- finalize com OWNERSHIP + IDEMPOTÊNCIA. Grava 'complete'/'error' se ESTE run é dono
-- (metadata->>'run_id' == p_run_id) E (status ainda 'syncing' — finalização normal — OU já finalizado
-- ANTES por este mesmo run: status == p_status E fase == 'fim' — retry após resposta HTTP perdida, que
-- aqui é REAL: o cron corta em 150s e a edge segue viva). Run alheio nunca casa (ownership). fase='fim'
-- distingue "EU finalizei" de "alguém pôs 'complete' por fora" (esse não re-finaliza → false).
-- Retorno: true = finalizado/já-finalizado-por-mim; false = não sou dono.
CREATE OR REPLACE FUNCTION public.finalizar_calculate_scores(p_run_id text, p_status text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_done boolean := false;
BEGIN
  IF p_run_id IS NULL OR p_run_id = '' THEN RAISE EXCEPTION 'p_run_id vazio' USING ERRCODE = '22004'; END IF;
  -- p_status IS NULL explícito: `NULL NOT IN (...)` = NULL (não TRUE) → sem o IS NULL o RAISE não
  -- rodaria e o finalize gravaria status=NULL retornando true. (Lição do re-challenge do #1461.)
  IF p_status IS NULL OR p_status NOT IN ('complete', 'error') THEN
    RAISE EXCEPTION 'p_status invalido: %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE public.sync_state
     SET status = p_status, last_sync_at = now(),
         metadata = jsonb_build_object('run_id', p_run_id, 'fase', 'fim'),
         updated_at = now()
   WHERE entity_type = 'calculate_scores'
     AND account = 'global'
     AND (metadata->>'run_id') = p_run_id
     AND (
       status = 'syncing'                                       -- finalização normal
       OR (status = p_status AND (metadata->>'fase') = 'fim')   -- retry idempotente do MESMO run
     )
  RETURNING true INTO v_done;
  RETURN COALESCE(v_done, false);
END $$;

REVOKE ALL ON FUNCTION public.finalizar_calculate_scores(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalizar_calculate_scores(text, text) TO service_role;

COMMENT ON FUNCTION public.finalizar_calculate_scores(text, text) IS
  'Libera o lease do calculate-scores com ownership (so o run DONO fecha) e idempotencia (retry do '
  'mesmo run apos resposta HTTP perdida nao acusa falso ownership-lost). false = perdi o lease '
  '(fencing quebrado ou lease adulterado) — a edge loga, NAO reescreve.';

-- BLOQUEIO de adulteração direta do lease. A policy "Staff can manage sync state" dá FOR ALL em
-- sync_state a employee/master, e o GRANT de tabela dá DML a authenticated/anon → um staff (ou
-- insider comprometido) faria UPDATE sync_state SET status='complete' na chave do lease e furaria a
-- exclusão (o claim seguinte reivindicaria). Policies RESTRICTIVE reservam a ESCRITA da chave
-- 'calculate_scores' ao service_role (BYPASSRLS → edge/cron não afetados). SELECT fica livre (ler a
-- linha de lease é inócuo). Mesmo desenho das 3 policies de carteira_rebuild; RESTRICTIVE são ANDadas,
-- então as duas famílias coexistem sem se anular.
-- Dívida anotada (fora deste escopo): cada lease novo acrescenta 3 policies. Se surgir um 3º, vale
-- consolidar em `entity_type <> ALL (ARRAY[...])` — mexer nas do carteira_rebuild agora quebraria o
-- harness dele por nome de policy, e é superfície alheia a este PR.
DROP POLICY IF EXISTS calculate_scores_lease_no_insert ON public.sync_state;
DROP POLICY IF EXISTS calculate_scores_lease_no_update ON public.sync_state;
DROP POLICY IF EXISTS calculate_scores_lease_no_delete ON public.sync_state;
CREATE POLICY calculate_scores_lease_no_insert ON public.sync_state
  AS RESTRICTIVE FOR INSERT TO public WITH CHECK (entity_type <> 'calculate_scores');
CREATE POLICY calculate_scores_lease_no_update ON public.sync_state
  AS RESTRICTIVE FOR UPDATE TO public
  USING (entity_type <> 'calculate_scores') WITH CHECK (entity_type <> 'calculate_scores');
CREATE POLICY calculate_scores_lease_no_delete ON public.sync_state
  AS RESTRICTIVE FOR DELETE TO public USING (entity_type <> 'calculate_scores');

-- TRUNCATE NÃO passa por RLS (bypassa as policies acima). Já revogado pela migration do
-- carteira_rebuild; repetido aqui porque num restore/DR esta migration pode ser a primeira a rodar
-- (idempotente — REVOKE de privilégio ausente é no-op).
REVOKE TRUNCATE ON public.sync_state FROM PUBLIC, anon, authenticated;

-- Validação pós-apply (read-only): as 2 funções existem, revogadas de anon/authenticated, e as 3 policies.
SELECT 'MIGRATION calculate_scores_lease OK' AS status,
  (to_regprocedure('public.claim_calculate_scores(text)')       IS NOT NULL) AS claim_existe,
  (to_regprocedure('public.finalizar_calculate_scores(text,text)') IS NOT NULL) AS finalizar_existe,
  has_function_privilege('service_role', 'public.claim_calculate_scores(text)', 'EXECUTE') AS claim_service_role,
  has_function_privilege('anon', 'public.claim_calculate_scores(text)', 'EXECUTE') AS claim_anon_deve_ser_false,
  has_function_privilege('authenticated', 'public.finalizar_calculate_scores(text, text)', 'EXECUTE') AS finalizar_authenticated_deve_ser_false,
  (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.sync_state'::regclass
     AND polname LIKE 'calculate\_scores\_lease\_%')::int AS policies_lease_deve_ser_3;
