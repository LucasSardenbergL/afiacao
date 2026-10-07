-- Remendo: o galão da WP01 (12078998671, WP01.3900GL) congelado em 11,72 no sku_estoque_atual.
--
-- O galão é membro NÃO habilitado do grupo de equivalência da WP01, e o omie-sync-estoque só grava SKUs
-- habilitados: a linha está parada desde 2026-07-31. O Omie CONFIRMOU 0 (ListarPosEstoque cExibeTodos "S"
-- + lista_produtos, o zero confirmado do #2788) em 2026-10-06 00:30:12Z, nos dois espelhos de
-- inventory_position. O motor (gerar_pedidos_sugeridos_ciclo) soma GREATEST(inv.saldo, sea.estoque_fisico)
-- por membro do grupo, então o 11,72 virava ~47 quartos fantasmas e seguraria a compra da WP01 (quarto em
-- 5,2, no ponto de pedido). O conserto da classe é o PR-3 (o omie-sync-estoque passa a gravar os membros
-- de grupo); este remendo só tira o fantasma até lá. Diário: docs/historico/estoque-dono-unico.md.
--
-- Aplicado pelo envelope `bun run db:aplicar` (a transação é do executor: sem BEGIN/COMMIT aqui).
-- Idempotente: o UPDATE é CAS no valor congelado (11,72 e a data de 31/07); re-rodar não acha linha, e a
-- pós-condição confere o estado final. ultima_sincronizacao recebe o instante da confirmação do zero, e
-- fonte_sync fica ListarPosEstoque (o motor só trata 'cold_start_seed' como linha não confirmada).

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM inventory_position
    WHERE omie_codigo_produto = 12078998671 AND account IN ('vendas', 'oben')
    GROUP BY omie_codigo_produto
    HAVING count(*) = 2 AND bool_and(saldo = 0) AND min(synced_at) >= '2026-10-06 00:30:00+00'
  ) THEN
    RAISE EXCEPTION 'REMENDO_WP01_PRE: a posição do galão não está mais em 0 confirmado nos dois espelhos';
  END IF;
END
$pre$;

UPDATE sku_estoque_atual
SET estoque_fisico = 0,
    estoque_disponivel = 0,
    ultima_sincronizacao = '2026-10-06 00:30:12.431+00'
WHERE empresa = 'OBEN'
  AND sku_codigo_omie = '12078998671'
  AND estoque_fisico = 11.72
  AND ultima_sincronizacao = '2026-07-31 02:27:20.268+00';

DO $post$
DECLARE
  v_fisico numeric;
  v_disp numeric;
BEGIN
  SELECT estoque_fisico, estoque_disponivel INTO v_fisico, v_disp
  FROM sku_estoque_atual
  WHERE empresa = 'OBEN' AND sku_codigo_omie = '12078998671';
  IF v_fisico IS DISTINCT FROM 0 OR v_disp IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'REMENDO_WP01_POST: o galão não ficou em 0 (fisico=%, disponivel=%)', v_fisico, v_disp;
  END IF;
  RAISE NOTICE 'REMENDO_WP01_OK: galão 12078998671 em 0 no sku_estoque_atual';
END
$post$;
