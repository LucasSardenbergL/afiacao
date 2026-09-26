#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: erro TERMINAL do portal deixa de virar "estoque a caminho".
# Incidente: pedido #1276 (OBEN/Sayerlack) travado em aprovado_aguardando_disparo + erro_nao_retentavel
# inflou o estoque efetivo por 7 dias e SUPRIMIU a recompra de 4 SKUs.
# + 2026-09-25: a guarda era NULL-blind ("=" em status_envio_portal) — com a coluna NULL, NOT(NULL) tirava
#   pedido SAUDAVEL do em_transito (compra dupla). S7 cobre o caso; CONTROLE roda a versao da PROD
#   (20260904232555) e exige o vazamento ANTES de aplicar o conserto; F5 volta o "=" e exige vazar de novo.
# + 2026-09-25 (follow-up Codex do #2549): S8 — 'disparado_simulado' (o dry_run CRIA pedido real no Omie) nao
#   contava como a caminho -> compra dupla; S9 — JOIN item<->cabecalho por COALESCE(grupo,'') fundia grupo NULL
#   com '' e cruzava itens (4 itens/16 un em vez de 2/8). CONTROLE C3/C4 roda a versao da PROD (20260925210332)
#   e exige os dois defeitos; F7/F8 revertem cada conserto; F9/F10 provam o dente da postcondicao.
#   E o run_ciclo passou a FALHAR o assert quando a RPC nao retorna sucesso (antes, RPC que abortava deixava
#   qf=AUSENTE e F1/RST VERDES por omissao); F11 prova esse guard com controle verde na mesma invocacao.
# Rodar: bash db/test-em-transito-erro-terminal.sh > log 2>&1; echo "exit=$?"  (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica as MIGRATIONS REAIS (base 20260730130000 -> PROD antiga -> PROD atual -> a nova); asserts
# numericos por cenario; FALSIFICA (sabota -> exige vermelho ESPECIFICO -> restaura). Sentinelas ASCII, caixa fixa.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="em-transito-erro-terminal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_BASE="$REPO_ROOT/supabase/migrations/20260730130000_reposicao_teto_cobertura_motor.sql"
MIG_PROD="$REPO_ROOT/supabase/migrations/20260904232555_reposicao_qtde_multiplo_embalagem_portal.sql"  # a viva na PROD ate 2026-09-25 (com o "=")
MIG_NULLSAFE="$REPO_ROOT/supabase/migrations/20260925210332_reposicao_em_transito_guarda_fantasma_null_safe.sql"  # a viva na PROD depois (sem disparado_simulado, JOIN com COALESCE)
MIG="$REPO_ROOT/supabase/migrations/20260925225004_reposicao_em_transito_simulado_e_join_grupo_null_safe.sql"
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
 (9207,'oben','S7 APROVADO PORTAL NULL','Tintas',true,'00'),
 (9208,'oben','S8 DISPARADO SIMULADO','Tintas',true,'00'),
 (9209,'oben','S9a GRUPO NULL','Tintas',true,'00'),
 (9210,'oben','S9b GRUPO VAZIO','Tintas',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7),
 -- S9 mora num fornecedor PROPRIO: o cruzamento do JOIN nao pode contaminar os cenarios Sayerlack (qf e escalar)
 ('OBEN','Fornec S9', interval '18:00:00', 7);

INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
SELECT 'OBEN', g, 'S'||g, CASE WHEN g >= 9209 THEN 'Fornec S9' ELSE 'Sayerlack' END, 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL
FROM generate_series(9201,9210) g;

INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
SELECT 'OBEN', g::text, 1, 0, 'ListarPosEstoque' FROM generate_series(9201,9210) g;

-- S9: 9209 SEM linha em sku_grupo_producao (grupo NULL pelo LEFT JOIN); 9210 com grupo '' (o schema nao proibe).
-- GROUP BY separa NULL de '' -> 2 cabecalhos. Sem pedido anterior: os dois sao sugeridos (qtde 4 cada).
INSERT INTO sku_grupo_producao (empresa, sku_codigo_omie, grupo_codigo) VALUES ('OBEN','9210','');

-- pedidos anteriores (data_ciclo dentro da janela de 7 dias do ciclo de teste 2026-07-03)
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, portal_protocolo, omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   NULL,   'normal'),
 (2,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','nao_aplicavel',        NULL,   NULL,   'normal'),
 (3,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel','PROTO-9',NULL,   'normal'),
 (4,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_nao_retentavel', NULL,   '7788',  'normal'),
 (5,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo','erro_retentavel',      NULL,   NULL,   'normal'),
 (6,'OBEN','Sayerlack','2026-07-01','disparado',                  'erro_nao_retentavel', NULL,   NULL,   'normal'),
 -- S7: pedido SAUDAVEL com status_envio_portal NULL (coluna nullable; INSERT com NULL explicito / backfill)
 (7,'OBEN','Sayerlack','2026-07-01','aprovado_aguardando_disparo', NULL,                  NULL,   NULL,   'normal'),
 -- S8: dry_run da edge — IncluirPedCompra CRIOU o pedido no Omie (tem nº), status 'disparado_simulado'.
 --     O 2o ramo exige nº Omie NULL, entao so o 1o ramo pode conta-lo.
 (8,'OBEN','Sayerlack','2026-07-01','disparado_simulado',         'nao_aplicavel',       NULL,   '5566',  'normal');
SELECT setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100);

INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES
 (1,'9201','S1',4),(2,'9202','S2',4),(3,'9203','S3',4),(4,'9204','S4',4),(5,'9205','S5',4),(6,'9206','S6',4),(7,'9207','S7',4),
 (8,'9208','S8',4);
SQL
echo "seeds ok"

RPC_ERR="$(mktemp "/tmp/rpcerr-${SLUG}.XXXXXX")"
# Roda o ciclo e FALHA O ASSERT se a RPC nao retornou sucesso. Sem isto (ate 2026-09-25 o exit era ignorado):
# RPC que aborta (timeout, erro late-bound) nao grava pedido -> qf devolve AUSENTE -> F1 e RST ficavam VERDES
# por omissao (o Codex reproduziu com RPC mock exit 3 -> FAIL=0). Sucesso = rc 0 E um inteiro no stdout.
# Chamar SEM redirecionar o stdout: o RED tem de aparecer no log (em sucesso nao imprime nada).
run_ciclo() {
  local out rc
  out="$(Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos" 2>"$RPC_ERR")"; rc=$?
  if [ "$rc" -ne 0 ] || ! [[ "$out" =~ ^[0-9]+$ ]]; then
    bad "RPC gerar_pedidos_sugeridos_ciclo($1,$2) NAO retornou sucesso (rc=$rc out=[$out]): $(head -c 200 "$RPC_ERR")"
    return 1
  fi
  return 0
}
# qtde_final sugerida para o SKU no ciclo (pedido recem-gerado = pendente_aprovacao), ou AUSENTE
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
# estoque_a_caminho gravado na linha (prova o fantasma no numero, nao so na presenca)
qac() { Pq -c "SELECT COALESCE((SELECT pci.estoque_a_caminho::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
# S9: "itens|soma qtde|cabecalhos|cabecalhos com num_skus = itens reais" do fornecedor S9 no ciclo
s9() { Pq -c "SELECT count(pci.id)||'|'||COALESCE(sum(pci.qtde_final),0)||'|'||count(DISTINCT pcs.id)||'|'||(SELECT count(*) FROM pedido_compra_sugerido h WHERE h.fornecedor_nome='Fornec S9' AND h.data_ciclo='$1' AND h.status='pendente_aprovacao' AND h.num_skus = (SELECT count(*) FROM pedido_compra_item i WHERE i.pedido_id=h.id)) FROM pedido_compra_sugerido pcs LEFT JOIN pedido_compra_item pci ON pci.pedido_id=pcs.id WHERE pcs.fornecedor_nome='Fornec S9' AND pcs.data_ciclo='$1' AND pcs.status='pendente_aprovacao'"; }
# S9: SKU>grupo do CABECALHO em que o item caiu (NULL/VAZIO explicitos). Os totais do s9 nao veem item no
# cabecalho ERRADO (achado Codex: trocar NULL<->'' no RETURNING mantem 2|8|2|2) — este mapa ve.
s9map() { Pq -c "SELECT COALESCE(string_agg(pci.sku_codigo_omie||'>'||CASE WHEN pcs.grupo_codigo IS NULL THEN 'NULL' WHEN pcs.grupo_codigo='' THEN 'VAZIO' ELSE pcs.grupo_codigo END, ',' ORDER BY pci.sku_codigo_omie, pcs.grupo_codigo NULLS FIRST), 'NENHUM') FROM pedido_compra_sugerido pcs JOIN pedido_compra_item pci ON pci.pedido_id=pcs.id WHERE pcs.fornecedor_nome='Fornec S9' AND pcs.data_ciclo='$1' AND pcs.status='pendente_aprovacao'"; }
# itens do fornecedor Sayerlack no ciclo (os cenarios S1..S8; o S9 mora em outro fornecedor)
nsay() { Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.fornecedor_nome='Sayerlack' AND pcs.data_ciclo='$1' AND pcs.status='pendente_aprovacao'"; }
fdef() { Pq -c "SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'"; }

echo "=== CONTROLE 1: a versao da PROD ate 2026-09-25 (20260904232555, com \"=\") VAZA o S7 — o defeito existe ==="
run_ciclo OBEN 2026-07-02
eq "C1 PROD antiga: S7 (portal NULL) SAI do em_transito e e RECOMPRADO" "$(qf OBEN 2026-07-02 9207)" "4"
eq "C2 PROD antiga: S2 (nao_aplicavel) segue contando (o vazamento e so o NULL)" "$(qf OBEN 2026-07-02 9202)" "AUSENTE"

# ── a PROD atual (NULL-safe, mas sem disparado_simulado e com o JOIN por COALESCE) ──
P -q -f "$MIG_NULLSAFE"
echo "migration aplicada: $(basename "$MIG_NULLSAFE")"
# determinismo do apply: md5 da funcao viva no PG17 local = md5 medido na PROD (psql-ro 2026-09-25).
# E a trava DO \$md5\$ do apply manual depende disto — se divergir, o md5 esperado da nova tambem nao vale.
eq "D1 md5 local da PROD atual = md5 da PROD" "$(fdef)" "105b00098685a697f3fb5c80279ed3fb"

echo "=== CONTROLE 2: a PROD atual (20260925210332) tem os dois defeitos do Codex ==="
run_ciclo OBEN 2026-07-04
eq "C3 PROD atual: S8 disparado_simulado SAI do em_transito e e RECOMPRADO" "$(qf OBEN 2026-07-04 9208)" "4"
eq "C4 PROD atual: S9 grupo NULL + '' cruza itens (4 itens/16 un, 2 cabecalhos, 0 com num_skus certo)" "$(s9 2026-07-04)" "4|16|2|0"
eq "C4b PROD atual: cada SKU do S9 cai nos DOIS cabecalhos" "$(s9map 2026-07-04)" "9209>NULL,9209>VAZIO,9210>NULL,9210>VAZIO"

# ── aplica a migration NOVA (a que vence) ──
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# baseline de que a funcao viva e a NOVA (detector com objeto vivo, nao grep de arquivo)
eq "funcao viva tem a guarda NULL-safe" \
   "$(Pq -c "SELECT (pg_get_functiondef(oid) LIKE '%status_envio_portal IS NOT DISTINCT FROM ''erro_nao_retentavel''%')::text FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "true"
MD5_NOVA="$(fdef)"
echo "  md5 da funcao nova (esperado na trava do apply manual): $MD5_NOVA"

echo "=== R1: ciclo com a correcao aplicada ==="
run_ciclo OBEN 2026-07-03
eq "P1 erro terminal limpo VOLTA a ser sugerido (caso #1276)" "$(qf OBEN 2026-07-03 9201)" "4"
eq "P1 e o a-caminho dele e ZERO (fantasma sumiu)"            "$(qac OBEN 2026-07-03 9201)" "0"
eq "N1 aprovado SAUDAVEL segue contando (nao recompra)"       "$(qf OBEN 2026-07-03 9202)" "AUSENTE"
eq "N2 erro terminal COM PROTOCOLO segue contando"            "$(qf OBEN 2026-07-03 9203)" "AUSENTE"
eq "N3 erro terminal COM Nº OMIE segue contando"              "$(qf OBEN 2026-07-03 9204)" "AUSENTE"
eq "N4 erro RETENTAVEL segue contando (ainda pode ir)"        "$(qf OBEN 2026-07-03 9205)" "AUSENTE"
eq "N5 DISPARADO nunca e excluido"                            "$(qf OBEN 2026-07-03 9206)" "AUSENTE"
eq "N6 aprovado com portal NULL segue contando (NULL-safe)"   "$(qf OBEN 2026-07-03 9207)" "AUSENTE"
eq "N7 DISPARADO_SIMULADO (pedido real no Omie) segue contando" "$(qf OBEN 2026-07-03 9208)" "AUSENTE"
eq "R1 exatamente 1 SKU Sayerlack sugerido no ciclo"          "$(nsay 2026-07-03)" "1"
eq "P2 S9 grupo NULL + '': 2 itens/8 un, 2 cabecalhos, os 2 com num_skus = itens" "$(s9 2026-07-03)" "2|8|2|2"
eq "P2b S9: 9209 no cabecalho de grupo NULL, 9210 no de grupo ''" "$(s9map 2026-07-03)" "9209>NULL,9210>VAZIO"

echo "=== R2: fora da janela de 7 dias o pedido sai sozinho (nao mascara a correcao) ==="
# ciclo 2026-07-09: data_ciclo 07-01 < 07-02 -> TODOS saem da janela -> todos voltam a ser sugeridos.
# Prova que os AUSENTE de R1 vieram da janela+guarda, e nao de um SKU inelegivel por outro motivo.
run_ciclo OBEN 2026-07-09
eq "R2 os 8 SKUs Sayerlack sao elegiveis fora da janela" "$(nsay 2026-07-09)" "8"

echo "=== FALSIFICACOES (baseline verde acima; cada sabotagem exige vermelho ESPECIFICO e restaura) ==="
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"

falsifica() {  # $1=nome  $2=sed-expr  $3=descricao  $4=query  $5=valor_sabotado_esperado
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.full.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.full.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  # UMA camada por vez: corta a postcondicao (tudo apos $function$;) — ela barraria a sabotagem ANTES do
  # comportamento ser medido. O dente da postcondicao e provado a parte (F6).
  awk '{print} /^\$function\$;$/{exit}' "$SAB_DIR/$nome.full.sql" > "$SAB_DIR/$nome.sql"
  echo "COMMIT;" >> "$SAB_DIR/$nome.sql"   # a fixture abre BEGIN; o corte levou o COMMIT junto com a postcondicao
  P -q -f "$SAB_DIR/$nome.sql" 2>/dev/null || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-07-05
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

# F7: [SIMULADO] tira 'disparado_simulado' da lista do 1o ramo (a forma da PROD ate hoje) -> o S8 (pedido real
#     criado no Omie pelo dry_run) sai do a-caminho e e recomprado. Prova que o assert N7 tem dente.
falsifica "F7-sem-simulado" \
  "s/'disparado','disparado_simulado','concluido_recebido'/'disparado','concluido_recebido'/" \
  "sem disparado_simulado na lista, o pedido real do dry_run vira compra dupla" \
  "qf OBEN 2026-07-05 9208" "4"

# F8: [GRUPO-NULL] volta o JOIN para COALESCE(grupo,'') (a forma da PROD ate hoje) -> o S9 cruza os itens.
#     Ancorada no ";$": a postcondicao cita o mesmo predicado SEM ponto-e-virgula (e ela e cortada aqui mesmo).
falsifica "F8-join-coalesce" \
  "s/pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;\$/COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'');/" \
  "COALESCE no JOIN cruza itens entre os cabecalhos de grupo NULL e ''" \
  "s9 2026-07-05" "4|16|2|0"

# F8b: o contraexemplo do Codex — troca NULL<->'' so no grupo DEVOLVIDO pelo RETURNING. Os totais seguem 2|8|2|2
#      (o s9 nao ve); o mapa SKU>grupo tem de acusar os itens nos cabecalhos TROCADOS.
falsifica "F8b-returning-trocado" \
  "s/^    RETURNING id, fornecedor_nome, grupo_codigo\$/    RETURNING id, fornecedor_nome, CASE WHEN grupo_codigo IS NULL THEN '' WHEN grupo_codigo = '' THEN NULL ELSE grupo_codigo END AS grupo_codigo/" \
  "item no cabecalho do grupo errado" \
  "s9map 2026-07-05" "9209>VAZIO,9210>NULL"

# Dente da POSTCONDICAO (a outra camada): a migration REAL sabotada tem de ABORTAR com a mensagem ESPECIFICA e,
# por estar em BEGIN/COMMIT, deixar a funcao viva INTACTA (rollback — md5 identico ao da nova).
falsifica_post() {  # $1=nome  $2=sed-expr  $3=sentinela (trecho ASCII da mensagem do RAISE)  $4=descricao
  local nome="$1" sedexpr="$2" sentinela="$3"
  P -q -f "$FIXTURE" >/dev/null 2>&1   # parte da funcao REAL
  sed "$sedexpr" "$MIG" > "$SAB_DIR/$nome.sql"
  if cmp -s "$MIG" "$SAB_DIR/$nome.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  local rc; P -q -f "$SAB_DIR/$nome.sql" > "$SAB_DIR/$nome.log" 2>&1; rc=$?
  if [ "$rc" -ne 0 ] && grep -q "$sentinela" "$SAB_DIR/$nome.log"; then
    ok "FALSIF $nome postcondicao abortou a migration ($4, rc=$rc)"
  else
    bad "FALSIF $nome postcondicao NAO barrou ($4, rc=$rc): $(head -c 300 "$SAB_DIR/$nome.log")"
  fi
  eq "$nome rollback: funcao viva intacta apos o abort (md5 da nova)" "$(fdef)" "$MD5_NOVA"
}

# F6: o "=" de volta na guarda [FANTASMA]
falsifica_post "F6-post-null-blind" \
  "s/^           AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'\$/           AND pcs2.status_envio_portal = 'erro_nao_retentavel'/" \
  "sem IS NOT DISTINCT FROM" "guarda com \"=\""
# F9: sem disparado_simulado na lista
falsifica_post "F9-post-sem-simulado" \
  "s/'disparado','disparado_simulado','concluido_recebido'/'disparado','concluido_recebido'/" \
  "nao conta disparado_simulado" "em_transito sem disparado_simulado"
# F10: JOIN por COALESCE
falsifica_post "F10-post-join-coalesce" \
  "s/pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;\$/COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'');/" \
  "nao usa IS NOT DISTINCT FROM no grupo" "JOIN de grupo por COALESCE"

# F9c/F10c: o predicado esperado sobrevive SO EM COMENTARIO e o codigo e revertido. A postcondicao limpa o
# comentario antes do LIKE, entao tem de abortar igual (achado Codex: sem a limpeza, dava verde).
SIM_COMENT="s/'disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')\$/'disparado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days') -- pcs2.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')/"
JOIN_COMENT="s/pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo;\$/pfg.grupo_codigo = sn.grupo_codigo; -- pfg.grupo_codigo IS NOT DISTINCT FROM sn.grupo_codigo/"
falsifica_post "F9c-post-simulado-so-em-comentario" "$SIM_COMENT" "nao conta disparado_simulado" "lista so no comentario"
falsifica_post "F10c-post-join-so-em-comentario"   "$JOIN_COMENT" "nao usa IS NOT DISTINCT FROM no grupo" "JOIN so no comentario"
# CONTROLE da camada: sem a linha de limpeza, as MESMAS sabotagens passam pela postcondicao (rc 0) — prova
# que e a limpeza, e nao outro check, que morde em F9c/F10c.
for par in "F9c|$SIM_COMENT" "F10c|$JOIN_COMENT"; do
  nm="${par%%|*}"; sx="${par#*|}"
  sed -e "$sx" -e "/^  v_def := regexp_replace(v_def, '--/d" "$MIG" > "$SAB_DIR/$nm-ctl.sql"
  if [ "$(grep -c "regexp_replace(v_def" "$SAB_DIR/$nm-ctl.sql")" -ne 0 ] || cmp -s "$MIG" "$SAB_DIR/$nm-ctl.sql"; then
    bad "$nm-ctl: sed NAO aplicou"
  else
    P -q -f "$SAB_DIR/$nm-ctl.sql" > "$SAB_DIR/$nm-ctl.log" 2>&1; crc=$?
    eq "$nm-ctl sem a limpeza de comentario a postcondicao e ENGANADA (commita)" "$crc" "0"
  fi
  P -q -f "$FIXTURE" >/dev/null 2>&1   # o controle commitou a funcao sabotada: restaura
done

echo "=== F11: o guard do run_ciclo — RPC que nao retorna sucesso tem de pintar RED ==="
# A forma ate 2026-09-25 (exit ignorado) — mantida AQUI so como controle do defeito.
run_ciclo_sem_guarda() { Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos" >/dev/null 2>&1; }
P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100;" >/dev/null
fail0=$FAIL
# F11a CONTROLE VERDE (mesma invocacao, ANTES da sabotagem): RPC saudavel passa pelo guard sem RED.
if run_ciclo OBEN 2026-07-06 > "$SAB_DIR/F11a.out" && [ "$FAIL" -eq "$fail0" ] && [ "$(qf OBEN 2026-07-06 9201)" = "4" ]; then
  ok "F11a controle: RPC saudavel passa pelo guard (e grava o S1)"
else
  bad "F11a controle: guard pintou RED com RPC saudavel: $(head -c 300 "$SAB_DIR/F11a.out")"
fi
# Sabotagem: a sessao da RPC vira read-only -> o 1o UPDATE da funcao aborta (25006). Deterministico (um
# statement_timeout curto seria o caso real do Codex, mas depende do relogio).
export PGOPTIONS='-c default_transaction_read_only=on'
# F11b controle do DEFEITO: a forma sem guarda engole o abort — FAIL nao sobe e o qf do S1 vira AUSENTE, o
# mesmo valor que o F1 exige sob sabotagem (e por isso o F1 ficava verde com a RPC morta).
run_ciclo_sem_guarda OBEN 2026-07-07
if [ "$FAIL" -eq "$fail0" ] && [ "$(PGOPTIONS='' qf OBEN 2026-07-07 9201)" = "AUSENTE" ]; then
  ok "F11b controle: sem guard, a RPC morta passa CALADA (qf=AUSENTE, o falso verde do F1)"
else
  bad "F11b controle: a sabotagem nao reproduziu o falso verde (FAIL=$FAIL fail0=$fail0)"
fi
# F11c o guard morde: rc 1 + exatamente UM RED + o erro e o da sabotagem (nao outro qualquer)
run_ciclo OBEN 2026-07-07 > "$SAB_DIR/F11c.out"; f11rc=$?
unset PGOPTIONS
if [ "$f11rc" -eq 1 ] && [ "$FAIL" -eq $((fail0+1)) ] && grep -q "NAO retornou sucesso" "$SAB_DIR/F11c.out" \
   && grep -q "read-only transaction" "$RPC_ERR"; then
  FAIL=$fail0   # o RED era o esperado: neutraliza ANTES de contar o ok
  ok "F11c guard pegou a RPC morta (rc=1, 1 RED, erro 25006 da sabotagem)"
else
  FAIL=$fail0
  bad "F11c guard NAO pegou a RPC morta (rc=$f11rc): $(head -c 300 "$SAB_DIR/F11c.out") | $(head -c 200 "$RPC_ERR")"
fi

# controle pos-falsificacao: a funcao restaurada e a REAL (md5) e volta a segurar S7/S8/S9 (a restauracao nao e teatro)
P -q -f "$FIXTURE" >/dev/null 2>&1
eq "RST0 funcao restaurada pela fixture = a da migration nova (md5)" "$(fdef)" "$MD5_NOVA"
P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100;" >/dev/null
run_ciclo OBEN 2026-07-05
eq "RST funcao restaurada segura o S7 de novo" "$(qf OBEN 2026-07-05 9207)" "AUSENTE"
eq "RST funcao restaurada segura o S8 de novo" "$(qf OBEN 2026-07-05 9208)" "AUSENTE"
eq "RST funcao restaurada nao cruza o S9"      "$(s9 2026-07-05)" "2|8|2|2"
eq "RST S9 cada SKU no cabecalho do SEU grupo"  "$(s9map 2026-07-05)" "9209>NULL,9210>VAZIO"

rm -rf "$SAB_DIR" "$RPC_ERR"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
