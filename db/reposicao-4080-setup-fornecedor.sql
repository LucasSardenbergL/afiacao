-- ============================================================================
-- Setup de COMPRA do destino da consolidação (DFA.4080LT, omie 12101724100).
-- Aplicado em prod 2026-07-05 (founder colou no SQL Editor) + verificado psql-ro.
-- Complementa db/reposicao-consolidacao-demanda.sql (a consolidação de DEMANDA).
--
-- LIÇÃO (descoberta pós-apply, Codex challenge): consolidar demanda NÃO basta —
-- o SKU DESTINO precisa estar COMPRÁVEL. O 4080 só era VENDIDO (60 ordens), nunca
-- COMPRADO pelo sistema → sem grupo de produção, sem fornecedor, sem lead-time
-- (status SEM_LEADTIME_DEFINIDO) → o motor não o dimensionaria, mesmo com a demanda
-- somada (1,0778/dia). Circularidade: v_sku_lt_teorico só dá o LT se houver linha
-- em sku_grupo_producao E sku_parametros.fornecedor_nome = o fornecedor do grupo.
-- Os antigos (8040/4128) tinham ambos via histórico de compra; o 4080 não.
-- ============================================================================

-- 1. Classifica o 4080 no MESMO grupo do 8040 (sayerlack_normal → LT teórico 10:
--    8 úteis de produção + 2 de logística; fornecedor RENNER SAYERLACK, já habilitado).
INSERT INTO sku_grupo_producao (empresa, sku_codigo_omie, grupo_codigo, atualizado_por)
VALUES ('OBEN', '12101724100', 'sayerlack_normal', 'consolidacao-4080')
ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE
  SET grupo_codigo = 'sayerlack_normal', atualizado_em = now();

-- 2. Quebra a circularidade (fornecedor_nome) + habilita + seed de pp/emax.
--    Seed = soma dos antigos (8040 pp7/emax9 + 4128 pp17/emax21) → o motor já compra
--    e evita o bloqueio da escritora quando estoque_maximo é NULL. O sistema calculou
--    pp23/emax28 (seed certeiro: recompute aplica sem disparar o fusível 'segurado').
UPDATE sku_parametros
   SET fornecedor_nome = 'RENNER SAYERLACK S/A',
       habilitado_reposicao_automatica = true,
       ponto_pedido = 24,
       estoque_maximo = 30
 WHERE empresa = 'OBEN' AND sku_codigo_omie = 12101724100;

-- VERIFICADO pós-apply (psql-ro): v_sku_parametros_sugeridos do 4080 → status=OK,
-- lt=10, demanda=1.0778, pp_sug=23, emax_sug=28, classe=A. CMC=329,46 (preço do
-- pedido não-zero). De-para Sayerlack já ativo (sku_fornecedor_externo: DFA.4080LT).
--
-- MONITORAR (Codex P2, não-bloqueante):
--  - 1ª compra real do 4080: se o fornecedor entrar variante ('RENNER SAYERLACK SA'
--    etc.) o match exato com fornecedor_grupo_producao quebra → canonicalizar/alias.
--  - LT teórico 10 vs histórico dos antigos (~8,6 e ~12,1): se subproteger na prática,
--    pinar ou ajustar. O seed 24/30 já dá folga sobre o sugerido 23/28.
