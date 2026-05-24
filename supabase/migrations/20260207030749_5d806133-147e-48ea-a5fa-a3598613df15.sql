-- Remover constraint única em app_service_type
ALTER TABLE public.omie_servicos DROP CONSTRAINT unique_service_type;