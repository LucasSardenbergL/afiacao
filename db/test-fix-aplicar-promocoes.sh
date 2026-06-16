#!/usr/bin/env bash
# Harness PG17 — valida o fix de `aplicar_promocoes_no_ciclo` (migration 20260606170000).
# Aplica a MIGRATION REAL sobre stubs e prova: (1) o padrão de prod aborta no parse;
# (2) a função corrigida roda e aplica flat (desconto no preço) + forward_buying (infla
# qtde); (3) idempotência; (4) guardrail de delta bloqueia pedido inflado; (5) pedido
# só-flat não dispara guardrail.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO/supabase/migrations/20260606170000_reposicao_fix_aplicar_promocoes.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
[ -x "$PGBIN/initdb" ] || PGBIN="$(dirname "$(command -v initdb)")"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
export LC_ALL=C LANG=C
PORT=5444
DATA="$(mktemp -d)/pgd"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-promofix.log -w start >/dev/null
PSQL=("$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# ── 1. Stubs (só as colunas que a função toca) ────────────────────────────────
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

# ── 2. Aplica a MIGRATION REAL (cria a função corrigida) ──────────────────────
"${PSQL[@]}" -f "$MIG" >/dev/null

# ── 3. Função "buggy" = padrão de PROD (JOIN com alvo no FROM) p/ contraprova ──
"${PSQL[@]}" <<'SQL'
CREATE FUNCTION aplicar_buggy(p_empresa text, p_data_ciclo date) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  UPDATE pedido_compra_item pci SET modo_promocao = 'flat'
  FROM v_promocao_avaliacao_hoje av
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE av.modo_aplicacao = 'flat' AND av.empresa = p_empresa
    AND pcs.empresa = p_empresa AND pcs.data_ciclo = p_data_ciclo AND pcs.status = 'pendente_aprovacao'
    AND pci.sku_codigo_omie::bigint = av.sku_codigo_omie AND pci.modo_promocao IS NULL;
END $f$;
SQL

# ── 4. Seed + cenários + asserts ──────────────────────────────────────────────
"${PSQL[@]}" <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao VALUES ('OBEN','FORN_A',50);  -- delta máx 50%
-- Pedido 1 (não bloqueia): anterior alto; flat sku111 + forward sku222
INSERT INTO pedido_compra_sugerido VALUES (1,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao',150,5000,NULL,NULL);
INSERT INTO pedido_compra_item VALUES (10,1,'111',5,5,10,50,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO pedido_compra_item VALUES (20,1,'222',5,5,20,100,NULL,NULL,NULL,NULL,NULL,NULL);
-- Pedido 2 (bloqueia guardrail): anterior baixo; forward sku333 infla muito
INSERT INTO pedido_compra_sugerido VALUES (2,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao',100,100,NULL,NULL);
INSERT INTO pedido_compra_item VALUES (30,2,'333',5,5,20,100,NULL,NULL,NULL,NULL,NULL,NULL);
-- Pedido 3 (só flat, não dispara guardrail): anterior baixo; flat sku444
INSERT INTO pedido_compra_sugerido VALUES (3,'OBEN','FORN_A',CURRENT_DATE,'pendente_aprovacao',50,100,NULL,NULL);
INSERT INTO pedido_compra_item VALUES (40,3,'444',10,10,5,50,NULL,NULL,NULL,NULL,NULL,NULL);
-- Promoções na view (1 linha por SKU, como o DISTINCT ON real garante)
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','flat',111,10,1001,5,0);
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','forward_buying',222,5,1002,50,90);
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','forward_buying',333,5,1003,100,200);
INSERT INTO v_promocao_avaliacao_hoje VALUES ('OBEN','flat',444,20,1004,10,0);

-- CENÁRIO 1: contraprova — a função buggy (padrão de prod) ABORTA no parse
DO $$
BEGIN
  PERFORM aplicar_buggy('OBEN', CURRENT_DATE);
  RAISE EXCEPTION 'C1 FALHOU: a versao buggy deveria abortar no parse, mas rodou';
EXCEPTION WHEN others THEN
  IF SQLERRM ILIKE '%invalid reference to FROM-clause entry%' THEN
    RAISE NOTICE 'C1 OK: padrao de prod aborta -> %', SQLERRM;
  ELSE
    RAISE EXCEPTION 'C1 FALHOU: buggy abortou com erro inesperado -> %', SQLERRM;
  END IF;
END $$;

-- Executa a função CORRIGIDA (processa todos os pedidos pendentes do ciclo)
CREATE TEMP TABLE r1 AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);

-- CENÁRIO 2/4/5: asserts de aplicação + guardrail
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM r1;
  -- economia = sku111(5) + sku222(90) + sku333(200) + sku444(10) = 305
  IF ret.itens_flat_aplicados <> 2 OR ret.itens_forward_buying_aplicados <> 2
     OR ret.pedidos_afetados <> 3 OR ret.economia_total_estimada <> 305
     OR ret.pedidos_bloqueados_por_delta <> 1 THEN
    RAISE EXCEPTION 'RETORNO errado: flat=% fb=% ped=% econ=% bloq=%',
      ret.itens_flat_aplicados, ret.itens_forward_buying_aplicados, ret.pedidos_afetados,
      ret.economia_total_estimada, ret.pedidos_bloqueados_por_delta;
  END IF;

  -- flat (sku111): preço 10->9, qtde inalterada, vl 45, econ 5
  SELECT * INTO r FROM pedido_compra_item WHERE id=10;
  IF r.modo_promocao<>'flat' OR r.qtde_final<>5 OR r.preco_unitario<>9 OR r.valor_linha<>45 OR r.economia_estimada_valor<>5 THEN
    RAISE EXCEPTION 'FLAT sku111 errado: % q% p% vl% e%', r.modo_promocao,r.qtde_final,r.preco_unitario,r.valor_linha,r.economia_estimada_valor; END IF;
  -- forward (sku222): qtde 5->50, preço 19, vl 950, econ 90
  SELECT * INTO r FROM pedido_compra_item WHERE id=20;
  IF r.modo_promocao<>'forward_buying' OR r.qtde_final<>50 OR r.preco_unitario<>19 OR r.valor_linha<>950 OR r.economia_estimada_valor<>90 THEN
    RAISE EXCEPTION 'FORWARD sku222 errado: % q% p% vl% e%', r.modo_promocao,r.qtde_final,r.preco_unitario,r.valor_linha,r.economia_estimada_valor; END IF;
  -- pedido 1: NAO bloqueado (995/5000 << 1.5)
  SELECT * INTO r FROM pedido_compra_sugerido WHERE id=1;
  IF r.status<>'pendente_aprovacao' OR r.valor_total<>995 THEN RAISE EXCEPTION 'pedido1 errado: % vt%', r.status, r.valor_total; END IF;
  -- pedido 2: BLOQUEADO (1900/100=19 > 1.5)
  SELECT * INTO r FROM pedido_compra_sugerido WHERE id=2;
  IF r.status<>'bloqueado_guardrail' OR r.valor_total<>1900 THEN RAISE EXCEPTION 'pedido2 deveria bloquear: % vt%', r.status, r.valor_total; END IF;
  -- pedido 3: so flat (sku444 q10 p5 desc20% -> preco 4, vl 40) -> NAO entra na reavaliacao de guardrail
  SELECT * INTO r FROM pedido_compra_sugerido WHERE id=3;
  IF r.status<>'pendente_aprovacao' OR r.valor_total<>40 OR r.delta_vs_anterior_perc IS NOT NULL THEN
    RAISE EXCEPTION 'pedido3 (so flat) nao deveria ser tocado pelo guardrail: % vt% delta%', r.status, r.valor_total, r.delta_vs_anterior_perc; END IF;
  RAISE NOTICE 'C2/C4/C5 OK: flat+forward aplicados; guardrail bloqueia inflado; so-flat intacto.';
END $$;

-- CENÁRIO 3: idempotência — rodar de novo aplica 0 e NAO re-desconta
CREATE TEMP TABLE r2 AS SELECT * FROM aplicar_promocoes_no_ciclo('OBEN', CURRENT_DATE);
DO $$
DECLARE r record; ret record;
BEGIN
  SELECT * INTO ret FROM r2;
  IF ret.itens_flat_aplicados<>0 OR ret.itens_forward_buying_aplicados<>0 THEN
    RAISE EXCEPTION 'IDEMPOTENCIA falhou: 2a passada aplicou flat=% fb=%', ret.itens_flat_aplicados, ret.itens_forward_buying_aplicados; END IF;
  SELECT * INTO r FROM pedido_compra_item WHERE id=10;
  IF r.preco_unitario<>9 THEN RAISE EXCEPTION 'IDEMPOTENCIA falhou: sku111 re-descontado -> preco %', r.preco_unitario; END IF;
  RAISE NOTICE 'C3 OK: idempotente (2a passada nao reaplica).';
END $$;
SQL

echo "✓ TODOS OS CENÁRIOS PASSARAM (contraprova + flat + forward + guardrail + so-flat + idempotência)"
