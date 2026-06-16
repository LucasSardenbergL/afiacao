-- ============================================================
-- Conserta o bug que travava a gravação de contas_pagar/receber.
--
-- fin_audit_trigger e fin_period_lock_trigger são triggers GENÉRICOS (uma
-- função pra várias tabelas). O CASE de data fazia acesso DIRETO à coluna —
-- (NEW).data_movimento — que só existe em fin_movimentacoes. Em
-- fin_contas_pagar/receber o Postgres quebra com
-- 'column "data_movimento" not found in data type fin_contas_pagar' e a
-- gravação inteira falha. Por isso AP/AR gravavam 0 desde que esses triggers
-- foram criados (meados de maio); só apareceu agora que o sync voltou a rodar.
--
-- Fix: acessar a data via JSON ((rec->>'col')::date), que devolve NULL pra
-- coluna ausente em vez de quebrar — mesmo padrão que os triggers já usam pra
-- 'company'. Computo o registro como jsonb uma vez (v_rec) e leio dele.
--
-- Também SUPERSEDE 20260524101500 (que recriou o period-lock a partir de uma
-- versão antiga e derrubou os casos fin_eventos_recorrentes/eventuais/
-- estoque_valor). Aqui restauro esses casos E mantenho o bypass do sync.
--
-- Idempotente (CREATE OR REPLACE). Triggers já apontam pra estas funções.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fin_audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_origem  text := COALESCE(current_setting('fin.origem', true), 'manual');
  v_justif  text := current_setting('fin.override_justificativa', true);
  v_period  date;
  v_row_id  text;
  v_company text;
  v_rec     jsonb := CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(key, jsonb_build_object('before', o_val, 'after', n_val))
      INTO v_changed
      FROM (
        SELECT o.key, o.value AS o_val, n.value AS n_val
          FROM jsonb_each(to_jsonb(OLD)) o
          JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
         WHERE o.value IS DISTINCT FROM n.value
      ) diffs;
    IF v_changed IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_changed := to_jsonb(NEW);
  ELSE
    v_changed := to_jsonb(OLD);
  END IF;

  v_row_id  := COALESCE(v_rec->>'id', 'unknown');
  v_company := COALESCE(v_rec->>'company', v_rec->>'empresa_origem');

  -- Acesso via JSON: tolera coluna ausente (NULL) em vez de quebrar a gravação.
  v_period := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'           THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_contas_pagar'             THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_movimentacoes'            THEN (v_rec->>'data_movimento')::date
    WHEN 'fin_categoria_dre_mapping'    THEN current_date
    WHEN 'fin_orcamento'                THEN make_date((v_rec->>'ano')::int, (v_rec->>'mes')::int, 1)
    WHEN 'fin_fechamentos'              THEN make_date((v_rec->>'ano')::int, (v_rec->>'mes')::int, 1)
    WHEN 'fin_eliminacoes_intercompany' THEN current_date
    ELSE current_date
  END;

  INSERT INTO fin_audit_log (
    table_name, row_id, op, changed_fields,
    changed_by, company, origem, period_ref, override_justificativa
  ) VALUES (
    TG_TABLE_NAME, v_row_id, TG_OP, v_changed,
    auth.uid(), v_company, v_origem, v_period, v_justif
  );

  RETURN COALESCE(NEW, OLD);
END $function$;

CREATE OR REPLACE FUNCTION public.fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_target_date date;
  v_target_company text;
  v_last_closed_year int;
  v_last_closed_month int;
  v_last_closed_date date;
  v_has_override boolean;
  v_bypass text := current_setting('fin.bypass_lock', true);
  v_rec jsonb := CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  IF v_bypass = 'true' THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Sync do ERP / automação backend (service_role) espelha a verdade do Omie.
  -- A trava é pra edição humana via app, não pro mirror.
  IF auth.role() = 'service_role' THEN RETURN COALESCE(NEW, OLD); END IF;

  v_target_company := v_rec->>'company';

  -- Acesso via JSON: tolera coluna ausente (NULL) em vez de quebrar a gravação.
  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_contas_pagar'          THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_movimentacoes'         THEN (v_rec->>'data_movimento')::date
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date((v_rec->>'ano')::int, (v_rec->>'mes')::int, 1)
    WHEN 'fin_eventos_recorrentes'   THEN (v_rec->>'inicio')::date
    WHEN 'fin_eventos_eventuais'     THEN (v_rec->>'data_prevista')::date
    WHEN 'fin_estoque_valor'         THEN (v_rec->>'data_ref')::date
  END;

  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping','fin_eventos_recorrentes','fin_eventos_eventuais','fin_estoque_valor'
  ) THEN RETURN NEW; END IF;

  IF v_target_date IS NULL OR v_target_company IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company AND status = 'fechado' AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now()
       AND closed_at IS NULL
       AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN RETURN COALESCE(NEW, OLD); END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date),
    v_target_company,
    v_last_closed_date
    USING ERRCODE = 'P0001';
END $function$;
