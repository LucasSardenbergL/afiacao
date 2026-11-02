-- Migration: devolve o HOT update às 3 tabelas que o sync reescreve a cada ciclo (plano v4, lote 14 — B2/B9).
-- Plano: docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md. Evidência e números:
-- docs/historico/hot-carimbo-sync-lote14.md. Prova executada: db/test-hot-carimbo-sync.sh.
-- ⚠️ NÃO auto-aplica (nome custom). Tem DROP INDEX → é DDL destrutivo, apply do founder:
-- SQL Editor do Lovable (transação implícita da colagem — por isso o arquivo não leva BEGIN/COMMIT).
--
-- O QUE NÃO MUDA: nenhuma coluna, nenhum dado, nenhuma função. O carimbo por linha continua sendo escrito
-- em todo ciclo (é contrato: _data_health_compute, CMC rejeitado após 48 h, posição mais recente entre
-- fontes). Só o CUSTO de cada escrita cai.
--
-- Diagnóstico (psql-ro, 2026-11-02 01:15Z; contadores desde o restart de 2026-10-31):
--   inventory_position  136.558 updates, 0 HOT     · btree(synced_at)  1.280 kB p/ 3.346 linhas
--   product_costs       190.431 updates, 2.742 HOT · btree(updated_at)   560 kB p/ 3.805 linhas
--   omie_products       150.690 updates, 0 HOT     · btree(updated_at)   264 kB p/ 8.075 linhas
-- O Postgres só faz HOT (versão nova na mesma página, ZERO escrita de índice) quando nenhuma coluna
-- INDEXADA muda. Cada uma das 3 tem índice NA PRÓPRIA coluna de carimbo, e o carimbo muda em todo update
-- → nenhum update pode ser HOT → cada um insere uma entrada em TODOS os índices da tabela (3 a 5).
-- Os índices vieram de 20260615095710_idx_data_health_freshness_cols.sql, só para o max() do
-- _data_health_compute. Sem eles o max() vira seq scan: 119/143/827 buffers, todos em cache, 1,0/1,1/4,2 ms
-- (EXPLAIN ANALYZE na prod). Nenhum outro leitor depende deles: as demais leituras do carimbo são
-- dirigidas por SKU/chave única (ORDER BY synced_at DESC LIMIT 1 por SKU, DISTINCT ON (codigo) ORDER BY
-- codigo, synced_at) — o índice de uma coluna só não serve a nenhuma delas.
--
-- Por que fillfactor 80 junto (medido em PG17, db/test-hot-carimbo-sync.sh): o sync atualiza TODAS as
-- linhas de uma página na MESMA transação (chunk de 500 em ordem de chave). Com fillfactor 100, a página
-- está cheia de versões vivas e não cabe a nova → update não-HOT → o FSM manda a versão para uma página
-- esvaziada pelo vacuum, que é empacotada cheia de novo: as linhas fazem ping-pong entre duas metades da
-- tabela e o HOT fica em ~4% mesmo SEM o índice. Com 80, as relocações deixam 20% livre e a tabela chega
-- ao equilíbrio (cada página com espaço para a 2ª versão das suas linhas) em poucos ciclos: ~99% HOT.
-- O fillfactor vale para as páginas escritas daqui em diante; sem VACUUM FULL (nada é reescrito agora).
--
-- Lock: DROP INDEX pega ACCESS EXCLUSIVE na TABELA (bloqueia até SELECT) até o fim da transação. Os 3
-- locks são pedidos de uma vez, em ordem fixa e com NOWAIT (Codex, 2026-11-01): se qualquer tabela estiver
-- ocupada (chunk do sync, autovacuum), aborta NA HORA sem segurar as outras — nada meio-aplicado, é só
-- re-rodar. Esperar com o 1º lock na mão enfileiraria leitura de todo mundo atrás do apply. Com os locks
-- obtidos, o resto é catálogo de tabelas de KB. Sem CONCURRENTLY: não roda dentro de transação.
LOCK TABLE public.inventory_position, public.product_costs, public.omie_products
  IN ACCESS EXCLUSIVE MODE NOWAIT;

DROP INDEX IF EXISTS public.idx_inventory_position_synced_at;
DROP INDEX IF EXISTS public.idx_product_costs_updated_at;
DROP INDEX IF EXISTS public.idx_omie_products_updated_at;

ALTER TABLE public.inventory_position SET (fillfactor = 80);
ALTER TABLE public.product_costs      SET (fillfactor = 80);
ALTER TABLE public.omie_products      SET (fillfactor = 80);

-- Pós-condição: o predicado é a CAUSA, não o nome — nenhum índice (de qualquer nome) que DEPENDA da coluna
-- de carimbo, e o fillfactor gravado. pg_depend registra a coluna seja ela chave, INCLUDE, expressão ou
-- predicado parcial (Codex: dependência de catálogo, não busca textual). Um índice homônimo recriado por
-- outra sessão, ou outro índice na mesma coluna, devolveria o 0% HOT em silêncio.
DO $post$
DECLARE
  v_alvo constant text[][] := ARRAY[
    ['inventory_position', 'synced_at'],
    ['product_costs',      'updated_at'],
    ['omie_products',      'updated_at']
  ];
  v_tab regclass;
  v_att smallint;
  v_idx text;
BEGIN
  FOR i IN 1 .. array_length(v_alvo, 1) LOOP
    v_tab := format('public.%I', v_alvo[i][1])::regclass;
    SELECT attnum INTO v_att FROM pg_catalog.pg_attribute
     WHERE attrelid = v_tab AND attname = v_alvo[i][2] AND NOT attisdropped;
    IF v_att IS NULL THEN
      RAISE EXCEPTION 'POS: coluna %.% não existe — o contrato de frescor mudou, revise antes', v_alvo[i][1], v_alvo[i][2];
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
      RAISE EXCEPTION 'POS: %.% ainda indexada por % — todo update do carimbo segue nao-HOT',
        v_alvo[i][1], v_alvo[i][2], v_idx;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = v_tab AND 'fillfactor=80' = ANY (reloptions)
    ) THEN
      RAISE EXCEPTION 'POS: % sem fillfactor=80 — as linhas seguem em ping-pong, HOT ~4%%', v_alvo[i][1];
    END IF;
  END LOOP;
  RAISE NOTICE 'POS ok: carimbos sem indice e fillfactor=80 nas 3 tabelas';
END
$post$;
