-- Crédito-IA PR 5 (1/2) — índices do vínculo PV→título que a sombra lê a cada lote.
-- Migration SEPARADA de propósito (Codex diff P1): o `db:aplicar` envolve o arquivo numa transação,
-- e o lock de `CREATE INDEX` (incompatível com INSERT/UPDATE/DELETE) dura até o COMMIT. Sozinhos, os
-- dois índices travam a escrita só durante a construção (~32 mil + ~45 mil linhas, sub-segundo); junto
-- da migration da sombra, travariam `sales_orders` durante a carga e as pós-condições.
-- Idempotente. Sem BEGIN/COMMIT (a transação é do executor). Prova: db/test-credito-sombra.sh.

CREATE INDEX IF NOT EXISTS sales_orders_account_numero_pedido_idx
  ON public.sales_orders (account, omie_numero_pedido);
CREATE INDEX IF NOT EXISTS fin_contas_receber_company_numero_pedido_idx
  ON public.fin_contas_receber (company, numero_pedido) WHERE numero_pedido IS NOT NULL;

DO $pos$
BEGIN
  IF (SELECT count(*) FROM pg_index i
       WHERE i.indexrelid IN ('public.sales_orders_account_numero_pedido_idx'::regclass,
                              'public.fin_contas_receber_company_numero_pedido_idx'::regclass)
         AND i.indisvalid AND i.indisready) <> 2 THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra-indices: índice ausente ou inválido';
  END IF;
  RAISE NOTICE 'POSCONDICAO credito-sombra-indices OK';
END
$pos$;
