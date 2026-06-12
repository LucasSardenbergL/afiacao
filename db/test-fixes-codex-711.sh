#!/usr/bin/env bash
# Teste PG17 dos fixes do adversarial retroativo do Codex no #711 (migration 20260611120000).
# (1) [SIMETRIA-NORMAL] gerar_pedidos_oportunidade_ciclo não oferece SKU já em pedido normal
#     economicamente ativo (header E itens); SKU livre continua entrando.
# (2) [CAST-SEGURO] tick do alerta com config malformada não explode (no-op limpo).
# Técnica: a view v_oportunidade_economica_hoje é substituída por TABELA-fixture homônima
# (plpgsql resolve nomes em runtime) — testa a LÓGICA da função com dados determinísticos.
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5438
DATA="$(mktemp -d /tmp/pgtest-fixcodex.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-fixcodex.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres fixcodex_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d fixcodex_verify "$@"; }

RR="$(mktemp /tmp/snap-fixcodex.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ stub cron.schedule + migrations base (alerta 150000) + fixes (20260611120000)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
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
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611120000_reposicao_fixes_codex_711.sql" >/dev/null

echo "→ fixture: troca a view v_oportunidade_economica_hoje por tabela determinística…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP VIEW IF EXISTS v_oportunidade_economica_hoje CASCADE;
CREATE TABLE v_oportunidade_economica_hoje (
  empresa text, cenario text, economia_bruta_estimada numeric, qtde_oportunidade numeric,
  campanha_id bigint, aumentos_json jsonb, fornecedor_nome text,
  sku_codigo_omie text, sku_descricao text, preco_item_eoq numeric,
  desconto_total_perc numeric, promo_item_id bigint
);
-- 2 SKUs do MESMO fornecedor/cenário: 5001 (vai estar em pedido normal ativo) e 5002 (livre).
-- promo_item_id NULL: pedido_compra_item tem FK pra promocao_item (não semeada) — NULL passa.
INSERT INTO v_oportunidade_economica_hoje VALUES
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','5001','SKU 5001',20,10,NULL),
  ('OBEN','promo_flat',100,10,77,NULL,'FORN-OPP','5002','SKU 5002',20,10,NULL);

-- Pedido NORMAL economicamente ativo (aprovado, dentro de 7d) com o SKU 5001.
INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
VALUES ('OBEN','FORN-X',NULL,CURRENT_DATE,500,1,'aprovado_aguardando_disparo','normal');
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
SELECT id, '5001', 'SKU 5001', 25, 25, 20, 500 FROM pedido_compra_sugerido WHERE fornecedor_nome='FORN-X';
SQL

echo "→ roda gerar_pedidos_oportunidade_ciclo + asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; v numeric;
BEGIN
  PERFORM * FROM public.gerar_pedidos_oportunidade_ciclo('OBEN', CURRENT_DATE);

  -- F1: SKU 5001 (em pedido normal ativo) NÃO entrou na oportunidade
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.tipo_ciclo LIKE 'oportunidade_%' AND pci.sku_codigo_omie='5001';
  IF d <> 0 THEN RAISE EXCEPTION 'F1 FALHOU: SKU em pedido normal ativo entrou na oportunidade (compra dupla)'; END IF;
  RAISE NOTICE 'OK F1 — [SIMETRIA-NORMAL] SKU em pedido normal ativo fica fora da oportunidade';

  -- F2: SKU 5002 (livre) ENTROU; header consistente (num_skus=1, valor = 10×20×0.9=180)
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.tipo_ciclo LIKE 'oportunidade_%' AND pci.sku_codigo_omie='5002';
  IF d <> 1 THEN RAISE EXCEPTION 'F2 FALHOU: SKU livre não entrou na oportunidade (count=%)', d; END IF;
  SELECT num_skus INTO d FROM pedido_compra_sugerido WHERE tipo_ciclo LIKE 'oportunidade_%' AND status='pendente_aprovacao';
  IF d <> 1 THEN RAISE EXCEPTION 'F2 FALHOU: header num_skus=% (esperado 1 — divergência header×itens)', d; END IF;
  RAISE NOTICE 'OK F2 — SKU livre entra; header e itens consistentes (sem divergência)';

  -- F3: idempotência — re-rodar não duplica (limpeza própria + simetria estável)
  PERFORM * FROM public.gerar_pedidos_oportunidade_ciclo('OBEN', CURRENT_DATE);
  SELECT count(*) INTO d FROM pedido_compra_item pci
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.tipo_ciclo LIKE 'oportunidade_%';
  IF d <> 1 THEN RAISE EXCEPTION 'F3 FALHOU: re-rodada duplicou/perdeu itens (count=%)', d; END IF;
  RAISE NOTICE 'OK F3 — re-rodada idempotente';

  -- F4: [CAST-SEGURO] config malformada não mata o tick (no-op limpo)
  UPDATE company_config SET value = 'abc' WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  PERFORM public.reposicao_alerta_pedido_minimo_tick();  -- não pode lançar exceção
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 0 THEN RAISE EXCEPTION 'F4 FALHOU: config malformada gerou alerta'; END IF;
  UPDATE company_config SET value = '3000' WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  RAISE NOTICE 'OK F4 — [CAST-SEGURO] config malformada = no-op limpo (tick sobrevive)';

  -- F5: tick segue FUNCIONANDO depois (regressão do REPLACE) — pedido Sayerlack ≥3k alerta
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','SAYERLACK DO BRASIL','G1',CURRENT_DATE,3200,5,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'F5 FALHOU: tick não alertou pós-REPLACE (count=%)', d; END IF;
  RAISE NOTICE 'OK F5 — tick funcional pós-REPLACE (alerta dispara)';

  RAISE NOTICE '✅ TODOS OS 5 ASSERTS DOS FIXES PASSARAM';
END $$;
SQL

echo "✅ test-fixes-codex-711: OK"
