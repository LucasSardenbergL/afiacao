-- Tabela de log para o webhook do Gmail (Apps Script)
CREATE TABLE IF NOT EXISTS public.gmail_webhook_log (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  remetente TEXT NOT NULL,
  subject TEXT,
  received_at TIMESTAMPTZ,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  processado_em TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'recebido',
  tipo_documento TEXT,
  campanhas_criadas BIGINT[] DEFAULT ARRAY[]::BIGINT[],
  alertas_criados BIGINT[] DEFAULT ARRAY[]::BIGINT[],
  aumentos_criados BIGINT[] DEFAULT ARRAY[]::BIGINT[],
  erro TEXT,
  detalhes JSONB,
  CONSTRAINT gmail_webhook_log_status_check
    CHECK (status IN ('recebido','processando','sucesso','parcial','erro','duplicado','suspensao','rejeitado'))
);

CREATE INDEX IF NOT EXISTS idx_gmail_webhook_log_message_id
  ON public.gmail_webhook_log (message_id);
CREATE INDEX IF NOT EXISTS idx_gmail_webhook_log_recebido_em
  ON public.gmail_webhook_log (recebido_em DESC);

ALTER TABLE public.gmail_webhook_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff lê gmail_webhook_log"
  ON public.gmail_webhook_log
  FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
    OR has_role(auth.uid(), 'employee'::app_role)
  );

CREATE POLICY "Admin/manager editam gmail_webhook_log"
  ON public.gmail_webhook_log
  FOR ALL
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  )
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'master'::app_role)
  );

-- Bucket privado para anexos de aumentos (já existe 'promocoes')
INSERT INTO storage.buckets (id, name, public)
VALUES ('aumentos', 'aumentos', false)
ON CONFLICT (id) DO NOTHING;

-- Política: staff pode ler anexos de aumentos
CREATE POLICY "Staff lê anexos aumentos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'aumentos' AND (
      has_role(auth.uid(), 'admin'::app_role)
      OR has_role(auth.uid(), 'manager'::app_role)
      OR has_role(auth.uid(), 'master'::app_role)
      OR has_role(auth.uid(), 'employee'::app_role)
    )
  );