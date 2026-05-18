-- ============================================================
-- A1 — Eventos recorrentes e eventuais pro cashflow
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_eventos_recorrentes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria_dre   text CHECK (categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  is_folha        boolean NOT NULL DEFAULT false,
  dia_do_mes      integer NOT NULL CHECK (dia_do_mes BETWEEN 1 AND 31),
  inicio          date NOT NULL,
  fim             date,
  ativo           boolean NOT NULL DEFAULT true,
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_eventos_rec_company_ativo_idx
  ON fin_eventos_recorrentes (company, ativo);
CREATE INDEX IF NOT EXISTS fin_eventos_rec_categoria_idx
  ON fin_eventos_recorrentes (categoria_dre);

ALTER TABLE fin_eventos_recorrentes ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_eventos_rec_select_staff ON fin_eventos_recorrentes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_eventos_rec_write_staff ON fin_eventos_recorrentes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_eventos_recorrentes IS
  'Eventos que se repetem mensalmente (folha, aluguel, pró-labore, dividendo). Usados pra projetar cashflow 13s.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_eventos_eventuais (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria_dre   text CHECK (categoria_dre IS NULL OR categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  data_prevista   date NOT NULL,
  data_realizada  date,
  status          text NOT NULL CHECK (status IN ('previsto','confirmado','cancelado','realizado'))
                  DEFAULT 'previsto',
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_eventos_ev_company_data_idx
  ON fin_eventos_eventuais (company, data_prevista);
CREATE INDEX IF NOT EXISTS fin_eventos_ev_status_idx
  ON fin_eventos_eventuais (status, company);

ALTER TABLE fin_eventos_eventuais ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_eventos_ev_select_staff ON fin_eventos_eventuais
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_eventos_ev_write_staff ON fin_eventos_eventuais
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_eventos_eventuais IS
  'Eventos pontuais (aporte, compra de máquina, empréstimo). Status: previsto → confirmado → realizado (ou cancelado).';
