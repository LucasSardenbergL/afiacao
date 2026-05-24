CREATE TABLE IF NOT EXISTS fin_ic_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem  text NOT NULL CHECK (empresa_origem IN ('oben','colacor','colacor_sc')),
  empresa_destino text NOT NULL CHECK (empresa_destino IN ('oben','colacor','colacor_sc')),
  cr_id           uuid REFERENCES fin_contas_receber(id) ON DELETE SET NULL,
  cp_id           uuid REFERENCES fin_contas_pagar(id) ON DELETE SET NULL,
  valor_origem    numeric(15,2),
  valor_destino   numeric(15,2),
  diff_valor      numeric(15,2) GENERATED ALWAYS AS (COALESCE(valor_origem,0) - COALESCE(valor_destino,0)) STORED,
  diff_dias       integer,
  status          text NOT NULL CHECK (status IN (
    'auto_matched','manual_matched',
    'divergencia_valor','divergencia_data',
    'sem_contrapartida','duplicidade_possivel',
    'desconsiderado'
  )),
  matched_at      timestamptz NOT NULL DEFAULT now(),
  resolvido_por   uuid REFERENCES auth.users(id),
  resolvido_em    timestamptz,
  observacao      text,
  CHECK (empresa_origem <> empresa_destino),
  CHECK (cr_id IS NOT NULL OR cp_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fin_ic_matches_status_idx ON fin_ic_matches (status, matched_at DESC);
CREATE INDEX IF NOT EXISTS fin_ic_matches_cr_idx ON fin_ic_matches (cr_id) WHERE cr_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_ic_matches_cp_idx ON fin_ic_matches (cp_id) WHERE cp_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_ic_matches_cr_unique ON fin_ic_matches (cr_id) WHERE cr_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_ic_matches_cp_unique ON fin_ic_matches (cp_id) WHERE cp_id IS NOT NULL;

ALTER TABLE fin_ic_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_ic_matches_select_staff ON fin_ic_matches
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('employee','master'))
  );

CREATE POLICY fin_ic_matches_update_staff ON fin_ic_matches
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('employee','master'))
  );
