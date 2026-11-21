-- Predecessores VERBATIM da PROD (psql-ro pg_get_functiondef, 2026-11-21) para db/test-churn-risk-nulo-sem-historico.sh.
-- md5(prosrc): apply_score_updates cfed7452509290eede629acc01619c62 · enqueue_visit_... f863be30b7a6a6c8d3ad4d6ab3d4cce2

CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
  v_sem_prioridade int;
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

  -- GUARD DE CONTRATO (full-update only): as 11 chaves CORE são obrigatórias e NÃO-NULAS em TODA linha.
  -- Aqui jsonb_to_recordset basta: ausente e null são AMBOS inválidos, então colapsá-los é correto.
  -- sales_history_status, gross_margin_pct, m_score, itens_com_custo, itens_sem_custo e
  -- avg_repurchase_interval NÃO entram (nuláveis por semântica). priority_score também saiu daqui
  -- (migration 20261120210000): NULL é o valor CERTO de quem nunca comprou — o guard dele é o de baixo.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
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
    AND rf_score                 IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 11 chaves CORE sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- priority_score: a CHAVE é obrigatória, o VALOR pode ser NULL. jsonb_exists distingue os dois — o
  -- recordset acima não distinguiria (ausente e null viram o mesmo NULL). Chave ausente = writer que não
  -- sabe da regra; aceitá-la gravaria NULL por omissão e apagaria a prioridade de um comprador.
  SELECT count(*) INTO v_sem_prioridade
  FROM jsonb_array_elements(p_updates) AS e(elem)
  WHERE NOT jsonb_exists(e.elem, 'priority_score');

  IF v_sem_prioridade > 0 THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) sem a chave priority_score (null explicito e aceito; chave ausente nao)',
      v_sem_prioridade, v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE)
  -- + cobertura de custo (itens_com_custo/itens_sem_custo, jsonb_exists como gross_margin_pct).
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    -- SEM COALESCE: a chave está garantida pelo guard acima, então NULL aqui é deliberado ("sem histórico,
    -- prioridade não se aplica") e tem de sobrescrever o número velho.
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = CASE WHEN u.tem_m_score          THEN u.m_score          ELSE f.m_score          END,
    g_score                  = u.g_score,
    gross_margin_pct         = CASE WHEN u.tem_gross_margin_pct THEN u.gross_margin_pct ELSE f.gross_margin_pct END,
    itens_com_custo          = CASE WHEN u.tem_itens_com_custo  THEN u.itens_com_custo  ELSE f.itens_com_custo  END,
    itens_sem_custo          = CASE WHEN u.tem_itens_sem_custo  THEN u.itens_sem_custo  ELSE f.itens_sem_custo  END,
    -- Intervalo de recompra medido (Venda por cliente, 1a): chave presente grava (NULL inclusive —
    -- "< 3 dias de pedido", nunca 0/30); ausente (edge anterior) preserva.
    avg_repurchase_interval  = CASE WHEN u.tem_avg_repurchase_interval THEN u.avg_repurchase_interval ELSE f.avg_repurchase_interval END,
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
      (e.elem->>'avg_repurchase_interval')::numeric  AS avg_repurchase_interval,
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
      jsonb_exists(e.elem, 'itens_sem_custo')        AS tem_itens_sem_custo,
      jsonb_exists(e.elem, 'avg_repurchase_interval') AS tem_avg_repurchase_interval
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $function$
;

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prioridade_mudou boolean;
BEGIN
  -- A prioridade que vira NULL numa linha que ERA e CONTINUA sem_historico não é mudança de insumo de
  -- visita: é a correção do 67 fabricado (migration 20261120210000). Enfileirá-la entupiria a fila com os
  -- ~15.765 sem histórico (500/noite de dreno). IS NOT DISTINCT FROM: status NULL não casa, e o resultado
  -- nunca é NULL (um NULL aqui faria o OR abaixo depender dos outros termos por acidente).
  v_prioridade_mudou := NEW.priority_score IS DISTINCT FROM OLD.priority_score
    AND NOT (NEW.priority_score IS NULL
             AND OLD.sales_history_status IS NOT DISTINCT FROM 'sem_historico'
             AND NEW.sales_history_status IS NOT DISTINCT FROM 'sem_historico');

  IF (v_prioridade_mudou
      OR NEW.churn_risk      IS DISTINCT FROM OLD.churn_risk
      OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score
      OR NEW.signal_modifiers IS DISTINCT FROM OLD.signal_modifiers)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$
;
