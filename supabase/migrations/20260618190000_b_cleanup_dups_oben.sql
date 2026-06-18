-- ============================================================
-- #B — cleanup das duplicatas de sales_orders + índice de IDENTIDADE IMUTÁVEL
--
-- Contexto (diagnóstico 2026-06-18 + Codex consult/challenge): o edge sync-reprocess
-- (reprocessOrders) reescrevia hash_payload de 'omie_<account>_<codigo_pedido>' para
-- um hash de CONTEÚDO ao detectar "divergência" → a linha saía do índice parcial
-- uniq_sales_orders_omie_hash (WHERE hash_payload LIKE 'omie\_%') → o próximo
-- omie-vendas-sync NÃO a achava por hash e RE-INSERIA → 2 linhas por pedido.
-- Estado: ~520 pedidos (517 oben + 0 colacor) com 1 linha 'omie_' (viva) + 1 de-namespaced
-- (estado antigo, congelada). As de-namespaced inflam a receita de positivação (money-path).
--
-- ⚠️ PRÉ-REQUISITO: a contenção já deve ter PARADO o sync-reprocess
--    (sync_reprocess_config.operational_enabled/strategic_enabled = 0), senão re-suja.
--    O conserto do EDGE (idempotência por omie_pedido_id + status mapping alinhado ao sync +
--    total c/ desconto + delete de itens removidos) vem em sessão fresca (deploy manual) ANTES
--    de religar o reprocess.
--
-- Faz, ATOMICAMENTE (1 transação, com LOCK anti-race):
--   [lock]    LOCK sales_orders → o sync de ENTRADA (que segue ativo) não insere um 'omie_'
--             entre o materialize do alvo e o CREATE INDEX (achado Codex challenge A1).
--   [alvo]    de-namespaced = hash NÃO-NULL e NÃO-'omie_' COM par 'omie_' do mesmo
--             (account, omie_pedido_id). Assinatura EXCLUSIVA do bug (sync grava 'omie_%',
--             PUSH grava NULL — nada mais grava hash não-'omie_'). GLOBAL e cirúrgico.
--             b.account=a.account → não cruza contas. Nunca deleta linha sem par 'omie_'.
--   [sph]     DELETA os sales_price_history dos losers (NÃO SET NULL). Os consumers
--             (useCustomerSelection, algorithm-a-audit, analyze-unified-order) leem por
--             customer+product SEM filtrar sales_order_id → órfão (SET NULL) ainda distorce
--             preço. O sph do loser é duplicata espúria; a canônica preserva o legítimo
--             (achado Codex challenge B). Caveat: 3 pares sem sph na canônica perdem o
--             histórico daquele pedido — aceito (preferível a manter linha envenenada).
--   [delete]  remove as de-namespaced. order_items → CASCADE; production_orders → SET NULL.
--             farmer_calls/recommendation_log/picking_tasks: 0 refs (verificado).
--   [push]    preserva checkout_id/origem/atendimento_id na canônica quando o loser os tem e
--             a canônica não (1 caso: pedido PUSH 'web_staff' de-namespaçado — não perder o
--             rastro). ⚠️ DEPOIS do delete: prod tem UNIQUE (checkout_id, account) WHERE
--             checkout_id NOT NULL — copiar com o loser ainda vivo violaria 23505 (achado
--             Codex re-challenge). Snapshot do bundle no temp; copia após o loser sumir.
--   [índice]  UNIQUE (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND
--             omie_pedido_id IS NOT NULL — ancora a idempotência na IDENTIDADE IMUTÁVEL do
--             Omie, não no hash_payload mutável. WHERE hash NOT NULL preserva as PUSH (hash
--             NULL); AND pid NOT NULL fecha o furo de pid-null (achado Codex challenge C).
--   [post]    postcondition: aborta se sobrar QUALQUER dup (account, omie_pedido_id)
--             hash-not-null+pid-not-null (defesa se o índice já existir com def errada).
--
-- Idempotente: re-rodar deleta 0 (predicado exige par 'omie_'); índice IF NOT EXISTS;
-- guard NÃO aborta em 0 (achado Codex challenge E). Teto 600 protege contra deletar demais.
-- Validação pós-apply (pg_get_indexdef) vai no handoff lovable-db-operator (challenge A4).
-- ============================================================

BEGIN;

-- [lock] anti-race com o sync de entrada (que continua ativo durante a migration).
LOCK TABLE public.sales_orders IN SHARE ROW EXCLUSIVE MODE;

-- [alvo]
CREATE TEMP TABLE _b_denamespaced ON COMMIT DROP AS
SELECT a.id, a.account, a.omie_pedido_id, a.checkout_id, a.origem, a.atendimento_id
FROM public.sales_orders a
WHERE a.hash_payload IS NOT NULL
  AND a.hash_payload NOT LIKE 'omie\_%'
  AND a.omie_pedido_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.sales_orders b
    WHERE b.account = a.account
      AND b.omie_pedido_id = a.omie_pedido_id
      AND b.hash_payload LIKE 'omie\_%'
  );

-- [guard] teto; NÃO aborta em 0 (idempotência).
DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _b_denamespaced;
  IF n > 600 THEN
    RAISE EXCEPTION 'Cleanup #B abortado: % linhas de-namespaced (>600, fora da faixa segura)', n;
  END IF;
  RAISE NOTICE 'Cleanup #B: removendo % linhas de-namespaced', n;
END
$guard$;

-- [sph] deletar os price-history dos losers (duplicata espúria; canônica preserva o legítimo).
DELETE FROM public.sales_price_history WHERE sales_order_id IN (SELECT id FROM _b_denamespaced);

-- [delete] remover as de-namespaced (order_items CASCADE; production_orders SET NULL).
DELETE FROM public.sales_orders WHERE id IN (SELECT id FROM _b_denamespaced);

-- [push] AGORA, com o loser já deletado: copia o bundle de proveniência (snapshot no temp) p/ a
--        canônica. Deletar antes evita o 23505 do UNIQUE (checkout_id, account) (Codex re-challenge).
UPDATE public.sales_orders canon
SET checkout_id    = COALESCE(canon.checkout_id, den.checkout_id),
    origem         = COALESCE(canon.origem, den.origem),
    atendimento_id = COALESCE(canon.atendimento_id, den.atendimento_id)
FROM _b_denamespaced den
WHERE canon.account = den.account
  AND canon.omie_pedido_id = den.omie_pedido_id
  AND canon.hash_payload LIKE 'omie\_%'
  AND (den.checkout_id IS NOT NULL OR den.origem IS NOT NULL OR den.atendimento_id IS NOT NULL);

-- [índice] identidade imutável (correção estrutural — guard na coluna certa).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_omie_pedido_id
  ON public.sales_orders (account, omie_pedido_id)
  WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;

-- [post] postcondition: 0 dups residuais (defesa se o índice já existia com definição errada).
DO $post$
DECLARE d int;
BEGIN
  SELECT count(*) INTO d FROM (
    SELECT account, omie_pedido_id
    FROM public.sales_orders
    WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL
    GROUP BY account, omie_pedido_id
    HAVING count(*) > 1
  ) x;
  IF d > 0 THEN
    RAISE EXCEPTION 'Cleanup #B postcondition FALHOU: % grupos (account, omie_pedido_id) ainda duplicados', d;
  END IF;
  RAISE NOTICE 'Cleanup #B postcondition OK: 0 dups residuais';
END
$post$;

COMMIT;
