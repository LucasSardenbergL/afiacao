-- ============================================================================================
-- Desfabricar o AUTOR dos pedidos importados do Omie (venda por cliente · rodada 2 · Entrega 2).
-- Registro: docs/historico/vendedor-pedido-omie.md · Migration-mãe: 20261113120000_vendedor_pedido_omie
--
-- Todo importado (hash_payload omie_*) tinha em `created_by` o 1º `profiles.is_employee` que o
-- PostgREST devolvia ao sync — assinatura do sync, não autoria (prod 2026-11-12: Tatyana 30.447,
-- Lucas 1.863). A edge v1.37 já grava NULL; este script alinha o acervo.
--
-- ORDEM: depois da migration 20261113120000 (created_by nullable) E do deploy ATESTADO da edge
-- `omie-vendas-sync` v1.37 — antes disso a edge velha re-fabricaria a cada 2h. Re-rodar é seguro
-- (idempotente): pega só o que ainda tem autor.
--
-- Reversível: o valor anterior fica em private.bkp_sales_orders_created_by_20261113 (id → created_by).
-- Leitores conferidos (2026-11-12): nenhuma RLS/view/ranking lê sales_orders.created_by; o único
-- leitor SQL (venda_prazo_decisao_registrar, gate "pedido é meu") tem 0 linhas e fica fail-closed
-- (só carteira completa) para importado; useTeamKpis já exclui importados (hash_payload IS NULL).
--
-- Caminho: `bun run db:aplicar` (transação do executor — sem BEGIN/COMMIT aqui).
-- ============================================================================================

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'sales_orders'
                AND column_name = 'created_by' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'PRE FALHOU: created_by ainda NOT NULL — aplique 20261113120000_vendedor_pedido_omie antes';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS private.bkp_sales_orders_created_by_20261113 (
  sales_order_id uuid PRIMARY KEY,
  created_by     uuid NOT NULL,
  salvo_em       timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.bkp_sales_orders_created_by_20261113 FROM PUBLIC, anon, authenticated;

INSERT INTO private.bkp_sales_orders_created_by_20261113 (sales_order_id, created_by)
SELECT so.id, so.created_by
  FROM public.sales_orders so
 WHERE so.hash_payload LIKE 'omie\_%'
   AND so.created_by IS NOT NULL
ON CONFLICT (sales_order_id) DO NOTHING;

-- Só anula o que está NO BACKUP com o MESMO valor: reversível por construção.
UPDATE public.sales_orders so
   SET created_by = NULL
 WHERE so.hash_payload LIKE 'omie\_%'
   AND so.created_by IS NOT NULL
   AND EXISTS (SELECT 1 FROM private.bkp_sales_orders_created_by_20261113 b
                WHERE b.sales_order_id = so.id AND b.created_by = so.created_by);

DO $post$
DECLARE
  v_resta bigint;
BEGIN
  -- Zero com autor ⇒ todo anulado passou pelo filtro do backup (o UPDATE exige a linha lá).
  SELECT count(*) INTO v_resta
    FROM public.sales_orders WHERE hash_payload LIKE 'omie\_%' AND created_by IS NOT NULL;
  IF v_resta IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % importado(s) ainda com created_by', v_resta;
  END IF;
  RAISE NOTICE 'desfabricar_autor_importado: 0 importados com autor';
END
$post$;

SELECT 'DESFABRICAR_AUTOR_IMPORTADO_OK' AS marcador,
       (SELECT count(*) FROM private.bkp_sales_orders_created_by_20261113) AS no_backup;
