-- Núcleo HSM: catálogo de templates Meta aprovados + log de envio com idempotência.
-- Escrita nas duas tabelas é da EDGE (service_role); staff lê; master gerencia o catálogo.
-- Seed entra com ativo=false — o founder ativa após a Meta aprovar o template na 360dialog.

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,                       -- nome EXATO aprovado na Meta/360dialog
  categoria text NOT NULL CHECK (categoria IN ('utility','marketing')),
  idioma text NOT NULL DEFAULT 'pt_BR',
  corpo_referencia text NOT NULL,                  -- corpo com {{1}}..{{n}} (preview no inbox)
  num_body_params smallint NOT NULL DEFAULT 0 CHECK (num_body_params BETWEEN 0 AND 10),
  ativo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_template_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_nome text NOT NULL REFERENCES public.whatsapp_templates(nome),
  conversation_id uuid REFERENCES public.whatsapp_conversations(id),
  phone_e164 text NOT NULL,
  body_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text NOT NULL UNIQUE,                 -- idempotência: reservada ANTES do POST
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id text,
  erro text,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','proposta','status_pedido','rota')),
  disparado_por uuid,                              -- staff que disparou (null = automação)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wts_conversation ON public.whatsapp_template_sends(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wts_wa_message_id ON public.whatsapp_template_sends(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wts_pendentes ON public.whatsapp_template_sends(status, created_at) WHERE status IN ('queued','sent');

ALTER TABLE public.whatsapp_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_template_sends ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master). catálogo: master escreve. log: SÓ service_role escreve (edge).
CREATE POLICY "wt_staff_read" ON public.whatsapp_templates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "wt_master_write" ON public.whatsapp_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "wts_staff_read" ON public.whatsapp_template_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito) — revogar por nome (CLAUDE.md).
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_template_sends FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_templates FROM anon;

-- Seed (ativo=false até aprovação na Meta; wording final é do founder — brand-voice):
INSERT INTO public.whatsapp_templates (nome, categoria, idioma, corpo_referencia, num_body_params, ativo) VALUES
  ('colacor_proposta_recompra', 'marketing', 'pt_BR',
   'Olá, {{1}}! Preparamos sua reposição para a entrega de {{2}} na sua região: {{3}}. Quer que a gente já separe? Responda SIM ou fale com sua vendedora. Para não receber mais, responda PARAR.', 3, false),
  ('colacor_status_pedido', 'utility', 'pt_BR',
   'Olá, {{1}}! Atualização do seu pedido {{2}}: {{3}}.', 3, false)
ON CONFLICT (nome) DO NOTHING;
