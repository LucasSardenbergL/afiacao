-- ============================================================
-- #B (resíduo) — RE-NAMESPACE das órfãs de-namespaced SEM par 'omie_'
--
-- Contexto: o edge sync-reprocess (PRÉ-conserto) reescrevia hash_payload de
-- 'omie_<account>_<pid>' para um hash de CONTEÚDO. A cleanup #B (20260618190000) removeu as
-- de-namespaced que tinham par 'omie_' (dups). Restaram as SEM par — ÓRFÃS criadas entre a
-- medição e a contenção (hoje 4: oben, pids 12104598757/12104601737/12104602329/12104607815,
-- pedidos 11551-11554). Elas são um problema duplo:
--   (a) ÍNDICE/LANDMINE: ocupam (account, omie_pedido_id) no índice uniq_sales_orders_omie_pedido_id
--       com hash NÃO-'omie_' → o omie-vendas-sync, ao tentar inserir a linha 'omie_' real do pedido,
--       leva 23505 (a RPC engole como 'failed' → o pedido NUNCA sincroniza);
--   (b) STATUS MISLABELED: o mapa invertido do reprocess antigo (60→cancelado, mas etapa 60 =
--       faturado) → provável SUBcontagem de positivação.
--
-- Heal = restaurar a IDENTIDADE: hash_payload = 'omie_'||account||'_'||omie_pedido_id. A linha
-- vira a canônica 'omie_' do pedido → o sync a acha por hash (ON CONFLICT DO NOTHING, sem 23505)
-- e o reprocess CONSERTADO reconcilia o status pela etapa ATUAL do Omie (source-truth).
-- ⚠️ NÃO mexe em status aqui — a correção de status é do reprocess (não de DEDUÇÃO).
--
-- ⚠️ PRÉ-REQUISITO: a cleanup #B (20260618190000) e o índice uniq_sales_orders_omie_hash (#929)
--    já aplicados. Idempotente: re-rodar casa 0 (após re-namespace, hash LIKE 'omie\_%' → excluído).
-- Provado em PG17 (db/test-b-renamespace-orfaos.sh) com falsificação.
-- ============================================================

BEGIN;

-- anti-race com o sync de entrada (segue ativo) — não cria um 'omie_' do mesmo pid no meio.
LOCK TABLE public.sales_orders IN SHARE ROW EXCLUSIVE MODE;

-- [alvo] de-namespaced (hash NÃO-NULL e NÃO-'omie_') com pid e SEM par 'omie_' (órfã).
-- Assinatura EXCLUSIVA do bug (sync grava 'omie_%', PUSH grava NULL). O NOT EXISTS é defesa: o
-- índice uniq_sales_orders_omie_pedido_id já garante ≤1 linha hash-not-null por (account, pid),
-- mas mantém a migration segura mesmo se o índice não existir.
CREATE TEMP TABLE _b_orfaos ON COMMIT DROP AS
SELECT a.id, a.account, a.omie_pedido_id
FROM public.sales_orders a
WHERE a.hash_payload IS NOT NULL
  AND a.hash_payload NOT LIKE 'omie\_%'
  AND a.omie_pedido_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.sales_orders b
    WHERE b.account = a.account
      AND b.omie_pedido_id = a.omie_pedido_id
      AND b.hash_payload LIKE 'omie\_%'
  );

-- [guard] teto baixo (são ~4; >50 = anomalia). NÃO aborta em 0 (idempotência). E aborta se 2+
-- órfãs no MESMO (account, pid) — re-namespeá-las geraria hash idêntico → colisão (investigar).
DO $guard$
DECLARE n int; c int;
BEGIN
  SELECT count(*) INTO n FROM _b_orfaos;
  IF n > 50 THEN
    RAISE EXCEPTION 'Re-namespace #B abortado: % órfãs (>50, fora da faixa segura)', n;
  END IF;
  SELECT count(*) INTO c FROM (
    SELECT 1 FROM _b_orfaos GROUP BY account, omie_pedido_id HAVING count(*) > 1
  ) x;
  IF c > 0 THEN
    RAISE EXCEPTION 'Re-namespace #B abortado: % (account,pid) com 2+ órfãs — re-namespace colidiria, investigar', c;
  END IF;
  RAISE NOTICE 'Re-namespace #B: % órfã(s)', n;
END
$guard$;

-- [re-namespace] restaura a identidade imutável do Omie.
UPDATE public.sales_orders s
SET hash_payload = 'omie_' || s.account || '_' || s.omie_pedido_id
FROM _b_orfaos o
WHERE s.id = o.id;

-- [post] 0 órfãs de-namespaced restantes (defesa anti-engano).
DO $post$
DECLARE d int;
BEGIN
  SELECT count(*) INTO d
  FROM public.sales_orders s
  WHERE s.hash_payload IS NOT NULL
    AND s.hash_payload NOT LIKE 'omie\_%'
    AND s.omie_pedido_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sales_orders b
      WHERE b.account = s.account AND b.omie_pedido_id = s.omie_pedido_id
        AND b.hash_payload LIKE 'omie\_%'
    );
  IF d > 0 THEN
    RAISE EXCEPTION 'Re-namespace #B postcondition FALHOU: % órfã(s) de-namespaced restante(s)', d;
  END IF;
  RAISE NOTICE 'Re-namespace #B postcondition OK: 0 órfãs restantes';
END
$post$;

COMMIT;
