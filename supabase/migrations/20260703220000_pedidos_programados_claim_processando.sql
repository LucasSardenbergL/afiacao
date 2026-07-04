-- ============================================================
-- Pedidos programados — claim transitório 'processando' + watchdog de claim órfão
-- + UNIQUE (envio, account) em sales_orders.
-- Follow-up formal do PR #1158 (recomendação Codex gpt-5.5 xhigh): fecha POR
-- CONSTRUÇÃO a corrida edge×edge e o residual cancelamento-vs-edge-em-voo.
-- Prova PG17: db/test-pedidos-programados-claim.sh
--
-- 4 partes (transação única — erro no meio não deixa estado parcial):
--   1. CHECK de status do envio ganha 'processando' (claim atômico do edge:
--      UPDATE … SET status='processando' WHERE status IN ('agendado','erro');
--      0 linhas = outro runner/cancelamento venceu → skip). Evolução GUARDADA
--      POR DEFINIÇÃO: só dropa a constraint se a atual NÃO contém 'processando'
--      — re-run é no-op e NUNCA dropa uma constraint mais nova (regra do repo:
--      nunca DROP+ADD cego; ver 20260617091500).
--   2. Watchdog de claim órfão: crash do runner entre claim e release deixaria
--      'processando' pra sempre (invisível pro cron, incancelável). Função SQL
--      pura + cron */10 revertem claims com updated_at parado há >15 min para
--      'erro' COM o marcador [OMIE-INCERTO]: o crash pode ter sido pós-fetch
--      (PV criado no Omie sem write-back) — o guard de cancelamento client-side
--      bloqueia ao vê-lo (precisão > recall; "Enviar agora" é o caminho seguro,
--      idempotente). 15 min porque o wall-clock máximo de edge function é ~400s:
--      claim mais velho que isso é runner comprovadamente morto — o watchdog
--      nunca disputa com um runner vivo. Por TIMESTAMP (now() - interval),
--      nunca CURRENT_DATE (database.md §4).
--   3. sales_orders.pedido_programado_envio_id (FK) + UNIQUE parcial
--      (envio, account): o vínculo hoje vive só no jsonb sales_orders_map do
--      envio — dois runners no MESMO envio criariam 2 sales_orders → 2 chaves
--      PV_${id} → pedido DUPLICADO REAL no Omie. A coluna faz a constraint
--      morder no MESMO INSERT que cria o sales_order (23505 → o edge converge
--      pro existente); tabela de vínculo abriria janela de 2 statements.
--      FK sem ON DELETE de propósito (fail-closed: apagar um envio que gerou
--      sales_order deve gritar, não desvincular silencioso).
--   4. Backfill do vínculo a partir do sales_orders_map existente (verificado
--      em prod 2026-07-03: 0 entradas no map → no-op hoje; defensivo caso o
--      cron crie envios com map entre o merge e o apply).
--
-- ⚠️ ORDEM DE DEPLOY: esta migration ANTES do redeploy do edge
--    pedido-programado-enviar (o edge novo grava 'processando' — sem o CHECK
--    novo o claim falharia 23514 e NENHUM envio seria processado). O edge
--    antigo nunca escreve 'processando' — inócuo rodar dias com migration
--    aplicada e edge velho.
-- ⚠️ Se o CREATE UNIQUE INDEX falhar com "could not create unique index …
--    duplicate key": JÁ existe par (envio, account) duplicado em sales_orders
--    → risco real de PV duplicado no Omie. NÃO forçar o índice — me avise
--    para investigar antes.
-- ============================================================

BEGIN;

-- ── 1. CHECK de status: + 'processando' (evolução guardada por definição) ──
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'pedidos_programados_envios'
    AND con.conname = 'pedidos_programados_envios_status_check';
  -- Só dropa se a definição atual NÃO cobre 'processando' (nunca a mais nova).
  IF def IS NOT NULL AND def NOT LIKE '%processando%' THEN
    ALTER TABLE public.pedidos_programados_envios
      DROP CONSTRAINT pedidos_programados_envios_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'pedidos_programados_envios'
      AND con.conname = 'pedidos_programados_envios_status_check'
  ) THEN
    ALTER TABLE public.pedidos_programados_envios
      ADD CONSTRAINT pedidos_programados_envios_status_check
      CHECK (status IN ('agendado','processando','enviado','erro','cancelado'));
  END IF;
END $$;

-- ── 2. Watchdog de claims órfãos (função SQL pura + cron, sem net.http_post) ──
CREATE OR REPLACE FUNCTION public.pedidos_programados_watchdog_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  -- Claim órfão = runner morreu entre claim e release. O crash pode ter sido
  -- DEPOIS de tocar o Omie (PV criado sem write-back) → [OMIE-INCERTO]
  -- obrigatório: o cancelamento client-side bloqueia até humano conferir.
  -- updated_at é bumpado pelo trigger upd_pp_envios em todo UPDATE do runner
  -- (claim, sales_orders_map) — 15 min parado = morto, nunca um runner vivo.
  UPDATE public.pedidos_programados_envios
     SET status = 'erro',
         erro_motivo = '[OMIE-INCERTO] Runner morreu no meio do envio (claim ''processando'' órfão há mais de 15 min). O pedido PODE existir no Omie sem registro aqui — confira no Omie ou use "Enviar agora" (idempotente). Não cancele sem conferir.'
   WHERE status = 'processando'
     AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Cron-only: nenhum role do app chama isto (muta status money-path).
REVOKE EXECUTE ON FUNCTION public.pedidos_programados_watchdog_claims() FROM anon, authenticated, PUBLIC;

SELECT cron.unschedule('pedidos-programados-watchdog')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pedidos-programados-watchdog');

SELECT cron.schedule(
  'pedidos-programados-watchdog',
  '*/10 * * * *',
  $$ SELECT public.pedidos_programados_watchdog_claims(); $$
);

-- ── 3. Vínculo forte sales_order ← envio ──
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS pedido_programado_envio_id uuid
    REFERENCES public.pedidos_programados_envios(id);

-- ── 4. Backfill a partir do sales_orders_map (idempotente; no-op com map vazio) ──
-- Guard de regex antes do cast: valor não-uuid no map (não deveria existir —
-- single-writer) não pode explodir a transação inteira do apply.
UPDATE public.sales_orders so
   SET pedido_programado_envio_id = e.id
  FROM public.pedidos_programados_envios e
 CROSS JOIN LATERAL jsonb_each_text(e.sales_orders_map) kv
 WHERE so.pedido_programado_envio_id IS NULL
   AND kv.value ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
   AND so.id = kv.value::uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_pp_envio_account
  ON public.sales_orders (pedido_programado_envio_id, account)
  WHERE pedido_programado_envio_id IS NOT NULL;

COMMIT;
