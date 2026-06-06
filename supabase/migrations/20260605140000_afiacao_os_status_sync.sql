-- Sync de andamento: pedido de afiação (public.orders) → etapa (cEtapa) da OS no Omie (Colacor SC).
-- A integração que CRIA a OS já existe (omie-sync sync_order). Aqui ligamos a ATUALIZAÇÃO de etapa,
-- que era dormente. Abordagem B (spec 2026-06-05): trigger → fila → cron → edge cron-authed.
-- Backend aplicado À MÃO via Lovable SQL Editor (founder não tem terminal). Idempotente.

-- 1) Fila (upsert por order_id: 1 linha/pedido, sempre o alvo mais novo).
CREATE TABLE IF NOT EXISTS public.afiacao_os_sync_fila (
  order_id      uuid PRIMARY KEY,
  etapa_alvo    text NOT NULL,
  status_app    text NOT NULL,
  tentativas    int NOT NULL DEFAULT 0,
  next_retry_em timestamptz NOT NULL DEFAULT now(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_afiacao_os_sync_fila_retry
  ON public.afiacao_os_sync_fila (next_retry_em);

-- RLS: service_role bypassa (trigger SECURITY DEFINER + edge service_role escrevem).
-- Sem policy de write → authenticated/anon NÃO escrevem. Staff LÊ (debug).
ALTER TABLE public.afiacao_os_sync_fila ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_le_afiacao_os_sync_fila" ON public.afiacao_os_sync_fila;
CREATE POLICY "staff_le_afiacao_os_sync_fila" ON public.afiacao_os_sync_fila
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- 2) Colunas de observabilidade/idempotência em omie_ordens_servico.
ALTER TABLE public.omie_ordens_servico
  ADD COLUMN IF NOT EXISTS last_etapa_sincronizada text,
  ADD COLUMN IF NOT EXISTS last_status_sincronizado text,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

-- 3) Mapa status→etapa (ESPELHA verbatim src/lib/afiacao/os-etapa.ts).
CREATE OR REPLACE FUNCTION public.mapear_status_etapa(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'pedido_recebido'    THEN '10'
    WHEN 'aguardando_coleta'  THEN '10'
    WHEN 'orcamento_enviado'  THEN '10'
    WHEN 'aprovado'           THEN '10'
    WHEN 'em_triagem'         THEN '20'
    WHEN 'em_afiacao'         THEN '20'
    WHEN 'controle_qualidade' THEN '20'
    WHEN 'pronto_entrega'     THEN '30'
    WHEN 'em_rota'            THEN '30'
    ELSE NULL  -- 'entregue' + desconhecido → mantém a OS como está
  END;
$$;

-- 4) Trigger de enqueue: só enfileira se a etapa-alvo mudou E não é null.
CREATE OR REPLACE FUNCTION public.afiacao_os_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_etapa_nova  text := public.mapear_status_etapa(NEW.status);
  v_etapa_velha text := public.mapear_status_etapa(OLD.status);
BEGIN
  IF v_etapa_nova IS NOT NULL AND v_etapa_nova IS DISTINCT FROM v_etapa_velha THEN
    INSERT INTO public.afiacao_os_sync_fila
      (order_id, etapa_alvo, status_app, tentativas, next_retry_em, criado_em, atualizado_em)
    VALUES (NEW.id, v_etapa_nova, NEW.status, 0, now(), now(), now())
    ON CONFLICT (order_id) DO UPDATE SET
      etapa_alvo    = EXCLUDED.etapa_alvo,
      status_app    = EXCLUDED.status_app,
      tentativas    = 0,
      next_retry_em = now(),
      atualizado_em = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_afiacao_os_enqueue ON public.orders;
CREATE TRIGGER trg_afiacao_os_enqueue
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.afiacao_os_enqueue();

-- 5) Kick do cron: cutuca a edge se há pendentes (idle barato). Auth via x-cron-secret do Vault.
CREATE OR REPLACE FUNCTION public.afiacao_os_sync_kick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cron_secret text;
  v_request_id  bigint;
  v_pendentes   int;
  v_url constant text := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync';
BEGIN
  SELECT count(*) INTO v_pendentes
  FROM public.afiacao_os_sync_fila
  WHERE next_retry_em <= now();

  IF v_pendentes = 0 THEN
    RETURN jsonb_build_object('pendentes', 0);
  END IF;

  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_cron_secret),
    body := jsonb_build_object('action', 'sync_os_status'),
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN jsonb_build_object('pendentes', v_pendentes, 'request_id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.afiacao_os_sync_kick() FROM anon, authenticated, PUBLIC;

SELECT cron.schedule('afiacao-os-sync', '*/5 * * * *',
  $cron$ SELECT public.afiacao_os_sync_kick(); $cron$);
