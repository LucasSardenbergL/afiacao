-- Quantidade inteira PERSISTIDA no banco — função + backfill (hotfix do #663)
-- ============================================================================
-- POR QUÊ (revisão adversária Codex no #663): o ceil só na RPC + nos consumidores
-- (disparo Omie, front) era CAÇA AOS RATOS e deixou furos money-path:
--   • Portal Sayerlack: pede ceil ao fornecedor (enviar-pedido-portal-sayerlack:1774)
--     mas DERIVA o custo dividindo o total capturado pela qtde_final CRUA (:1376) →
--     preço unitário inflado → total do Omie diverge do portal (ex.: q=10,6 → +3,77%).
--   • em_transito (RPC :73), valor_total, embalagem (useEmbalagemPedido:135) leem qtde_final CRU.
--   • Promoção (aplicar_promocoes_no_ciclo) faz qtde_final = qtde_com_desconto → pode
--     reintroduzir fração DEPOIS da RPC, sem passar por nenhum ceil.
-- A fonte da verdade é o qtde_final NO BANCO. Tem que ser inteiro lá — aí TODOS os
-- consumidores (portal, Omie, em_transito, valor, embalagem) leem inteiro de graça.
--
-- ESTA MIGRAÇÃO:
--  1. Função reposicao_persistir_qtde_inteira(pedido_id): ceila qtde_sugerida/qtde_final
--     (só linhas fracionárias — preserva valor_linha capturado do portal em linhas já
--     inteiras) + recalcula valor_linha = ceil(qtde)×preco + valor_total do pedido.
--     O disparo (disparar-pedidos-aprovados) chama ANTES do portal/Omie → source-agnostic
--     (cobre RPC, promo, edição, legado). Idempotente (ceil de inteiro = no-op → 0 linhas).
--  2. Backfill one-time: aplica a função nos pedidos NÃO-disparados (a qtde ainda não foi
--     ao fornecedor; valor_linha é custo, não total capturado). Conserta os pendentes de hoje.
--     EXCLUI disparado/concluído (já foram ao fornecedor; rewrite desincronizaria do Omie e
--     CLOBBERIA o valor_linha capturado do portal) e cancelado/expirado (terminais).
--
-- NÃO toca a RPC (ceil já está nela via #663) nem a promo (território de outra sessão;
-- a persistência no disparo cobre a fração da promo sem reescrever a função).
-- Validado em PG17: db/test-qtde-inteira-persist.sh.
--
-- ⚠️ Migração manual (SQL Editor). Backfill roda 1×; a função fica p/ o disparo chamar.
-- Requer deploy do edge disparar-pedidos-aprovados (que passa a chamar a função) — ver PR.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reposicao_persistir_qtde_inteira(p_pedido_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ajustados integer;
BEGIN
  -- Ceila só as linhas REALMENTE fracionárias. Em linha já inteira, NÃO toca valor_linha —
  -- isso preserva o valor_linha = total capturado que o portal grava (preço cheio).
  UPDATE pedido_compra_item
    SET qtde_sugerida = ceil(qtde_sugerida),
        qtde_final    = ceil(qtde_final),
        valor_linha   = ceil(qtde_final) * preco_unitario
  WHERE pedido_id = p_pedido_id
    AND (qtde_final    IS DISTINCT FROM ceil(qtde_final)
      OR qtde_sugerida IS DISTINCT FROM ceil(qtde_sugerida));
  GET DIAGNOSTICS v_ajustados = ROW_COUNT;

  -- Só recomputa o total do pedido se algo mudou (idempotente; não reescreve à toa).
  IF v_ajustados > 0 THEN
    UPDATE pedido_compra_sugerido
      SET valor_total = (
        SELECT COALESCE(sum(valor_linha), 0)
        FROM pedido_compra_item WHERE pedido_id = p_pedido_id
      )
    WHERE id = p_pedido_id;
  END IF;

  RETURN v_ajustados;
END;
$function$;

-- Trava: só o service_role (edge de disparo) executa. Não é dado sensível, mas é money-path.
REVOKE EXECUTE ON FUNCTION public.reposicao_persistir_qtde_inteira(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_persistir_qtde_inteira(bigint) TO service_role;

-- ─── Backfill one-time: pedidos NÃO-disparados ───
SELECT public.reposicao_persistir_qtde_inteira(id)
FROM public.pedido_compra_sugerido
WHERE status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio');

-- ─── Validação ───
SELECT 'MIGRATION qtde_inteira_persist OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'reposicao_persistir_qtde_inteira') AS func,
  -- 0 = nenhum item fracionário restante nos pedidos NÃO-disparados
  (SELECT count(*)
     FROM public.pedido_compra_item pci
     JOIN public.pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
    WHERE pcs.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio')
      AND (pci.qtde_final    IS DISTINCT FROM ceil(pci.qtde_final)
        OR pci.qtde_sugerida IS DISTINCT FROM ceil(pci.qtde_sugerida))
  ) AS frac_restantes_nao_disparados;
