-- ============================================================
-- Trigger de travamento: rejeita mutações em período fechado.
-- Bypass: override ativo (15 min, master) OU GUC fin.bypass_lock = 'true'.
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
  -- Bypass explícito de migração/seed: rota administrativa só.
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
    WHEN 'fin_categoria_dre_mapping' THEN current_date  -- mapping novo é current_date, sempre passa
    WHEN 'fin_orcamento'             THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
  END;

  -- INSERT em mapping (criar novo) sempre passa
  IF TG_TABLE_NAME = 'fin_categoria_dre_mapping' AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Sem data ou sem company: deixa passar (não temos como bloquear)
  IF v_target_date IS NULL OR v_target_company IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Último fechamento aprovado
  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company
     AND status = 'fechado'
     AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN
    RETURN COALESCE(NEW, OLD);  -- nenhuma aprovação ainda, libera
  END IF;

  -- último fechamento cobre até o último dia do mês
  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN
    RETURN COALESCE(NEW, OLD);  -- período aberto, libera
  END IF;

  -- Período fechado → checa override ativo do usuário atual
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

COMMENT ON FUNCTION fin_period_lock_trigger() IS
  'Trigger BEFORE de travamento de período. Bypass: override ativo (master) OU fin.bypass_lock=true.';
