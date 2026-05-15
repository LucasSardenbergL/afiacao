UPDATE public.pedido_compra_sugerido
SET status_envio_portal = 'pendente_envio_portal',
    portal_erro = NULL,
    enviado_portal_em = NULL,
    atualizado_em = now()
WHERE id = 130
  AND status_envio_portal = 'falha_envio_portal';