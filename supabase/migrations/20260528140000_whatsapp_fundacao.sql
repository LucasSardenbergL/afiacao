-- WhatsApp Fundação (PR1): inbox do número central. Tabelas de eventos crus (auditoria/dedup),
-- conversas (1 por telefone, roteada por operador) e mensagens (in/out). RLS: só staff
-- (employee/master) lê/escreve via app; service_role (edge functions) bypassa.
-- Dedup idempotente via UNIQUE(wa_message_id) em whatsapp_messages.

-- 1) Eventos crus do webhook (auditoria; processamento assíncrono)
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- 2) Conversas: 1 por telefone (chave normalizada). Reabrimos a mesma conversa quando o cliente volta.
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key text NOT NULL UNIQUE,
  phone_e164 text,
  contact_name text,
  customer_user_id uuid,
  assigned_operator_id uuid,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','aguardando_cliente','fechada')),
  opt_in_status text NOT NULL DEFAULT 'unknown',
  last_inbound_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer ON public.whatsapp_conversations(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_operator ON public.whatsapp_conversations(assigned_operator_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_last_msg ON public.whatsapp_conversations(last_message_at DESC);

-- 3) Mensagens (in/out). UNIQUE(wa_message_id) = idempotência do webhook.
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  wa_message_id text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  type text NOT NULL DEFAULT 'text' CHECK (type IN ('text','audio','image','template','system')),
  body text,
  media_id text,
  media_url text,
  transcript text,
  status text,
  sender_user_id uuid,
  wa_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON public.whatsapp_messages(conversation_id, created_at);

-- RLS
ALTER TABLE public.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

-- Helper inline de staff (employee/master). service_role bypassa RLS automaticamente.
CREATE POLICY "wa_events_staff_select" ON public.whatsapp_webhook_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

CREATE POLICY "wa_conv_staff_all" ON public.whatsapp_conversations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

CREATE POLICY "wa_msg_staff_all" ON public.whatsapp_messages
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_messages;
