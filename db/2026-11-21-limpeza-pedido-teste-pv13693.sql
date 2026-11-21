-- 2026-11-21-limpeza-pedido-teste-pv13693.sql
-- ================================================================================================
-- Limpeza do pedido TESTE criado para provar o checkout pelo app (PR #4069, RPC pedido_por_checkout).
-- O PV 13693 (Oben, omie_pedido_id 12215613527) foi EXCLUÍDO no Omie pelo founder. O app só espelha
-- CANCELAMENTO (etapa 80), nunca exclusão — sem esta limpeza ficariam para sempre:
--   · sales_orders 1a3c47e6… como 'enviado' (R$ 1,70 nas vendas do mês);
--   · estoque_reservas a80e35ea… 'ativa' (1 un PRD03581) — o TTL só expira reserva de pedido SEM PV.
--
-- O que faz (só nestas duas linhas, com guardas de identidade):
--   · pedido  → deleted_at = now()       (exclusão LÓGICA; nada de DELETE)
--   · reserva → status 'liberada' + motivo
-- Idempotente (WHERE deleted_at IS NULL / status = 'ativa'). Sem BEGIN/COMMIT: o db:aplicar fornece
-- a transação. Postcondição aborta se o estado final não for o esperado.
-- ================================================================================================

UPDATE public.sales_orders
   SET deleted_at = now()
 WHERE id = '1a3c47e6-d767-4562-b9ff-d5afd7c9ae4b'
   AND account = 'oben'
   AND omie_pedido_id = 12215613527
   AND notes LIKE 'TESTE CHECKOUT%'
   AND deleted_at IS NULL;

UPDATE public.estoque_reservas
   SET status = 'liberada',
       motivo = 'PV de teste 13693 excluido no Omie (limpeza 2026-11-21, PR #4069)',
       atualizado_em = now()
 WHERE id = 'a80e35ea-83e6-482a-ab89-e97c56df4afc'
   AND sales_order_id = '1a3c47e6-d767-4562-b9ff-d5afd7c9ae4b'
   AND status = 'ativa';

-- ── postcondição ───────────────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales_orders
                  WHERE id = '1a3c47e6-d767-4562-b9ff-d5afd7c9ae4b'
                    AND notes LIKE 'TESTE CHECKOUT%' AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'P1_FALHOU: pedido teste 1a3c47e6 não ficou com deleted_at';
  END IF;
  IF EXISTS (SELECT 1 FROM public.estoque_reservas
              WHERE sales_order_id = '1a3c47e6-d767-4562-b9ff-d5afd7c9ae4b' AND status = 'ativa') THEN
    RAISE EXCEPTION 'P2_FALHOU: ainda há reserva ativa do pedido teste';
  END IF;
  IF (SELECT count(*) FROM public.sales_orders WHERE notes LIKE 'TESTE CHECKOUT%') <> 1 THEN
    RAISE EXCEPTION 'P3_FALHOU: esperado exatamente 1 pedido TESTE CHECKOUT';
  END IF;
  RAISE NOTICE 'limpeza do pedido teste PV 13693: pedido com deleted_at, reserva liberada';
END
$post$;
