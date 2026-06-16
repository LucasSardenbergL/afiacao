-- 20260525230000_impersonation_audit.sql
-- "Ver como pessoa": tabela de auditoria LGPD + RPCs log_impersonation_start / end_impersonation.
CREATE TABLE IF NOT EXISTS public.impersonation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reason text,
  source text NOT NULL DEFAULT 'master_dashboard'
);
ALTER TABLE public.impersonation_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "master vê audit de impersonação" ON public.impersonation_audit;
CREATE POLICY "master vê audit de impersonação" ON public.impersonation_audit
  FOR SELECT USING (has_role(auth.uid(),'master'::app_role));

-- Loga o INÍCIO (actor = auth.uid() SEMPRE; nunca client-provided). Retorna o id.
CREATE OR REPLACE FUNCTION public.log_impersonation_start(p_target uuid, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;
  IF p_target IS NULL THEN RAISE EXCEPTION 'target required'; END IF;
  INSERT INTO public.impersonation_audit (actor_user_id, target_user_id, reason)
  VALUES (auth.uid(), p_target, p_reason)   -- actor do auth.uid(), não do cliente
  RETURNING id INTO new_id;
  RETURN new_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.log_impersonation_start(uuid, text) TO authenticated;

-- Fecha (só o próprio actor pode fechar a sua linha).
CREATE OR REPLACE FUNCTION public.end_impersonation(p_audit_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.impersonation_audit
  SET ended_at = now()
  WHERE id = p_audit_id AND actor_user_id = auth.uid() AND ended_at IS NULL;
END; $$;
GRANT EXECUTE ON FUNCTION public.end_impersonation(uuid) TO authenticated;

SELECT 'BLOCO VIEWAS-C OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='impersonation_audit') AS tbl,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('log_impersonation_start','end_impersonation')) AS fns;
