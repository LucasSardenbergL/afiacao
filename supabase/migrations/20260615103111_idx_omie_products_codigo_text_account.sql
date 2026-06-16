-- ============================================================
-- idx_omie_products_codigo_text_account — mata o nested loop do check
-- reposicao_sayerlack_fabricado em _data_health_compute()
--
-- Causa-raiz (CONFIRMADA por EXPLAIN ANALYZE, 2026-06-15): o check
-- reposicao_sayerlack_fabricado faz um EXISTS correlacionado:
--   EXISTS (SELECT 1 FROM omie_products o
--           WHERE o.omie_codigo_produto::text = sp.sku_codigo_omie::text
--             AND lower(o.account) = lower(sp.empresa) ...)
-- O ::text nos DOIS lados anula qualquer índice em omie_codigo_produto (bigint)
-- → Nested Loop Semi Join com Seq Scan on omie_products POR linha de
-- sku_parametros (loops=179). Isso sozinho = 144.990 de 154.175 buffers (94%)
-- e ~todos os 1.188ms de _data_health_compute() — que roda a cada 30min
-- (watchdog) + ~860x/dia (badge do front, que recomputa sem cache). Os outros
-- 17 checks são ruído (~9k buffers / ~30ms).
--
-- Fix TRANSPARENTE (sem tocar a função acoplada): índice de EXPRESSÃO que casa
-- exatamente com o Join Filter — (omie_codigo_produto::text, lower(account)) →
-- o inner Seq Scan vira Index Scan (1-2 linhas por loop em vez de varrer 7.9k).
-- Bônus: serve qualquer lookup account-aware por código (ex. o motor de compra
-- gerar_pedidos_sugeridos_ciclo, que também junta omie_products por código+conta).
-- Não-concorrente: omie_products é pequena (~6,5MB), build <1s.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_omie_products_codigo_text_account
  ON public.omie_products ((omie_codigo_produto::text), lower(account));
