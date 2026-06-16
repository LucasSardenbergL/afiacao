#!/usr/bin/env bash
# Teste PG17 do ciclo INTRA-DAY — PR2 (migration 20260609160000).
# Aplica schema-snapshot + a def viva da RPC (20260606190000) + a migration intra-day, semeia
# cenários e valida as 4 marcas [INTRADAY] em 8 asserts: limpeza preserva oportunidade pendente,
# limpeza apaga bloqueado_guardrail normal do dia (e o SKU renasce 1×, não 2), zumbi de ontem
# expira, NOT EXISTS exclui SKU de oportunidade, aprovado intacto, comportamento base inalterado,
# crons agendados, marcas presentes na def.
# Base: db/test-rpc-account-aware.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5437
DATA="$(mktemp -d /tmp/pgtest-intraday.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-intraday.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres intraday_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d intraday_verify "$@"; }

RR="$(mktemp /tmp/snap-intraday.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (colunas stale no snapshot) + stub cron.schedule…"
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
    INSERT INTO cron.job (jobid, jobname, schedule, command, active)
    VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ base: 20260606190000 (def VIVA da RPC, A2-CMC-ACCOUNT)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606190000_reposicao_preco_pedido_cmc_account.sql" >/dev/null

echo "→ aplica a migration INTRA-DAY: 20260609160000…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609160000_reposicao_ciclo_intraday.sql" >/dev/null

echo "→ seed…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- 3 SKUs OBEN que PRECISAM repor (estoque 90 ≤ pp 100; natural = 100-90 = 10) + 1 que não.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, familia, tipo_produto) VALUES
  (4001,'4001','PROD 4001','oben',true,'F1','00'),
  (4002,'4002','PROD 4002','oben',true,'F1','00'),
  (4003,'4003','PROD 4003','oben',true,'F1','00'),
  (4004,'4004','PROD 4004','oben',true,'F1','00');
INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
   habilitado_reposicao_automatica, tipo_reposicao, minimo_forcado_manual, ativo) VALUES
  ('OBEN',4001,'SKU 4001','FORN-A',100,100,true,'automatica',NULL,true),
  ('OBEN',4002,'SKU 4002','FORN-B',100,100,true,'automatica',NULL,true),
  ('OBEN',4003,'SKU 4003','FORN-C',100,100,true,'automatica',NULL,true),
  ('OBEN',4004,'SKU 4004','FORN-D',100,100,true,'automatica',NULL,true);
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
  ('OBEN','4001',90,0), ('OBEN','4002',90,0), ('OBEN','4003',90,0),
  ('OBEN','4004',200,0); -- 4004 NÃO precisa (acima do ponto)
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc) VALUES
  (4001,'vendas',10),(4002,'vendas',10),(4003,'vendas',10),(4004,'vendas',10);

-- Cenário A (tipo-aware + NOT EXISTS): pedido de OPORTUNIDADE pendente do dia contendo o SKU 4001.
INSERT INTO public.pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-A',NULL,CURRENT_DATE,500,1,'pendente_aprovacao','oportunidade_promo');
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
SELECT id, '4001', 'SKU 4001', 50, 50, 10, 500 FROM public.pedido_compra_sugerido WHERE tipo_ciclo='oportunidade_promo';

-- Cenário B (bloqueado do dia entra na limpeza): pedido NORMAL bloqueado_guardrail do dia com SKU 4002.
INSERT INTO public.pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-B',NULL,CURRENT_DATE,999,1,'bloqueado_guardrail','normal');
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
SELECT id, '4002', 'SKU 4002', 99, 99, 10, 999 FROM public.pedido_compra_sugerido WHERE status='bloqueado_guardrail';

-- Cenário C (zumbi): pendente NORMAL de ONTEM.
INSERT INTO public.pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-Z',NULL,CURRENT_DATE - 1,777,1,'pendente_aprovacao','normal');

-- Cenário D (intacto): pedido APROVADO de hoje (não pode ser tocado pela limpeza).
INSERT INTO public.pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-APR',NULL,CURRENT_DATE,1234,1,'aprovado_aguardando_disparo','normal');

-- Zumbi de OPORTUNIDADE de ontem: NÃO deve ser expirado pela RPC normal (território do outro ciclo).
INSERT INTO public.pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-OPP-Z',NULL,CURRENT_DATE - 1,333,1,'pendente_aprovacao','oportunidade_aumento');
SQL

echo "→ roda a RPC (rodada intra-day simulada)…"
P -v ON_ERROR_STOP=1 -q -c "SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);" >/dev/null

echo "→ asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; s text;
BEGIN
  -- I1: oportunidade pendente do dia PRESERVADA (limpeza tipo-aware)
  SELECT count(*) INTO d FROM pedido_compra_sugerido
  WHERE tipo_ciclo='oportunidade_promo' AND status='pendente_aprovacao' AND data_ciclo=CURRENT_DATE;
  IF d <> 1 THEN RAISE EXCEPTION 'I1 FALHOU: oportunidade do dia foi apagada (count=%)', d; END IF;
  RAISE NOTICE 'OK I1 — limpeza preserva pedido de oportunidade pendente do dia';

  -- I2: SKU 4001 (na oportunidade pendente) NÃO re-sugerido no ciclo normal (NOT EXISTS)
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pci.sku_codigo_omie='4001' AND pcs.status='pendente_aprovacao'
    AND COALESCE(pcs.tipo_ciclo,'normal')='normal' AND pcs.data_ciclo=CURRENT_DATE;
  IF d <> 0 THEN RAISE EXCEPTION 'I2 FALHOU: SKU da oportunidade re-sugerido no normal (compra dupla)'; END IF;
  RAISE NOTICE 'OK I2 — NOT EXISTS: SKU em oportunidade pendente não nasce no ciclo normal';

  -- I3: bloqueado_guardrail NORMAL do dia foi APAGADO e o SKU 4002 renasceu pendente 1× (não 2)
  SELECT count(*) INTO d FROM pedido_compra_sugerido WHERE status='bloqueado_guardrail';
  IF d <> 0 THEN RAISE EXCEPTION 'I3 FALHOU: bloqueado_guardrail do dia sobreviveu à limpeza'; END IF;
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pci.sku_codigo_omie='4002' AND pcs.status='pendente_aprovacao' AND pcs.data_ciclo=CURRENT_DATE;
  IF d <> 1 THEN RAISE EXCEPTION 'I3 FALHOU: SKU 4002 aparece %× pendente (esperado 1 — anti compra dupla)', d; END IF;
  RAISE NOTICE 'OK I3 — bloqueado normal do dia re-avaliado (apagado + SKU renasce 1×)';

  -- I4: zumbi pendente NORMAL de ontem EXPIRADO
  SELECT status INTO s FROM pedido_compra_sugerido WHERE fornecedor_nome='FORN-Z';
  IF s <> 'expirado_sem_aprovacao' THEN RAISE EXCEPTION 'I4 FALHOU: zumbi de ontem status=%', s; END IF;
  RAISE NOTICE 'OK I4 — pendente normal de ontem expirado pela rodada de hoje';

  -- I5: zumbi de OPORTUNIDADE de ontem NÃO tocado (território do outro ciclo)
  SELECT status INTO s FROM pedido_compra_sugerido WHERE fornecedor_nome='FORN-OPP-Z';
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'I5 FALHOU: oportunidade de ontem foi tocada (status=%)', s; END IF;
  RAISE NOTICE 'OK I5 — oportunidade de ontem intocada (fora do território da RPC normal)';

  -- I6: aprovado de hoje INTACTO + comportamento base (4003 abaixo do ponto vira pendente; 4004 não)
  SELECT status INTO s FROM pedido_compra_sugerido WHERE fornecedor_nome='FORN-APR';
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'I6 FALHOU: aprovado foi tocado (%)', s; END IF;
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pci.sku_codigo_omie='4003' AND pcs.status='pendente_aprovacao' AND pcs.data_ciclo=CURRENT_DATE;
  IF d <> 1 THEN RAISE EXCEPTION 'I6 FALHOU: SKU 4003 (necessita) não gerou pedido'; END IF;
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pci.sku_codigo_omie='4004' AND pcs.status='pendente_aprovacao';
  IF d <> 0 THEN RAISE EXCEPTION 'I6 FALHOU: SKU 4004 (sobra de estoque) gerou pedido'; END IF;
  RAISE NOTICE 'OK I6 — aprovado intacto; base inalterada (4003 entra, 4004 não)';

  -- I7: re-rodada idempotente (mesmo dia, 2ª vez) mantém as invariantes I1/I2/I5
  PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
  SELECT count(*) INTO d FROM pedido_compra_sugerido
  WHERE tipo_ciclo LIKE 'oportunidade%' AND status='pendente_aprovacao';
  IF d <> 2 THEN RAISE EXCEPTION 'I7 FALHOU: re-rodada mexeu nas oportunidades (count=%)', d; END IF;
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pci.sku_codigo_omie IN ('4002','4003') AND pcs.status='pendente_aprovacao' AND pcs.data_ciclo=CURRENT_DATE;
  IF d <> 2 THEN RAISE EXCEPTION 'I7 FALHOU: re-rodada duplicou/perdeu SKUs (count=%)', d; END IF;
  RAISE NOTICE 'OK I7 — re-rodada no mesmo dia: idempotente, sem duplicação';

  -- I8: crons agendados + marcas na def viva
  SELECT count(*) INTO d FROM cron.job WHERE jobname IN ('gerar-pedidos-intraday-oben','omie-sync-estoque-intraday-oben');
  IF d <> 2 THEN RAISE EXCEPTION 'I8 FALHOU: crons intraday ausentes (%)', d; END IF;
  SELECT schedule INTO s FROM cron.job WHERE jobname='omie-sync-estoque-diario';
  IF s <> '0 9 * * *' THEN RAISE EXCEPTION 'I8 FALHOU: omie-sync-estoque-diario não reagendado (%)', s; END IF;
  SELECT count(*) INTO d FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'
    AND pg_get_functiondef(oid) LIKE '%INTRADAY 4/4%' AND pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%';
  IF d <> 1 THEN RAISE EXCEPTION 'I8 FALHOU: marcas INTRADAY ausentes na def'; END IF;
  RAISE NOTICE 'OK I8 — crons agendados (diário reagendado 0 9) + marcas na def';

  RAISE NOTICE '✅ TODOS OS 8 ASSERTS DO INTRA-DAY PASSARAM';
END $$;
SQL

echo "✅ test-rpc-intraday: OK"
