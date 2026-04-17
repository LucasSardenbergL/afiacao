-- Adiciona flag para clientes que exigem ordem de compra
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS requires_po BOOLEAN NOT NULL DEFAULT false;

-- Marca o cliente CNPJ 64422892000100 como exigente de OC
UPDATE public.profiles
SET requires_po = true
WHERE REGEXP_REPLACE(COALESCE(document, ''), '\D', '', 'g') = '64422892000100';