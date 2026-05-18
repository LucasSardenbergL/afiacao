-- Phase 3: DRE Competência — fin_fechamentos dual snapshot tracking
-- Added columns to hold both caixa and competencia DRE snapshots frozen at closure time

ALTER TABLE fin_fechamentos
  ADD COLUMN IF NOT EXISTS snapshot_dre_caixa_id uuid REFERENCES fin_dre_snapshots(id),
  ADD COLUMN IF NOT EXISTS snapshot_dre_competencia_id uuid REFERENCES fin_dre_snapshots(id);

-- Backfill: existing snapshot_dre_id becomes snapshot_dre_caixa_id
UPDATE fin_fechamentos
   SET snapshot_dre_caixa_id = snapshot_dre_id
 WHERE snapshot_dre_caixa_id IS NULL
   AND snapshot_dre_id IS NOT NULL;

COMMENT ON COLUMN fin_fechamentos.snapshot_dre_caixa_id IS
  'Snapshot DRE regime caixa congelado no momento do fechamento.';

COMMENT ON COLUMN fin_fechamentos.snapshot_dre_competencia_id IS
  'Snapshot DRE regime competência congelado. NULL para fechamentos pré-migration.';
