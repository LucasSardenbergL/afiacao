-- Migration: índices que faltam em 4 tabelas lidas por seq scan (plano v4, lote 7 — itens B4, B5, B6, B7).
-- Plano: docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md. Puramente ADITIVA: só CREATE INDEX
-- IF NOT EXISTS, nenhuma escrita de dado, nenhuma função/policy tocada.
-- ⚠️ NÃO auto-aplica (nome custom). Caminho: `bun run db:aplicar <este arquivo> --ensaio`, depois sem
-- --ensaio (a transação e o lock_timeout 15s vêm do executor). Fallback: SQL Editor do Lovable, que roda a
-- colagem inteira numa transação implícita — por isso o arquivo não leva BEGIN/COMMIT.
--
-- Por que SEM `CONCURRENTLY`: ele não roda dentro de transação nenhuma, e os dois caminhos acima são
-- transacionais (o db:aplicar o recusa: RECUSA_FORA_DE_TRANSACAO). O CREATE INDEX comum pega SHARE lock:
-- LEITURA segue normal; só ESCRITA na tabela espera o build. Medido na prod em 2026-11-01: a maior tabela é
-- tint_importacoes (116.586 linhas, 35 MB) e sales_orders tem 32.155 linhas (39 MB) — build de fração de
-- segundo. O lock_timeout abaixo impede que o CREATE fique na fila atrás de uma transação longa segurando a
-- escrita de todo mundo: se não pegar o lock em 10 s, aborta inteiro (nada meio-aplicado) e é só re-rodar.
--
-- Evidência (psql-ro, 2026-11-01; contadores de pg_stat_user_tables desde o restart de 2026-10-31):
--   B6 sales_orders(customer_user_id, created_at DESC): 20.918 seq scans e nenhum índice com
--      customer_user_id. As 9 leituras de src/ filtram `.eq('customer_user_id')`; o cliente mediano (5
--      pedidos) custa Seq Scan de 4.962 buffers / 11,9 ms. O plano GENÉRICO ($1) anda o
--      idx_sales_orders_active inteiro filtrando o cliente. Índice COMPLETO, não parcial: a policy
--      sales_orders_select_customer não tem `deleted_at IS NULL` (e hoje há 0 linhas deletadas, então o
--      parcial não economizaria nada). created_at DESC na 2ª coluna serve o `.order(created_at desc).limit(n)`
--      de 5 das 9 leituras sem sort (o maior cliente tem 1.129 pedidos).
--   B5 fin_sync_log(action, status, completed_at DESC): 5.108 seq scans, 24.150 linhas, só índice em
--      started_at. Seq Scan + sort de 1.442 buffers / 8 ms nos hooks useUtiContas e useAlertaCreditoCliente.
--      Sem predicado parcial: o PostgREST manda `status` como parâmetro, e um índice `WHERE status='complete'`
--      não pode ser provado contra `status = $1` no plano genérico. Com `action` na frente, o mesmo índice
--      serve as funções da prod que leem `action = X AND status = 'complete'` (fin_sync_heartbeat,
--      venda_prazo_aviso, cobranca_quitacao_ok, venda_sync_dia_coberto).
--   B4 tint_importacoes(account, created_at DESC): 141 seq scans × 116 k linhas; Seq Scan + sort de 60 ms em
--      TintDashboard e useTintometricoZone (`.eq('account').order('created_at desc').limit(1|3)`). Só o
--      índice; o expurgo da tabela é o lote 12.
--   B7 addresses(user_id): 3.637 seq scans, 9.626 linhas, só a pkey. Seq Scan de 57 buffers / 1 ms por
--      leitura `.eq('user_id')` (1 endereço por usuário); com o índice, ~3 buffers. Ganho absoluto pequeno,
--      custo também (~300 kB, tabela quase sem escrita).
--
-- Pós-condição: o DO $post$ no fim exige cada índice com a DEFINIÇÃO esperada (um homônimo com outras
-- colunas faria o IF NOT EXISTS pular em silêncio), válido e pronto.

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_created
  ON public.sales_orders (customer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fin_sync_log_action_status_completed
  ON public.fin_sync_log (action, status, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_tint_importacoes_account_created
  ON public.tint_importacoes (account, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_addresses_user_id
  ON public.addresses (user_id);

DO $post$
DECLARE
  v_esperado constant text[][] := ARRAY[
    ['idx_sales_orders_customer_created',
     'CREATE INDEX idx_sales_orders_customer_created ON public.sales_orders USING btree (customer_user_id, created_at DESC)'],
    ['idx_fin_sync_log_action_status_completed',
     'CREATE INDEX idx_fin_sync_log_action_status_completed ON public.fin_sync_log USING btree (action, status, completed_at DESC)'],
    ['idx_tint_importacoes_account_created',
     'CREATE INDEX idx_tint_importacoes_account_created ON public.tint_importacoes USING btree (account, created_at DESC)'],
    ['idx_addresses_user_id',
     'CREATE INDEX idx_addresses_user_id ON public.addresses USING btree (user_id)']
  ];
  v_def text;
  v_ok boolean;
BEGIN
  FOR i IN 1 .. array_length(v_esperado, 1) LOOP
    SELECT pg_get_indexdef(x.indexrelid), x.indisvalid AND x.indisready
      INTO v_def, v_ok
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class c ON c.oid = x.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_esperado[i][1];
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'POS: índice % não existe — a leitura segue em seq scan', v_esperado[i][1];
    END IF;
    IF v_def IS DISTINCT FROM v_esperado[i][2] THEN
      RAISE EXCEPTION 'POS: índice % existe com outra definição (%) — o IF NOT EXISTS o pulou', v_esperado[i][1], v_def;
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'POS: índice % inválido ou não pronto — o planner não o usa', v_esperado[i][1];
    END IF;
  END LOOP;
  RAISE NOTICE 'POS ok: 4 índices do lote 7 válidos e com a definição esperada';
END
$post$;
