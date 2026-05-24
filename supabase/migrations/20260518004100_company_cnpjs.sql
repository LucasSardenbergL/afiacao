CREATE TABLE IF NOT EXISTS company_cnpjs (
  company text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  cnpj    text NOT NULL,
  cnpj_normalized text GENERATED ALWAYS AS (regexp_replace(cnpj, '[^0-9]', '', 'g')) STORED,
  nome_fantasia text,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_cnpjs_normalized_idx ON company_cnpjs (cnpj_normalized);

ALTER TABLE company_cnpjs ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_cnpjs_select_authenticated ON company_cnpjs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY company_cnpjs_master_write ON company_cnpjs FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='master'));

COMMENT ON TABLE company_cnpjs IS 'CNPJs das empresas do grupo, usado por fin-ic-reconcile pra cruzar IC.';
