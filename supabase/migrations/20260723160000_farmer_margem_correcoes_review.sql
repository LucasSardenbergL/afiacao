-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FU4-F fase 3 — correções de review sobre 20260723150000_farmer_margem_server_side.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Migration SEPARADA (e não edição da 150000) porque o snapshot supabase/migrations/ é a fonte de
-- DR e o apply é manual: arquivo já commitado é imutável. APLICAR AS DUAS, NESTA ORDEM — a 150000
-- cria get_customer_margin_summary, esta refina apply_score_updates e o schema. Verificado por
-- psql-ro em 2026-07-21: a 150000 ainda NÃO estava aplicada em produção quando isto foi escrito.
--
-- Origem: revisão adversarial (Codex gpt-5.6-sol, xhigh) do PR #1495 + medição em prod.
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 1) DROP DEFAULT em gross_margin_pct e m_score
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- As colunas são NULLABLE mas carregam DEFAULT 0 — então OMITIR a coluna num INSERT não deixa a
-- linha "sem margem", deixa com margem ZERO. Isso não é hipotético: o trigger
-- reconcile_score_owner_from_carteira faz
--     INSERT INTO farmer_client_scores (customer_user_id, farmer_id) VALUES (...)
-- e portanto CRIA, a cada mudança de carteira, uma linha afirmando margem 0% para um cliente que
-- nunca foi medido. É o mesmo defeito que este PR remove no seed da edge, por outro caminho — e
-- fechar só um dos dois deixaria a fabricação viva.
--
-- Com o default removido: quem quer gravar 0 grava 0 explicitamente; quem omite passa a dizer "não
-- sei" (NULL), que é a verdade. Só estas duas colunas mudam — os demais scores seguem com DEFAULT
-- 0 (são de outros componentes, fora do escopo deste PR).
ALTER TABLE public.farmer_client_scores ALTER COLUMN gross_margin_pct DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN m_score          DROP DEFAULT;

COMMENT ON COLUMN public.farmer_client_scores.gross_margin_pct IS
  'Margem bruta % do cliente, calculada no SERVIDOR por get_customer_margin_summary. '
  'NULL = nao medida (nenhum item com custo conhecido, ou RPC de margem falhou no run). '
  'ausente<>zero: 0 aqui significa "margem zero apurada", nunca "nao sei". Sem DEFAULT de proposito.';

COMMENT ON COLUMN public.farmer_client_scores.m_score IS
  'Componente de margem do health score (0-100), derivado de gross_margin_pct. '
  'NULL quando a margem e desconhecida — nesse caso o peso do componente e redistribuido entre os '
  'demais em vez de contribuir 0. Sem DEFAULT de proposito.';

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2) apply_score_updates — distinguir CHAVE AUSENTE de chave presente com null
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- jsonb_to_recordset colapsa os dois casos no MESMO SQL NULL. Para as 12 chaves CORE isso é
-- indiferente (ambos inválidos, o guard barra). Mas gross_margin_pct e m_score são legitimamente
-- NULÁVEIS e ficaram FORA do guard — então, com o recordset, um typo no nome da chave na edge
-- ('m_scor') NULLaria a coluna inteira em produção sem erro nenhum, e o próximo run leria de volta
-- esse NULL. jsonb_exists() recupera exatamente a informação que o recordset perde.
--
-- Semântica resultante, nos três casos:
--   chave presente com número → grava o número
--   chave presente com null   → grava NULL ("medi e não sei"; TEM de sobrescrever o valor velho,
--                               senão o score guarda uma margem que já não se sustenta)
--   chave AUSENTE             → preserva o valor atual (no-op)
--
-- O terceiro caso é o que mantém seguras as DUAS ordens de deploy do Lovable (migration e edge são
-- publicações independentes e manuais): a edge ANTIGA, que não conhece gross_margin_pct, vira no-op
-- nessas colunas em vez de zerar a base enquanto o founder não publica a edge nova. Um guard exigindo
-- a chave — a correção "óbvia" — transformaria a janela entre os dois deploys em cron 100% quebrado.
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
  -- sales_history_status, gross_margin_pct e m_score NÃO entram (nuláveis por semântica).
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

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = CASE WHEN u.tem_m_score          THEN u.m_score          ELSE f.m_score          END,
    g_score                  = u.g_score,
    gross_margin_pct         = CASE WHEN u.tem_gross_margin_pct THEN u.gross_margin_pct ELSE f.gross_margin_pct END,
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
      (e.elem->>'days_since_last_purchase')::integer AS days_since_last_purchase,
      (e.elem->>'avg_monthly_spend_180d')::numeric   AS avg_monthly_spend_180d,
      (e.elem->>'category_count')::integer           AS category_count,
      (e.elem->>'sales_history_status')              AS sales_history_status,
      (e.elem->>'calculated_at')::timestamptz        AS calculated_at,
      (e.elem->>'updated_at')::timestamptz           AS updated_at,
      -- jsonb_exists(), e não o operador ?, para não depender de como o parser trata ? em plpgsql.
      jsonb_exists(e.elem, 'm_score')                AS tem_m_score,
      jsonb_exists(e.elem, 'gross_margin_pct')       AS tem_gross_margin_pct
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- NÃO INCLUÍDO DE PROPÓSITO: desconto no cálculo da margem
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- A revisão pediu para descontar order_items.discount da receita. NÃO foi feito, e a razão não é
-- "o impacto é pequeno" — é que a semântica da coluna está AMBÍGUA e aplicá-la seria escolher no
-- cara-ou-coroa. Medido em 2026-07-21:
--   · discount = 0 em 68.459 de 68.459 linhas (min 0, max 0); margem com e sem desconto: 53,47%
--   · omie-vendas-sync grava `prod.desconto`, mas a API do Omie expõe `valor_desconto` — nome que
--     omie-financeiro usa corretamente. A coluna é um campo MORTO por erro de nome na ingestão.
--   · e os dois consumidores em produção leem a mesma coluna de formas INCOMPATÍVEIS:
--       src/lib/custos/auditoria-margem.ts:46      → up * (1 - discount/100)   [percentual]
--       supabase/functions/fin-valor-cockpit:505   → unit_price*qty - discount [valor absoluto]
-- Não há dado para desempatar (tudo é zero) e as duas leituras não podem estar ambas certas. Fixar
-- uma delas aqui plantaria um erro silencioso que só apareceria no dia em que o sync começasse a
-- popular a coluna. Fica como trabalho próprio: corrigir a ingestão e unificar a semântica primeiro.
