-- ============================================================
-- A1 — Audit + Period Lock attach nas 4 tabelas que precisam
-- ============================================================

-- Audit: aplicado em todas as 4 tabelas auditáveis
DROP TRIGGER IF EXISTS trg_audit ON fin_eventos_recorrentes;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eventos_recorrentes
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_eventos_eventuais;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eventos_eventuais
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_alertas;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_alertas
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_config_cashflow;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_config_cashflow
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

-- ============================================================
-- Estender fin_period_lock_trigger pra cobrir as 2 novas tabelas
-- (mantém os casos existentes da Fundação Phase 2 intactos)
-- ============================================================

CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_date date;
  v_target_company text;
  v_last_closed_year int;
  v_last_closed_month int;
  v_last_closed_date date;
  v_has_override boolean;
  v_bypass text := current_setting('fin.bypass_lock', true);
BEGIN
  IF v_bypass = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_target_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company'
  );

  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'          THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'         THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
    -- A1: novos casos
    WHEN 'fin_eventos_recorrentes'   THEN COALESCE((NEW).inicio, (OLD).inicio)
    WHEN 'fin_eventos_eventuais'     THEN COALESCE((NEW).data_prevista, (OLD).data_prevista)
  END;

  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping',
    'fin_eventos_recorrentes',
    'fin_eventos_eventuais'
  ) THEN
    RETURN NEW;
  END IF;

  IF v_target_date IS NULL OR v_target_company IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company
     AND status = 'fechado'
     AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now()
       AND closed_at IS NULL
       AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date),
    v_target_company,
    v_last_closed_date
    USING ERRCODE = 'P0001';
END $$;

-- Anexar trigger nas 2 tabelas novas (BEFORE UPDATE/DELETE só)
DROP TRIGGER IF EXISTS trg_period_lock ON fin_eventos_recorrentes;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_eventos_recorrentes
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_eventos_eventuais;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_eventos_eventuais
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();
