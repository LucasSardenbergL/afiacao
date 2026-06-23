#!/usr/bin/env bash
# Teste PG17 da Frente B — mínimo de compra forçado por SKU (money-path).
# Aplica o schema-snapshot + foundation (omie_products.tipo_produto, stale no snapshot) +
# a migration 20260604170000_reposicao_minimo_forcado.sql, semeia cenários controlados em
# sku_parametros/omie_products/sku_estoque_atual/inventory_position, roda a RPC
# gerar_pedidos_sugeridos_ciclo e assere o comportamento do piso (qtde_sugerida=natural,
# qtde_final=forçada, gate de necessidade, filtro qtde_natural>0, valor_linha, CHECK).
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5434
DATA="$(mktemp -d /tmp/pgtest-minforc.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-minforc.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres minforc_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d minforc_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-minforc.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (omie_products.tipo_produto — stale no snapshot, a RPC só lê)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

echo "→ migration 20260604190000_reposicao_minimo_forcado.sql (RPC = blindar + mínimo forçado)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604190000_reposicao_minimo_forcado.sql" >/dev/null

echo "→ seed dos cenários + RPC + asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Guarda fail-closed da RPC: precisa de >=1 omie_products com tipo_produto não-nulo e account='oben'.
-- Semeio 5 produtos compráveis (tipo_produto='00'), descrições sem 405/450ML.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, tipo_produto)
VALUES
  (1001,'1001','SKU-A piso eleva',        'oben', true, '00'),
  (1002,'1002','SKU-B natural acima',     'oben', true, '00'),
  (1003,'1003','SKU-C sem minimo',        'oben', true, '00'),
  (1004,'1004','SKU-D nao precisa',       'oben', true, '00'),
  (1005,'1005','SKU-E natural<=0 borda',  'oben', true, '00'),
  (1006,'1006','SKU-F sem fornecedor',    'oben', true, '00');

-- sku_parametros: empresa OBEN, habilitado, automatica. minimo_forcado_manual por cenário.
-- 1001 e 1005 compartilham fornecedor FORN-X (e grupo NULL) → testam a 4ª mudança (filtro do insert).
INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
   habilitado_reposicao_automatica, tipo_reposicao, minimo_forcado_manual, ativo)
VALUES
  ('OBEN',1001,'SKU-A','FORN-X',12, 15, true,'automatica', 200, true),
  ('OBEN',1002,'SKU-B','FORN-Y',600,600, true,'automatica', 200, true),
  ('OBEN',1003,'SKU-C','FORN-Z',50, 60, true,'automatica', NULL,true),
  ('OBEN',1004,'SKU-D','FORN-W',50, 200,true,'automatica', 200, true),
  ('OBEN',1005,'SKU-E','FORN-X',60, 40, true,'automatica', 200, true),
  ('OBEN',1006,'SKU-F',NULL,    50, 60, true,'automatica', 200, true);

-- estoque atual por SKU (estoque_efetivo = fisico + pendente; pendente=0).
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
VALUES
  ('OBEN','1001',  5, 0),  -- efetivo 5  <= pp 12  → precisa; natural 15-5  = 10
  ('OBEN','1002',100, 0),  -- efetivo 100<= pp 600 → precisa; natural 600-100= 500
  ('OBEN','1003', 10, 0),  -- efetivo 10 <= pp 50  → precisa; natural 60-10 = 50
  ('OBEN','1004',100, 0),  -- efetivo 100 > pp 50  → NÃO precisa (gate falha)
  ('OBEN','1005', 50, 0),  -- efetivo 50 <= pp 60  → passa gate; natural 40-50 = -10 (<=0)
  ('OBEN','1006', 10, 0);  -- efetivo 10 <= pp 50  → precisaria; MAS fornecedor_nome NULL (blindagem)

-- preço via inventory_position.cmc (account 'oben'); fallback da RPC quando não há histórico.
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc)
VALUES (1001,'oben',10),(1002,'oben',10),(1003,'oben',10),(1004,'oben',10),(1005,'oben',10),(1006,'oben',10);

-- Roda o motor.
SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);
SQL

echo ""
echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE
  r RECORD;
BEGIN
  -- SKU-A (1001): natural 10, minimo 200 → qtde_sugerida=10, qtde_final=200, valor_linha=200*10
  SELECT qtde_sugerida, qtde_final, valor_linha INTO r FROM pedido_compra_item WHERE sku_codigo_omie='1001';
  IF r IS NULL THEN RAISE EXCEPTION 'A1 FALHOU: SKU-A não entrou no pedido (deveria, precisa repor)'; END IF;
  IF r.qtde_sugerida <> 10 THEN RAISE EXCEPTION 'A2 FALHOU: SKU-A qtde_sugerida=% (esperado 10=natural)', r.qtde_sugerida; END IF;
  IF r.qtde_final <> 200 THEN RAISE EXCEPTION 'A3 FALHOU: SKU-A qtde_final=% (esperado 200=mínimo forçado)', r.qtde_final; END IF;
  IF r.valor_linha <> 2000 THEN RAISE EXCEPTION 'A4 FALHOU: SKU-A valor_linha=% (esperado 2000=200*10)', r.valor_linha; END IF;
  RAISE NOTICE 'OK A — piso eleva: sugerida=10 final=200 valor=2000';

  -- SKU-B (1002): natural 500 >= minimo 200 → final mantém 500
  SELECT qtde_sugerida, qtde_final INTO r FROM pedido_compra_item WHERE sku_codigo_omie='1002';
  IF r IS NULL THEN RAISE EXCEPTION 'B1 FALHOU: SKU-B não entrou'; END IF;
  IF r.qtde_sugerida <> 500 OR r.qtde_final <> 500 THEN RAISE EXCEPTION 'B2 FALHOU: SKU-B sugerida=% final=% (esperado 500/500)', r.qtde_sugerida, r.qtde_final; END IF;
  RAISE NOTICE 'OK B — natural acima do mínimo: 500/500';

  -- SKU-C (1003): sem minimo (NULL) → final = natural 50 = comportamento atual
  SELECT qtde_sugerida, qtde_final INTO r FROM pedido_compra_item WHERE sku_codigo_omie='1003';
  IF r IS NULL THEN RAISE EXCEPTION 'C1 FALHOU: SKU-C não entrou'; END IF;
  IF r.qtde_sugerida <> 50 OR r.qtde_final <> 50 THEN RAISE EXCEPTION 'C2 FALHOU: SKU-C sugerida=% final=% (esperado 50/50, sem piso)', r.qtde_sugerida, r.qtde_final; END IF;
  RAISE NOTICE 'OK C — sem mínimo (NULL): 50/50 (idêntico ao atual)';

  -- SKU-D (1004): NÃO precisa (estoque>ponto) → não entra, mesmo com minimo setado (PISO, NÃO GATILHO)
  IF EXISTS (SELECT 1 FROM pedido_compra_item WHERE sku_codigo_omie='1004') THEN
    RAISE EXCEPTION 'D1 FALHOU: SKU-D entrou no pedido — mínimo forçado NÃO deve ativar item sobre-estocado';
  END IF;
  RAISE NOTICE 'OK D — não precisa repor: mínimo NÃO ativou (piso, não gatilho)';

  -- SKU-E (1005): passa o gate de necessidade mas natural<=0; compartilha fornecedor FORN-X com 1001.
  -- O filtro [MIN-FORCADO 4/4] do insert de itens deve excluí-lo (senão o GREATEST o elevaria a 200).
  IF EXISTS (SELECT 1 FROM pedido_compra_item WHERE sku_codigo_omie='1005') THEN
    RAISE EXCEPTION 'E1 FALHOU: SKU-E (natural<=0) entrou via header compartilhado — o mínimo viraria gatilho';
  END IF;
  RAISE NOTICE 'OK E — natural<=0 + fornecedor compartilhado: filtro qtde_natural>0 excluiu';

  -- SKU-F (1006): precisa repor MAS fornecedor_nome IS NULL → a blindagem da migration irmã
  -- (fornecedor_nome IS NOT NULL / btrim<>'') deve excluir. Garante que o merge preservou a blindagem.
  IF EXISTS (SELECT 1 FROM pedido_compra_item WHERE sku_codigo_omie='1006') THEN
    RAISE EXCEPTION 'F1 FALHOU: SKU-F (sem fornecedor) entrou — a blindagem de fornecedor foi PERDIDA no merge';
  END IF;
  RAISE NOTICE 'OK F — sem fornecedor: blindagem da irmã preservada (não entrou)';

  RAISE NOTICE '──────── TODOS OS ASSERTS DE QUANTIDADE OK ────────';
END $$;

-- CHECK constraint: rejeita 0, NaN, Infinity; aceita >0 finito e NULL.
DO $$
BEGIN
  BEGIN
    UPDATE sku_parametros SET minimo_forcado_manual = 0 WHERE sku_codigo_omie=1001;
    RAISE EXCEPTION 'CK1 FALHOU: CHECK aceitou 0';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK CHECK rejeita 0'; END;
  BEGIN
    UPDATE sku_parametros SET minimo_forcado_manual = 'NaN'::numeric WHERE sku_codigo_omie=1001;
    RAISE EXCEPTION 'CK2 FALHOU: CHECK aceitou NaN';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK CHECK rejeita NaN'; END;
  BEGIN
    UPDATE sku_parametros SET minimo_forcado_manual = 'Infinity'::numeric WHERE sku_codigo_omie=1001;
    RAISE EXCEPTION 'CK3 FALHOU: CHECK aceitou Infinity';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK CHECK rejeita Infinity'; END;
  -- valor válido e NULL passam
  UPDATE sku_parametros SET minimo_forcado_manual = 150 WHERE sku_codigo_omie=1001;
  UPDATE sku_parametros SET minimo_forcado_manual = NULL WHERE sku_codigo_omie=1001;
  RAISE NOTICE 'OK CHECK aceita >0 finito e NULL';
END $$;

-- NOTA: a interação mínimo×promoção forward_buying (Codex P1) NÃO é coberta aqui — a função
-- aplicar_promocoes_no_ciclo do snapshot usa um padrão SQL inválido (JOIN ON tabela-alvo) que não
-- roda em PG17 e diverge da migration-fonte → tratada como follow-up (requer pg_get_functiondef de
-- prod via Lovable antes de qualquer CREATE OR REPLACE). Ver spec §Follow-ups.

SELECT 'TODOS OS TESTES PG17 PASSARAM ✓' AS resultado;
SQL
echo ""
echo "✓ db/test-minimo-forcado.sh — PASSOU"
