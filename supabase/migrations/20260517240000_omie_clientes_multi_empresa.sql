-- PR-CAPTURE-B: suporte multi-empresa em omie_clientes
-- Cada cliente pode ter N códigos Omie (1 por empresa do grupo Colacor: colacor / oben / colacor_sc).
-- Coluna default 'colacor' pra backward compat de rows antigas (presumidas Colacor).

ALTER TABLE public.omie_clientes
  ADD COLUMN IF NOT EXISTS empresa_omie text NOT NULL DEFAULT 'colacor'
    CHECK (empresa_omie IN ('colacor', 'oben', 'colacor_sc'));

-- Constraint composta: 1 código por (cliente, empresa)
-- Drop unique antiga em omie_codigo_cliente se existir (era global)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omie_clientes_omie_codigo_cliente_key'
  ) THEN
    ALTER TABLE public.omie_clientes DROP CONSTRAINT omie_clientes_omie_codigo_cliente_key;
  END IF;
END $$;

-- Nova unique: (omie_codigo_cliente, empresa_omie) — códigos podem repetir entre empresas
CREATE UNIQUE INDEX IF NOT EXISTS idx_omie_clientes_codigo_empresa
  ON public.omie_clientes (omie_codigo_cliente, empresa_omie);

-- Index pra lookup rápido por (user, empresa)
CREATE UNIQUE INDEX IF NOT EXISTS idx_omie_clientes_user_empresa
  ON public.omie_clientes (user_id, empresa_omie);

COMMENT ON COLUMN public.omie_clientes.empresa_omie IS
  'Qual empresa do grupo Colacor: colacor (principal) | oben (distribuição) | colacor_sc (serviços). Cada user_id pode ter 1 código por empresa.';
