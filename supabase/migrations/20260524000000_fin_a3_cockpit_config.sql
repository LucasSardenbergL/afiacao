-- supabase/migrations/20260524000000_fin_a3_cockpit_config.sql
-- A3 — Cockpit de Valor: limiares operacionais (política comercial, NÃO dado do dono).
-- Coluna OPCIONAL em fin_config_cashflow (legível por staff/gestor é OK). Engine lê defensivo.

ALTER TABLE fin_config_cashflow
  ADD COLUMN IF NOT EXISTS cockpit_config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fin_config_cashflow.cockpit_config IS
  'A3: { margem_minima_pct, desconto_max_pct, prazo_alvo_dias, dias_estoque_max, sample_min_receita }';

SELECT 'A3 cockpit_config OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='fin_config_cashflow' AND column_name='cockpit_config') AS coluna_existe;
