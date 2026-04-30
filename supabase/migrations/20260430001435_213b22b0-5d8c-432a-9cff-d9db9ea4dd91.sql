-- 1. Colunas de tracking
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS status_envio_portal text DEFAULT 'nao_aplicavel',
  ADD COLUMN IF NOT EXISTS enviado_portal_em timestamptz,
  ADD COLUMN IF NOT EXISTS portal_protocolo text,
  ADD COLUMN IF NOT EXISTS portal_resposta jsonb,
  ADD COLUMN IF NOT EXISTS portal_screenshot_url text,
  ADD COLUMN IF NOT EXISTS portal_tentativas integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS portal_proximo_retry_em timestamptz,
  ADD COLUMN IF NOT EXISTS portal_erro text;

-- Check constraint
ALTER TABLE public.pedido_compra_sugerido
  DROP CONSTRAINT IF EXISTS pedido_compra_sugerido_status_envio_portal_check;
ALTER TABLE public.pedido_compra_sugerido
  ADD CONSTRAINT pedido_compra_sugerido_status_envio_portal_check
  CHECK (status_envio_portal IN (
    'nao_aplicavel', 'pendente_envio_portal', 'enviando_portal',
    'enviado_portal', 'falha_envio_portal'
  ));

-- Índice para a fila de envio
CREATE INDEX IF NOT EXISTS idx_pedido_status_envio_portal
  ON public.pedido_compra_sugerido (status_envio_portal)
  WHERE status_envio_portal IN ('pendente_envio_portal', 'falha_envio_portal');

-- 2. Trigger automático de status_envio_portal ao disparar
CREATE OR REPLACE FUNCTION public.set_status_envio_portal_on_disparo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Só age na transição p/ disparado
  IF NEW.status = 'disparado' AND COALESCE(OLD.status, '') IS DISTINCT FROM 'disparado' THEN
    -- Idempotente: só sobrescreve se ainda está em 'nao_aplicavel' (default)
    IF COALESCE(NEW.status_envio_portal, 'nao_aplicavel') = 'nao_aplicavel' THEN
      IF NEW.canal_usado = 'portal_b2b'
         AND NEW.fornecedor_nome ILIKE '%SAYERLACK%' THEN
        NEW.status_envio_portal := 'pendente_envio_portal';
      ELSE
        NEW.status_envio_portal := 'nao_aplicavel';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_status_envio_portal ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_set_status_envio_portal
  BEFORE UPDATE OF status ON public.pedido_compra_sugerido
  FOR EACH ROW
  EXECUTE FUNCTION public.set_status_envio_portal_on_disparo();

-- 3. Storage bucket portal_screenshots
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'portal_screenshots',
  'portal_screenshots',
  false,
  5242880, -- 5MB
  ARRAY['image/png', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- RLS policies do bucket
DROP POLICY IF EXISTS "portal_screenshots_select_authenticated" ON storage.objects;
CREATE POLICY "portal_screenshots_select_authenticated"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'portal_screenshots');

-- INSERT/UPDATE/DELETE: apenas service_role (sem policy = bloqueado para anon/authenticated;
-- service_role bypassa RLS por padrão)
DROP POLICY IF EXISTS "portal_screenshots_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "portal_screenshots_update_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "portal_screenshots_delete_authenticated" ON storage.objects;

-- 4. View de monitoramento
CREATE OR REPLACE VIEW public.v_envios_portal_status AS
SELECT
  date_trunc('day', COALESCE(enviado_portal_em, criado_em))::date AS dia,
  fornecedor_nome,
  status_envio_portal,
  count(*) AS total,
  count(*) FILTER (WHERE portal_tentativas >= 3) AS esgotados,
  avg(portal_tentativas)::numeric(10,2) AS media_tentativas
FROM public.pedido_compra_sugerido
WHERE COALESCE(enviado_portal_em, criado_em) >= now() - interval '30 days'
  AND status_envio_portal != 'nao_aplicavel'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;