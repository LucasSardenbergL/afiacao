-- Phase 3: DRE Competência — fin_dre_snapshots unique constraint includes regime
-- Previously: unique(company, ano, mes) blocked dual snapshots per month
-- Now: unique(company, ano, mes, regime) allows caixa + competencia snapshots to coexist

ALTER TABLE fin_dre_snapshots DROP CONSTRAINT IF EXISTS fin_dre_snapshots_company_ano_mes_key;

ALTER TABLE fin_dre_snapshots
  ADD CONSTRAINT fin_dre_snapshots_company_ano_mes_regime_key
  UNIQUE (company, ano, mes, regime);

-- Guarantee existing records have regime explicitly set
UPDATE fin_dre_snapshots SET regime = 'caixa' WHERE regime IS NULL;

ALTER TABLE fin_dre_snapshots ALTER COLUMN regime SET NOT NULL;
