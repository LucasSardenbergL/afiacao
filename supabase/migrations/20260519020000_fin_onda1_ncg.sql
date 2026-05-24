-- ============================================================
-- Onda 1 — Correção do NCG
-- 1) fin_estoque_valor (histórico de valor de estoque por empresa)
-- 2) rename capital_giro_proprio -> liquidez_operacional_liquida
-- 3) RPC fin_estimar_estoque_omie (estimativa best-effort)
-- 4) estende fin_period_lock_trigger p/ fin_estoque_valor
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_estoque_valor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company       text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  valor         numeric(15,2) NOT NULL CHECK (valor >= 0),
  data_ref      date NOT NULL,
  fonte         text NOT NULL CHECK (fonte IN ('manual','omie_estimado')) DEFAULT 'manual',
  cobertura_pct numeric(5,2),
  observacao    text,
  criado_por    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_estoque_valor_company_data_idx
  ON fin_estoque_valor (company, data_ref DESC);

ALTER TABLE fin_estoque_valor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_estoque_valor_select_staff ON fin_estoque_valor;
CREATE POLICY fin_estoque_valor_select_staff ON fin_estoque_valor FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('employee','master'))
);
DROP POLICY IF EXISTS fin_estoque_valor_write_master ON fin_estoque_valor;
CREATE POLICY fin_estoque_valor_write_master ON fin_estoque_valor FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

-- Audit trigger (genérico da Fundação)
DROP TRIGGER IF EXISTS trg_audit ON fin_estoque_valor;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON fin_estoque_valor
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

-- Rename da coluna mal rotulada (preserva dados). Idempotente via guard.
DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='fin_projecao_snapshots' AND column_name='capital_giro_proprio'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='fin_projecao_snapshots' AND column_name='liquidez_operacional_liquida'
  ) THEN
    ALTER TABLE fin_projecao_snapshots
      RENAME COLUMN capital_giro_proprio TO liquidez_operacional_liquida;
  END IF;
END $rename$;

-- Estende a função de lock p/ cobrir fin_estoque_valor por data_ref.
-- (Recria a função inteira com o novo WHEN; mantém os casos existentes.)
CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
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
  IF v_bypass = 'true' THEN RETURN COALESCE(NEW, OLD); END IF;
  v_target_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company'
  );
  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'          THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'         THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date(COALESCE((NEW).ano,(OLD).ano), COALESCE((NEW).mes,(OLD).mes), 1)
    WHEN 'fin_eventos_recorrentes'   THEN COALESCE((NEW).inicio, (OLD).inicio)
    WHEN 'fin_eventos_eventuais'     THEN COALESCE((NEW).data_prevista, (OLD).data_prevista)
    WHEN 'fin_estoque_valor'         THEN COALESCE((NEW).data_ref, (OLD).data_ref)
  END;
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping','fin_eventos_recorrentes','fin_eventos_eventuais','fin_estoque_valor'
  ) THEN RETURN NEW; END IF;
  IF v_target_date IS NULL OR v_target_company IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT ano, mes INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos WHERE company = v_target_company AND status='fechado' AND aprovado_em IS NOT NULL
    ORDER BY ano DESC, mes DESC LIMIT 1;
  IF v_last_closed_year IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1) + interval '1 month - 1 day')::date;
  IF v_target_date > v_last_closed_date THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now() AND closed_at IS NULL AND opened_by = auth.uid()
  ) INTO v_has_override;
  IF v_has_override THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date), v_target_company, v_last_closed_date
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS trg_period_lock ON fin_estoque_valor;
CREATE TRIGGER trg_period_lock BEFORE UPDATE OR DELETE ON fin_estoque_valor
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

-- RPC estimativa de estoque via Omie (best-effort, retorna score de cobertura).
-- Junta sku_estoque_atual (qtd por empresa) a um custo por SKU.
-- A fonte de custo confiável por SKU é parcial → devolve cobertura_pct.
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
RETURNS TABLE (valor_estimado numeric, cobertura_pct numeric, skus_total int, skus_com_custo int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH est AS (
    SELECT s.sku_codigo_omie, s.estoque_fisico,
           pc.cost_price AS custo
      FROM sku_estoque_atual s
      LEFT JOIN product_costs pc ON pc.product_id::text = s.sku_codigo_omie
     WHERE s.empresa = p_company AND COALESCE(s.estoque_fisico,0) > 0
  )
  SELECT
    COALESCE(SUM(CASE WHEN custo > 0 THEN estoque_fisico * custo ELSE 0 END), 0) AS valor_estimado,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE custo > 0) / COUNT(*), 2) END AS cobertura_pct,
    COUNT(*)::int AS skus_total,
    COUNT(*) FILTER (WHERE custo > 0)::int AS skus_com_custo
  FROM est;
$$;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated, service_role;

SELECT 'Onda 1 NCG migration OK' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='fin_projecao_snapshots' AND column_name='liquidez_operacional_liquida') AS coluna_renomeada,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='fin_estoque_valor') AS tabela_estoque;
