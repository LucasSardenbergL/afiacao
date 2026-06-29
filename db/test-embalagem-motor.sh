#!/usr/bin/env bash
# Prova PG17 — gerar_pedidos_sugeridos_ciclo: consolidação de estoque de grupo + escolha de embalagem (QT↔GL).
# Spec: docs/superpowers/specs/2026-06-26-reposicao-embalagem-no-motor-spec.md
# Rodar: bash db/test-embalagem-motor.sh > /tmp/t.log 2>&1; echo "exit=$?"   (NÃO pipe pra tail — engole exit)
# Lei de Ferro: aplica a função REAL; asserts numéricos; FALSIFICA (sabota → exige vermelho → restaura).
# Cobre os 6 achados do Codex: GREATEST(2 fontes), em_transito×fator, galão-âncora, oportunidade, minimo, filtro-membro.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="embalagem-motor"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/db/embalagem-motor-rpc.sql"   # fonte versionada da função (aplicada manual em prod 26/06)

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

# ── ZONA 1: stubs mínimos (tipos replicam o snapshot; inventory_position TEM saldo; item com FK CASCADE p/ a função limpar) ──
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
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric NOT NULL DEFAULT 0, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric);
-- [GATE estoque-não-confirmado] a função agora LOGA os suprimidos aqui (CTE log_ins). Stub mínimo (sem RLS no harness).
-- Os seeds deste teste NÃO setam fonte_sync (→ NULL) → o gate não dispara → asserts do galão (a-k) intactos.
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
SQL

# ── ZONA 2: aplicar a migration REAL ──
P -q -f "$MIG"
echo "migration aplicada"

# ── ZONA 3: seeds ──
# Estoque DIVERGENTE (como em prod): galão WP87/WP04 SÓ em inventory_position; galão WP01 SÓ em sku_estoque_atual.
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (8689775044,'oben','WP01 QT','Concentrados',true,'00'),  (12078998671,'oben','WP01 GL','Concentrados',true,'00'),
 (8689775019,'oben','WP87 QT','Concentrados',true,'00'),  (12097949925,'oben','WP87 GL','Concentrados',true,'00'),
 (8689733271,'oben','WP04 QT','Concentrados',true,'00'),  (12101098529,'oben','WP04 GL','Concentrados',true,'00'),
 (9999999001,'oben','CTRL QT','Concentrados',true,'00'),
 (8888888001,'oben','STALE QT','Concentrados',true,'00'), (8888888002,'oben','STALE GL','Concentrados',true,'00'),
 (7777777001,'oben','NOMAP QT','Concentrados',true,'00'), (7777777002,'oben','NOMAP GL','Concentrados',true,'00'),
 (6666666001,'oben','TRANS QT','Concentrados',true,'00'), (6666666002,'oben','TRANS GL','Concentrados',true,'00'),
 (5555555001,'oben','INAT QT','Concentrados',true,'00'),  (5555555002,'oben','INAT GL','Concentrados',false,'00'),  -- GL INATIVO
 (4444444001,'oben','ANC QT','Concentrados',true,'00'),   (4444444002,'oben','ANC GL','Concentrados',true,'00'),
 (3333333001,'oben','MIN QT','Concentrados',true,'00'),   (3333333002,'oben','MIN GL','Concentrados',true,'00'),
 (2222222001,'oben','OPORT QT','Concentrados',true,'00'), (2222222002,'oben','OPORT GL','Concentrados',true,'00'),
 (1111111001,'oben','OPQT QT','Concentrados',true,'00'), (1111111002,'oben','OPQT GL','Concentrados',true,'00');

INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias)
VALUES ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO company_config (key, value) VALUES ('embalagem_preco_motor_stale_dias','45');

-- âncoras QT (+ ANCORA-GL tem PARÂMETRO no GL p/ testar o guard P1-c)
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo, minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao) VALUES
 ('OBEN',8689775044,'WP01 QT','Sayerlack',6,10,NULL,true,'automatica'),
 ('OBEN',8689775019,'WP87 QT','Sayerlack',2,4,NULL,true,'automatica'),
 ('OBEN',8689733271,'WP04 QT','Sayerlack',1,2,NULL,true,'automatica'),
 ('OBEN',9999999001,'CTRL QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',8888888001,'STALE QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',7777777001,'NOMAP QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',6666666001,'TRANS QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',5555555001,'INAT QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',4444444001,'ANC QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',4444444002,'ANC GL','Sayerlack',3,6,NULL,true,'automatica'),   -- galão COM parâmetro: NÃO pode virar âncora
 ('OBEN',3333333001,'MIN QT','Sayerlack',5,6,8,true,'automatica'),       -- minimo_forcado_manual=8
 ('OBEN',2222222001,'OPORT QT','Sayerlack',5,10,NULL,true,'automatica'),
 ('OBEN',1111111001,'OPQT QT','Sayerlack',5,10,NULL,true,'automatica');  -- OPQT: âncora SEM preço-app → mantém QT mesmo com GL barato

-- sku_estoque_atual: galão WP87/WP04/etc AUSENTE (vive em inventory_position); galão WP01 presente (pendente 2)
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
 ('OBEN','8689775044',3.24,0),  ('OBEN','12078998671',0,2),
 ('OBEN','8689775019',1.62,0),
 ('OBEN','8689733271',0.81,0),
 ('OBEN','9999999001',1,0),
 ('OBEN','8888888001',1,0),
 ('OBEN','7777777001',1,0),
 ('OBEN','6666666001',0,0),
 ('OBEN','5555555001',0,0),
 ('OBEN','4444444001',0,0),
 ('OBEN','3333333001',5,0),
 ('OBEN','2222222001',0,0),
 ('OBEN','1111111001',0,0);

-- inventory_position (saldo): galão WP87 (9.72) e WP04 (3.24) vivem AQUI. WP01 GL NÃO (só em sea).
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at) VALUES
 (8689775044,'vendas',3.24,100.174718, now()),
 (8689775019,'vendas',1.62,116.388937, now()),  (12097949925,'vendas',9.72,115.2, now()),  -- WP87 GL parado SÓ aqui
 (8689733271,'vendas',0.81,121.963016, now()),  (12101098529,'vendas',3.24,114.1, now()),  -- WP04 GL parado SÓ aqui
 (9999999001,'vendas',1,50, now()),
 (8888888001,'vendas',1,45, now()),
 (7777777001,'vendas',1,45, now()),
 (6666666001,'vendas',0,45, now()),
 (5555555001,'vendas',0,45, now()),
 (4444444001,'vendas',0,45, now()),
 (3333333001,'vendas',5,45, now()),
 (2222222001,'vendas',0,45, now()),
 (1111111001,'vendas',0,45, now());  -- OPQT QT tem cmc 45 (custo da linha) mas SEM preço-app → não-elegível

INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','11111111-1111-1111-1111-111111111111','8689775044',1,true),  ('oben','11111111-1111-1111-1111-111111111111','12078998671',4,true),
 ('oben','22222222-2222-2222-2222-222222222222','8689775019',1,true),  ('oben','22222222-2222-2222-2222-222222222222','12097949925',4,true),
 ('oben','33333333-3333-3333-3333-333333333333','8689733271',1,true),  ('oben','33333333-3333-3333-3333-333333333333','12101098529',4,true),
 ('oben','44444444-4444-4444-4444-444444444444','8888888001',1,true),  ('oben','44444444-4444-4444-4444-444444444444','8888888002',4,true),
 ('oben','55555555-5555-5555-5555-555555555555','7777777001',1,true),  ('oben','55555555-5555-5555-5555-555555555555','7777777002',4,true),
 ('oben','66666666-6666-6666-6666-666666666666','6666666001',1,true),  ('oben','66666666-6666-6666-6666-666666666666','6666666002',4,true),
 ('oben','77777777-7777-7777-7777-777777777777','5555555001',1,true),  ('oben','77777777-7777-7777-7777-777777777777','5555555002',4,true),
 ('oben','88888888-8888-8888-8888-888888888888','4444444001',1,true),  ('oben','88888888-8888-8888-8888-888888888888','4444444002',4,true),
 ('oben','99999999-9999-9999-9999-999999999999','3333333001',1,true),  ('oben','99999999-9999-9999-9999-999999999999','3333333002',4,true),
 ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2222222001',1,true),  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2222222002',4,true),
 ('oben','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','1111111001',1,true),  ('oben','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','1111111002',4,true);

-- preço-app (oben): galões mais baratos/base; STALE GL com 100 dias
INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em) VALUES
 ('oben','8689775044',81.7068,'ok', now()-interval '10 days'),  ('oben','12078998671',306.4977,'ok', now()-interval '10 days'),
 ('oben','8689775019',97.5684,'ok', now()-interval '10 days'),  ('oben','12097949925',348.2099,'ok', now()-interval '10 days'),
 ('oben','8689733271',106,'ok', now()-interval '1 days'),       ('oben','12101098529',345,'ok', now()-interval '1 days'),
 ('oben','8888888001',40,'ok', now()-interval '5 days'),        ('oben','8888888002',100,'ok', now()-interval '100 days'),
 ('oben','7777777001',40,'ok', now()-interval '5 days'),        ('oben','7777777002',100,'ok', now()-interval '5 days'),
 ('oben','6666666001',40,'ok', now()-interval '5 days'),        ('oben','6666666002',100,'ok', now()-interval '5 days'),
 ('oben','5555555001',40,'ok', now()-interval '5 days'),        ('oben','5555555002',100,'ok', now()-interval '5 days'),
 ('oben','4444444001',40,'ok', now()-interval '5 days'),        ('oben','4444444002',100,'ok', now()-interval '5 days'),
 ('oben','3333333001',40,'ok', now()-interval '5 days'),        ('oben','3333333002',100,'ok', now()-interval '5 days'),
 ('oben','2222222001',40,'ok', now()-interval '5 days'),        ('oben','2222222002',100,'ok', now()-interval '5 days'),
 ('oben','1111111002',100,'ok', now()-interval '5 days');  -- OPQT: SÓ o GL tem preço-app (a âncora QT NÃO) → trocou=false

-- portal-map (OBEN). NOMAP: só QT. INAT: ambos (o filtro de catálogo é que barra).
INSERT INTO sku_fornecedor_externo (empresa, sku_omie, sku_portal, ativo) VALUES
 ('OBEN','8689775044','WP01QT',true),  ('OBEN','12078998671','WP01GL',true),
 ('OBEN','8689775019','WP87QT',true),  ('OBEN','12097949925','WP87GL',true),
 ('OBEN','8689733271','WP04QT',true),  ('OBEN','12101098529','WP04GL',true),
 ('OBEN','8888888001','SQT',true),     ('OBEN','8888888002','SGL',true),
 ('OBEN','7777777001','NQT',true),
 ('OBEN','6666666001','TQT',true),     ('OBEN','6666666002','TGL',true),
 ('OBEN','5555555001','IQT',true),     ('OBEN','5555555002','IGL',true),
 ('OBEN','4444444001','AQT',true),     ('OBEN','4444444002','AGL',true),
 ('OBEN','3333333001','MQT',true),     ('OBEN','3333333002','MGL',true),
 ('OBEN','2222222001','OQT',true),     ('OBEN','2222222002','OGL',true),
 ('OBEN','1111111001','OPQTQT',true),  ('OBEN','1111111002','OPQTGL',true);

-- PEDIDOS-SEED (sobrevivem ao ciclo): TRANS tem 2 galões EM VOO (disparado); OPORT tem galão em pedido OPORTUNIDADE.
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, tipo_ciclo) VALUES
 (90001,'OBEN','Sayerlack',CURRENT_DATE,'disparado','normal'),          -- TRANS: 2 galões a caminho
 (90002,'OBEN','Sayerlack',CURRENT_DATE,'pendente_aprovacao','oportunidade'),  -- OPORT: galão (será escolhido) em oportunidade
 (90003,'OBEN','Sayerlack',CURRENT_DATE,'pendente_aprovacao','oportunidade');  -- OPQT: galão (NÃO escolhido) em oportunidade
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, qtde_final, preco_unitario) VALUES
 (90001,'6666666002',2,100),
 (90002,'2222222002',1,345),
 (90003,'1111111002',1,345);
SELECT setval('pedido_compra_sugerido_id_seq', 100000);  -- a função gera ids acima dos seeds
SQL

# [PRECO-AUSENTE] FRESH: SKU de PRIMEIRA COMPRA sem custo (sem cmc, sem histórico, sem grupo, fornecedor isolado)
# → o motor grava preco_unitario NULL (não 0) e valor_total=COALESCE(SUM(NULL),0)=0 (não NULL → não viola o NOT NULL).
P -q <<'SQL'
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (1212121001,'oben','FRESH QT','Concentrados',true,'00');
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo, minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao) VALUES
 ('OBEN',1212121001,'FRESH QT','FreshForn',5,10,NULL,true,'automatica');
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
 ('OBEN','1212121001',0,0);
-- SEM inventory_position (cmc), SEM sku_leadtime_history (preço médio), SEM equivalência, SEM preço-app, SEM portal-map.
SQL

# run_ciclo NÃO trunca: a função limpa os pendentes NORMAIS do dia (FK CASCADE limpa os itens); os pedidos-seed
# (disparado / oportunidade) sobrevivem — exatamente como em prod.
run_ciclo() { Pq -c "SELECT 1 FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);" >/dev/null; }
# leitura SÓ do que o ciclo NORMAL gerou (exclui os pedidos-seed disparado/oportunidade)
G="s.status='pendente_aprovacao' AND COALESCE(s.tipo_ciclo,'normal')='normal'"
sku_grp() { Pq -c "SELECT i.sku_codigo_omie FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id=i.pedido_id WHERE i.sku_codigo_omie IN ($1) AND $G ORDER BY i.sku_codigo_omie;" | tr '\n' ',' ; }
campo()  { Pq -c "SELECT $1 FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id=i.pedido_id WHERE i.sku_codigo_omie='$2' AND $G;"; }
conta()  { Pq -c "SELECT count(*) FROM pedido_compra_item i JOIN pedido_compra_sugerido s ON s.id=i.pedido_id WHERE i.sku_codigo_omie IN ($1) AND $G;"; }

echo "── asserts (regra verdadeira) ──"
run_ciclo

# (a) WP01 → GALÃO, 2 galões, custo=preço-app (galão sem cmc → não fabricou 0). [estoque QT bate inv=sea; GL pendente em sea]
eq "a1 WP01 escolheu GALÃO"      "$(sku_grp "'8689775044','12078998671'")" "12078998671,"
eq "a2 WP01 qtde=2 galões"       "$(campo 'qtde_final::int' '12078998671')" "2"
eq "a3 WP01 custo=preço-app"     "$(campo 'round(preco_unitario,4)' '12078998671')" "306.4977"

# (b) [P0-a GREATEST] WP87/WP04 NÃO compram — galão parado vive em inventory_position, não em sku_estoque_atual
eq "b1 WP87 não gera (GL inv)"   "$(conta "'8689775019','12097949925'")" "0"
eq "b2 WP04 não gera (GL inv)"   "$(conta "'8689733271','12101098529'")" "0"

# (c) galão STALE → mantém QT (estrito)
eq "c1 STALE mantém QT"          "$(sku_grp "'8888888001','8888888002'")" "8888888001,"
# (d) galão SEM portal-map → mantém QT
eq "d1 NOMAP mantém QT"          "$(sku_grp "'7777777001','7777777002'")" "7777777001,"
# (e) controle SEM grupo → idêntico legado (QT, cmc, ceil(10-1)=9)
eq "e1 CTRL QT, qtde=9, cmc"     "$(sku_grp "'9999999001'")$(campo 'qtde_final::int' '9999999001')$(campo 'round(preco_unitario,2)' '9999999001')" "9999999001,950.00"

# (f) [P0-b em_transito×fator] TRANS tem 2 galões em voo (=8 unid-base) > ponto 5 → NÃO compra (anti double-buy)
eq "f1 TRANS não recompra"       "$(conta "'6666666001','6666666002'")" "0"

# (g) [P1-f filtro membro] galão INATIVO no omie_products → inelegível → mantém QT
eq "g1 INAT mantém QT"           "$(sku_grp "'5555555001','5555555002'")" "5555555001,"

# (h) [P1-c guard] galão COM parâmetro NÃO vira âncora → exatamente 1 linha do GL (do QT), sem duplicar
eq "h1 ANCORA 1 linha GL"        "$(conta "'4444444001','4444444002'")" "1"
eq "h2 ANCORA é o GL"            "$(sku_grp "'4444444001','4444444002'")" "4444444002,"

# (i) [P1-e minimo no galão] necessidade 1 mas minimo_forcado 8 → ceil(GREATEST(1,8)/4)=2 galões (não 1)
eq "i1 MINIMO 2 galões"          "$(campo 'qtde_final::int' '3333333002')" "2"

# (j) [P1-d oportunidade] galão ESCOLHIDO em pedido oportunidade → bloqueia a compra normal do grupo
eq "j1 OPORT bloqueado"          "$(conta "'2222222001','2222222002'")" "0"

# (k) [P1-d regressão re-Codex] galão em oportunidade MAS resultado é QT (âncora sem preço-app) → QT É comprado
#     (o anti-dup olha o SKU FINAL=QT, não o candidato GL; senão bloquearia o quartinho indevidamente)
eq "k1 OPQT compra QT"           "$(sku_grp "'1111111001','1111111002'")" "1111111001,"

# (l) [PRECO-AUSENTE] FRESH (primeira compra, sem cmc/histórico) → custo DESCONHECIDO = NULL, não 0 fabricado.
eq "l1 FRESH gerou (qtde 10)"    "$(campo 'qtde_final::int' '1212121001')" "10"
eq "l2 FRESH preco IS NULL"      "$(campo 'preco_unitario IS NULL' '1212121001')" "t"
eq "l3 FRESH valor_linha NULL"   "$(campo 'valor_linha IS NULL' '1212121001')" "t"
eq "l4 FRESH primeira_compra"    "$(campo 'primeira_compra' '1212121001')" "t"
# pedido isolado (todos itens sem custo): valor_total=COALESCE(SUM(NULL),0)=0 — NÃO NULL (preserva o NOT NULL).
eq "l5 FRESH valor_total=0"      "$(Pq -c "SELECT valor_total FROM pedido_compra_sugerido WHERE fornecedor_nome='FreshForn' AND status='pendente_aprovacao';")" "0"

# ── ZONA 5: FALSIFICAÇÃO (sabota → exige que o assert vire VERMELHO → restaura) ──
echo "── falsificação ──"
falsify() { # $1 desc | $2 sed-expr | $3 SQL-valor | $4 valor_são (deve MUDAR após sabotar)
  sed "$2" "$MIG" > /tmp/mig-sab.sql
  P -q -f /tmp/mig-sab.sql >/dev/null
  run_ciclo
  local got; got="$(eval "$3")"
  if [ "$got" != "$4" ]; then ok "FALSIFY $1 (são=$4 → furado=$got)"; else bad "FALSIFY $1 — assert SEM DENTE (seguiu $4)"; fi
  P -q -f "$MIG" >/dev/null
}

# F1 — consolidação furada (equiv vazia): WP87 volta a comprar
falsify "consolidacao" \
  's/AND ativo = TRUE AND fator_para_base > 0/AND ativo = TRUE AND fator_para_base > 0 AND FALSE/' \
  'conta "'"'"'8689775019'"'"','"'"'12097949925'"'"'"' "0"
# F2 — [P0-a] GREATEST sabotado (só sku_estoque_atual): WP87 GL (que vive em inventory) some → WP87 compra
falsify "greatest-2fontes" \
  's/GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0))/COALESCE(sea.estoque_fisico, 0)/g' \
  'conta "'"'"'8689775019'"'"','"'"'12097949925'"'"'"' "0"
# F3 — [P0-b] em_transito SEM ×fator (galão em voo conta 2 cru, não 8): TRANS recompra
falsify "transito-fator" \
  's/COALESCE(et.qtde, 0) \* e.fator_para_base/COALESCE(et.qtde, 0)/g' \
  'conta "'"'"'6666666001'"'"','"'"'6666666002'"'"'"' "0"
# F4 — frescor removido: galão STALE vira elegível e troca
falsify "frescor" \
  's/AND pa.capturado_em >= now() - make_interval(days => v_stale_dias)//' \
  'sku_grp "'"'"'8888888001'"'"','"'"'8888888002'"'"'"' "8888888001,"
# F5 — portal-map ignorado: galão NOMAP vira elegível e troca
falsify "portal-map" \
  's/JOIN portal_map pm ON pm.sku = e.sku//' \
  'sku_grp "'"'"'7777777001'"'"','"'"'7777777002'"'"'"' "7777777001,"
# F6 — [P1-f] filtro de ativo no membro neutralizado (vira TRUE): galão INATIVO vira elegível e troca
falsify "filtro-membro-ativo" \
  's/COALESCE(opm.ativo, TRUE) = TRUE/TRUE/' \
  'sku_grp "'"'"'5555555001'"'"','"'"'5555555002'"'"'"' "5555555001,"
# F7 — [P1-c] guard âncora-galão removido: ANC GL vira âncora → 2 linhas do GL
falsify "guard-ancora-galao" \
  's/AND eg2.fator_para_base > 1/AND eg2.fator_para_base > 99999/' \
  'conta "'"'"'4444444001'"'"','"'"'4444444002'"'"'"' "1"
# F8 — [P1-e] minimo ignorado no galão (zera o piso na branch trocou): MINIMO compra 1 (não 2)
falsify "minimo-no-galao" \
  's/COALESCE(b.minimo_forcado_manual, 0)) \/ b.fator_escolhido/0) \/ b.fator_escolhido/' \
  'campo "qtde_final::int" "3333333002"' "2"
# F9 — [P1-d] anti-dup ignora o galão escolhido (só âncora): OPORT (galão escolhido em oportunidade) deixa de bloquear
falsify "oportunidade-escolhido" \
  's/CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END/b.ancora_sku/' \
  'conta "'"'"'2222222001'"'"','"'"'2222222002'"'"'"' "0"
# F10 — [P1-d regressão] anti-dup usa o CANDIDATO (não o SKU final): OPQT bloqueia o QT indevidamente
falsify "oportunidade-sku-final" \
  's/CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END/b.sku_escolhido/' \
  'sku_grp "'"'"'1111111001'"'"','"'"'1111111002'"'"'"' "1111111001,"
# F11 — [PRECO-AUSENTE] restaura o fallback ", 0" da âncora → FRESH volta a fabricar preco 0 (não NULL)
falsify "preco-ausente-zero" \
  's/pm.preco_unitario) AS preco_unitario_ancora/pm.preco_unitario, 0) AS preco_unitario_ancora/' \
  'campo "preco_unitario IS NULL" "1212121001"' "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
