#!/usr/bin/env bash
# Teste PG17 do PASSO 3 — motor gerar_pedidos_sugeridos_ciclo FONTE ÚNICA (sem em_transito + barreira).
# Aplica schema-snapshot + a def base (20260609160000, COM em_transito) + a migration nova
# (20260611200000, SEM em_transito + barreira) e valida:
#   B1  barreira (4): marcador de snapshot AUSENTE → aborta
#   B2  barreira (4): marcador STALE (>6h) → aborta
#   B3  barreira (1): pedido aprovado_aguardando_disparo → aborta
#   B4  barreira (2): portal-confirmado sem PO no Omie → aborta
#   B5  barreira (3): recém-disparado (status=disparado, <30min) SEM codint no snapshot → aborta
#   B6  barreira (3) NÃO dispara quando o AFI-<id> ESTÁ no snapshot.codints → gera
#   B7  marcador OK, sem pedidos em voo → GERA; estoque_efetivo = fisico + pendente (sem em_transito)
#   B8  SKU com PENDENTE alto (fisico+pendente > ponto) NÃO é sugerido → prova que o pendente entra no efetivo
#   B9  estoque_atual gravado no item = fisico + pendente (não soma em_transito)
#   B10 barreira é OBEN-only: COLACOR sem marcador NÃO aborta → gera
#   B11 a def não contém mais 'em_transito' e contém 'FONTE-ÚNICA' (functiondef)
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
DO $$
DECLARE v_msg text; v_n int; v_efetivo numeric; v_id bigint;
BEGIN
  -- ── helper de reset: limpa pedidos + marcador ──
  -- B1: marcador AUSENTE → barreira (4)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  DELETE FROM sync_state WHERE entity_type='reposicao_pendente_po';
  BEGIN
    PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
    ASSERT false, 'B1 deveria abortar (marcador ausente)';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%barreira_fonte_unica%', format('B1 msg inesperada: %s', v_msg);
  END;

  -- B2: marcador STALE (>6h) → barreira (4)
  INSERT INTO sync_state (entity_type, account, status, last_sync_at, metadata)
  VALUES ('reposicao_pendente_po','oben','complete', now() - interval '7 hours', '{"codints_aprovados":[]}'::jsonb);
  BEGIN
    PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
    ASSERT false, 'B2 deveria abortar (marcador stale)';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%barreira_fonte_unica%' AND v_msg LIKE '%stale%', format('B2 msg: %s', v_msg);
  END;

  -- marcador OK p/ os próximos (fresco, complete)
  UPDATE sync_state SET last_sync_at = now(), metadata = '{"codints_aprovados":[]}'::jsonb
   WHERE entity_type='reposicao_pendente_po' AND account='oben';

  -- B3: pedido aprovado_aguardando_disparo → barreira (1)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'aprovado_aguardando_disparo');
  BEGIN
    PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
    ASSERT false, 'B3 deveria abortar (aprovado_aguardando_disparo)';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%aprovado_aguardando_disparo%', format('B3 msg: %s', v_msg);
  END;

  -- B4: portal-confirmado sem PO no Omie → barreira (2)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, status_envio_portal, portal_protocolo, omie_pedido_compra_numero)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','sucesso_portal','PROTO-1',NULL);
  BEGIN
    PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
    ASSERT false, 'B4 deveria abortar (portal sem PO)';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%portal%', format('B4 msg: %s', v_msg);
  END;

  -- B5: recém-disparado (status=disparado, <30min) SEM codint no snapshot → barreira (3)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, data_ciclo, valor_total, num_skus, status, omie_pedido_compra_numero, atualizado_em)
  VALUES ('OBEN','FORN-A',CURRENT_DATE,100,1,'disparado','OMIE-1', now()) RETURNING id INTO v_id;
  -- snapshot SEM o AFI-<id> deste pedido
  UPDATE sync_state SET metadata = '{"codints_aprovados":[]}'::jsonb WHERE entity_type='reposicao_pendente_po' AND account='oben';
  BEGIN
    PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
    ASSERT false, 'B5 deveria abortar (disparado recente sem codint)';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    ASSERT v_msg LIKE '%recém-disparado%' OR v_msg LIKE '%recem-disparado%', format('B5 msg: %s', v_msg);
  END;

  -- B6: agora o snapshot CONTÉM o AFI-<id> → barreira (3) NÃO dispara → gera
  UPDATE sync_state SET metadata = jsonb_build_object('codints_aprovados', jsonb_build_array('AFI-' || v_id::text))
   WHERE entity_type='reposicao_pendente_po' AND account='oben';
  PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
  SELECT count(*) INTO v_n FROM pedido_compra_sugerido WHERE data_ciclo=CURRENT_DATE AND status='pendente_aprovacao';
  ASSERT v_n >= 1, format('B6 esperava gerar (codint presente), veio %s pedidos', v_n);

  RAISE NOTICE 'B1..B6 OK: barreira fail-closed (4 condições) + libera quando o codint está no snapshot';

  -- B7..B9: geração limpa (marcador OK, sem pedidos em voo)
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  UPDATE sync_state SET last_sync_at = now(), metadata = '{"codints_aprovados":[]}'::jsonb WHERE entity_type='reposicao_pendente_po' AND account='oben';
  PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);

  -- B7: 5001 e 5003 sugeridos
  SELECT count(*) INTO v_n FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pcs.data_ciclo=CURRENT_DATE AND pci.sku_codigo_omie IN ('5001','5003');
  ASSERT v_n = 2, format('B7 esperava 5001+5003 sugeridos (2), veio %s', v_n);

  -- B8: 5002 (pendente 60 → efetivo 110 > ponto 100) NÃO sugerido
  SELECT count(*) INTO v_n FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pci.sku_codigo_omie='5002';
  ASSERT v_n = 0, format('B8 5002 NÃO podia ser sugerido (pendente entra no efetivo), veio %s', v_n);

  -- B9: estoque_atual do item de 5001 = fisico(90) + pendente(0) = 90 (sem em_transito)
  SELECT pci.estoque_atual INTO v_efetivo FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='OBEN' AND pci.sku_codigo_omie='5001';
  ASSERT v_efetivo = 90, format('B9 estoque_efetivo de 5001 esperava 90 (fisico+pendente), veio %s', v_efetivo);

  RAISE NOTICE 'B7..B9 OK: gera com fonte única; pendente entra no efetivo; sem em_transito';

  -- B10: COLACOR sem marcador → barreira OBEN-only NÃO aborta → gera
  DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;
  -- (não há marcador 'colacor'; a barreira só roda p/ 'oben')
  PERFORM public.gerar_pedidos_sugeridos_ciclo('COLACOR', CURRENT_DATE);
  SELECT count(*) INTO v_n FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.empresa='COLACOR' AND pci.sku_codigo_omie='3001';
  ASSERT v_n = 1, format('B10 COLACOR deveria gerar (barreira OBEN-only), veio %s', v_n);

  RAISE NOTICE 'B10 OK: barreira é OBEN-only (COLACOR não trava sem marcador)';
END $$;

-- B11: a def não tem mais 'em_transito' e contém a barreira FONTE-ÚNICA
DO $$
DECLARE v_sem int; v_com int; v_intra int;
BEGIN
  -- checa a ausência do CÓDIGO do em_transito (a coluna et.qtde e a CTE), não a palavra do comentário.
  SELECT count(*) INTO v_sem FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) NOT LIKE '%et.qtde%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%em_transito AS%'
     AND pg_get_functiondef(p.oid) NOT LIKE '%JOIN em_transito%';
  SELECT count(*) INTO v_com FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%FONTE-ÚNICA%';
  SELECT count(*) INTO v_intra FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
     AND pg_get_functiondef(p.oid) LIKE '%INTRADAY 4/4%';
  ASSERT v_sem = 1, 'B11 a def ainda usa o CÓDIGO do em_transito (et.qtde / CTE / join)';
  ASSERT v_com = 1, 'B11 a def não contém a barreira FONTE-ÚNICA';
  ASSERT v_intra = 1, 'B11 a def perdeu as marcas INTRADAY';
  RAISE NOTICE 'B11 OK: sem em_transito, com barreira, marcas INTRADAY preservadas';
END $$;

SELECT '✅ TODOS OS ASSERTS (B1..B11) PASSARAM' AS resultado;
SQL

echo "✅ test-motor-fonte-unica: OK"
