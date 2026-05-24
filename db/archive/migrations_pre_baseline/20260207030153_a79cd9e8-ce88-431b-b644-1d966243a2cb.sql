-- Adicionar coluna para armazenar o código do vendedor do Omie
ALTER TABLE public.omie_clientes 
ADD COLUMN IF NOT EXISTS omie_codigo_vendedor bigint;