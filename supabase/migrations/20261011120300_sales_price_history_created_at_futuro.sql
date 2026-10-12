-- M-13 (plano 2026-09-05, Lote D): sales_price_history sem created_at no futuro
--
-- Medido via psql-ro (2026-10-11): 5 de 72.657 linhas com created_at = 2120-10-25 00:00 UTC, todas do
-- pedido Omie 4271675609 (colacor), cujo sales_orders.created_at é 2021-10-15 12:00 UTC.
--
-- O writer: meia-noite UTC é a assinatura do writer LEGADO (upsert do omie-analytics-sync, já aposentado
-- — "poluía sales_price_history", omie-analytics-sync/index.ts:2679). O writer de hoje é a RPC
-- criar_pedidos_com_itens, que grava created_at = o do pedido pai (G6, meio-dia UTC da data canônica);
-- sales_orders e order_items têm 0 linhas no futuro. Nenhum leitor money-path usa esta tabela
-- (edge-money-path-invariants.test.ts barra), então o dano era em histórico/telas de preço.
--
-- O que muda:
--   1. as linhas no futuro herdam o created_at do PEDIDO PAI (mesma regra do G6) — só quando o pai
--      existe e está no presente;
--   2. CHECK created_at <= now() + interval '1 day'. now() num CHECK é aceito pelo Postgres e é seguro
--      NESTE sentido: uma linha que passa ao entrar continua passando para sempre (o limite só cresce),
--      então dump/restore e re-validação nunca a reprovam.
--   Efeito no writer: um pedido Omie com data no futuro passa a falhar ALTO na RPC (G8 grava em `failed`
--   com SQLSTATE 23514) em vez de entrar com preço datado de 2120.
--
-- Aplicar: SQL Editor do Lovable (o arquivo traz a transação). Idempotente: o UPDATE só pega linha no
-- futuro e o CHECK só é criado se ausente. Linha no futuro SEM pai faz o VALIDATE abortar tudo (alto).
-- Reversão: ALTER TABLE public.sales_price_history DROP CONSTRAINT sales_price_history_created_at_nao_futuro;
-- Prova: db/test-sales-price-history-created-at-futuro.sh (PG17, controle + falsificação).

BEGIN;

UPDATE public.sales_price_history h
   SET created_at = so.created_at
  FROM public.sales_orders so
 WHERE so.id = h.sales_order_id
   AND h.created_at > now() + interval '1 day'
   AND so.created_at <= now() + interval '1 day';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_price_history'::regclass
                    AND conname = 'sales_price_history_created_at_nao_futuro') THEN
    ALTER TABLE public.sales_price_history
      ADD CONSTRAINT sales_price_history_created_at_nao_futuro
      CHECK (created_at <= now() + interval '1 day') NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.sales_price_history VALIDATE CONSTRAINT sales_price_history_created_at_nao_futuro;

-- Pós-condição: 0 linhas no futuro e o CHECK existe VALIDADO.
DO $post$
DECLARE v_futuro int; v_ok int;
BEGIN
  SELECT count(*) INTO v_futuro FROM public.sales_price_history WHERE created_at > now() + interval '1 day';
  SELECT count(*) INTO v_ok FROM pg_constraint
   WHERE conrelid = 'public.sales_price_history'::regclass
     AND conname = 'sales_price_history_created_at_nao_futuro' AND contype = 'c' AND convalidated;
  IF v_futuro <> 0 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'M13_POS_FALHOU futuro=% check_validado=%', v_futuro, v_ok;
  END IF;
END
$post$;

COMMIT;
