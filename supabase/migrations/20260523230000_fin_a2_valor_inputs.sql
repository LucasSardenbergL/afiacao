-- supabase/migrations/20260523230000_fin_a2_valor_inputs.sql
-- A2 — Retorno & Valor: inputs manuais por empresa (ativo fixo, dívida, PL, Ke decomposto + cenários,
-- Kd, pró-labore real/mercado, aluguel de mercado, intercompany). Coluna OPCIONAL: o engine lê
-- defensivamente (?? {}) — sem ela, tudo degrada (só NOPAT + margem + capital de giro computados).

ALTER TABLE fin_config_cashflow
  ADD COLUMN IF NOT EXISTS valor_inputs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fin_config_cashflow.valor_inputs IS
  'A2: { ativo_fixo:{valor,data_ref,fonte,base,operacional}, ajustes, divida, equity, kd, ke:{conservador,base,agressivo}, prolabore_real_mensal, prolabore_mercado_mensal, aluguel_mercado_mensal, intercompany_giro }';

-- Validação
SELECT 'A2 valor_inputs OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='fin_config_cashflow' AND column_name='valor_inputs') AS coluna_existe;
