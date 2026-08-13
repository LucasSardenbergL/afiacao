#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: erro TERMINAL do portal deixa de virar "estoque a caminho".
# Incidente: pedido #1276 (OBEN/Sayerlack) travado em aprovado_aguardando_disparo + erro_nao_retentavel
# inflou o estoque efetivo por 7 dias e SUPRIMIU a recompra de 4 SKUs.
# Rodar: bash db/test-em-transito-erro-terminal.sh > log 2>&1; echo "exit=$?"  (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica as MIGRATIONS REAIS (base 20260730130000 + a nova); asserts numericos por cenario;
# FALSIFICA (sabota -> exige vermelho ESPECIFICO -> restaura). Sentinelas ASCII, caixa fixa.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="em-transito-erro-terminal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260730130000_reposicao_teto_cobertura_motor.sql"
MIG="$REPO_ROOT/supabase/migrations/20260802120000_reposicao_erro_terminal_nao_e_estoque_a_caminho.sql"
FIXTURE="$REPO_ROOT/db/embalagem-motor-rpc.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ── ZONA 1: roles/schemas + stubs das tabelas que a funcao LE (espelham a prod) ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE SCHEMA private;
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric, fonte_sync text);
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean);
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, sku_omie text, sku_portal text, ativo boolean);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric, lt_logistica_dias int);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric NOT NULL DEFAULT 0, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
SQL
echo "stubs criados"

# ── ZONA 2: MIGRATIONS REAIS, na ordem (base cria log/ALTERs/config; a nova recria a funcao = a que vence) ──
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") -> $(basename "$MIG")"

# baseline de que a funcao viva e a NOVA (detector com objeto vivo, nao grep de arquivo)
eq "funcao em prod tem a clausula do erro terminal" \
   "$(Pq -c "SELECT (pg_get_functiondef(oid) LIKE '%erro_nao_retentavel%')::text FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "true"

# ── ZONA 3: seeds — 6 SKUs, 1 por cenario. Todos identicos EXCETO o estado do pedido anterior. ──
# Desenho: pp=3, max=5, fisico=1, pedido anterior qtde_final=4.
#   sem fantasma -> efetivo 1 <= pp 3 -> SUGERE ceil(5-1)=4
#   com fantasma -> efetivo 1+4=5  > pp 3 -> AUSENTE
# classe A: fora do teto de cobertura (isola a variavel testada). fonte_sync confirmada.
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (9201,'oben','S1 ERRO TERMINAL LIMPO','Tintas',true,'00'),
 (9202,'oben','S2 APROVADO SAUDAVEL','Tintas',true,'00'),
 (9203,'oben','S3 ERRO COM PROTOCOLO','Tintas',true,'00'),
 (9204,'oben','S4 ERRO COM OMIE','Tintas',true,'00'),
 (9205,'oben','S5 ERRO RETENTAVEL','Tintas',true,'00'),
 (9206,'oben','S6 DISPARADO','Tintas',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);

INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
SELECT 'OBEN', g, 'S'||g, 'Sayerlack', 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL
FROM generate_series(9201,9206) g;

INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
SELECT 'OBEN', g::text, 1, 0, 'ListarPosEstoque' FROM generate_series(9201,9206) g;

-- pedidos anteriores (data_ciclo dentro da janela de 7 dias do ciclo de teste 2026-07-03)
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, portal_protocolo, omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   NULL,   'normal'),
 (2,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','nao_aplicavel',        NULL,   NULL,   'normal'),
 (3,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel','PROTO-9',NULL,   'normal'),
 (4,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   '7788',  'normal'),
 (5,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_retentavel',      NULL,   NULL,   'normal'),
 (6,'OBEN','Sayerlack','2026-07-01','disparado',                  'erro_nao_retentavel', NULL,   NULL,   'normal');
SELECT setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100);

INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES
 (1,'9201','S1',4),(2,'9202','S2',4),(3,'9203','S3',4),(4,'9204','S4',4),(5,'9205','S5',4),(6,'9206','S6',4);
SQL
echo "seeds ok"

run_ciclo() { Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos"; }
# qtde_final sugerida para o SKU no ciclo (pedido recem-gerado = pendente_aprovacao), ou AUSENTE
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
# estoque_a_caminho gravado na linha (prova o fantasma no numero, nao so na presenca)
qac() { Pq -c "SELECT COALESCE((SELECT pci.estoque_a_caminho::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }

echo "=== R1: ciclo com a correcao aplicada ==="
run_ciclo OBEN 2026-07-03 >/dev/null
eq "P1 erro terminal limpo VOLTA a ser sugerido (caso #1276)" "$(qf OBEN 2026-07-03 9201)" "4"
eq "P1 e o a-caminho dele e ZERO (fantasma sumiu)"            "$(qac OBEN 2026-07-03 9201)" "0"
eq "N1 aprovado SAUDAVEL segue contando (nao recompra)"       "$(qf OBEN 2026-07-03 9202)" "AUSENTE"
eq "N2 erro terminal COM PROTOCOLO segue contando"            "$(qf OBEN 2026-07-03 9203)" "AUSENTE"
eq "N3 erro terminal COM Nº OMIE segue contando"              "$(qf OBEN 2026-07-03 9204)" "AUSENTE"
eq "N4 erro RETENTAVEL segue contando (ainda pode ir)"        "$(qf OBEN 2026-07-03 9205)" "AUSENTE"
eq "N5 DISPARADO nunca e excluido"                            "$(qf OBEN 2026-07-03 9206)" "AUSENTE"
eq "R1 exatamente 1 SKU sugerido no ciclo"                    "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='2026-07-03' AND pcs.status='pendente_aprovacao'")" "1"

echo "=== R2: fora da janela de 7 dias o pedido sai sozinho (nao mascara a correcao) ==="
# ciclo 2026-07-09: data_ciclo 07-01 < 07-02 -> TODOS saem da janela -> todos voltam a ser sugeridos.
# Prova que os AUSENTE de R1 vieram da janela+guarda, e nao de um SKU inelegivel por outro motivo.
run_ciclo OBEN 2026-07-09 >/dev/null
eq "R2 os 6 SKUs sao elegiveis fora da janela" "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='2026-07-09' AND pcs.status='pendente_aprovacao'")" "6"

echo "=== FALSIFICACOES (baseline verde acima; cada sabotagem exige vermelho ESPECIFICO e restaura) ==="
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"

falsifica() {  # $1=nome  $2=sed-expr  $3=descricao  $4=query  $5=valor_sabotado_esperado
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  P -q -f "$SAB_DIR/$nome.sql" 2>/dev/null || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 6; DELETE FROM pedido_compra_sugerido WHERE id > 6; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-07-05 >/dev/null
  local veio; veio="$(eval "$query")"
  if [ "$veio" = "$esperado_sab" ]; then ok "FALSIF $nome pegou a sabotagem ($3)"; else bad "FALSIF $nome NAO detectou — esperado sob sabotagem [$esperado_sab], veio [$veio]"; fi
  P -q -f "$FIXTURE"   # restaura a funcao REAL
}

# F1: a exclusao nunca casa (equivale a REVERTER a correcao) -> o caso #1276 volta a ser suprimido.
#     Prova que o assert P1 tem dente: sem a correcao ele fica vermelho.
falsifica "F1-correcao-morta" \
  "s/^           AND pcs2.status_envio_portal = 'erro_nao_retentavel'\$/           AND pcs2.status_envio_portal = 'NUNCA_CASA_ZZZ'/" \
  "correcao revertida volta a suprimir o #1276" \
  "qf OBEN 2026-07-05 9201" "AUSENTE"

# F2: derruba a guarda do PROTOCOLO -> pedido que EFETIVOU no portal passaria a ser recomprado (compra dupla).
falsifica "F2-sem-guarda-protocolo" \
  "s/^           AND pcs2.portal_protocolo IS NULL\$/           AND true/" \
  "sem a guarda, pedido com protocolo vira compra dupla" \
  "qf OBEN 2026-07-05 9203" "4"

# F3: derruba a guarda do Nº OMIE -> pedido que existe no Omie passaria a ser recomprado.
#     Ancorada em ^...$ de proposito: a MESMA condicao aparece no 2o ramo da CTE (sem ancora, o sed
#     casaria os dois e a sabotagem provaria outra coisa).
falsifica "F3-sem-guarda-omie" \
  "s/^           AND pcs2.omie_pedido_compra_numero IS NULL\$/           AND true/" \
  "sem a guarda, pedido ja no Omie vira compra dupla" \
  "qf OBEN 2026-07-05 9204" "4"

# F4: derruba a guarda de STATUS -> 'disparado' passaria a ser elegivel a exclusao.
falsifica "F4-sem-guarda-status" \
  "s/^           pcs2.status = 'aprovado_aguardando_disparo'\$/           true/" \
  "sem a guarda, pedido DISPARADO vira compra dupla" \
  "qf OBEN 2026-07-05 9206" "4"

rm -rf "$SAB_DIR"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
