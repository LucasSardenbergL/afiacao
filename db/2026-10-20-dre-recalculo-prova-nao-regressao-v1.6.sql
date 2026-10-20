-- ============================================================================================
-- Prova de não-regressão do #3234 (omie-financeiro v1.6, títulos do DRE por keyset)  [money-path]
--
-- O QUE: executa AGORA o comando do próprio job `fin-dre-recalculo-diario` (jobid 215), lido de
-- cron.job — mesmo recorte que gravou a baseline às 15:30 UTC de hoje com a edge v1.5:
-- competência dos 12 meses fechados + corrente e caixa do anterior + corrente, 3 empresas.
-- Ler o comando do cron (em vez de reescrevê-lo) garante escopo idêntico ao da baseline.
--
-- Idempotente: a edge faz upsert (company,ano,mes,regime) — rodar de novo só recalcula.
-- O job já pula (empresa, mês) com fechamento ≠ 'aberto' (0 fechamentos em prod, psql-ro hoje).
--
-- APLICAR: bun run db:aplicar db/2026-10-20-dre-recalculo-prova-nao-regressao-v1.6.sql
-- VALIDAR (psql-ro, ~3 min depois): net._http_response dos ids do NOTICE = 200; snapshots com
--   calculated_at > envio comparados com a baseline (meses fechados devem bater).
-- ============================================================================================

DO $prova$
DECLARE
  v_cmd   text;
  v_antes bigint;
  v_ids   bigint[];
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'fin-dre-recalculo-diario' AND active;
  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'R0 FALHOU: job fin-dre-recalculo-diario ausente ou inativo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' AND decrypted_secret IS NOT NULL) THEN
    RAISE EXCEPTION 'R1 FALHOU: CRON_SECRET ausente no vault — nenhuma chamada enfileirada';
  END IF;

  SELECT coalesce(max(id), 0) INTO v_antes FROM net.http_request_queue;
  EXECUTE v_cmd;

  -- Postcondição: 12 chamadas desta execução na fila (3 empresas × (2 competência por ano + 2 caixa)),
  -- todas para a omie-financeiro. O pg_net só dispara após o COMMIT.
  SELECT array_agg(q.id ORDER BY q.id) INTO v_ids
    FROM net.http_request_queue q
   WHERE q.id > v_antes AND q.url LIKE '%/functions/v1/omie-financeiro';
  IF coalesce(cardinality(v_ids), 0) IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'R2 FALHOU: % chamadas enfileiradas, esperado 12', coalesce(cardinality(v_ids), 0);
  END IF;
  RAISE NOTICE 'recalculo da prova enfileirado, ids pg_net: %', v_ids;
END
$prova$;
