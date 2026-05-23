-- Central de Telefonia: ledger telefônico (separado de farmer_calls/coaching)
-- Enums
DO $$ BEGIN
  CREATE TYPE public.call_direction AS ENUM ('inbound','outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.call_status AS ENUM ('ringing','answered','missed','rejected','busy','failed','canceled','ended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tabela
CREATE TABLE IF NOT EXISTS public.call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  direction public.call_direction NOT NULL,
  status public.call_status NOT NULL DEFAULT 'ringing',
  provider text NOT NULL CHECK (provider IN ('nvoip_click_to_call','nvoip_sip','manual')),
  provider_call_id text,
  sip_call_id text,
  customer_user_id uuid,
  matched_contact_id uuid,
  match_confidence text CHECK (match_confidence IS NULL OR match_confidence IN ('exact','last8','none')),
  display_name text,
  phone_normalized text,
  phone_raw text,
  caller_id_used text,
  recorded boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','cdr','webhook','backfill')),
  source_payload jsonb,
  last_synced_at timestamptz,
  farmer_call_id uuid REFERENCES public.farmer_calls(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup idempotente. Índices NÃO-parciais: NULLs continuam distintos em unique index
-- do Postgres (várias linhas NULL permitidas — mesmo efeito), mas agora o ON CONFLICT
-- do PostgREST (sem predicado) bate no índice e o upsert funciona (evita erro 42P10).
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_log_provider_call_id
  ON public.call_log (provider, provider_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_log_sip_call_id
  ON public.call_log (provider, sip_call_id);

-- Listagem do histórico
CREATE INDEX IF NOT EXISTS idx_call_log_farmer_started
  ON public.call_log (farmer_id, started_at DESC);
-- Badge de perdidas não-lidas
CREATE INDEX IF NOT EXISTS idx_call_log_missed_unack
  ON public.call_log (farmer_id)
  WHERE direction = 'inbound' AND status = 'missed' AND acknowledged_at IS NULL;

-- RLS
ALTER TABLE public.call_log ENABLE ROW LEVEL SECURITY;

-- Próprio: lê/escreve/atualiza as próprias
CREATE POLICY "call_log own select" ON public.call_log FOR SELECT
  USING (farmer_id = auth.uid());
CREATE POLICY "call_log own insert" ON public.call_log FOR INSERT
  WITH CHECK (farmer_id = auth.uid());
CREATE POLICY "call_log own update" ON public.call_log FOR UPDATE
  USING (farmer_id = auth.uid());

-- Time: gestor/estratégico/super_admin (commercial_roles) ou master (app_role) leem tudo
CREATE POLICY "call_log team select" ON public.call_log FOR SELECT
  USING (
    public.has_role(auth.uid(), 'master'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.commercial_roles cr
      WHERE cr.user_id = auth.uid()
        AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
    )
  );

-- Backstop de perdidas: aba fechou no toque → marca ringing antigo como terminal.
-- Inbound vira 'missed'; outbound vira 'failed' (ex: aba fechada antes do callState terminal).
SELECT cron.schedule(
  'call-log-missed-backstop',
  '* * * * *',
  $$UPDATE public.call_log
      SET status = CASE WHEN direction = 'inbound' THEN 'missed'::public.call_status ELSE 'failed'::public.call_status END,
          ended_at = COALESCE(ended_at, now())
      WHERE status = 'ringing'
        AND started_at < now() - interval '90 seconds'$$
);
