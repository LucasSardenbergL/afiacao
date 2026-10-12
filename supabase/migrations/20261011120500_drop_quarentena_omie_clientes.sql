-- M-18 (plano 2026-09-05, Lote D): DROP da quarentena public._quarantine_omie_clientes_20260722
--
-- A quarentena (20260722110000, Fatia 5B do P0-B-bis) RENOMEOU o espelho omie_clientes em vez de dropar
-- (veto do /codex challenge) e deixou o DROP "só após um ciclo completo sem erro — ver o PR de fecho".
-- Este é o PR de fecho. Evidência do ciclo (psql-ro, 2026-10-11 — 81 dias depois):
--   * nenhuma função (pg_proc), view, cron ou edge/src referencia `omie_clientes` pelo nome (os 2 hits
--     de regex são de outra tabela, omie_clientes_nao_vinculados); a última leitura de edge saiu na
--     Fatia 5 (omie-analytics-sync/index.ts:300);
--   * 0 escrita desde a quarentena: max(updated_at) = 2026-07-18 05:02 UTC; anon/authenticated sem grant;
--   * o last_idx_scan "de hoje" era o próprio count(*) do pré-voo (medido: subiu 408196 → 408197 com a
--     minha leitura); o último seq_scan (2026-10-01) bate com as medições do plano de melhorias.
--
-- BACKUP LÓGICO (registrado): ~/afiacao-backups/2026-10-11-m18/ no Mac do founder — CSV (6909 linhas,
-- sha256 5729ef36…8bd), ddl.sql e README. Restauração PROVADA em PG17 local: ddl + CSV devolvem o MESMO
-- md5 de conteúdo que o banco calcula (8c050bbe3007457fc85a48b4d04a8459, em UTC).
--
-- TRAVA: o DROP só roda se a tabela for EXATAMENTE a do backup (count 6909 + md5 de conteúdo acima). Se
-- algo mudou depois do backup, a migration aborta em vez de dropar dado sem cópia.
-- Fica para trás (de propósito): a função public.tg_omie_clientes_to_ledger, que fica sem gatilho —
-- remover é outro PR, se ninguém mais a usar.
--
-- Aplicar: SQL Editor do Lovable — DDL DESTRUTIVO, é do founder (database.md §1). Idempotente: se a
-- tabela já não existe, a trava e o DROP viram no-op. Reversão: o README do backup.
-- Prova: db/test-drop-quarentena-omie-clientes.sh (PG17: trava por count e por md5, idempotência, falsificação).

BEGIN;

SET LOCAL timezone = 'UTC';   -- o md5 abaixo é do texto de timestamptz em UTC

DO $pre$
DECLARE v_n bigint; v_md5 text;
BEGIN
  IF to_regclass('public._quarantine_omie_clientes_20260722') IS NULL THEN
    RETURN;   -- já dropada: re-colar é no-op
  END IF;
  EXECUTE $q$SELECT count(*), md5(string_agg(t::text, E'\n' ORDER BY t.id))
              FROM public._quarantine_omie_clientes_20260722 t$q$ INTO v_n, v_md5;
  IF v_n <> 6909 OR v_md5 IS DISTINCT FROM '8c050bbe3007457fc85a48b4d04a8459' THEN
    RAISE EXCEPTION 'M18_TRAVA: tabela difere do backup (n=% md5=%) — refazer o backup antes do DROP', v_n, v_md5;
  END IF;
END
$pre$;

DROP TABLE IF EXISTS public._quarantine_omie_clientes_20260722;

DO $post$
BEGIN
  IF to_regclass('public._quarantine_omie_clientes_20260722') IS NOT NULL THEN
    RAISE EXCEPTION 'M18_POS_FALHOU: tabela ainda existe';
  END IF;
END
$post$;

COMMIT;
