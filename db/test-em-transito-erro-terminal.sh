#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: erro TERMINAL do portal deixa de virar "estoque a caminho".
# Incidente: pedido #1276 (OBEN/Sayerlack) travado em aprovado_aguardando_disparo + erro_nao_retentavel
# inflou o estoque efetivo por 7 dias e SUPRIMIU a recompra de 4 SKUs.
# + 2026-09-25: a guarda era NULL-blind ("=" em status_envio_portal) — com a coluna NULL, NOT(NULL) tirava
#   pedido SAUDAVEL do em_transito (compra dupla). S7 cobre o caso; CONTROLE roda a versao da PROD
#   (20260904232555) e exige o vazamento ANTES de aplicar o conserto; F5 volta o "=" e exige vazar de novo.
# Rodar: bash db/test-em-transito-erro-terminal.sh > log 2>&1; echo "exit=$?"  (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica as MIGRATIONS REAIS (base 20260730130000 -> PROD atual -> a nova); asserts numericos
# por cenario; FALSIFICA (sabota -> exige vermelho ESPECIFICO -> restaura). Sentinelas ASCII, caixa fixa.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="em-transito-erro-terminal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260730130000_reposicao_teto_cobertura_motor.sql"
MIG_PROD="$REPO_ROOT/supabase/migrations/20260904232555_reposicao_qtde_multiplo_embalagem_portal.sql"  # a viva na PROD (com o "=")
MIG="$REPO_ROOT/supabase/migrations/20260925210332_reposicao_em_transito_guarda_fantasma_null_safe.sql"
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
CREATE TABLE public.sku_fornecedor_externo (empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean,
  fator_conversao numeric NOT NULL DEFAULT 1);  -- [EMBALAGEM PORTAL] a funcao le fornecedor_nome + fator_conversao (20260904232555)
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
  estoque_fisico numeric, estoque_a_caminho numeric, fator_embalagem_portal numeric);  -- [EMBALAGEM PORTAL] o fixture de restauro grava esta coluna
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
SQL
echo "stubs criados"

# ── ZONA 2: MIGRATIONS REAIS, na ordem (base cria log/ALTERs/config; MIG_PROD = a viva hoje; a nova vem DEPOIS
#    do controle, abaixo dos seeds) ──
P -q -f "$MIG_BASE"
P -q -f "$MIG_PROD"
echo "migrations aplicadas: $(basename "$MIG_BASE") -> $(basename "$MIG_PROD")"

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
 (9206,'oben','S6 DISPARADO','Tintas',true,'00'),
 (9207,'oben','S7 APROVADO PORTAL NULL','Tintas',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);

INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
SELECT 'OBEN', g, 'S'||g, 'Sayerlack', 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL
FROM generate_series(9201,9207) g;

INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
SELECT 'OBEN', g::text, 1, 0, 'ListarPosEstoque' FROM generate_series(9201,9207) g;

-- pedidos anteriores (data_ciclo dentro da janela de 7 dias do ciclo de teste 2026-07-03)
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, portal_protocolo, omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   NULL,   'normal'),
 (2,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','nao_aplicavel',        NULL,   NULL,   'normal'),
 (3,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel','PROTO-9',NULL,   'normal'),
 (4,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   '7788',  'normal'),
 (5,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_retentavel',      NULL,   NULL,   'normal'),
 (6,'OBEN','Sayerlack','2026-07-01','disparado',                  'erro_nao_retentavel', NULL,   NULL,   'normal'),
 -- S7: pedido SAUDAVEL com status_envio_portal NULL (coluna nullable; INSERT com NULL explicito / backfill)
 (7,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo', NULL,                  NULL,   NULL,   'normal');
SELECT setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100);

INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES
 (1,'9201','S1',4),(2,'9202','S2',4),(3,'9203','S3',4),(4,'9204','S4',4),(5,'9205','S5',4),(6,'9206','S6',4),(7,'9207','S7',4);
SQL
echo "seeds ok"

run_ciclo() { Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos"; }
# qtde_final sugerida para o SKU no ciclo (pedido recem-gerado = pendente_aprovacao), ou AUSENTE
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
# estoque_a_caminho gravado na linha (prova o fantasma no numero, nao so na presenca)
qac() { Pq -c "SELECT COALESCE((SELECT pci.estoque_a_caminho::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }

echo "=== CONTROLE: a versao da PROD (20260904232555, com \"=\") VAZA o S7 — o defeito existe ==="
run_ciclo OBEN 2026-07-02 >/dev/null
eq "C1 PROD atual: S7 (portal NULL) SAI do em_transito e e RECOMPRADO" "$(qf OBEN 2026-07-02 9207)" "4"
eq "C2 PROD atual: S2 (nao_aplicavel) segue contando (o vazamento e so o NULL)" "$(qf OBEN 2026-07-02 9202)" "AUSENTE"

# ── aplica a migration NOVA (a que vence) ──
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# baseline de que a funcao viva e a NOVA (detector com objeto vivo, nao grep de arquivo)
eq "funcao viva tem a guarda NULL-safe" \
   "$(Pq -c "SELECT (pg_get_functiondef(oid) LIKE '%status_envio_portal IS NOT DISTINCT FROM ''erro_nao_retentavel''%')::text FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "true"

echo "=== R1: ciclo com a correcao aplicada ==="
run_ciclo OBEN 2026-07-03 >/dev/null
eq "P1 erro terminal limpo VOLTA a ser sugerido (caso #1276)" "$(qf OBEN 2026-07-03 9201)" "4"
eq "P1 e o a-caminho dele e ZERO (fantasma sumiu)"            "$(qac OBEN 2026-07-03 9201)" "0"
eq "N1 aprovado SAUDAVEL segue contando (nao recompra)"       "$(qf OBEN 2026-07-03 9202)" "AUSENTE"
eq "N2 erro terminal COM PROTOCOLO segue contando"            "$(qf OBEN 2026-07-03 9203)" "AUSENTE"
eq "N3 erro terminal COM Nº OMIE segue contando"              "$(qf OBEN 2026-07-03 9204)" "AUSENTE"
eq "N4 erro RETENTAVEL segue contando (ainda pode ir)"        "$(qf OBEN 2026-07-03 9205)" "AUSENTE"
eq "N5 DISPARADO nunca e excluido"                            "$(qf OBEN 2026-07-03 9206)" "AUSENTE"
eq "N6 aprovado com portal NULL segue contando (NULL-safe)"   "$(qf OBEN 2026-07-03 9207)" "AUSENTE"
eq "R1 exatamente 1 SKU sugerido no ciclo"                    "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='2026-07-03' AND pcs.status='pendente_aprovacao'")" "1"

echo "=== R2: fora da janela de 7 dias o pedido sai sozinho (nao mascara a correcao) ==="
# ciclo 2026-07-09: data_ciclo 07-01 < 07-02 -> TODOS saem da janela -> todos voltam a ser sugeridos.
# Prova que os AUSENTE de R1 vieram da janela+guarda, e nao de um SKU inelegivel por outro motivo.
run_ciclo OBEN 2026-07-09 >/dev/null
eq "R2 os 7 SKUs sao elegiveis fora da janela" "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='2026-07-09' AND pcs.status='pendente_aprovacao'")" "7"

echo "=== FALSIFICACOES (baseline verde acima; cada sabotagem exige vermelho ESPECIFICO e restaura) ==="
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"

falsifica() {  # $1=nome  $2=sed-expr  $3=descricao  $4=query  $5=valor_sabotado_esperado
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.full.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.full.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  # UMA camada por vez: corta a postcondicao (tudo apos $function$;) — ela barraria a sabotagem ANTES do
  # comportamento ser medido. O dente da postcondicao e provado a parte (F6).
  awk '{print} /^\$function\$;$/{exit}' "$SAB_DIR/$nome.full.sql" > "$SAB_DIR/$nome.sql"
  P -q -f "$SAB_DIR/$nome.sql" 2>/dev/null || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-07-05 >/dev/null
  local veio; veio="$(eval "$query")"
  if [ "$veio" = "$esperado_sab" ]; then ok "FALSIF $nome pegou a sabotagem ($3)"; else bad "FALSIF $nome NAO detectou — esperado sob sabotagem [$esperado_sab], veio [$veio]"; fi
  P -q -f "$FIXTURE"   # restaura a funcao REAL
}

# F1: a exclusao nunca casa (equivale a REVERTER a correcao) -> o caso #1276 volta a ser suprimido.
#     Prova que o assert P1 tem dente: sem a correcao ele fica vermelho.
falsifica "F1-correcao-morta" \
  "s/^           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'\$/           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'NUNCA_CASA_ZZZ'/" \
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

# F5: o NULL-blind. Volta IS NOT DISTINCT FROM para "=" — a forma INGENUA (a da PROD ate hoje) -> o S7
#     (portal NULL) tem de vazar e ser recomprado. Prova que o assert N6 distingue as duas formas.
falsifica "F5-null-blind" \
  "s/^           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'\$/           AND pcs2.status_envio_portal = 'erro_nao_retentavel'/" \
  "com \"=\" o pedido saudavel de portal NULL vira compra dupla" \
  "qf OBEN 2026-07-05 9207" "4"

# F6: o dente da POSTCONDICAO (a outra camada). Migration REAL com o "=" de volta: tem de ABORTAR com a
#     mensagem da forma NULL-blind e, por estar em BEGIN/COMMIT, deixar a funcao viva INTACTA (rollback).
sed "s/^           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'\$/           AND pcs2.status_envio_portal = 'erro_nao_retentavel'/" \
  "$MIG" > "$SAB_DIR/F6.sql"
if cmp -s "$MIG" "$SAB_DIR/F6.sql"; then
  bad "FALSIF F6: sed NAO aplicou (padrao nao casou)"
else
  P -q -f "$SAB_DIR/F6.sql" > "$SAB_DIR/F6.log" 2>&1; f6rc=$?
  if [ "$f6rc" -ne 0 ] && grep -q "sem IS NOT DISTINCT FROM" "$SAB_DIR/F6.log"; then
    ok "FALSIF F6 postcondicao abortou a migration com \"=\" (rc=$f6rc)"
  else
    bad "FALSIF F6 postcondicao NAO barrou o \"=\" (rc=$f6rc): $(head -c 300 "$SAB_DIR/F6.log")"
  fi
  eq "F6 rollback: funcao viva segue NULL-safe apos o abort" \
     "$(Pq -c "SELECT (pg_get_functiondef(oid) LIKE '%status_envio_portal IS NOT DISTINCT FROM ''erro_nao_retentavel''%')::text FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "true"
fi

# controle pos-falsificacao: a funcao restaurada volta a segurar o S7 (a restauracao nao e teatro)
P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100;" >/dev/null
run_ciclo OBEN 2026-07-05 >/dev/null
eq "RST funcao restaurada segura o S7 de novo" "$(qf OBEN 2026-07-05 9207)" "AUSENTE"

rm -rf "$SAB_DIR"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
