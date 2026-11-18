#!/usr/bin/env bash
# Prova PG17 — o "a caminho" do motor com UM relógio só: o corte dos pedidos do app no em_transito de
# gerar_pedidos_sugeridos_ciclo passa a ser o MESMO que o omie-sync-estoque usou ao publicar o pendente.
#
# Defeito (revisão de código 2026-11-18): dois relógios independentes.
#   · o sync exclui do pendente (sku_estoque_atual.estoque_pendente_entrada) os pedidos do app com
#     data_ciclo >= hojeSP() − 7 NO DIA EM QUE RODOU (S) — fetchEmTransitoKeys;
#   · o motor contava os pedidos do app com data_ciclo >= p_data_ciclo − 7 (D = dia do ciclo).
#   Motor em D lendo pendente publicado em S < D → todo pedido com data_ciclo em [S−7, D−8] fica FORA do pendente
#   (o sync tirou) E fora do em_transito (o motor cortou) = contado 0× → COMPRA DUPLA. Medido em prod
#   (2026-11-18): 2 dias em 42 (06/11 e 11/11) o motor das 09:15 UTC rodou com o retrato da véspera; o vão tinha
#   6 e 3 pedidos do app.
# Conserto: o motor corta POR SKU no dia (SP) do retrato que está lendo — ultima_sincronizacao, gravada pelo sync
#   na MESMA linha e no MESMO upsert do pendente —, com 1 h de folga para o run que cruza a meia-noite e nunca
#   depois do corte de antes (LEAST com p_data_ciclo). Sem retrato datado (NULL) = o corte de antes.
#
# Rodar: bash db/test-acaminho-relogio-unico.sh > log 2>&1; echo "exit=$?"  (NÃO pipe pra tail — engole exit)
#   Sem a migration nova no repo a prova roda os asserts P* contra o motor VIVO e fica VERMELHA (o defeito).
# Lei de Ferro: aplica as MIGRATIONS REAIS (a viva 20261101090000 → a nova); asserts por valor; FALSIFICA com
# CONTROLE VERDE na mesma invocação (a fixture intacta pelo MESMO caminho da sabotagem tem de dar o valor certo).
# Sentinelas ASCII, caixa fixa; rode em LC_ALL=C e pt_BR.UTF-8.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="acaminho-relogio-unico"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
: "${LC_ALL:=C}"; export LC_ALL LANG="$LC_ALL"
MIG_VIVA="$REPO_ROOT/supabase/migrations/20261101090000_reposicao_compra_suspensa.sql"
MIG="$REPO_ROOT/supabase/migrations/20261118120000_reposicao_acaminho_relogio_do_sync.sql"
# FIXADA na 20261118120000 (a fixture viva db/embalagem-motor-rpc.sql seguiu para a 20261119130000): o motor
# desta prova é o trecho CREATE→fim DESTA migration — que o guard de paridade exigiu igual à fixture quando
# ela era a última. A evolução [MEMBRO SEM LINHA] tem a prova própria: db/test-acaminho-membro-sem-linha.sh.
FIXTURE="$(mktemp "/tmp/fx-${SLUG}.XXXXXX")"
python3 - "$MIG" "$FIXTURE" <<'PY_FX' || { echo "INFRA: nao extraí o motor da $MIG"; exit 1; }
import sys
t = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(t[t.index("CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo"):])
PY_FX
# md5(prosrc) do motor na PROD (psql-ro, 2026-11-18) — o pré-voo: a viva do repo É a da prod.
MD5_PROD_VIVA="93b2407ddde45cbb068478f5acf86c85"

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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT (LC_ALL=$LC_ALL) ==="

# ── ZONA 1: roles/schemas + stubs (os do db/test-compra-suspensa-motor.sh; sku_estoque_atual = colunas da prod) ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT; GRANT authenticated TO authenticator; GRANT anon TO authenticator;
CREATE SCHEMA auth;
-- auth.uid() como o Supabase: le o sub dos claims da sessao (NULL sem JWT)
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE SCHEMA private;
CREATE TABLE public.cap_stub (user_id uuid PRIMARY KEY, ler boolean NOT NULL, escrever boolean NOT NULL);
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT ler FROM public.cap_stub WHERE user_id = p), false) $$;
CREATE FUNCTION private.cap_compras_escrever(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT escrever FROM public.cap_stub WHERE user_id = p), false) $$;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid), private.cap_compras_escrever(uuid) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- helpers da 20261018200000 (fin_ciclo_giro_sku) que a foto reutiliza — mesma regra, provada la
CREATE FUNCTION public._fin_estoque_account(p_company text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; BEGIN
  v := CASE lower(trim(p_company)) WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v IS NULL THEN RAISE EXCEPTION 'empresa invalida: %', p_company USING ERRCODE = 'P0001'; END IF;
  RETURN v; END $$;
CREATE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(trim(p_familia)) IN ('uso e consumo','imobilizado') THEN 'fora_giro'
              WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
              WHEN trim(p_tipo) IN ('07','08','09','99') THEN 'fora_giro' ELSE 'giro' END $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text, valor_vendido_90d numeric);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_disponivel numeric,
  estoque_pendente_entrada numeric, ultima_sincronizacao timestamptz, fonte_sync text, PRIMARY KEY (empresa, sku_codigo_omie));  -- = prod (pkey empresa,sku)
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean,
  unidades_omie_por_embalagem numeric);  -- [UNIDADES #2849] o motor le a coluna
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean,
  fator_conversao numeric NOT NULL DEFAULT 1);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'rascunho', account text NOT NULL DEFAULT 'oben', hash_payload text, omie_numero_pedido text,
  omie_reconciliado_em timestamptz, deleted_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, capados_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
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
  estoque_fisico numeric, estoque_a_caminho numeric, fator_embalagem_portal numeric, qtde_sem_teto numeric,
  teto_cobertura_aplicado boolean, estoque_comprometido numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
CREATE TABLE public.reposicao_teto_cobertura_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, classe_abc text, teto_dias numeric, demanda_diaria numeric,
  estoque_efetivo numeric, ponto_pedido numeric, estoque_maximo numeric, cap_teto_ancora numeric, qtde_sem_teto numeric, qtde_final numeric, motivo text);
-- fontes da FOTO (consumo efetivo e substituicao) — tabela no lugar da view: mesma assinatura lida
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.sku_substituicao (id bigserial, empresa text, sku_codigo_antigo text, sku_codigo_novo text, acao_parametros text, status text);
-- o motor e INVOKER: o staff (authenticated) le/escreve estas tabelas no "Recalcular" — GRANT como na prod
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido, public.pedido_compra_item, public.reposicao_motor_run,
  public.reposicao_estoque_nao_confirmado_log, public.reposicao_teto_cobertura_log TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
SQL
echo "stubs criados"

# ── ZONA 2: a migration VIVA (a que está na prod) ──
P -q -f "$MIG_VIVA" >/dev/null
fsrc() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'"; }
eq "D0 pre-voo: md5(prosrc) do motor da migration viva = o da PROD" "$(fsrc)" "$MD5_PROD_VIVA"

# ── ZONA 3: seeds. Ciclo D = 2026-12-20 (recesso). Todo SKU: Sayerlack, classe A, pp=3, max=5, demanda 0,5.
#    Pedido anterior do app = 'disparado' com nº Omie (o sync o reconhece e o tira do pendente se >= S−7).
#    pendente = o que o sync teria publicado no dia S (ultima_sincronizacao) com o corte S−7.
#      sem contar o pedido  -> fisico 1 + 0  <= pp 3 -> SUGERE 4
#      contando o pedido    -> fisico 1 + 4  >  pp 3 -> AUSENTE
#    9704/9705 (precisao, o lado 2x): fisico 0, pendente 2 = o PROPRIO pedido (anterior ao corte do sync)
#      1x -> efetivo 2 -> SUGERE 3 (a caminho 2) ;  2x -> efetivo 4 > 3 -> AUSENTE
P -q <<'SQL'
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto)
SELECT g, 'oben', 'RU '||g, 'Tintas', true, '00' FROM generate_series(9701,9709) g;
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada)
SELECT 'OBEN', g, 'RU '||g, 'Sayerlack', 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL FROM generate_series(9701,9709) g;
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync) VALUES
 ('OBEN','9701',1,0,'2026-12-19 09:10:00+00','ListarPosEstoque'),  -- G1 retrato da vespera (S=D-1)
 ('OBEN','9702',1,0,'2026-12-17 09:10:00+00','ListarPosEstoque'),  -- G2 3 dias sem sync (S=D-3)
 ('OBEN','9703',1,0,'2026-12-19 09:10:00+00','ListarPosEstoque'),  -- N1 pedido recente (dentro dos dois cortes)
 ('OBEN','9704',0,2,'2026-12-19 09:10:00+00','ListarPosEstoque'),  -- N2 pedido ANTES do corte do sync: ja no pendente
 ('OBEN','9705',0,2,'2026-12-20 09:05:00+00','ListarPosEstoque'),  -- N3 sync do dia: D-8 ja no pendente
 ('OBEN','9706',1,0,NULL,'ListarPosEstoque'),                      -- L1 retrato sem data: corte de antes
 ('OBEN','9707',1,0,'2026-12-20 03:20:00+00','ListarPosEstoque'),  -- M1 run que cruzou a meia-noite SP (00:20 de D)
 ('OBEN','9708',1,0,'2026-12-23 09:10:00+00','ListarPosEstoque'),  -- F1 retrato POSTERIOR ao ciclo (recalculo de data passada)
 ('OBEN','9709',1,0,NULL,'ListarPosEstoque');                      -- L2 sem data + pedido recente: segue contando
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-12-12','disparado','nao_aplicavel','5001','normal'),  -- 9701: D-8 = S-7 (o vao de 1 dia)
 (2,'OBEN','Sayerlack','2026-12-10','disparado','nao_aplicavel','5002','normal'),  -- 9702: D-10 (vao [D-10, D-8])
 (3,'OBEN','Sayerlack','2026-12-17','disparado','nao_aplicavel','5003','normal'),  -- 9703: D-3
 (4,'OBEN','Sayerlack','2026-12-11','disparado','nao_aplicavel','5004','normal'),  -- 9704: S-8 (no pendente)
 (5,'OBEN','Sayerlack','2026-12-12','disparado','nao_aplicavel','5005','normal'),  -- 9705: D-8 com S=D (no pendente)
 (6,'OBEN','Sayerlack','2026-12-12','disparado','nao_aplicavel','5006','normal'),  -- 9706: D-8, retrato sem data
 (7,'OBEN','Sayerlack','2026-12-12','disparado','nao_aplicavel','5007','normal'),  -- 9707: D-8 = (D-1)-7, o corte do fetch das 23:59
 (8,'OBEN','Sayerlack','2026-12-14','disparado','nao_aplicavel','5008','normal'),  -- 9708: D-6
 (9,'OBEN','Sayerlack','2026-12-18','disparado','nao_aplicavel','5009','normal');  -- 9709: D-2
DO $s$ BEGIN PERFORM setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100); END $s$;
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES
 (1,'9701','RU',4),(2,'9702','RU',4),(3,'9703','RU',4),(4,'9704','RU',2),(5,'9705','RU',2),
 (6,'9706','RU',4),(7,'9707','RU',4),(8,'9708','RU',4),(9,'9709','RU',4);
SQL
echo "seeds ok"

RPC_ERR="$(mktemp "/tmp/rpcerr-${SLUG}.XXXXXX")"
# Roda o ciclo e FALHA o assert se a RPC nao retornou sucesso (rc 0 E inteiro no stdout) — RPC morta nao pode
# deixar qf=AUSENTE passar por "contou o pedido".
run_ciclo() {
  local out rc
  P -q -c "DELETE FROM pedido_compra_item WHERE pedido_id > 100; DELETE FROM pedido_compra_sugerido WHERE id > 100;" >/dev/null
  out="$(Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('OBEN','$1')).skus_incluidos" 2>"$RPC_ERR")"; rc=$?
  if [ "$rc" -ne 0 ] || ! [[ "$out" =~ ^[0-9]+$ ]]; then
    bad "RPC gerar_pedidos_sugeridos_ciclo(OBEN,$1) NAO retornou sucesso (rc=$rc out=[$out]): $(head -c 300 "$RPC_ERR")"
    return 1
  fi
  return 0
}
qf()  { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='$1' AND pci.sku_codigo_omie='$2' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
qac() { Pq -c "SELECT COALESCE((SELECT pci.estoque_a_caminho::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='$1' AND pci.sku_codigo_omie='$2' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }
# retrato de todos os cenarios numa linha (sku=qf), para o controle e as falsificacoes
mapa() { Pq -c "SELECT string_agg(g||'='||COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='$1' AND pci.sku_codigo_omie=g::text AND pcs.status='pendente_aprovacao'),'A'), ',' ORDER BY g) FROM generate_series(9701,9709) g"; }
D=2026-12-20
ESPERADO_VIVA="9701=4,9702=4,9703=A,9704=3,9705=3,9706=4,9707=4,9708=A,9709=A"
ESPERADO_NOVA="9701=A,9702=A,9703=A,9704=3,9705=3,9706=4,9707=A,9708=A,9709=A"

echo "=== CONTROLE: o motor VIVO conta 0x o pedido do vao (o defeito existe e e este) ==="
run_ciclo "$D"
eq "C1 viva: mapa do ciclo (G1/G2/M1 recomprados = 0x)" "$(mapa "$D")" "$ESPERADO_VIVA"
eq "C2 viva: o a caminho do G1 e ZERO — o pedido de 4 sumiu dos dois lados" "$(qac "$D" 9701)" "0"

if [ -f "$MIG" ]; then
  # sobre o PREDECESSOR (o caminho da prod): tem de passar, senao a fixture abaixo mascararia uma PRE quebrada
  if P -q -f "$MIG" >/dev/null; then ok "A0 migration aplica sobre o predecessor (rc=0)"; else bad "A0 migration FALHOU sobre o predecessor"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; fi
  echo "migration aplicada: $(basename "$MIG")"
  P -q -f "$FIXTURE" >/dev/null
  eq "D1 fixture viva = a migration nova (mesmo prosrc)" "$(fsrc)" "$(P -q -f "$MIG" >/dev/null && fsrc)"
else
  echo "  (migration nova AUSENTE: os P* abaixo rodam contra o motor VIVO — tem de dar RED)"
fi

echo "=== P: o motor corta no relogio do retrato ==="
run_ciclo "$D"
eq "P1 G1 retrato da vespera: o pedido de D-8 CONTA (nao recompra)"        "$(qf "$D" 9701)" "AUSENTE"
eq "P2 G2 3 dias sem sync: o pedido de D-10 CONTA"                         "$(qf "$D" 9702)" "AUSENTE"
eq "N1 pedido recente segue contando"                                      "$(qf "$D" 9703)" "AUSENTE"
eq "N2 pedido anterior ao corte do sync NAO conta 2x (ja esta no pendente)" "$(qf "$D" 9704)" "3"
eq "N2 e o a caminho dele e o pendente, 1x"                                "$(qac "$D" 9704)" "2"
eq "N3 sync do dia: o D-8 NAO conta 2x"                                    "$(qf "$D" 9705)" "3"
eq "L1 retrato sem data: corte de antes (D-8 fora)"                        "$(qf "$D" 9706)" "4"
eq "M1 run que cruzou a meia-noite: corte do fetch (D-1)-7, o D-8 CONTA"   "$(qf "$D" 9707)" "AUSENTE"
eq "F1 retrato posterior ao ciclo: nunca conta MENOS que o corte de antes" "$(qf "$D" 9708)" "AUSENTE"
eq "L2 retrato sem data: pedido recente segue contando"                    "$(qf "$D" 9709)" "AUSENTE"
eq "R mapa completo"                                                       "$(mapa "$D")" "$ESPERADO_NOVA"

echo "=== R2: retrato fresco num ciclo longe de tudo: os 9 voltam a ser elegiveis (os AUSENTE vieram do a caminho) ==="
# com o retrato VELHO o pedido do app segue contando em qualquer ciclo (nao esta naquele pendente) — por isso o R2
# refresca o retrato para o dia do ciclo; e o volta ao seed depois.
P -q -c "CREATE TABLE r2_bkp AS SELECT sku_codigo_omie, ultima_sincronizacao FROM sku_estoque_atual; UPDATE sku_estoque_atual SET ultima_sincronizacao = '2027-01-20 09:05:00+00';" >/dev/null
run_ciclo 2027-01-20
eq "R2 9 SKUs sugeridos num ciclo longe de tudo" "$(Pq -c "SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.data_ciclo='2027-01-20' AND pcs.status='pendente_aprovacao'")" "9"
P -q -c "UPDATE sku_estoque_atual s SET ultima_sincronizacao = b.ultima_sincronizacao FROM r2_bkp b WHERE b.sku_codigo_omie = s.sku_codigo_omie; DROP TABLE r2_bkp;" >/dev/null

if [ ! -f "$MIG" ]; then
  echo ""; echo "=== RESULTADO (sem a migration nova): PASS=$PASS FAIL=$FAIL ==="
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

echo "=== FALSIFICACOES (cada uma: CONTROLE verde pelo MESMO caminho, depois sabotagem -> vermelho especifico) ==="
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
# Substituicao LITERAL (perl \Q\E) SO no corpo da funcao (ate o 1o $function$; — a POS repete o predicado de
# proposito) e que exige EXATAMENTE 1 ocorrencia ali — 0 ou 2 = a sabotagem mediria outra coisa.
troca() {  # $1=arquivo-in $2=arquivo-out ; OLD/NEW no ambiente
  perl -ne 'BEGIN{$o=$ENV{OLD};$n=$ENV{NEW};$c=0;$f=0} $c += s/\Q$o\E/$n/g unless $f; $f=1 if /^\$function\$;$/; print; END{exit($c==1?0:3)}' "$1" > "$2"
}
# carrega a fixture (cortada no fim da funcao: a POS barraria a sabotagem antes do comportamento ser medido —
# o dente da POS e provado a parte) e roda o ciclo
carrega_e_roda() {  # $1=arquivo
  awk '{print} /^\$function\$;$/{exit}' "$1" > "$1.fn.sql"
  P -q -f "$1.fn.sql" >/dev/null 2>"$1.err" || { bad "carga de $(basename "$1") nao compilou: $(head -c 200 "$1.err")"; return 1; }
  run_ciclo "$D"
}
falsifica() {  # $1=nome $2=sku $3=valor-verde $4=valor-sabotado $5=descricao ; OLD/NEW no ambiente
  local nome="$1" sku="$2" verde="$3" sab="$4"
  # CONTROLE: a fixture INTACTA pelo mesmo caminho (awk + carga + ciclo) tem de dar o valor verde
  cp "$FIXTURE" "$SAB_DIR/$nome.ctl.sql"
  carrega_e_roda "$SAB_DIR/$nome.ctl.sql" || return
  local c; c="$(qf "$D" "$sku")"
  if [ "$c" != "$verde" ]; then bad "FALSIF $nome CONTROLE nao ficou verde ($sku: esperado [$verde], veio [$c]) — sabotar agora seria teatro"; return; fi
  troca "$FIXTURE" "$SAB_DIR/$nome.sql" || { bad "FALSIF $nome: OLD nao casou EXATAMENTE 1 vez na fixture"; return; }
  carrega_e_roda "$SAB_DIR/$nome.sql" || return
  local v; v="$(qf "$D" "$sku")"
  if [ "$v" = "$sab" ]; then ok "FALSIF $nome pegou ($5: $sku verde [$c] -> sabotado [$v])"; else bad "FALSIF $nome NAO detectou ($sku sob sabotagem: esperado [$sab], veio [$v])"; fi
}
CORTE_NOVO="(LEAST(p_data_ciclo, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date) - 7)"

OLD="$CORTE_NOVO" NEW="(p_data_ciclo - INTERVAL '7 days')" \
  falsifica F1-dois-relogios 9701 AUSENTE 4 "corte de volta no dia do ciclo = 0x no vao"
OLD="(sea_c.ultima_sincronizacao - INTERVAL '1 hour')" NEW="(sea_c.ultima_sincronizacao)" \
  falsifica F2-sem-folga-meia-noite 9707 AUSENTE 4 "sem a folga, o run das 23:59 perde o D-8"
OLD="LEAST(p_data_ciclo, " NEW="(" \
  falsifica F3-sem-least 9708 AUSENTE 4 "retrato posterior ao ciclo contaria MENOS que antes"
OLD="::date) - 7)" NEW="::date) - 8)" \
  falsifica F4-um-dia-a-mais 9704 3 AUSENTE "cortar 1 dia antes do sync conta 2x o que ja esta no pendente"
# (sem F5 do NULL: LEAST ignora NULL — o fallback e da semantica do LEAST, coberto por L1/L2; a F3 tira o LEAST e o
#  retrato sem data vira corte NULL, que o 9709 tambem acusaria)

# Dente da POS (a outra camada): a migration REAL com o corte revertido tem de ABORTAR com a sentinela e deixar
# o motor vivo INTACTO. CONTROLE: a migration intacta pelo mesmo caminho commita (rc 0). Parte da fixture REAL: a
# PRE da migration (md5 do corpo vivo) barra com razao um motor que ficou sabotado.
P -q -f "$FIXTURE" >/dev/null
P -q -f "$MIG" >/dev/null 2>&1
MD5_NOVA="$(fsrc)"
P -1 -q -f "$MIG" > "$SAB_DIR/post-ctl.log" 2>&1; prc=$?
eq "POS controle: a migration intacta aplica de novo (idempotente, rc 0)" "$prc" "0"
OLD="$CORTE_NOVO" NEW="(p_data_ciclo - INTERVAL '7 days')" troca "$MIG" "$SAB_DIR/post-sab.sql" \
  || bad "POS sabotagem: OLD nao casou 1 vez na migration"
P -1 -q -f "$SAB_DIR/post-sab.sql" > "$SAB_DIR/post-sab.log" 2>&1; prc=$?
if [ "$prc" -ne 0 ] && grep -q "POS-RU1 FALHOU" "$SAB_DIR/post-sab.log"; then
  ok "POS-RU1 abortou a migration com o corte revertido (rc=$prc)"
else
  bad "POS-RU1 NAO barrou o corte revertido (rc=$prc): $(head -c 300 "$SAB_DIR/post-sab.log")"
fi
eq "POS rollback: motor vivo intacto apos o abort" "$(fsrc)" "$MD5_NOVA"
# a POS limpa comentario antes de procurar: o predicado certo INTEIRO so em COMENTARIO + no codigo um equivalente
# do velho que escapa a comparacao literal ("- 7" em vez de "- INTERVAL '7 days'") tem de abortar. So a camada da
# limpeza pega este mutante (o ramo "velho literal presente" nao casa) — provado abaixo tirando a limpeza.
OLD="$CORTE_NOVO" NEW="(p_data_ciclo - 7) -- pcs2.data_ciclo >= $CORTE_NOVO" troca "$MIG" "$SAB_DIR/post-com.sql" \
  || bad "POS comentario: OLD nao casou 1 vez"
P -1 -q -f "$SAB_DIR/post-com.sql" > "$SAB_DIR/post-com.log" 2>&1; prc=$?
if [ "$prc" -ne 0 ] && grep -q "POS-RU1 FALHOU" "$SAB_DIR/post-com.log"; then
  ok "POS-RU1 nao se engana com o corte so em comentario (rc=$prc)"
else
  bad "POS-RU1 enganada pelo comentario (rc=$prc)"
fi
# controle da camada: a MESMA migration-mutante com a POS sem a limpeza de comentario tem de PASSAR (rc=0)
perl -0pe '$n = s/regexp_replace\(v_src, \x27--\[\^\\n\]\*\x27, \x27\x27, \x27g\x27\)/v_src/g; END { exit($n == 2 ? 0 : 3) }' \
  "$SAB_DIR/post-com.sql" > "$SAB_DIR/post-com-sem-limpeza.sql"; lrc=$?
if [ "$lrc" -ne 0 ]; then
  bad "POS sem limpeza: a limpeza nao casou exatamente 2 vezes (rc=$lrc)"
else
  P -1 -q -f "$SAB_DIR/post-com-sem-limpeza.sql" > "$SAB_DIR/post-com-sl.log" 2>&1; prc=$?
  if [ "$prc" -eq 0 ]; then ok "POS sem a limpeza deixa passar o mutante do comentario (a limpeza e a camada que pega)"
  else bad "POS sem a limpeza ainda barrou (rc=$prc) — o teste do comentario nao isola a limpeza"; fi
fi

# restauracao nao e teatro: a fixture de volta reproduz o mapa novo
P -q -f "$FIXTURE" >/dev/null
run_ciclo "$D"
eq "RST fixture restaurada = mapa novo" "$(mapa "$D")" "$ESPERADO_NOVA"

rm -rf "$SAB_DIR" "$RPC_ERR" "$FIXTURE"
echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
