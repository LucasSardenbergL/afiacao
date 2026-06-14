#!/usr/bin/env bash
# Teste PG17 do PASSO 3 — motor gerar_pedidos_sugeridos_ciclo FONTE ÚNICA (sem em_transito + barreira).
# Aplica schema-snapshot + a def base (20260609160000, COM em_transito) + a migration nova
# (20260611200000, SEM em_transito + barreira) e valida:
#   B1  barreira (4): marcador de snapshot AUSENTE → aborta
#   B2  barreira (4): marcador STALE (>6h) → aborta
#   B3  barreira (1): pedido aprovado_aguardando_disparo → aborta
#   B4  barreira (2): portal-confirmado sem PO no Omie → aborta
#   B5  barreira (3a): disparado SEM codint no snapshot, <6h [P1-F janela 6h] → aborta
#   B5a barreira (3a): disparado entre 30min e 6h (antes escapava da janela 30min) → aborta [P1-F]
#   B5b barreira (3b): disparado >6h com PO etapa-10 (em aprovação) → aborta SEM janela
#   B6  barreira (3) NÃO dispara quando o AFI-<id> ESTÁ no snapshot.codints → gera
#   B7  marcador OK, sem pedidos em voo → GERA; estoque_efetivo = fisico + pendente (sem em_transito)
#   B8  SKU com PENDENTE alto (fisico+pendente > ponto) NÃO é sugerido → prova que o pendente entra no efetivo
#   B9  estoque_atual gravado no item = fisico + pendente (não soma em_transito)
#   B10  [P2 round3] o MOTOR recusa empresa != OBEN (a UI chama a RPC direto; guard no motor) → RAISE
#   B10b [P2 round3] colacor_sc também recusado
#   B11  [P1-C/P1-F/P2] a def NÃO contém em_transito + barreira + INTRADAY + janela 6h + guard OBEN-only
# Base: db/test-rpc-intraday.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441
DATA="$(mktemp -d /tmp/pgtest-motorfu.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-motorfu.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres motorfu_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d motorfu_verify "$@"; }

RR="$(mktemp /tmp/snap-motorfu.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (colunas stale) + stub cron.schedule…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;
ALTER TABLE public.sku_parametros ADD COLUMN IF NOT EXISTS minimo_forcado_manual numeric;
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ base 20260609160000 (COM em_transito) + 20260611200000 (FONTE ÚNICA + barreira)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609160000_reposicao_ciclo_intraday.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611200000_reposicao_motor_fonte_unica.sql" >/dev/null

echo "→ seed (SKUs)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- omie_products: tipo_produto não-NULL (guard) e != '04'; account = empresa.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, familia, tipo_produto) VALUES
  (5001,'5001','PROD 5001','oben',true,'F1','00'),
  (5002,'5002','PROD 5002','oben',true,'F1','00'),
  (5003,'5003','PROD 5003','oben',true,'F1','00'),
  (3001,'3001','PROD 3001','colacor',true,'F1','00');
INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
   habilitado_reposicao_automatica, tipo_reposicao, minimo_forcado_manual, ativo) VALUES
  ('OBEN',5001,'SKU 5001','FORN-A',100,100,true,'automatica',NULL,true),   -- fisico 90 → efetivo 90 ≤ 100 → sugere (10)
  ('OBEN',5002,'SKU 5002','FORN-B',100,200,true,'automatica',NULL,true),   -- fisico 50 + pendente 60 = 110 > 100 → NÃO sugere
  ('OBEN',5003,'SKU 5003','FORN-C',100,200,true,'automatica',NULL,true),   -- fisico 50 → efetivo 50 ≤ 100 → sugere (150)
  ('COLACOR',3001,'SKU 3001','FORN-D',100,100,true,'automatica',NULL,true);
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
  ('OBEN','5001',90,0),
  ('OBEN','5002',50,60),     -- pendente alto: prova que entra no efetivo (sem em_transito)
  ('OBEN','5003',50,0),
  ('COLACOR','3001',90,0);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc) VALUES
  (5001,'vendas',10),(5002,'vendas',10),(5003,'vendas',10),(3001,'colacor_vendas',10);
SQL

echo "ASSERTS:"
P -v ON_ERROR_STOP=1 <<'SQL'
-- helper: seta os 2 markers OBEN (pendente + físico). status NULL = marcador ausente.
CREATE OR REPLACE FUNCTION _mk(p_ps text, p_pa interval, p_fs text, p_fa interval,
                               p_cod jsonb DEFAULT '[]'::jsonb, p_cea jsonb DEFAULT '[]'::jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM sync_state WHERE entity_type IN ('reposicao_pendente_po','reposicao_estoque_full') AND account='oben';
  IF p_ps IS NOT NULL THEN
    INSERT INTO sync_state (entity_type, account, status, last_sync_at, metadata)
    VALUES ('reposicao_pendente_po','oben',p_ps, now()-p_pa,
            jsonb_build_object('codints_aprovados',p_cod,'codints_em_aprovacao',p_cea));
  END IF;
  IF p_fs IS NOT NULL THEN
    INSERT INTO sync_state (entity_type, account, status, last_sync_at)
    VALUES ('reposicao_estoque_full','oben',p_fs, now()-p_fa);
  END IF;
END $$;

DO $$
DECLARE v_msg text; v_n int; v_efetivo numeric; v_id bigint;
BEGIN
  -- B1: AMBOS markers ausentes → barreira (4 a-caminho)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  PERFORM _mk(NULL,NULL,NULL,NULL);
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B1 deveria abortar (markers ausentes)';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%barreira_fonte_unica%', format('B1: %s', v_msg); END;

  -- B1b [P1.6]: a-caminho OK, FÍSICO ausente → barreira (4b)
  PERFORM _mk('complete','1 minute', NULL, NULL);
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B1b deveria abortar (físico ausente)';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%FÍSICO%', format('B1b: %s', v_msg); END;

  -- B2: a-caminho STALE (>6h), físico OK → barreira (4) stale
  PERFORM _mk('complete','7 hours', 'complete','1 minute');
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B2 deveria abortar (a-caminho stale)';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%stale%', format('B2: %s', v_msg); END;

  -- B3: aprovado_aguardando_disparo → barreira (1)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  PERFORM _mk('complete','1 minute','complete','1 minute');
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'aprovado_aguardando_disparo');
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B3 deveria abortar';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%aprovado_aguardando_disparo%', format('B3: %s', v_msg); END;

  -- B4: portal-confirmado sem PO no Omie → barreira (2)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, status_envio_portal, portal_protocolo, omie_pedido_compra_numero)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','sucesso_portal','PROTO-1',NULL);
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B4 deveria abortar';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%portal%', format('B4: %s', v_msg); END;

  -- B5 [P1-F]: disparado recente (<6h) cujo codint NÃO está em nenhum conjunto → barreira (3a, janela 6h)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, omie_pedido_compra_numero, atualizado_em)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','OMIE-1', now()) RETURNING id INTO v_id;
  PERFORM _mk('complete','1 minute','complete','1 minute');  -- codints vazios
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B5 deveria abortar';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%ainda não refletido%', format('B5: %s', v_msg); END;

  -- B5a [P1-F]: disparado ENTRE 30min e 6h (era FORA da janela antiga de 30min, agora DENTRO da 6h) → (3a) fira
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, omie_pedido_compra_numero, atualizado_em)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','OMIE-1b', now() - interval '90 minutes') RETURNING id INTO v_id;
  PERFORM _mk('complete','1 minute','complete','1 minute');  -- codints vazios
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B5a deveria abortar (90min < 6h)';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%ainda não refletido%', format('B5a: %s', v_msg); END;

  -- B5b [P1.2]: disparado ANTIGO (>6h, FORA da janela da 3a) cuja PO está EM APROVAÇÃO (etapa-10) → (3b) SEM janela
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, omie_pedido_compra_numero, atualizado_em)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','OMIE-2', now() - interval '8 hours') RETURNING id INTO v_id;
  PERFORM _mk('complete','1 minute','complete','1 minute', '[]'::jsonb, jsonb_build_array('AFI-' || v_id::text));
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE); ASSERT false, 'B5b deveria abortar (PO em aprovação, sem janela)';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%APROVAÇÃO%', format('B5b: %s', v_msg); END;

  -- B6: codint em aprovados → barreira (3) NÃO dispara → gera
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, omie_pedido_compra_numero, atualizado_em)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','OMIE-3', now()) RETURNING id INTO v_id;
  PERFORM _mk('complete','1 minute','complete','1 minute', jsonb_build_array('AFI-' || v_id::text));
  PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
  SELECT count(*) INTO v_n FROM pedido_compra_sugerido WHERE data_ciclo=CURRENT_DATE AND status='pendente_aprovacao';
  ASSERT v_n >= 1, format('B6 esperava gerar (codint aprovado presente), veio %s', v_n);

  RAISE NOTICE 'B1..B6 OK: barreira fail-closed (físico+a-caminho; 4 condições incl. etapa-10 SEM janela)';

  -- B7..B9: geração limpa (ambos markers OK, sem pedidos em voo)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  PERFORM _mk('complete','1 minute','complete','1 minute');
  PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
  SELECT count(*) INTO v_n FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pci.sku_codigo_omie IN ('5001','5003');
  ASSERT v_n = 2, format('B7 esperava 5001+5003 (2), veio %s', v_n);
  SELECT count(*) INTO v_n FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pci.sku_codigo_omie='5002';
  ASSERT v_n = 0, format('B8 5002 NÃO podia ser sugerido (pendente entra no efetivo), veio %s', v_n);
  SELECT pci.estoque_atual INTO v_efetivo FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pci.sku_codigo_omie='5001';
  ASSERT v_efetivo = 90, format('B9 efetivo 5001 esperava 90 (OBEN NÃO conta em_transito), veio %s', v_efetivo);

  RAISE NOTICE 'B7..B9 OK: OBEN gera fonte única; pendente no efetivo; em_transito NÃO conta p/ OBEN';

  -- B10 [P2 round3]: o MOTOR recusa empresa != OBEN (a UI chama a RPC direto; guard tem que estar no motor)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('COLACOR', CURRENT_DATE); ASSERT false, 'B10 COLACOR deveria ser RECUSADO';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%só habilitada p/ OBEN%', format('B10 esperava recusa OBEN-only, veio: %s', v_msg); END;
  -- e NÃO gerou nada p/ COLACOR
  SELECT count(*) INTO v_n FROM pedido_compra_sugerido WHERE empresa='COLACOR';
  ASSERT v_n = 0, format('B10 COLACOR não podia gerar nada (recusado), veio %s', v_n);

  -- B10b [P2 round3]: colacor_sc também recusado (qualquer != OBEN)
  BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('colacor_sc', CURRENT_DATE); ASSERT false, 'B10b colacor_sc deveria ser RECUSADO';
  EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%só habilitada p/ OBEN%', format('B10b esperava recusa, veio: %s', v_msg); END;

  RAISE NOTICE 'B10 OK: motor RECUSA não-OBEN (guard no motor, não só na edge — a UI chama a RPC direto)';
END $$;

-- B11 [P1-C]: a def NÃO contém mais em_transito (CTE, JOIN, et.qtde) + barreira FONTE-ÚNICA + INTRADAY + janela 6h
DO $$
DECLARE v_semet int; v_com int; v_intra int; v_jan int; v_guard int;
BEGIN
  -- em_transito ELIMINADO: nenhuma referência à CTE, ao JOIN (et.) nem ao CASE oben→0 no CÓDIGO da função.
  -- (pg_get_functiondef inclui comentários; por isso casa padrões de CÓDIGO, não a palavra solta em comentário.)
  SELECT count(*) INTO v_semet FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) NOT LIKE '%em_transito AS%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%COALESCE(et.qtde%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%JOIN em_transito et%';
  SELECT count(*) INTO v_com FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%FONTE-ÚNICA%';
  SELECT count(*) INTO v_intra FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%INTRADAY 4/4%';
  -- [P1-F] a janela da (3a) é 6h (não 30min)
  SELECT count(*) INTO v_jan FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%now() - INTERVAL ''6 hours''%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%now() - INTERVAL ''30 minutes''%';
  -- [P2 round3] o guard OBEN-only está no motor
  SELECT count(*) INTO v_guard FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%só habilitada p/ OBEN%';
  ASSERT v_semet = 1, 'B11 em_transito NÃO foi removido (CTE/JOIN/et.qtde ainda presentes)';
  ASSERT v_com = 1, 'B11 a def não contém a barreira FONTE-ÚNICA';
  ASSERT v_intra = 1, 'B11 a def perdeu as marcas INTRADAY';
  ASSERT v_jan = 1, 'B11 [P1-F] janela da (3a) não é 6h (ou ainda tem 30min)';
  ASSERT v_guard = 1, 'B11 [P2] guard OBEN-only ausente no motor';
  RAISE NOTICE 'B11 OK: em_transito REMOVIDO + barreira + INTRADAY + janela 6h + guard OBEN-only (P1-C/P1-F/P2)';
END $$;

SELECT '✅ TODOS OS ASSERTS (B1..B11) PASSARAM' AS resultado;
SQL

echo "✅ test-motor-fonte-unica: OK"
