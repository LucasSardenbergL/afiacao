-- PR 1 — Blindagem contra duplicidade no envio ao portal Sayerlack
-- Máquina de estados explícita + tabela de auditoria de tentativas.
-- Nada é removido: estados legados continuam válidos para linhas existentes.

-- 1. Ampliar o CHECK constraint de status_envio_portal com os novos estados.
--    União dos estados legados (linhas em produção dependem deles) + novos estados
--    da máquina de transições. Nenhum backfill necessário.
ALTER TABLE public.pedido_compra_sugerido
  DROP CONSTRAINT IF EXISTS pedido_compra_sugerido_status_envio_portal_check;
ALTER TABLE public.pedido_compra_sugerido
  ADD CONSTRAINT pedido_compra_sugerido_status_envio_portal_check
  CHECK (status_envio_portal IN (
    -- legados (mantidos para compatibilidade com linhas já gravadas)
    'nao_aplicavel',
    'pendente_envio_portal',
    'enviando_portal',
    'enviado_portal',
    'falha_envio_portal',
    -- novos estados da máquina de transições
    'sucesso_portal',
    'aceito_portal_sem_protocolo',
    'indeterminado_requer_conciliacao',
    'erro_retentavel',
    'erro_nao_retentavel'
  ));

-- Índice da fila de envio agora também cobre 'erro_retentavel' (POST nunca enviado,
-- seguro retentar) além dos legados.
DROP INDEX IF EXISTS idx_pedido_status_envio_portal;
CREATE INDEX IF NOT EXISTS idx_pedido_status_envio_portal
  ON public.pedido_compra_sugerido (status_envio_portal)
  WHERE status_envio_portal IN (
    'pendente_envio_portal', 'falha_envio_portal', 'erro_retentavel'
  );

-- 2. Tabela de auditoria de tentativas de envio ao portal.
--    Uma linha por execução do Browserless, com a evidência completa
--    (network log + first signal + classificação) em jsonb.
CREATE TABLE IF NOT EXISTS public.pedidos_portal_tentativas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  status_resultado text NOT NULL,
  elapsed_ms integer,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  browserless_response_ms integer,
  erro text
);

CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_pedido
  ON public.pedidos_portal_tentativas (pedido_id, iniciado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_iniciado
  ON public.pedidos_portal_tentativas (iniciado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_status
  ON public.pedidos_portal_tentativas (status_resultado);

-- RLS: leitura para staff autenticado; escrita só service_role (sem policy de
-- INSERT/UPDATE = bloqueado para anon/authenticated; service_role bypassa RLS).
ALTER TABLE public.pedidos_portal_tentativas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pedidos_portal_tentativas_select_staff ON public.pedidos_portal_tentativas;
CREATE POLICY pedidos_portal_tentativas_select_staff
  ON public.pedidos_portal_tentativas FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- 3. RPC de seleção de candidatos: passa a incluir 'erro_retentavel'
--    (POST comprovadamente nunca enviado) na fila de retry, sem precisar
--    reverter para 'pendente_envio_portal'. Estados 'indeterminado_*',
--    'aceito_*' e 'sucesso_*' NUNCA entram na fila automática.
CREATE OR REPLACE FUNCTION public.envio_portal_lock_candidatos(p_max integer DEFAULT 5)
 RETURNS TABLE(id bigint, empresa text, fornecedor_nome text, status_envio_portal text, portal_tentativas integer, portal_protocolo text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidatos AS (
    SELECT p.id, p.status_envio_portal AS status_anterior
    FROM public.pedido_compra_sugerido p
    WHERE p.status = 'disparado'
      AND p.status_envio_portal IN ('pendente_envio_portal', 'erro_retentavel')
      AND COALESCE(p.portal_tentativas, 0) < 3
      AND p.fornecedor_nome ILIKE '%SAYERLACK%'
      AND p.empresa = 'OBEN'
      AND (p.portal_proximo_retry_em IS NULL OR p.portal_proximo_retry_em <= now())
    ORDER BY p.aprovado_em ASC NULLS LAST, p.id ASC
    LIMIT p_max FOR UPDATE SKIP LOCKED
  ),
  travados AS (
    UPDATE public.pedido_compra_sugerido p
    SET status_envio_portal = 'enviando_portal'
    FROM candidatos c WHERE p.id = c.id
    RETURNING p.id, p.empresa, p.fornecedor_nome,
              c.status_anterior AS status_envio_portal,
              COALESCE(p.portal_tentativas, 0) AS portal_tentativas, p.portal_protocolo
  )
  SELECT t.id, t.empresa, t.fornecedor_nome, t.status_envio_portal, t.portal_tentativas, t.portal_protocolo
  FROM travados t;
END;
$function$;

REVOKE ALL ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) TO service_role;
