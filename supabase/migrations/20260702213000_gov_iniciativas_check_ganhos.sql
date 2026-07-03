-- ============================================================
-- gov_iniciativas — CHECK de domínio nos ganhos (achado Codex P2 do PR do Painel Iceberg)
-- O form (zod) já barra valor negativo, mas escrita direta via PostgREST não
-- passaria por ele — sem o CHECK, um ganho negativo distorceria as somas do
-- iceberg silenciosamente. NULL continua permitido (ausente ≠ zero).
-- Padrão idempotente por nome em pg_constraint (nunca DROP+ADD — house style).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gov_iniciativas_ganho_esperado_nao_negativo'
      AND conrelid = 'public.gov_iniciativas'::regclass
  ) THEN
    ALTER TABLE public.gov_iniciativas
      ADD CONSTRAINT gov_iniciativas_ganho_esperado_nao_negativo
      CHECK (ganho_esperado_mensal IS NULL OR ganho_esperado_mensal >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gov_iniciativas_ganho_recorrente_nao_negativo'
      AND conrelid = 'public.gov_iniciativas'::regclass
  ) THEN
    ALTER TABLE public.gov_iniciativas
      ADD CONSTRAINT gov_iniciativas_ganho_recorrente_nao_negativo
      CHECK (ganho_recorrente_mensal IS NULL OR ganho_recorrente_mensal >= 0);
  END IF;
END $$;
