-- ============================================================
-- Função genérica de audit trigger
-- ============================================================

CREATE OR REPLACE FUNCTION fin_audit_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_origem  text  := COALESCE(current_setting('fin.origem', true), 'manual');
  v_justif  text  := current_setting('fin.override_justificativa', true);
  v_period  date;
  v_row_id  text;
  v_company text;
BEGIN
  -- Diff de campos modificados (UPDATE)
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(
      key,
      jsonb_build_object('before', o_val, 'after', n_val)
    )
    INTO v_changed
    FROM (
      SELECT o.key,
             o.value AS o_val,
             n.value AS n_val
        FROM jsonb_each(to_jsonb(OLD)) o
        JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
       WHERE o.value IS DISTINCT FROM n.value
    ) diffs;
    IF v_changed IS NULL THEN
      -- UPDATE sem mudança real (raro mas possível) — não loga
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_changed := to_jsonb(NEW);
  ELSE -- DELETE
    v_changed := to_jsonb(OLD);
  END IF;

  -- row_id como text (suporta uuid, bigint, etc.)
  v_row_id := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'id',
    'unknown'
  );

  -- company: as tabelas financeiras usam 'company'; eliminações usam 'empresa_origem'
  v_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company',
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'empresa_origem'
  );

  -- period_ref: data-chave por tabela
  v_period := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'         THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'           THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'          THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping'  THEN current_date
    WHEN 'fin_orcamento'              THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
    WHEN 'fin_fechamentos'            THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
    WHEN 'fin_eliminacoes_intercompany' THEN current_date
    ELSE current_date
  END;

  INSERT INTO fin_audit_log (
    table_name, row_id, op, changed_fields,
    changed_by, company, origem, period_ref, override_justificativa
  ) VALUES (
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    v_changed,
    auth.uid(),
    v_company,
    v_origem,
    v_period,
    v_justif
  );

  RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION fin_audit_trigger() IS
  'Trigger genérico de auditoria do módulo financeiro. Lê fin.origem e fin.override_justificativa do contexto da sessão.';
