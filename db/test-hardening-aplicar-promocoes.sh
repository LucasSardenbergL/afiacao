#!/usr/bin/env bash
# Harness PG17 — valida o HARDENING de `aplicar_promocoes_no_ciclo` (migration 20260606180000).
# Aplica a migration REAL sobre stubs. 1 cenário por trava (H1..H7) + happy + idempotência.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO/supabase/migrations/20260606180000_reposicao_aplicar_promocoes_hardening.sql"
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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-promohard.log -w start >/dev/null
PSQL=("$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# ── Stubs (colunas novas: view tem campanha_id/qtde_base/fornecedor_nome; item tem ajustado_humano; sugerido tem tipo_ciclo) ──
"${PSQL[@]}" <<'SQL'
CREATE TABLE pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text, fornecedor_nome text, data_ciclo date, status text, tipo_ciclo text,
  valor_total numeric, pedido_anterior_valor numeric, delta_vs_anterior_perc numeric, mensagem_bloqueio text
);
CREATE TABLE pedido_compra_item (
  id bigint PRIMARY KEY, pedido_id bigint, sku_codigo_omie text, qtde_sugerida numeric, qtde_final numeric,
  preco_unitario numeric, valor_linha numeric, modo_promocao text, promocao_item_id bigint,
  qtde_sem_promocao numeric, preco_sem_desconto numeric, desconto_perc_aplicado numeric,
  economia_estimada_valor numeric, ajustado_humano boolean DEFAULT false
);
CREATE TABLE fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, delta_max_perc numeric);
CREATE TABLE promocao_campanha (id bigint PRIMARY KEY, empresa text, fornecedor_nome text, data_inicio date, data_fim date);
CREATE TABLE v_promocao_avaliacao_hoje (
  empresa text, modo_aplicacao text, sku_codigo_omie bigint, desconto_perc numeric, item_id bigint,
  qtde_com_desconto numeric, economia_bruta_valor numeric, campanha_id bigint, fornecedor_nome text, qtde_base numeric
);
SQL

# ── Aplica a MIGRATION REAL (a função hardened) ──
"${PSQL[@]}" -f "$MIG" >/dev/null

# ── Seed (datas relativas a CURRENT_DATE) ──
"${PSQL[@]}" <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao VALUES ('OBEN','FORN_A',9999),('OBEN','FORN_B',9999);

-- campanhas (todas vigentes HOJE, exceto a janela específica de H2)
INSERT INTO promocao_campanha VALUES
 (10,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (20,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (30,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (40,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (50,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (60,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10),
 (70,'OBEN','FORN_A',CURRENT_DATE-2 ,CURRENT_DATE+10),  -- vigente HOJE, NAO em CT-5 (H2)
 (80,'OBEN','FORN_A',CURRENT_DATE-10,CURRENT_DATE+10);  -- vigente em CT-5 (controle B)

-- view: 1 linha por SKU (como o DISTINCT ON real)
INSERT INTO v_promocao_avaliacao_hoje VALUES
 ('OBEN','flat',          111,10,1001, 5 ,0 ,10,'FORN_A',5),
 ('OBEN','forward_buying',222, 5,1002,100,90,20,'FORN_A',50),  -- qcd 100 < qtde_final 200 (H6 GREATEST)
 ('OBEN','flat',          333,10,1003, 5 ,0 ,30,'FORN_A',5),   -- pedido e FORN_B (H1)
 ('OBEN','flat',          444,10,1004, 5 ,0 ,40,'FORN_A',5),   -- item ajustado (H4)
 ('OBEN','flat',          555,10,1005, 5 ,0 ,50,'FORN_A',5),   -- pedido oportunidade (H5)
 ('OBEN','forward_buying',666, 5,1006, 20,10,60,'FORN_A',10),  -- qtde_final 5 < qtde_base 10 (H7)
 ('OBEN','flat',          777,10,1007, 5 ,0 ,70,'FORN_A',5),   -- vigencia CT-2 (H2)
 ('OBEN','flat',          888,10,1008, 5 ,0 ,80,'FORN_A',5);   -- vigencia CT-10 (controle B)

-- pedidos de HOJE
INSERT INTO pedido_compra_sugerido VALUES (1,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (2,'OBEN','FORN_B',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (3,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (4,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','oportunidade_promo',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (6,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (7,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
-- pedidos de CT-5
INSERT INTO pedido_compra_sugerido VALUES (5,'OBEN','FORN_A',CURRENT_DATE-5,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_sugerido VALUES (8,'OBEN','FORN_A',CURRENT_DATE-5,'pendente_aprovacao','normal',999,99999,NULL,NULL);

-- itens
INSERT INTO pedido_compra_item(id,pedido_id,sku_codigo_omie,qtde_sugerida,qtde_final,preco_unitario,valor_linha,ajustado_humano) VALUES
 (1,1,'111', 5,  5,10, 50,false),   -- happy flat -> aplica
 (2,1,'222',10,200,20,4000,false),  -- happy forward, qtde_final 200 por minimo forcado (H6)
 (3,2,'333', 5,  5,10, 50,false),   -- H1: pedido FORN_B
 (4,3,'444', 5,  5,10, 50,true),    -- H4: ajustado_humano
 (5,4,'555', 5,  5,10, 50,false),   -- H5: pedido oportunidade
 (6,6,'666', 5,  5,20,100,false),   -- H7: qtde_final 5 < qtde_base 10
 (7,7,'ABC', 5,  5,10, 50,false),   -- H3: SKU nao-numerico (nao pode estourar)
 (8,5,'777', 5,  5,10, 50,false),   -- H2: vigencia (campanha CT-2, pedido CT-5)
 (9,8,'888', 5,  5,10, 50,false);   -- controle B: vigencia OK em CT-5 -> aplica

-- P2#1: pedido de OPORTUNIDADE com item ja-promocional -> a funcao NAO deve contar/recalcular/bloquear
INSERT INTO pedido_compra_sugerido VALUES (90,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','oportunidade_promo',777,99999,NULL,NULL);
INSERT INTO pedido_compra_item(id,pedido_id,sku_codigo_omie,qtde_sugerida,qtde_final,preco_unitario,valor_linha,modo_promocao,economia_estimada_valor,ajustado_humano)
 VALUES (10,90,'999',5,5,10,50,'flat',7,false);
-- P2#2 / H7b: item com qtde_final=0 (SKU com campanha valida) -> NAO aplica
INSERT INTO pedido_compra_sugerido VALUES (91,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao','normal',999,99999,NULL,NULL);
INSERT INTO pedido_compra_item(id,pedido_id,sku_codigo_omie,qtde_sugerida,qtde_final,preco_unitario,valor_linha,ajustado_humano)
 VALUES (11,91,'111',5,0,10,0,false);
SQL

# ── Chamada A (hoje) + asserts ──
"${PSQL[@]}" <<'SQL'
CREATE TEMP TABLE rA AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM rA;
  -- retorno agregado: 1 flat + 1 forward; pedidos_afetados=1 (so o normal, NAO o de oportunidade); economia=5+200=205
  IF ret.itens_flat_aplicados <> 1 OR ret.itens_forward_buying_aplicados <> 1
     OR ret.pedidos_afetados <> 1 OR ret.economia_total_estimada <> 205 THEN
    RAISE EXCEPTION 'A retorno errado: flat=% fb=% ped=% econ=% (esperado 1/1/1/205)',
      ret.itens_flat_aplicados, ret.itens_forward_buying_aplicados, ret.pedidos_afetados, ret.economia_total_estimada; END IF;
  -- happy flat (sku111): preco 10->9, valor_linha 45, economia 5
  SELECT * INTO r FROM pedido_compra_item WHERE id=1;
  IF r.modo_promocao<>'flat' OR r.preco_unitario<>9 OR r.valor_linha<>45 OR r.economia_estimada_valor<>5 THEN
    RAISE EXCEPTION 'happy flat falhou: % p% vl% e%', r.modo_promocao,r.preco_unitario,r.valor_linha,r.economia_estimada_valor; END IF;
  -- H6 forward nao-rebaixa (sku222): GREATEST(100,200)=200; preco 19; valor_linha 200*19=3800; economia 200*20*5/100=200
  SELECT * INTO r FROM pedido_compra_item WHERE id=2;
  IF r.modo_promocao<>'forward_buying' OR r.qtde_final<>200 OR r.qtde_sem_promocao<>200
     OR r.preco_unitario<>19 OR r.valor_linha<>3800 OR r.economia_estimada_valor<>200 THEN
    RAISE EXCEPTION 'H6 forward errado: qtde=% sem_promo=% preco=% vl=% e=%',
      r.qtde_final,r.qtde_sem_promocao,r.preco_unitario,r.valor_linha,r.economia_estimada_valor; END IF;
  -- pedido 1 (normal): valor_total recalculado = 45 + 3800 = 3845
  IF (SELECT valor_total FROM pedido_compra_sugerido WHERE id=1) <> 3845 THEN
    RAISE EXCEPTION 'pedido1 valor_total errado: %', (SELECT valor_total FROM pedido_compra_sugerido WHERE id=1); END IF;
  -- P2#1 oportunidade (pedido 90): valor_total NAO recalculado (continua 777)
  IF (SELECT valor_total FROM pedido_compra_sugerido WHERE id=90) <> 777 THEN
    RAISE EXCEPTION 'P2#1 oportunidade tocada: valor_total=%', (SELECT valor_total FROM pedido_compra_sugerido WHERE id=90); END IF;
  -- H1/H4/H5/H7(qtde_base)/H3 + H7b(qtde 0, item 11): NAO aplicados
  PERFORM 1 FROM pedido_compra_item WHERE id IN (3,4,5,6,7,11) AND modo_promocao IS NOT NULL;
  IF FOUND THEN RAISE EXCEPTION 'algum item proibido foi aplicado (3/4/5/6/7/11)'; END IF;
  RAISE NOTICE 'A OK: happy + formulas(H6) + H1 + H4 + H5 + H7 + H7b(qtde0) + H3 + P2#1(oportunidade intocada) + agregado';
END $$;

-- Chamada B (CT-5): H2 vigencia
CREATE TEMP TABLE rB AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE-5);
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM rB;
  IF ret.itens_flat_aplicados <> 1 THEN RAISE EXCEPTION 'B retorno errado: flat=% (esperado 1)', ret.itens_flat_aplicados; END IF;
  -- controle: sku888 aplica (vigente em CT-5)
  SELECT * INTO r FROM pedido_compra_item WHERE id=9;
  IF r.modo_promocao<>'flat' THEN RAISE EXCEPTION 'controle B falhou: sku888 deveria aplicar'; END IF;
  -- H2: sku777 NAO aplica (campanha CT-2 nao vigia em CT-5)
  SELECT * INTO r FROM pedido_compra_item WHERE id=8;
  IF r.modo_promocao IS NOT NULL THEN RAISE EXCEPTION 'H2 vigencia falhou: sku777 aplicou fora da vigencia'; END IF;
  RAISE NOTICE 'B OK: H2(vigencia na data do pedido) + controle vigente';
END $$;

-- Idempotencia (re-roda hoje, 0 aplicados, sku111 nao re-desconta)
CREATE TEMP TABLE rA2 AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM rA2;
  IF ret.itens_flat_aplicados<>0 OR ret.itens_forward_buying_aplicados<>0 THEN
    RAISE EXCEPTION 'idempotencia falhou: flat=% fb=%', ret.itens_flat_aplicados, ret.itens_forward_buying_aplicados; END IF;
  SELECT * INTO r FROM pedido_compra_item WHERE id=1;
  IF r.preco_unitario<>9 THEN RAISE EXCEPTION 'idempotencia: sku111 re-descontado -> %', r.preco_unitario; END IF;
  RAISE NOTICE 'IDEMPOTENCIA OK';
END $$;
SQL

echo "✓ HARDENING: todas as 7 travas (H1-H7) + happy + idempotência PASSARAM"
