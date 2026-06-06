#!/usr/bin/env bash
# Harness PG17 — valida PR2b (migration 20260606200000): forward_buying respeita a necessidade
# real (não reduz abaixo de pci.qtde_final, que já embute o mínimo forçado) + ceil (sem fração).
# Stubs self-contained (mesmo padrão do test-fix-aplicar-promocoes.sh).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO/supabase/migrations/20260606200000_reposicao_promo_forward_buying_min.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
[ -x "$PGBIN/initdb" ] || PGBIN="$(dirname "$(command -v initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
export LC_ALL=C LANG=C
PORT=5445
DATA="$(mktemp -d)/pgd"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-fbmin.log -w start >/dev/null
PSQL=("$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs (só as colunas que a função toca)
"${PSQL[@]}" <<'SQL'
CREATE TABLE pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text, fornecedor_nome text, data_ciclo date, status text,
  valor_total numeric, pedido_anterior_valor numeric, delta_vs_anterior_perc numeric, mensagem_bloqueio text
);
CREATE TABLE pedido_compra_item (
  id bigint PRIMARY KEY, pedido_id bigint, sku_codigo_omie text, qtde_sugerida numeric, qtde_final numeric,
  preco_unitario numeric, valor_linha numeric, modo_promocao text, promocao_item_id bigint,
  qtde_sem_promocao numeric, preco_sem_desconto numeric, desconto_perc_aplicado numeric, economia_estimada_valor numeric
);
CREATE TABLE fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, delta_max_perc numeric);
CREATE TABLE v_promocao_avaliacao_hoje (
  empresa text, modo_aplicacao text, sku_codigo_omie bigint, desconto_perc numeric, item_id bigint,
  qtde_com_desconto numeric, economia_bruta_valor numeric
);
SQL

# Aplica a MIGRATION REAL (PR2b)
"${PSQL[@]}" -f "$MIG" >/dev/null
echo "REPLACE OK (PR2b)."

# Seed + asserts
"${PSQL[@]}" <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao VALUES ('OBEN','FORN_A',1000); -- delta alto: guardrail não interfere
-- pedido_anterior_valor alto p/ não disparar guardrail (foco é a qtde do forward_buying)
INSERT INTO pedido_compra_sugerido VALUES (1,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao',0,9999999,NULL,NULL);
-- A (901): necessidade 30, promo 100 → compra 100 (promo > necessidade)
INSERT INTO pedido_compra_item VALUES (10,1,'901',30,30,10,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
-- B (902): necessidade 100, promo 30 → compra 100 (NÃO reduz; o piso — KEY FIX; antes daria 30)
INSERT INTO pedido_compra_item VALUES (20,1,'902',100,100,10,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
-- C (903): necessidade 50, promo 80.7 (fracionária) → ceil(GREATEST(80.7,50))=81
INSERT INTO pedido_compra_item VALUES (30,1,'903',50,50,10,NULL,NULL,NULL,NULL,NULL,NULL,NULL);

INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','forward_buying',901,10,1001,100,500);
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','forward_buying',902,10,1002,30,100);
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','forward_buying',903,10,1003,80.7,200);

SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);

DO $$
DECLARE r record;
BEGIN
  -- A: promo>necessidade → 100; qtde_sem_promocao = necessidade real (30); preço 9; vl 100*9=900
  SELECT * INTO r FROM pedido_compra_item WHERE id=10;
  IF r.qtde_final<>100 OR r.qtde_sem_promocao<>30 OR r.valor_linha<>900 THEN
    RAISE EXCEPTION 'A (901) errado: qf=% qsp=% vl=%', r.qtde_final, r.qtde_sem_promocao, r.valor_linha; END IF;
  RAISE NOTICE 'B1 OK: A promo(100)>necessidade(30) -> compra 100, qsp=30';

  -- B: promo<necessidade → PISO na necessidade (100), NÃO 30; qsp=100; vl 100*9=900
  SELECT * INTO r FROM pedido_compra_item WHERE id=20;
  IF r.qtde_final<>100 OR r.qtde_sem_promocao<>100 OR r.valor_linha<>900 THEN
    RAISE EXCEPTION 'B (902) errado [KEY]: qf=% qsp=% vl=% (esperado 100/100/900; bug daria 30)', r.qtde_final, r.qtde_sem_promocao, r.valor_linha; END IF;
  RAISE NOTICE 'B2 OK [KEY]: B promo(30)<necessidade(100) -> NAO reduz, compra 100';

  -- C: promo fracionária 80.7 → ceil(GREATEST(80.7,50))=81; vl 81*9=729
  SELECT * INTO r FROM pedido_compra_item WHERE id=30;
  IF r.qtde_final<>81 OR r.valor_linha<>729 THEN
    RAISE EXCEPTION 'C (903) errado: qf=% vl=% (esperado 81/729)', r.qtde_final, r.valor_linha; END IF;
  RAISE NOTICE 'B3 OK: C promo fracionaria 80.7 -> ceil 81';
END $$;

-- Idempotência: 2a passada não reaplica
CREATE TEMP TABLE r2 AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM r2;
  IF ret.itens_forward_buying_aplicados<>0 THEN RAISE EXCEPTION 'IDEMPOTENCIA: 2a passada aplicou fb=%', ret.itens_forward_buying_aplicados; END IF;
  SELECT * INTO r FROM pedido_compra_item WHERE id=20;
  IF r.qtde_final<>100 THEN RAISE EXCEPTION 'IDEMPOTENCIA: B mudou na 2a passada -> %', r.qtde_final; END IF;
  RAISE NOTICE 'B4 OK: idempotente.';
END $$;
SQL

echo "✅ test-promo-forward-buying-min OK (piso na necessidade + mínimo forçado embutido + ceil + idempotência)"
