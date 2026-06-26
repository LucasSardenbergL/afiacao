#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — split estoque_fisico/estoque_a_caminho no item do pedido         ║
# ║  Migration: 20260626150457_pedido_item_split_estoque_fisico_a_caminho.sql      ║
# ║  Prova: a RPC gerar_pedidos_sugeridos_ciclo EXECUTA (late-bound) e grava os    ║
# ║  componentes; invariante fisico+a_caminho=efetivo; a_caminho capta pendente E  ║
# ║  em-trânsito; cálculo de compra inalterado. Falsifica esquecendo em_transito.  ║
# ║  Rode: bash db/test-pedido-item-split-estoque.sh > /tmp/t.log 2>&1; echo $?    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="pedido-item-split-estoque"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-requisitos: stubs das 11 tabelas que a RPC lê/altera ──
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY,
  empresa text, fornecedor_nome text, grupo_codigo text, data_ciclo date,
  horario_corte_planejado timestamptz, valor_total numeric, num_skus int,
  status text, condicao_pagamento_codigo text, condicao_pagamento_descricao text,
  num_parcelas int, dias_parcelas text, condicao_origem text,
  status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text,
  tipo_ciclo text, atualizado_em timestamptz
);
CREATE TABLE public.pedido_compra_item (
  id bigserial PRIMARY KEY,
  pedido_id bigint, sku_codigo_omie text, sku_descricao text,
  estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric,
  valor_linha numeric, primeira_compra boolean
);
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie text, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text
);
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric);
CREATE TABLE public.omie_products (omie_codigo_produto text, account text, ativo boolean, descricao text, familia text, tipo_produto text, metadata jsonb);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.inventory_position (omie_codigo_produto text, account text, cmc numeric, synced_at timestamptz);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260626150457_pedido_item_split_estoque_fisico_a_caminho.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed: SKU1 (pendente puro: fis=2,pend=1) e SKU2 (em-trânsito puro: fis=0,pend=0,transito=4) ──
P -q <<'SQL'
-- guard tipo_produto_unhealthy exige >=1 omie_products(account='oben') com tipo_produto não-nulo
INSERT INTO public.omie_products(omie_codigo_produto,account,ativo,descricao,familia,tipo_produto) VALUES
 ('8689723601','oben',true,'SELADORA SEMI-BRILHO NLO.9506.00LT','SELADORA','01'),
 ('SKU2','oben',true,'PRODUTO EM TRANSITO','FAM2','01');

INSERT INTO public.sku_parametros(empresa,sku_codigo_omie,sku_descricao,fornecedor_nome,ponto_pedido,estoque_maximo,minimo_forcado_manual,habilitado_reposicao_automatica,tipo_reposicao) VALUES
 ('OBEN','8689723601','SELADORA SEMI-BRILHO NLO.9506.00LT','RENNER SAYERLACK S/A',5,5,NULL,true,'automatica'),
 ('OBEN','SKU2','PRODUTO EM TRANSITO','RENNER SAYERLACK S/A',10,10,NULL,true,'automatica');

INSERT INTO public.sku_estoque_atual(empresa,sku_codigo_omie,estoque_fisico,estoque_pendente_entrada) VALUES
 ('OBEN','8689723601',2,1),
 ('OBEN','SKU2',0,0);

INSERT INTO public.fornecedor_habilitado_reposicao(empresa,fornecedor_nome,horario_corte_pedido,valor_maximo_mensal,delta_max_perc) VALUES
 ('OBEN','RENNER SAYERLACK S/A', INTERVAL '18:00', NULL, NULL);

INSERT INTO public.inventory_position(omie_codigo_produto,account,cmc,synced_at) VALUES
 ('8689723601','oben',1421.064, now()),
 ('SKU2','oben',100, now());

-- em-trânsito p/ SKU2: 1 pedido DISPARADO hoje com item qtde_final=4 (entra no CTE em_transito)
INSERT INTO public.pedido_compra_sugerido(id,empresa,fornecedor_nome,grupo_codigo,data_ciclo,status,tipo_ciclo)
  VALUES (9001,'OBEN','RENNER SAYERLACK S/A',NULL,CURRENT_DATE,'disparado','normal');
INSERT INTO public.pedido_compra_item(pedido_id,sku_codigo_omie,sku_descricao,estoque_atual,ponto_pedido,estoque_maximo,qtde_sugerida,qtde_final,preco_unitario,valor_linha,primeira_compra)
  VALUES (9001,'SKU2','PRODUTO EM TRANSITO',0,10,10,4,4,100,400,false);
SQL

# ── ZONA 4 — asserts ──
echo "── asserts ──"
# A1 — a RPC EXECUTA (pega bug late-bound) e gera 1 pedido pai
GER=$(Pq -c "SELECT pedidos_gerados FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);")
eq "A1 RPC executa + gera 1 pedido" "$GER" "1"

# A2 — SKU1 (pendente puro): fisico=2, a_caminho=1, efetivo=3
S1=$(Pq -c "SELECT i.estoque_fisico||'/'||i.estoque_a_caminho||'/'||i.estoque_atual FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.sku_codigo_omie='8689723601';")
eq "A2 SKU1 split fis/caminho/efetivo" "$S1" "2/1/3"

# A3 — SKU2 (em-trânsito puro): fisico=0, a_caminho=4 (capta em_transito!), efetivo=4
S2=$(Pq -c "SELECT i.estoque_fisico||'/'||i.estoque_a_caminho||'/'||i.estoque_atual FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.sku_codigo_omie='SKU2';")
eq "A3 SKU2 a_caminho capta em_transito" "$S2" "0/4/4"

# A4 — invariante money-path: fisico + a_caminho = estoque_atual (efetivo) p/ TODOS os itens novos
VIOL=$(Pq -c "SELECT count(*) FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.estoque_fisico IS NOT NULL AND (i.estoque_fisico + i.estoque_a_caminho) <> i.estoque_atual;")
eq "A4 invariante fis+caminho=efetivo (0 violações)" "$VIOL" "0"

# A5 — cálculo de compra INALTERADO (SKU1 qtde_sugerida=ceil(5-3)=2, qtde_final=2)
Q1=$(Pq -c "SELECT i.qtde_sugerida||'/'||i.qtde_final FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.sku_codigo_omie='8689723601';")
eq "A5 SKU1 qtde de compra inalterada" "$Q1" "2/2"

# ── ZONA 5 — FALSIFICAÇÃO: sabota esquecendo o em_transito → invariante deve QUEBRAR no SKU2 ──
echo "── falsificação ──"
SAB=$(mktemp /tmp/sab-${SLUG}.XXXXXX.sql)
# troca (sn.estoque_pendente + sn.qtde_em_transito_recente) por só sn.estoque_pendente
sed 's/(sn.estoque_pendente + sn.qtde_em_transito_recente)/sn.estoque_pendente/' "$MIG" > "$SAB"
GREP_OK=$(grep -c 'sn.estoque_fisico, sn.estoque_pendente$' "$SAB" || true)
P -q -f "$SAB"
P -q -c "SELECT gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);" >/dev/null
VIOL_SAB=$(Pq -c "SELECT count(*) FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.estoque_fisico IS NOT NULL AND (i.estoque_fisico + i.estoque_a_caminho) <> i.estoque_atual;")
if [ "$GREP_OK" = "1" ] && [ "$VIOL_SAB" -ge 1 ]; then
  ok "FALSIFICAÇÃO mordeu: esquecer em_transito → $VIOL_SAB item(ns) violam o invariante"
else
  bad "FALSIFICAÇÃO NÃO mordeu (grep=$GREP_OK viol=$VIOL_SAB) — assert sem dente"
fi
# restaura a versão verdadeira
P -q -f "$MIG"
P -q -c "SELECT gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);" >/dev/null
VIOL_REST=$(Pq -c "SELECT count(*) FROM pedido_compra_item i JOIN pedido_compra_sugerido p ON p.id=i.pedido_id WHERE p.status='pendente_aprovacao' AND i.estoque_fisico IS NOT NULL AND (i.estoque_fisico + i.estoque_a_caminho) <> i.estoque_atual;")
eq "A6 restaurado: invariante volta a fechar (0 violações)" "$VIOL_REST" "0"
rm -f "$SAB"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
