CREATE OR REPLACE FUNCTION public.envio_portal_lock_candidatos(p_max integer DEFAULT 5)
RETURNS TABLE (
  id bigint,
  empresa text,
  fornecedor_nome text,
  status_envio_portal text,
  portal_tentativas integer,
  portal_protocolo text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH candidatos AS (
    SELECT p.id
    FROM public.pedido_compra_sugerido p
    WHERE p.status = 'disparado'
      AND p.status_envio_portal = 'pendente_envio_portal'
      AND COALESCE(p.portal_tentativas, 0) < 3
      AND p.fornecedor_nome ILIKE '%SAYERLACK%'
      AND p.empresa = 'OBEN'
      AND (p.portal_proximo_retry_em IS NULL OR p.portal_proximo_retry_em <= now())
    ORDER BY p.aprovado_em ASC NULLS LAST, p.id ASC
    LIMIT p_max
    FOR UPDATE SKIP LOCKED
  ),
  travados AS (
    UPDATE public.pedido_compra_sugerido p
    SET status_envio_portal = 'enviando_portal'
    FROM candidatos c
    WHERE p.id = c.id
    RETURNING p.id, p.empresa, p.fornecedor_nome,
              'pendente_envio_portal'::text AS status_envio_portal,
              COALESCE(p.portal_tentativas, 0) AS portal_tentativas,
              p.portal_protocolo
  )
  SELECT t.id, t.empresa, t.fornecedor_nome, t.status_envio_portal,
         t.portal_tentativas, t.portal_protocolo
  FROM travados t;
END;
$$;

REVOKE ALL ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) TO service_role;