-- Adicionar constraint única no omie_codigo_servico para evitar duplicatas
ALTER TABLE public.omie_servicos ADD CONSTRAINT unique_omie_codigo_servico UNIQUE (omie_codigo_servico);