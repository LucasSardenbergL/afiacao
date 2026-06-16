-- ============================================================
-- fin_audit_trigger: não auditar escritas do sync do ERP (service_role).
--
-- O sync (omie-financeiro, service_role) é um MIRROR de alto volume: cada run
-- faz ~12k upserts em fin_contas_*/movimentacoes → ~12k inserts em fin_audit_log
-- por run, várias vezes/dia. Isso incha o audit-log e adiciona overhead. A
-- auditoria existe pra rastrear EDIÇÃO HUMANA via app, não o espelho do ERP.
--
-- Fix: pular o audit quando auth.role()='service_role' (mesmo critério do bypass
-- do period-lock). Edição humana (anon/authenticated) continua auditada.
--
-- Mantém o resto idêntico ao 20260524102500 (acesso JSON via v_rec).
-- Idempotente (CREATE OR REPLACE).
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
  -- Sync do ERP (service_role) é mirror de alto volume: não auditar.
  IF auth.role() = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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
