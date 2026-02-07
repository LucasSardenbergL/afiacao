-- Adicionar coluna para controlar status do serviço
ALTER TABLE public.omie_servicos 
ADD COLUMN IF NOT EXISTS inativo boolean NOT NULL DEFAULT false;

-- Adicionar coluna para data de última atualização
ALTER TABLE public.omie_servicos 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();