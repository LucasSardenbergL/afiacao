-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- apply_score_updates — FENCING REAL do lease (a escrita passa a ser cercada, não só o início/fim)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FOLLOW-UP do #1578 (lease do calculate-scores), achado do challenge /codex gpt-5.6-sol e cortado
-- de lá como escopo próprio.
--
-- O QUE FICOU ABERTO. O lease row-based (claim_calculate_scores / finalizar_calculate_scores,
-- migration 20260728120001) é COOPERATIVO: protege o INÍCIO (quem pode começar) e a FINALIZAÇÃO
-- (quem pode fechar), mas NÃO cerca a ESCRITA. Se o TTL de 15min expirar e outro run assumir, o run
-- antigo — se ainda estiver vivo — chama apply_score_updates e grava o payload montado do snapshot
-- DELE. O finalizar devolve false (ownership perdido), mas isso é detecção TARDIA: a escrita já
-- aconteceu, e é exatamente a restauração de margem/recência velhas que o #1578 existe para matar.
--
-- POR QUE NÃO ERA CRÍTICO. O fencing vinha da PLATAFORMA: o edge do Supabase é morto pelo wall-clock
-- (150s Free / 400s pago, não-configurável) e o TTL é 900s, logo o run antigo já morreu antes de o
-- TTL expirar. O TTL foi escolhido com essa folga. Mas a garantia depende de uma premissa EXTERNA,
-- não de uma trava no banco: se a Supabase mudar o teto, ou se uma RPC continuar rodando no Postgres
-- depois da morte do isolate, a premissa cai EM SILÊNCIO — e o modo de falha é o mesmo de antes do
-- #1578, com o lease dando a impressão de que está resolvido. Esta migration troca a premissa
-- externa por uma trava no banco.
--
-- ⚠️ ESTA MIGRATION É INERTE ATÉ A EDGE NOVA SUBIR. Enquanto o writer não enviar p_run_id, o
--    comportamento é BIT-A-BIT o de hoje (NULL ⇒ sem fencing). O wiring vem no MESMO PR
--    (calculate-scores v1.2-fencing-apply: passa o runId do lease, para no 1º 55000). As DUAS ordens
--    de publicação manual do Lovable são seguras:
--      • migration ANTES da edge → a edge antiga chama com 1 argumento e casa o DEFAULT NULL (D2);
--      • edge ANTES da migration → a chamada com p_run_id dá PGRST202, a edge classifica pelo CÓDIGO
--        (`classificarErroApply`, _shared/lease.ts) e refaz o chunk sem token, com aviso `fencing`
--        na resposta — o banco ainda não tem a cerca, então nada a contornar.
--    Só com as DUAS no ar o fencing passa a valer (money-path.md §2: defesa inerte tem prazo curto).
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- POR QUE DROP + CREATE, E NÃO CREATE OR REPLACE
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE não muda assinatura: acrescentar p_run_id criaria uma SOBRECARGA, e as duas
-- conviveriam — apply_score_updates(jsonb) e apply_score_updates(jsonb, text DEFAULT NULL). Aí a
-- chamada que a edge faz hoje (só p_updates) casa com AS DUAS e o Postgres levanta 42725
-- "function is not unique": a edge ANTIGA quebraria no instante do apply da migration, que é
-- exatamente a janela que este arquivo se esforça para manter segura. Provado em PG17
-- (db/test-apply-score-updates-fencing.sh, assento D1) — não é folclore.
--
-- O DROP é seguro e foi pré-flightado contra a PROD por psql-ro (2026-07-23, RECONFERIDO 2026-10-10):
--   • pg_depend: NENHUM objeto depende de apply_score_updates(jsonb) (sem view/trigger/constraint).
--   • Único caller: supabase/functions/calculate-scores/index.ts (chunks de 500 via PostgREST).
--   • proacl em prod = {postgres, service_role, sandbox_exec_<ref>, sandbox_exec}. Os grants
--     sandbox_exec* são BLANKET da plataforma (306 das 424 funções de public os têm, inclusive
--     claim_carteira_rebuild, que nasceu de migration com REVOKE/GRANT explícito) — a plataforma os
--     reaplica; não são reproduzíveis aqui (o nome carrega o project ref e não existiria em DR).
--   • pg_get_functiondef da PROD conferido contra 20260728120000: SEM DRIFT (diff normalizado de
--     330 tokens, diferença única o `;` do recorte). O corpo abaixo é o de prod + o fencing.
-- DROP e CREATE no MESMO script: o SQL Editor roda o bloco em uma transação, então não há janela em
-- que a função não exista. Ainda assim, cole o arquivo INTEIRO de uma vez (nunca por partes).
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- O CONTRATO DO FENCING
-- ───────────────────────────────────────────────────────────────────────────────────────────────
--   p_run_id IS NULL   → SEM fencing. Retrocompat exata com a edge de hoje. É o mesmo padrão
--                        jsonb_exists que a 20260728120000 usa para as colunas de cobertura: a
--                        ausência do sinal é no-op, nunca um erro nem um número fabricado.
--   p_run_id = ''      → 22004. String vazia NÃO é "sem fencing": tratá-la como NULL daria um bypass
--                        trivial (basta mandar '') ao gate que esta migration existe para fechar.
--                        btrim() cobre a variante só-espaços. Espelha claim/finalizar_calculate_scores.
--   p_run_id = <id>    → só aplica se ESTE run ainda é o dono do lease:
--                        sync_state(entity_type='calculate_scores', account='global')
--                        com status='syncing' E metadata->>'run_id' = p_run_id.
--                        Caso contrário 55000 (object_not_in_prerequisite_state) e ZERO escrita.
--
-- O TTL NÃO entra no predicado, de propósito. Um run cujo lease ficou velho mas que NINGUÉM
-- reivindicou não causou dano nenhum: não há escrita mais nova para ele atropelar. Barrá-lo só
-- trocaria um dado coerente-porém-velho por uma escrita PELA METADE (o run pararia no meio dos
-- chunks). O dano que este gate mira é preciso — "outro run assumiu" (run_id mudou) ou "eu já
-- finalizei" (status ≠ 'syncing') —, e o predicado mira exatamente ele.
--
-- POR QUE `FOR SHARE` (é o que torna o fencing REAL, e não uma checagem decorativa). Sem o lock
-- haveria janela entre o IF e o UPDATE: em READ COMMITTED, o claim de outro run poderia commitar
-- ENTRE as duas instruções e o UPDATE seguiria mesmo assim, gravando o snapshot velho — a checagem
-- viraria teatro. FOR SHARE trava a linha de lease até o COMMIT do chunk, e o claim rival (que é um
-- INSERT ... ON CONFLICT DO UPDATE, ou seja, lock de escrita na mesma linha) BLOQUEIA até lá. O
-- custo é o claim esperar a duração de UM chunk (UPDATE de 500 linhas, milissegundos); o ganho é a
-- validação e a escrita serem atômicas de verdade. Provado em PG17 com duas sessões reais (C3).
--
-- GRANULARIDADE: o fencing é POR CHUNK, e isso é uma decisão, não um resto. A edge chama a RPC em
-- chunks de 500, cada um em sua própria transação. A propriedade que isto garante é
-- **nenhuma escrita enquanto não se é dono do lease** — e ela basta para o desfecho convergir: as
-- escritas do run perdedor acontecem todas ANTES de o rival reivindicar, e o rival reescreve o
-- universo inteiro depois, então o estado final é o snapshot do vencedor. O que o fencing por chunk
-- NÃO fecha é a parcialidade DENTRO de um run (o edge morrer no chunk k deixa metade nova, metade
-- velha) — mas isso é falha de ATOMICIDADE de crash, não de concorrência, e a cura dela é staging +
-- publicação atômica, escopo próprio e bem mais caro (tabela de staging para ~6,6k linhas). Fica
-- declarada como limitação, como já estava no #1578.
--
-- ⚠️ MONEY-PATH — provado em PG17 (db/test-apply-score-updates-fencing.sh): positivos, negativos com
--    SQLSTATE + re-raise, os invariantes HERDADOS re-exercidos sob ESTA versão (a função é recriada
--    inteira — cobertura das migrations anteriores não vale para ela, lição #1515), concorrência com
--    duas sessões reais e trilha de eventos provando que o perdedor TENTOU escrever e foi barrado, e
--    falsificação com baseline verde + contagem de vermelhos.

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 1) Fora a assinatura antiga (ver "POR QUE DROP + CREATE" acima)
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- DROP, CREATE e REVOKE/GRANT numa transação EXPLÍCITA (challenge Codex 2026-10-10): estar no mesmo
-- arquivo não garante atomicidade — sem o BEGIN, um erro no CREATE deixaria a PROD SEM a função (o
-- cron das 06:15 quebrado) e um erro depois dele deixaria a função nova com o ACL default (EXECUTE
-- para PUBLIC). Com o BEGIN, ou tudo entra, ou nada muda. Sob um runner que já abre transação, o
-- BEGIN só gera WARNING ("already a transaction in progress") — inofensivo.
BEGIN;

DROP FUNCTION IF EXISTS public.apply_score_updates(jsonb);

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2) A função, com o fencing na MESMA transação da escrita
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Corpo transcrito da PROD (pg_get_functiondef 2026-10-10, idêntico a 20260728120000) + o bloco de
-- fencing no topo. Nada mais mudou: guard das 12 chaves CORE, jsonb_exists de m_score /
-- gross_margin_pct / itens_com_custo / itens_sem_custo, COALESCE de sales_history_status,
-- UPDATE-only anti-ressurreição (#971) e RETURN = ROW_COUNT seguem verbatim.
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
  v_dono  text;
  v_status text;
BEGIN
  -- ── FENCING DO LEASE ─────────────────────────────────────────────────────────────────────────
  -- Primeira coisa do corpo, ANTES do guard de contrato e do UPDATE: quem não é dono não paga nem
  -- o custo de validar o payload, e o lock é tomado antes de qualquer trabalho.
  IF p_run_id IS NOT NULL THEN
    IF btrim(p_run_id) = '' THEN
      RAISE EXCEPTION 'apply_score_updates: p_run_id vazio (use NULL para chamar sem fencing, nunca string vazia)'
        USING ERRCODE = '22004';
    END IF;

    -- FOR SHARE: trava a linha de lease até o COMMIT deste chunk. O claim rival bloqueia até lá, de
    -- modo que "sou dono" e "escrevo" ficam atômicos. Sem isto a checagem seria decorativa.
    PERFORM 1
       FROM public.sync_state
      WHERE entity_type = 'calculate_scores'
        AND account     = 'global'
        AND status      = 'syncing'
        AND (metadata->>'run_id') = p_run_id
      FOR SHARE;

    IF NOT FOUND THEN
      -- Diagnóstico: quem é o dono corrente e em que estado. Só ids de run (crypto.randomUUID da
      -- edge) e o status do lease — domínio fechado, sem dado de cliente.
      SELECT s.metadata->>'run_id', s.status INTO v_dono, v_status
        FROM public.sync_state s
       WHERE s.entity_type = 'calculate_scores' AND s.account = 'global';
      RAISE EXCEPTION
        'apply_score_updates: run % nao e dono do lease (dono=% status=%) — escrita recusada para nao restaurar snapshot velho',
        p_run_id, coalesce(v_dono, '<sem lease>'), coalesce(v_status, '<sem linha>')
        USING ERRCODE = '55000';
    END IF;
  END IF;
  -- ── fim do fencing ───────────────────────────────────────────────────────────────────────────

  -- GUARD DE CONTRATO (full-update only): as 12 chaves CORE são obrigatórias em TODA linha.
  -- Aqui jsonb_to_recordset basta: ausente e null são AMBOS inválidos, então colapsá-los é correto.
  -- sales_history_status, gross_margin_pct, m_score, itens_com_custo e itens_sem_custo NÃO entram
  -- (nuláveis por semântica).
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND churn_risk               IS NOT NULL
    AND priority_score           IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 12 chaves CORE sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE)
  -- + cobertura de custo (itens_com_custo/itens_sem_custo, jsonb_exists como gross_margin_pct).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = CASE WHEN u.tem_m_score          THEN u.m_score          ELSE f.m_score          END,
    g_score                  = u.g_score,
    gross_margin_pct         = CASE WHEN u.tem_gross_margin_pct THEN u.gross_margin_pct ELSE f.gross_margin_pct END,
    itens_com_custo          = CASE WHEN u.tem_itens_com_custo  THEN u.itens_com_custo  ELSE f.itens_com_custo  END,
    itens_sem_custo          = CASE WHEN u.tem_itens_sem_custo  THEN u.itens_sem_custo  ELSE f.itens_sem_custo  END,
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status),
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM (
    SELECT
      (e.elem->>'id')::uuid                          AS id,
      (e.elem->>'health_score')::numeric             AS health_score,
      (e.elem->>'health_class')                      AS health_class,
      (e.elem->>'churn_risk')::numeric               AS churn_risk,
      (e.elem->>'priority_score')::numeric           AS priority_score,
      (e.elem->>'rf_score')::numeric                 AS rf_score,
      (e.elem->>'m_score')::numeric                  AS m_score,
      (e.elem->>'g_score')::numeric                  AS g_score,
      (e.elem->>'gross_margin_pct')::numeric         AS gross_margin_pct,
      (e.elem->>'itens_com_custo')::bigint           AS itens_com_custo,
      (e.elem->>'itens_sem_custo')::bigint           AS itens_sem_custo,
      (e.elem->>'days_since_last_purchase')::integer AS days_since_last_purchase,
      (e.elem->>'avg_monthly_spend_180d')::numeric   AS avg_monthly_spend_180d,
      (e.elem->>'category_count')::integer           AS category_count,
      (e.elem->>'sales_history_status')              AS sales_history_status,
      (e.elem->>'calculated_at')::timestamptz        AS calculated_at,
      (e.elem->>'updated_at')::timestamptz           AS updated_at,
      -- jsonb_exists(), e não o operador ?, para não depender de como o parser trata ? em plpgsql.
      jsonb_exists(e.elem, 'm_score')                AS tem_m_score,
      jsonb_exists(e.elem, 'gross_margin_pct')       AS tem_gross_margin_pct,
      jsonb_exists(e.elem, 'itens_com_custo')        AS tem_itens_com_custo,
      jsonb_exists(e.elem, 'itens_sem_custo')        AS tem_itens_sem_custo
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;

COMMENT ON FUNCTION public.apply_score_updates(jsonb, text) IS
  'Aplica o lote de scores do calculate-scores (UPDATE-only por id, anti-ressurreicao). p_run_id e o '
  'FENCING TOKEN do lease: quando informado, a RPC so escreve se sync_state(calculate_scores/global) '
  'ainda estiver syncing com metadata->>run_id = p_run_id, validado sob FOR SHARE na MESMA transacao '
  'da escrita (55000 se perdeu o lease). p_run_id NULL = sem fencing, retrocompat exata com a edge '
  'antiga; string vazia e 22004, NAO bypass. Sem o parametro o lease e apenas cooperativo: protege '
  'inicio e fim, mas um run que perdeu o lease e continuou vivo ainda restauraria o snapshot velho.';

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 3) SEGURANÇA — obrigatória aqui, não opcional: o DROP levou os grants junto
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Nas 7 recriações anteriores o CREATE OR REPLACE PRESERVAVA os grants e o REVOKE/GRANT era defesa
-- para o cenário de DR. Aqui a função nasce NOVA (assinatura nova após o DROP), então o default do
-- Postgres — EXECUTE para PUBLIC — vale SEMPRE, inclusive na PROD. Omitir este bloco seria falha
-- ABERTA imediata, não hipotética. REVOKE por NOME: `FROM PUBLIC` não remove grant explícito de
-- anon/authenticated. SECURITY INVOKER (default, menor privilégio) mantido — a função é chamada só
-- pelo edge/service_role, que tem os privilégios necessários em farmer_client_scores e sync_state
-- (relacl de prod: service_role=arwdDxtm, o `w` é o que FOR SHARE exige).
REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb, text) TO service_role;

-- Recarrega o cache de schema do PostgREST (entregue no COMMIT). Enquanto o cache guarda a assinatura
-- antiga, a chamada COM p_run_id volta PGRST202 — e PGRST202 é exatamente o sinal que a edge lê como
-- "migration ainda não aplicada" (challenge Codex 2026-10-10, P1). Encurtar essa janela é o que torna
-- o fallback da edge seguro na prática; a edge ainda tenta de novo com o token antes de cair.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 4) Validação pós-apply (read-only) — cole junto e confira ANTES de publicar a edge
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- to_regprocedure devolve NULL se ausente em vez de levantar erro, e resolve tipo de verdade — não
-- compara texto com pg_get_function_identity_arguments, que inclui os NOMES dos parâmetros e nunca
-- casaria (lição #1488). `sobrecargas` TEM de ser 1: se vier 2, o DROP não pegou e toda chamada da
-- edge antiga passa a dar 42725.
SELECT 'MIGRATION apply_score_updates_fencing_lease OK' AS status,
  (to_regprocedure('public.apply_score_updates(jsonb, text)') IS NOT NULL) AS assinatura_nova_existe,
  (to_regprocedure('public.apply_score_updates(jsonb)')       IS NULL)     AS assinatura_antiga_sumiu,
  (SELECT count(*) FROM pg_proc WHERE proname = 'apply_score_updates')::int AS sobrecargas_deve_ser_1,
  has_function_privilege('service_role',  'public.apply_score_updates(jsonb, text)', 'EXECUTE') AS service_role_executa,
  has_function_privilege('anon',          'public.apply_score_updates(jsonb, text)', 'EXECUTE') AS anon_deve_ser_false,
  has_function_privilege('authenticated', 'public.apply_score_updates(jsonb, text)', 'EXECUTE') AS authenticated_deve_ser_false;
