CREATE TABLE IF NOT EXISTS public.cockpit_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cockpit_audit_log_created_at ON public.cockpit_audit_log(created_at DESC);

ALTER TABLE public.cockpit_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view audit log"
ON public.cockpit_audit_log FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'master') OR public.has_role(auth.uid(), 'employee'));

CREATE POLICY "Staff can insert audit log"
ON public.cockpit_audit_log FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'master') OR public.has_role(auth.uid(), 'employee'));

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pedido_compra_sugerido;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sku_parametros;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;