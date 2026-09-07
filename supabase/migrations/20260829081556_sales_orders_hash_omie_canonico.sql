-- ============================================================
-- sales_orders: CHECK de CANONICIDADE do hash_payload das linhas nascidas no sync do Omie.
--
-- Defesa em PROFUNDIDADE do guard de reenvio da action `criar_pedido`
-- (supabase/functions/_shared/reenvio-pedido.ts). Achado Codex 2026-08-29, ritual /codex
-- retroativo do PR #2117.
--
-- ⚠️ ESTE CHECK É TARDIO PARA O DEFEITO PRINCIPAL — e isso é DELIBERADO, não um descuido.
--    O `criar_pedido` chamava `IncluirPedido` no Omie e SÓ DEPOIS gravava o write-back. Um
--    CHECK só pode reprovar a ESCRITA LOCAL — quando ele disparasse, o pedido duplicado JÁ
--    EXISTIRIA no Omie, fora do nosso banco e sem desfazer. Por isso o guard REAL é o da
--    fronteira, ANTES da mutação. Este CHECK é a segunda linha: ele impede que a CORRUPÇÃO
--    DO HASH se consolide (e com ela o sumiço silencioso do pedido original, abaixo).
--
-- O QUE ELE IMPEDE, concretamente:
--   linha pull `omie_oben_42` (pid 42) reenviada → Omie cria o pedido 43 → o write-back
--   gravaria pid=43 SEM tocar o hash. A linha ficaria com o hash MENTINDO. Aí o próximo sync
--   do pedido 42 remonta `omie_oben_42`, bate 23505 no índice parcial
--   uniq_sales_orders_omie_hash, e o ON CONFLICT da RPC `criar_pedidos_com_itens` trata como
--   no-op → UM PEDIDO REAL SOME EM SILÊNCIO (positivação/OTE/comissão perdidas).
--   Com o CHECK, esse write-back falha (23514) e o estado incoerente NUNCA se consolida.
--
-- PRÉ-VOO NA PROD (2026-08-29, via psql-ro — entra sem quebrar linha existente):
--   • 31.086 linhas com hash `omie\_%`; 0 com omie_pedido_id NULL; 0 fora da forma canônica.
--   • `account` é NOT NULL ⇒ a concatenação nunca vira NULL (um CHECK que avalia NULL PASSA:
--     seria fresta fail-open silenciosa). Confirmado no information_schema, não presumido.
--   • Writer único do par (hash_payload, omie_pedido_id) em sales_orders: a RPC
--     `criar_pedidos_com_itens`, que insere os dois do MESMO payload, montado como
--     `omie_${account}_${codigo_pedido}` (omie-vendas-sync:1283, sync-reprocess:242).
--     `sync-reprocess` só ESCREVE hash em `order_items`; em sales_orders ele apenas LÊ o pai
--     pelo hash. Nenhum trigger de sales_orders toca a coluna.
--   • Linha *push* (checkout/orçamento) tem hash NULL ⇒ isenta pela 1ª cláusula. As 26 linhas
--     push já enviadas (hash NULL, pid NOT NULL) não são afetadas.
--
-- ESCOPO: só o namespace `omie_`. Hash de outra origem (ex.: `checkout_…`) passa intacto —
-- este CHECK não legisla sobre forma de hash que ele não conhece (precisão > recall).
--
-- Idempotente: o DO só adiciona se ainda não existir. Re-colar é seguro.
-- ============================================================

DO $add$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sales_orders'::regclass
      AND conname = 'sales_orders_hash_omie_canonico'
  ) THEN
    ALTER TABLE public.sales_orders
      ADD CONSTRAINT sales_orders_hash_omie_canonico CHECK (
        hash_payload IS NULL
        OR hash_payload NOT LIKE 'omie\_%'
        OR (
          omie_pedido_id IS NOT NULL
          AND hash_payload = 'omie_' || account || '_' || omie_pedido_id::text
        )
      );
  END IF;
END
$add$;

-- [post] postcondição: a constraint existe E está VALIDADA (uma constraint NOT VALID aceitaria
-- linha nova mas não provaria nada sobre o acervo — "existe" não é "vale").
DO $post$
DECLARE v_existe boolean; v_validada boolean;
BEGIN
  SELECT true, convalidated INTO v_existe, v_validada
  FROM pg_constraint
  WHERE conrelid = 'public.sales_orders'::regclass
    AND conname = 'sales_orders_hash_omie_canonico';

  IF NOT coalesce(v_existe, false) THEN
    RAISE EXCEPTION 'postcondicao: sales_orders_hash_omie_canonico NAO foi criada';
  END IF;
  IF NOT coalesce(v_validada, false) THEN
    RAISE EXCEPTION 'postcondicao: sales_orders_hash_omie_canonico existe mas NAO esta validada';
  END IF;
END
$post$;

COMMENT ON CONSTRAINT sales_orders_hash_omie_canonico ON public.sales_orders IS
  'Linha nascida no sync do Omie (hash_payload omie_*) tem de ter omie_pedido_id e hash '
  'canonico omie_<account>_<pid>. Defesa em profundidade do guard de reenvio de criar_pedido '
  '(_shared/reenvio-pedido.ts): impede que um write-back grave pid novo sobre hash velho e o '
  'pedido original suma no proximo sync via ON CONFLICT no-op. Codex 2026-08-29.';
