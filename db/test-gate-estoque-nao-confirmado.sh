#!/usr/bin/env bash
# Prova PG17 — GATE de estoque-NÃO-CONFIRMADO em gerar_pedidos_sugeridos_ciclo (money-path).
# Spec: docs/superpowers/specs/2026-06-27-reposicao-gate-estoque-nao-confirmado-spec.md
# Rodar: bash db/test-gate-estoque-nao-confirmado.sh > /tmp/t.log 2>&1; echo "exit=$?"  (NÃO pipe pra tail — engole exit)
# Lei de Ferro: aplica a função REAL (db/embalagem-motor-rpc.sql = fixture viva galão+gate); FALSIFICA (sabota → vermelho → restaura).
# Invariante: estoque cuja ÚNICA fonte é 'cold_start_seed' (sem inventory_position) é DESCONHECIDO → o motor SUPRIME
#   a sugestão (LINHA e GRUPO) + LOGA. Zero CONFIRMADO (ListarPosEstoque/0) e inventory_position presente seguem comprando.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5468}"
SLUG="gate-estoque"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/db/embalagem-motor-rpc.sql"   # fixture VIVA: galão + gate estoque-não-confirmado

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
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

# ── ZONA 1: stubs (sku_estoque_atual TEM fonte_sync; tabela de log presente) ──
P -q <<'SQL'
CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text, demanda_media_diaria numeric);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric, fonte_sync text);
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean);
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, sku_omie text, sku_portal text, ativo boolean);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text, value text);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric, lt_logistica_dias int);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
SQL

# ── ZONA 2: aplicar a função REAL (fixture viva = galão+gate) ──
P -q -f "$MIG"
echo "migration aplicada"

# ── ZONA 3: seeds dos 5 cenários do gate (todos: ativo, tipo 00, Sayerlack, ponto 5/max 10, dispara compra) ──
P -q <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias)
VALUES ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO company_config (key, value) VALUES ('embalagem_preco_motor_stale_dias','45');

INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (100001,'oben','C1 SEED-ONLY','Concentrados',true,'00'),        -- C1: cold_start_seed sem inv → SUPRIME (linha)
 (100002,'oben','C2 CONFIRM ZERO','Concentrados',true,'00'),     -- C2: ListarPosEstoque/0 sem inv → COMPRA
 (100003,'oben','C3 CONFIRM SALDO','Concentrados',true,'00'),    -- C3: ListarPosEstoque/2 → COMPRA
 (100005,'oben','C5 SEED+INV','Concentrados',true,'00'),         -- C5: cold_start_seed MAS inv presente → COMPRA
 (200001,'oben','C4 ANCORA QT','Concentrados',true,'00'),        -- C4 âncora (confirmada) — grupo tem membro seed-only
 (200002,'oben','C4 GALAO GL','Concentrados',true,'00');         -- C4 galão (cold_start_seed) → GRUPO SUPRIME

INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo, minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao) VALUES
 ('OBEN',100001,'C1 SEED-ONLY','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',100002,'C2 CONFIRM ZERO','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',100003,'C3 CONFIRM SALDO','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',100005,'C5 SEED+INV','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',200001,'C4 ANCORA QT','Sayerlack',5,10,NULL,true,'automatica');   -- só a âncora tem parâmetro (galão não)

-- sku_estoque_atual com fonte_sync (a chave do gate)
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
 ('OBEN','100001',0,0,'cold_start_seed'),     -- C1: seed-only
 ('OBEN','100002',0,0,'ListarPosEstoque'),    -- C2: zero CONFIRMADO
 ('OBEN','100003',2,0,'ListarPosEstoque'),    -- C3: saldo confirmado abaixo do ponto
 ('OBEN','100005',0,0,'cold_start_seed'),     -- C5: seed MAS terá inv presente
 ('OBEN','200001',0,0,'ListarPosEstoque'),    -- C4 âncora: CONFIRMADA (não é ela que suprime)
 ('OBEN','200002',0,0,'cold_start_seed');     -- C4 galão: seed-only → contamina o grupo

-- inventory_position: SÓ C5 tem (saldo 0, mas presente = confirma). C1/C2/C3/C4 NÃO têm.
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at) VALUES
 (100005,'vendas',0,50, now());

-- C4: grupo de equivalência (âncora fator 1 + galão fator 4)
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4','200001',1,true),
 ('oben','c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4','200002',4,true);
SQL

# ── seeds das correções pós-Codex (xhigh): C6 missing-sea, C7 membro inativo não envenena ──
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (100006,'oben','C6 MISSING-SEA','Concentrados',true,'00'),   -- C6: SEM linha em sku_estoque_atual (sea ausente)
 (300001,'oben','C7 ANCORA','Concentrados',true,'00'),        -- C7 âncora (confirmada)
 (300002,'oben','C7 GALAO INATIVO','Concentrados',true,'00'); -- C7 galão seed-only MAS inativo no Omie → não vota
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo, minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao) VALUES
 ('OBEN',100006,'C6 MISSING-SEA','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',300001,'C7 ANCORA','Sayerlack',5,10,NULL,true,'automatica');
-- C6: NENHUMA linha em sku_estoque_atual (sea ausente = desconhecido). C7: âncora confirmada + galão seed.
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
 ('OBEN','300001',0,0,'ListarPosEstoque'),
 ('OBEN','300002',0,0,'cold_start_seed');
-- C7: galão 300002 INATIVO no Omie → NÃO deve votar no gate de grupo (senão envenenaria a âncora p/ sempre)
INSERT INTO sku_status_omie (empresa, sku_codigo_omie, ativo_no_omie) VALUES ('OBEN','300002',false);
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','c7c7c7c7-c7c7-c7c7-c7c7-c7c7c7c7c7c7','300001',1,true),
 ('oben','c7c7c7c7-c7c7-c7c7-c7c7-c7c7c7c7c7c7','300002',4,true);
SQL

run_ciclo() { Pq -c "SELECT 1 FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);" >/dev/null; }
G="s.status='pendente_aprovacao' AND COALESCE(s.tipo_ciclo,'normal')='normal'"
conta()     { Pq -c "SELECT count(*) FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id=i.pedido_id WHERE i.sku_codigo_omie='$1' AND $G;"; }
log_conta() { Pq -c "SELECT count(*) FROM reposicao_estoque_nao_confirmado_log WHERE sku_codigo_omie='$1';"; }
log_motivo(){ Pq -c "SELECT motivo FROM reposicao_estoque_nao_confirmado_log WHERE sku_codigo_omie='$1' LIMIT 1;"; }

echo "── asserts (regra verdadeira) ──"
P -q -c "TRUNCATE reposicao_estoque_nao_confirmado_log;"
run_ciclo

# C1 — LINHA seed-only: NÃO compra + loga linha_seed_only
eq "C1 seed-only NÃO gera"       "$(conta '100001')" "0"
eq "C1 logou suprimido"          "$(log_conta '100001')" "1"
eq "C1 motivo=linha_seed_only"   "$(log_motivo '100001')" "linha_seed_only"
# C2 — zero CONFIRMADO (ListarPosEstoque/0): COMPRA (1ª compra legítima, não trapeia zero-real)
eq "C2 confirm-zero COMPRA"      "$(conta '100002')" "1"
eq "C2 não logou"                "$(log_conta '100002')" "0"
# C3 — saldo CONFIRMADO abaixo do ponto: COMPRA normalmente
eq "C3 confirm-saldo COMPRA"     "$(conta '100003')" "1"
# C4 — GRUPO com membro seed-only: âncora NÃO compra + loga grupo_membro_seed_only
eq "C4 grupo SUPRIME âncora"     "$(conta '200001')" "0"
eq "C4 logou grupo"              "$(log_conta '200001')" "1"
eq "C4 motivo=grupo_membro"      "$(log_motivo '200001')" "grupo_membro_seed_only"
# C5 — cold_start_seed MAS inventory_position presente: CONFIRMADO → COMPRA
eq "C5 seed+inv COMPRA"          "$(conta '100005')" "1"
eq "C5 não logou"                "$(log_conta '100005')" "0"
# C6 — missing-sea (sem linha de estoque): NÃO compra (desconhecido ≠ zero confirmado) + loga
eq "C6 missing-sea NÃO gera"     "$(conta '100006')" "0"
eq "C6 logou suprimido"          "$(log_conta '100006')" "1"
# C7 — grupo com membro seed-only INATIVO no Omie: NÃO envenena → âncora ativa COMPRA
eq "C7 inativo não envenena"     "$(conta '300001')" "1"
eq "C7 âncora não logou"         "$(log_conta '300001')" "0"
# total logado = C1 + C4 + C6
eq "log total = 3"               "$(Pq -c 'SELECT count(*) FROM reposicao_estoque_nao_confirmado_log;')" "3"

# ── ZONA 5: FALSIFICAÇÃO (sabota → exige VERMELHO → restaura) ──
echo "── falsificação ──"
falsify() { # $1 desc | $2 sed-expr | $3 SQL-valor (eval) | $4 valor_são (deve MUDAR após sabotar)
  sed "$2" "$MIG" > /tmp/mig-gate-sab.sql
  P -q -f /tmp/mig-gate-sab.sql >/dev/null
  P -q -c "TRUNCATE reposicao_estoque_nao_confirmado_log;" >/dev/null
  run_ciclo
  local got; got="$(eval "$3")"
  if [ "$got" != "$4" ]; then ok "FALSIFY $1 (são=$4 → furado=$got)"; else bad "FALSIFY $1 — assert SEM DENTE (seguiu $4)"; fi
  P -q -f "$MIG" >/dev/null
}

# FAL1 — gate-off: remove "AND NOT sn.suprimido" (os 2 inserts) → C1 seed-only volta a GERAR pedido
falsify "gate-off" \
  's/ AND NOT sn.suprimido//g' \
  'conta 100001' "0"
# FAL2 — grupo-blind: ignora grupo_nao_confirmado (usa só a linha) → C4 âncora (confirmada) deixa de ser suprimida → GERA
falsify "grupo-blind" \
  's/COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido/COALESCE(b.linha_nao_confirmada, b.linha_nao_confirmada) AS suprimido/' \
  'conta 200001' "0"
# FAL3 — suprime-tudo: suprimido := true → C2 (zero CONFIRMADO) deixa de comprar (gate super-restritivo)
falsify "suprime-tudo" \
  's/COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido/true AS suprimido/' \
  'conta 100002' "1"
# FAL4 — inativo-vota: remove "membro inativo não vota" → C7 galão inativo passa a envenenar → âncora SUPRIME
falsify "inativo-vota" \
  's/AND COALESCE(ssg.ativo_no_omie, true) = true//' \
  'conta 300001' "1"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
