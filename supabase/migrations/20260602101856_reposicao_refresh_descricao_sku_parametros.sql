-- Reposição — refresh do RÓTULO sku_parametros.sku_descricao a partir do catálogo VIVO do Omie
-- ============================================================================
-- CAUSA-RAIZ (confirmada no código + em prod): sku_parametros.sku_descricao é semeado de
-- max(venda_items_history.sku_descricao) dos ÚLTIMOS 90 DIAS — atualizar_classificacao_skus() no
-- INSERT da linha nova; atualizar_parametros_numericos_skus() no UPDATE via COALESCE(v.sku_descricao,
-- sp.sku_descricao). SKU sem venda em 90d NÃO entra em v_sku_parametros_sugeridos → o COALESCE preserva
-- o nome ANTIGO de NF-e indefinidamente. NENHUM caminho lê omie_products.descricao (catálogo vivo) →
-- quando o produto é RENOMEADO no Omie, o motor de reposição fica preso no nome velho.
-- Caso real: CONCENTRADO AMARELO LIMAO WP07.3900QT (8689783095) e CONCENTRADO AZUL WP04.3900QT
-- (8689733271) — Omie renomeou pondo o código na frente (WP07.3900QT CONCENTRADO ...); última venda
-- 22/01/26 (>90d) → motor congelado no nome com o código no fim.
--
-- FIX (cirúrgico, money-path-SAFE): função dedicada que reabastece SÓ o rótulo a partir do catálogo
-- vivo. Decoupled da view de vendas → alcança também SKU SEM venda em 90d (que é exatamente o caso que
-- as funções existentes não alcançam, pois iteram só sobre v_sku_parametros_sugeridos).
--
-- GUARD-RAILS (revisão adversária):
--  • Join autoritativo do money-path: omie_products.account = lower(sku_parametros.empresa) AND ativo
--    = true. É o MESMO join que a RPC gerar_pedidos_sugeridos_ciclo usa em prod (omie_products é
--    UNIQUE(omie_codigo_produto, account) → casa ≤1 linha → UPDATE...FROM determinístico, sem DISTINCT ON).
--    op.ativo=true pega a linha ATIVA do account (ignora a linha duplicada inativa de outra empresa,
--    ex.: a do colacor). Sem linha omie ativa → não casa → PRESERVA o valor atual (nunca apaga/nula).
--  • Só toca a coluna sku_descricao. NÃO toca params numéricos (ponto_pedido/estoque_maximo/...) nem
--    chaves de join → ZERO risco à matemática do pedido.
--  • O trigger de auditoria trg_historico_sku_parametros IGNORA mudança de sku_descricao (só loga
--    estoque_minimo/ponto_pedido/estoque_maximo/aprovado_em/aplicar_no_omie) → ZERO churn de histórico.
--  • IS DISTINCT FROM + length(trim)>0: só atualiza quando muda E quando o nome vivo é não-vazio
--    (nunca sobrescreve um rótulo bom com vazio). Idempotente (re-rodar = no-op quando já alinhado).
--  • NÃO há caminho manual que edite sku_parametros.sku_descricao (verificado: nenhum UPDATE no front,
--    sem coluna de override de descrição) → não clobbera correção humana. fornecedor_nome NÃO é tocado.
--  • De-para do fornecedor é keyed por código NUMÉRICO (sku_fornecedor_externo.sku_omie); o parser
--    Sayerlack usa sku_descricao só p/ SUGERIR de-para novo + detectar fracionado — o de-para REAL não
--    muda. Trocar pro nome vivo é igual-ou-mais-correto (e o nome vivo já vem padronizado com o código).
-- Reversível: DROP FUNCTION + cron.unschedule; reescrita não-destrutiva (nome antigo segue em
-- venda_items_history / pedido_compra_item).

CREATE OR REPLACE FUNCTION public.atualizar_descricao_sku_parametros(p_empresa text)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_atualizados int := 0;
BEGIN
  UPDATE sku_parametros sp
  SET sku_descricao = trim(op.descricao)
  FROM omie_products op
  WHERE op.omie_codigo_produto::text = sp.sku_codigo_omie::text
    AND op.account = lower(sp.empresa)
    AND op.ativo = true
    AND op.descricao IS NOT NULL
    AND length(trim(op.descricao)) > 0
    AND trim(op.descricao) IS DISTINCT FROM sp.sku_descricao
    AND sp.empresa = p_empresa;
  GET DIAGNOSTICS v_atualizados = ROW_COUNT;
  RETURN v_atualizados;
END;
$$;

-- Cron diário: reabastece o rótulo a partir do catálogo vivo do Omie. Roda 08:45 UTC — depois do sync
-- de catálogo (omie-cron-diario, a cada 2h às :15) e ANTES do ciclo de geração de pedidos das 09:15
-- (gerar-pedidos-diario-oben), pra que os PVs futuros já carreguem o nome vivo. SQL-local (sem
-- net.http_post → sem a armadilha do timeout 5s do pg_net). Idempotente (upsert por nome).
SELECT cron.schedule('reposicao-refresh-descricao-diario', '45 8 * * *',
  $cron$ SELECT public.atualizar_descricao_sku_parametros('OBEN'); $cron$);
