-- Recência na FONTE: created_at dos pedidos Omie = DATA DO PEDIDO (order_date_kpi = dInc), nunca
-- previsão de entrega / now() da carga. Money-path (recência -> scoring/OTE, fin-valor-cockpit TTM).
-- Spec: chip recência 2026-06-24 (substitui o adiamento da Fase 2b, que blindou só os consumidores).
--
-- POR QUE (psql-ro 2026-06-24): 100% dos pedidos dos últimos 30d nasciam com created_at::date <>
-- order_date_kpi (colacor 119/119, oben 415/417). A FONTE re-suja a cada sync; o patch manual
-- 20260618130000 (só-colacor) foi anulado em 6 dias. Há 3 WRITERS de order_items.created_at:
--   (1) RPC criar_pedidos_com_itens (G6: já herda do pai) — ok;
--   (2) sync-reprocess (insert sem created_at -> now());
--   (3) omie-analytics-sync sync_all/sync_orders (upsert sem created_at -> now(); cron DIÁRIO).
-- Em vez de consertar cada edge (frágil, não cobre o futuro), um TRIGGER na fronteira universaliza
-- o G6: TODO order_items de pedido Omie herda o created_at do PAI. Decisão founder 2026-06-24
-- (AskUserQuestion: trigger vs consertar-writers -> trigger) + Codex challenge high. O PAI
-- (sales_orders.created_at) tem 1 só writer (omie-vendas-sync), corrigido no edge na mesma entrega.
--
-- Provado em PG17 local com falsificação: db/test-recencia-fonte-trigger-backfill.sh.
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar TUDO no SQL Editor -> Run.
-- ⚠️ ORDEM DE ROLLOUT (Codex): deploy do edge omie-vendas-sync ANTES desta migration (senão pais
--    novos nascem sujos no intervalo e os filhos herdam o pai sujo). Esta migration é idempotente
--    (re-colar afeta 0 linhas); um 2º apply após o edge no ar fecha qualquer resíduo.
-- Fórmula timezone-safe: created_at = MEIO-DIA UTC da data do pedido. 12h de folga -> created_at::date
--    bate order_date_kpi tanto em UTC (edge) quanto em America/Sao_Paulo (app). Meia-noite UTC recuaria
--    1 dia em fuso negativo (falsificação F3).

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- PARTE A — TRIGGER: order_items.created_at = created_at do PAI (só pedidos Omie). Guard de fronteira.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER: a invariante money-path tem de valer para QUALQUER writer (sync-reprocess,
--   omie-analytics-sync, futuros), independente do RLS/privilégio do invoker. A função é read-only do
--   PAI (por id uuid tipado) + set NEW.created_at — NÃO escreve em outra tabela, NÃO roda SQL dinâmico,
--   NÃO recebe texto livre: zero vetor de escalação (≠ G1 da RPC, onde DEFINER seria write-primitive à toa).
-- Restrito a hash 'omie_%': pedido do app já nasce com created_at = data real (now() do app) e fica
--   intocado. Idempotente vs a RPC (reescreve com o MESMO valor que o G6 já passa).
CREATE OR REPLACE FUNCTION public.order_items_herdar_created_at_omie()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pai_created_at timestamptz;
  v_pai_hash       text;
BEGIN
  SELECT created_at, hash_payload
    INTO v_pai_created_at, v_pai_hash
    FROM public.sales_orders
   WHERE id = NEW.sales_order_id;

  -- Só pedido Omie com pai conhecido: o filho nasce com a DATA DO PEDIDO (= created_at do pai =
  -- meio-dia UTC do order_date_kpi), nunca now() da carga. LIKE 'omie\_%' com escape literal (mesmo
  -- predicado do índice parcial uniq_sales_orders_omie_hash). Pai ausente/não-Omie -> NEW intacto.
  IF v_pai_hash LIKE 'omie\_%' AND v_pai_created_at IS NOT NULL THEN
    NEW.created_at := v_pai_created_at;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.order_items_herdar_created_at_omie() IS
  'Trigger BEFORE INSERT order_items: pedido Omie (hash omie_) herda created_at do PAI (data do pedido, '
  'nunca now() da carga). Universaliza o G6 da RPC criar_pedidos_com_itens p/ TODOS os writers '
  '(sync-reprocess, omie-analytics-sync). Money-path/recência — migration 20260624170000.';

-- Trigger function não é chamável diretamente: revogar EXECUTE (defesa, DEFINER).
REVOKE ALL ON FUNCTION public.order_items_herdar_created_at_omie() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_order_items_created_at_omie ON public.order_items;
CREATE TRIGGER trg_order_items_created_at_omie
  BEFORE INSERT ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.order_items_herdar_created_at_omie();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- PARTE B — BACKFILL do HISTÓRICO já gravado (oben + colacor; o gate #B caiu no PR #955).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- PAI PRIMEIRO, FILHOS DEPOIS (Codex): minimiza a janela onde um insert concorrente herdaria um pai
--   ainda sujo. Atômico (BEGIN/COMMIT). Predicado UTC **OR** SP (Codex): pega a linha que diverge em
--   QUALQUER fuso lido pelos consumidores (a MV usa SP; created_at=2026-06-10T00:00Z bate em UTC mas
--   vira 06-09 em SP). Fonte do filho = so.order_date_kpi (canônica), não so.created_at (robusto).
-- Idempotente: após a 1ª passada, (UTC OR SP) deixa de casar -> 0 linhas. NÃO toca order_date_kpi,
--   nem pedido não-Omie, nem order_date_kpi nulo.
BEGIN;

-- 1) sales_orders (PAI)
UPDATE public.sales_orders
   SET created_at = ((order_date_kpi + time '12:00') AT TIME ZONE 'UTC')
 WHERE account IN ('colacor', 'oben')
   AND hash_payload LIKE 'omie\_%'
   AND order_date_kpi IS NOT NULL
   AND ( (created_at AT TIME ZONE 'UTC')::date              <> order_date_kpi
      OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date <> order_date_kpi );

-- 2) order_items (FILHOS) — herdam a data canônica do pedido (pai já corrigido acima)
UPDATE public.order_items oi
   SET created_at = ((so.order_date_kpi + time '12:00') AT TIME ZONE 'UTC')
  FROM public.sales_orders so
 WHERE oi.sales_order_id = so.id
   AND so.account IN ('colacor', 'oben')
   AND so.hash_payload LIKE 'omie\_%'
   AND so.order_date_kpi IS NOT NULL
   AND ( (oi.created_at AT TIME ZONE 'UTC')::date              <> so.order_date_kpi
      OR (oi.created_at AT TIME ZONE 'America/Sao_Paulo')::date <> so.order_date_kpi );

COMMIT;
