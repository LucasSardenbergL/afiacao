-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Farmer — PERSISTIR a cobertura de custo por cliente (itens_com_custo / itens_sem_custo)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Motivação (análise 2026-07-22, docs/historico/farmer-margem-cobertura-custo.md): a margem de
-- `farmer_client_scores.gross_margin_pct` é NULL em 84% da base, e mesmo onde é conhecida cobre só
-- 58% da receita do cliente. Um número de margem SOZINHO não diz sobre QUANTOS itens ele foi apurado
-- — "53% sobre 3 de 40 itens" e "53% sobre 40 de 40" são confianças opostas. A RPC de margem
-- `get_customer_margin_summary()` JÁ retorna `itens_com_custo` e `itens_sem_custo` por cliente, mas o
-- writer `calculate-scores` os DESCARTA: extrai só `gross_margin_pct` do map e o UPDATE (via
-- apply_score_updates) nunca grava as duas contagens. Esta migration para de jogar fora o dado.
--
-- Escopo: 2 colunas nuláveis + estender apply_score_updates para transportá-las. NÃO recomputa
-- margem, NÃO cadastra custo, NÃO aplica janela temporal (decisão de produto — ver o doc). Aditivo.
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 1) Colunas de cobertura — nuláveis, SEM DEFAULT (de propósito)
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- bigint porque a origem é `count(*)` (bigint) de private.margem_cliente_agregada(). NULL = a
-- cobertura AINDA NÃO foi computada para este cliente (recém-semeado, ou cliente sem NENHUM item de
-- pedido elegível → ausente do resultado da RPC de margem). É distinto de 0, que é o veredito
-- "tem itens, nenhum com custo conhecido" (os 156 clientes da categoria D do doc). ausente≠zero: a
-- mesma regra money-path de gross_margin_pct/m_score. SEM DEFAULT para que OMITIR a coluna num
-- INSERT não fabrique 0 (foi o DEFAULT 0 de gross_margin_pct que criou o loop fechado do #1495).
ALTER TABLE public.farmer_client_scores
  ADD COLUMN IF NOT EXISTS itens_com_custo bigint,
  ADD COLUMN IF NOT EXISTS itens_sem_custo bigint;

COMMENT ON COLUMN public.farmer_client_scores.itens_com_custo IS
  'Qtd de LINHAS de item do cliente COMPUTAVEIS na margem (private.margem_cliente_agregada.itens_computaveis): '
  'custo conhecido E quantidade/preco validos. E a base sobre a qual gross_margin_pct foi apurado. '
  'NULL = cobertura nao computada (cliente sem item elegivel, ou RPC de margem falhou no run). '
  '0 = tem itens elegiveis, nenhum computavel. ausente<>zero. Sem DEFAULT de proposito.';

COMMENT ON COLUMN public.farmer_client_scores.itens_sem_custo IS
  'Qtd de LINHAS de item NAO computaveis (private.margem_cliente_agregada.itens_ignorados): sem custo conhecido '
  'OU com quantidade/preco invalidos — nao e estritamente "sem custo", o nome vem da RPC publica. '
  'itens_com_custo + itens_sem_custo = total de linhas elegiveis. ATENCAO ao ler na tela: e contagem de LINHAS, '
  'nao de unidades nem de receita, e a margem e ponderada por RECEITA — 3 de 40 linhas pode cobrir 99% do '
  'faturamento do cliente, e 39 de 40 pode omitir justamente a linha grande. NULL = nao computado. Sem DEFAULT.';

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2) apply_score_updates — transportar itens_com_custo / itens_sem_custo até a coluna
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Recriada a partir da versão em prod (20260723160000, conferida por pg_get_functiondef em
-- 2026-07-22 — idêntica ao repo, sem drift). ÚNICA mudança: as duas contagens entram no UPDATE com
-- EXATAMENTE o mesmo padrão jsonb_exists de gross_margin_pct/m_score. NÃO entram no guard das 12
-- chaves CORE (são nuláveis por semântica, como gross_margin_pct/m_score).
--
-- Semântica idêntica à de gross_margin_pct, nos três casos:
--   chave presente com número → grava o número (inclusive 0 = "tem itens, nenhum com custo")
--   chave presente com null   → grava NULL ("cliente sem item elegível neste run"; TEM de
--                               sobrescrever, senão a contagem velha sobrevive a um cliente que
--                               parou de ter pedido computável)
--   chave AUSENTE             → preserva o valor atual (no-op)
--
-- O terceiro caso é o que mantém seguras as DUAS ORDENS de deploy do Lovable (migration e edge são
-- publicações manuais independentes): a edge ANTIGA, que não envia estas chaves, vira no-op nestas
-- colunas em vez de zerá-las enquanto o founder não publica a edge nova. Espelha a lição do
-- 20260723160000 (um guard exigindo a chave transformaria a janela entre deploys em cron quebrado).
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
BEGIN
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

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 3) SEGURANÇA — repetida em TODO replace (padrão das 5 migrations anteriores desta função)
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE PRESERVA os grants num banco que JÁ tem a função (é o caso da PROD: proacl hoje
-- = postgres + service_role, conferido por psql-ro em 2026-07-22). Mas num restore/DR a função nasce
-- DESTE arquivo, e o default do Postgres é EXECUTE para PUBLIC — omitir isto seria falha ABERTA
-- silenciosa, a mesma classe do `WITH (security_invoker=on)` que o CLAUDE.md manda repetir sempre.
-- REVOKE por NOME: `FROM PUBLIC` não remove grant explícito de anon/authenticated.
-- SECURITY INVOKER (default, menor privilégio) mantido — a função é chamada só pelo edge/service_role.
REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO service_role;
