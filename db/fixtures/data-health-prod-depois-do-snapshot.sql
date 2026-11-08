-- Recorte de PROD posterior ao schema-snapshot (2026-10-15) que o trio do data_health LÊ, para a cadeia viva
-- (db/lib/data-health-vivo.sh) montar sobre o snapshot OU sobre os stubs. Só DDL idempotente; cada bloco cita a
-- migration de prod que o criou. Sem isto, uma migration do trio que lê objeto novo quebra TODAS as provas vizinhas.
--   20261108120000 (Onda 5A fatia 1): situação do portal no pedido.
--   20261110100000 (5.3): trilha de encerramento do cancelado no fornecedor.
--   espelho do Omie: colunas que a cobertura da 5.4 (20261110120000) lê.
DO $f$ BEGIN
  IF to_regclass('public.pedido_compra_sugerido') IS NOT NULL THEN
    ALTER TABLE public.pedido_compra_sugerido
      ADD COLUMN IF NOT EXISTS portal_situacao_codigo text, ADD COLUMN IF NOT EXISTS portal_situacao_texto text,
      ADD COLUMN IF NOT EXISTS portal_situacao_em timestamptz, ADD COLUMN IF NOT EXISTS portal_situacao_ate timestamptz,
      ADD COLUMN IF NOT EXISTS portal_situacao_protocolo text, ADD COLUMN IF NOT EXISTS portal_situacao_gravada_em timestamptz;
  END IF;
END $f$;
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, empresa text NOT NULL, status text, omie_codigo_pedido bigint
);
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS omie_codigo_integracao text, ADD COLUMN IF NOT EXISTS numero_contrato_fornecedor text,
  ADD COLUMN IF NOT EXISTS t2_data_faturamento timestamptz, ADD COLUMN IF NOT EXISTS encerrado_omie_em timestamptz;
CREATE TABLE IF NOT EXISTS public.sayerlack_encerramento_cancelado_portal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, pedido_id bigint NOT NULL, protocolo text NOT NULL,
  status_antes text NOT NULL, situacao_texto text NOT NULL, situacao_lida_de timestamptz NOT NULL,
  situacao_lida_ate timestamptz NOT NULL, prova_omie jsonb NOT NULL, espelho_sync_status text, espelho_sync_em timestamptz,
  ator uuid NOT NULL, justificativa text NOT NULL, execucao_id uuid, criado_em timestamptz NOT NULL DEFAULT now()
);
-- has_role/app_role: o snapshot tem; os stubs, não (a RLS da 5.4 os cita).
DO $f$ BEGIN CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $f$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
DO $f$ BEGIN
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    EXECUTE $c$CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
      'SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)'$c$;
  END IF;
END $f$;
