
CREATE OR REPLACE FUNCTION public.fin_projecao_13_semanas(p_company text DEFAULT NULL::text, p_saldo_inicial numeric DEFAULT NULL::numeric)
 RETURNS TABLE(semana_inicio date, semana_fim date, semana_label text, entradas_previstas numeric, saidas_previstas numeric, fluxo_liquido numeric, saldo_projetado numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_saldo numeric;
  v_week_start date;
  v_week_end date;
BEGIN
  IF p_saldo_inicial IS NOT NULL THEN
    v_saldo := p_saldo_inicial;
  ELSE
    IF p_company IS NOT NULL THEN
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo
      FROM fin_contas_correntes WHERE company = p_company AND ativo;
    ELSE
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo
      FROM fin_contas_correntes WHERE ativo;
    END IF;
  END IF;

  FOR i IN 0..12 LOOP
    v_week_start := date_trunc('week', CURRENT_DATE)::date + (i * 7);
    v_week_end := v_week_start + 6;

    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_recebido, 0)), 0) INTO entradas_previstas
    FROM fin_contas_receber
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');

    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_pago, 0)), 0) INTO saidas_previstas
    FROM fin_contas_pagar
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');

    fluxo_liquido := entradas_previstas - saidas_previstas;
    v_saldo := v_saldo + fluxo_liquido;

    semana_inicio := v_week_start;
    semana_fim := v_week_end;
    semana_label := to_char(v_week_start, 'DD/MM') || '-' || to_char(v_week_end, 'DD/MM');
    saldo_projetado := v_saldo;

    RETURN NEXT;
  END LOOP;
END;
$$;
