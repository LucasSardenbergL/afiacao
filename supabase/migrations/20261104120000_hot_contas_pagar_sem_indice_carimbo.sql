-- Migration: devolve o HOT update a fin_contas_pagar (plano v5, lote 11 — D1, só CP).
-- Plano: docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md. Evidência e números:
-- docs/historico/hot-contas-pagar-lote11.md. Prova executada: db/test-hot-contas-pagar.sh.
-- Molde: 20261101222916_hot_carimbo_sync_sem_indice.sql (B2/B9 — mesma causa, mesma cura).
-- ⚠️ NÃO auto-aplica (nome custom). Tem DROP INDEX → é DDL destrutivo, apply do founder:
-- SQL Editor do Lovable (transação implícita da colagem — por isso o arquivo não leva BEGIN/COMMIT).
--
-- O QUE NÃO MUDA: nenhuma coluna, nenhum dado, nenhuma função, nenhuma edge. O carimbo updated_at segue
-- escrito em TODA linha a cada ciclo (contrato de 26 h do _data_health_compute e do fin_sync_heartbeat).
-- Só o CUSTO de cada escrita cai. fin_contas_receber fica FORA de propósito (decisão medida no histórico:
-- com o incremental do B3 o CR caiu de ~91 k para ~9 k updates/dia projetados — 1,4 k/ciclo observado +
-- 1 full semanal —, e o leitor dele custaria 2,3× o do CP).
--
-- Diagnóstico (psql-ro, 2026-11-04 10:58Z; contadores desde o restart de 2026-10-31 10:33Z):
--   fin_contas_pagar  140.777 updates, 0 HOT · 16.322 linhas · 685 páginas · 8 índices
--   o sync de CP é FULL 2×/dia (cron 76, 08:00 e 14:00 UTC): ~16,1 k títulos por ciclo, páginas de 100.
-- O Postgres só faz HOT (versão nova na mesma página, ZERO escrita de índice) quando nenhuma coluna
-- INDEXADA muda. idx_fin_contas_pagar_updated_at (20260615095710) indexa o carimbo, que muda em todo
-- update → nenhum update é HOT → cada um insere uma entrada nos 8 índices da tabela.
-- Leitores do carimbo (varredura de src/, edges e pg_proc da prod): _data_health_compute (max) e
-- getLastSyncTime em src/services/financeiroService.ts (top-1). fin_cr_excluir_confirmados e as views
-- v_titulo_encargos_* leem updated_at por chave — o índice de uma coluna só não serve a elas.
-- Sem o índice: max() = seq scan de 685 páginas, 6,5 ms em cache / 0,6 s numa amostra fria (EXPLAIN
-- ANALYZE na prod); o top-1 sob RLS avalia fin_user_can_access por linha (~0,2–0,3 s em PG17) — o mesmo
-- PR põe as 3 leituras do getLastSyncTime em paralelo, e a de fin_movimentacoes (147 k linhas, também
-- sem índice no carimbo) já é a mais lenta.
--
-- Por que fillfactor 80 junto (medido em PG17, db/test-hot-contas-pagar.sh): o sync regrava a página
-- inteira na MESMA transação; com fillfactor 100 a versão nova não cabe e as linhas fazem ping-pong entre
-- metades da tabela (sem o índice e sem fillfactor, o pior dos ciclos 6–8 fica em 89%; com 80, ≥ 99,7%).
-- O fillfactor não redistribui as linhas de hoje: passa a valer em cada página que receber inserção ou
-- relocação, e a tabela converge sozinha em ~5 ciclos (≈ 2,5 dias a 2 ciclos/dia). Sem VACUUM FULL/
-- pg_repack: pegariam ACCESS EXCLUSIVE durante a cópia e a prova convergiu sem eles, com o heap parado.
--
-- Lock: DROP INDEX pega ACCESS EXCLUSIVE na TABELA (bloqueia até SELECT) até o fim da transação. NOWAIT:
-- tabela ocupada (upsert do sync, autovacuum) → aborta NA HORA, nada meio-aplicado, é só re-rodar. NOWAIT
-- só limita a ESPERA pelo lock; com ele obtido o resto é catálogo (ALTER … SET (fillfactor) não reescreve)
-- e dura milissegundos. Sem CONCURRENTLY: não roda dentro de transação.
LOCK TABLE public.fin_contas_pagar IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Pré-condição: o índice com esse nome, se existir, é o de fin_contas_pagar — DROP por nome num índice que
-- outra sessão tenha recriado noutra tabela derrubaria o objeto errado.
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index x ON x.indexrelid = c.oid
              WHERE c.oid = to_regclass('public.idx_fin_contas_pagar_updated_at')
                AND x.indrelid <> 'public.fin_contas_pagar'::regclass) THEN
    RAISE EXCEPTION 'PRE: idx_fin_contas_pagar_updated_at existe mas NAO e de fin_contas_pagar — revise antes';
  END IF;
END
$pre$;

DROP INDEX IF EXISTS public.idx_fin_contas_pagar_updated_at;

ALTER TABLE public.fin_contas_pagar SET (fillfactor = 80);

-- Pós-condição: o predicado é a CAUSA, não o nome — nenhum índice (de qualquer nome) que DEPENDA de
-- updated_at, e o fillfactor gravado. pg_depend registra a coluna seja ela chave, INCLUDE, expressão ou
-- predicado parcial. Um índice homônimo recriado, ou outro índice na mesma coluna, devolveria o 0% HOT
-- em silêncio.
DO $post$
DECLARE
  v_tab constant regclass := 'public.fin_contas_pagar'::regclass;
  v_att smallint;
  v_idx text;
BEGIN
  SELECT attnum INTO v_att FROM pg_catalog.pg_attribute
   WHERE attrelid = v_tab AND attname = 'updated_at' AND NOT attisdropped;
  IF v_att IS NULL THEN
    RAISE EXCEPTION 'POS: coluna fin_contas_pagar.updated_at não existe — o contrato de frescor mudou, revise antes';
  END IF;
  SELECT string_agg(DISTINCT c.relname, ', ')
    INTO v_idx
    FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class c ON c.oid = x.indexrelid
   WHERE x.indrelid = v_tab
     AND (v_att = ANY (x.indkey::smallint[])
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_class'::regclass
                        AND d.objid = x.indexrelid
                        AND d.refclassid = 'pg_catalog.pg_class'::regclass
                        AND d.refobjid = v_tab
                        AND d.refobjsubid = v_att));
  IF v_idx IS NOT NULL THEN
    RAISE EXCEPTION 'POS: fin_contas_pagar.updated_at ainda indexada por % — todo update do carimbo segue nao-HOT', v_idx;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
     WHERE oid = v_tab AND 'fillfactor=80' = ANY (reloptions)
  ) THEN
    RAISE EXCEPTION 'POS: fin_contas_pagar sem fillfactor=80 — as linhas seguem em ping-pong';
  END IF;
  RAISE NOTICE 'POS ok: fin_contas_pagar sem indice no carimbo e fillfactor=80';
END
$post$;
