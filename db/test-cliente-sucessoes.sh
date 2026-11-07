#!/usr/bin/env bash
# test-cliente-sucessoes.sh — prova EXECUTADA (PG17) da 20261107013000_cliente_sucessoes.sql: a sucessão/cisão
# DECLARADA entre clientes (entrega 2 do "sucessor declarado" do Radar).
#
# O que ela prende: o gate de gestor/master nas escritas e na prévia (e o do Radar na leitura do selo), a ACL de
# duas pontas, a resolução do CNPJ para UMA identidade canônica (profiles + alias; ambíguo e mesmo-comprador
# recusados), a versão otimista e a trava COMUM do grafo sob concorrência REAL (A→B × B→A em duas sessões), a
# recusa de cadeia/ciclo, 1 evento por antiga (a 2ª nova entra no mesmo), a auditoria (sem DELETE/TRUNCATE; só
# a revogação altera), o estado (declarada × ativa, corte futuro não ativa) e a prévia do corte com o MESMO dia
# de private.venda_linhas_pedido (fallback em America/Sao_Paulo, data estimada marcada).
#
# Monta o schema de produção como a db/test-radar-atribuir-atendimento.sh (snapshot + ACL medido + retrato de
# prod de 2026-10-29 + a cadeia viva, que pega ESTA migration pelo nome dos objetos guardados).
#
# Uso:
#   bash db/test-cliente-sucessoes.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-cliente-sucessoes.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5498}"
TMPD="$(mktemp -d /tmp/pgtest-cliente-sucessoes.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
# A sessão em UTC: o dia do pedido sem order_date_kpi TEM de sair do fuso de São Paulo escrito na função, não do
# fuso da sessão (a sabotagem previa_fuso só fica vermelha porque aqui os dois divergem).
export PGTZ=UTC

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
MIG="$REPO_ROOT/supabase/migrations/20261107013000_cliente_sucessoes.sql"
[ -f "$FIXTURE" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }

# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar cliente_resolver_documento cliente_sucessoes_chaves cliente_sucessoes_vigentes cliente_declarar_sucessao
            cliente_revogar_sucessao cliente_sucessao_previa cliente_sucessao_previa_lado cliente_sucessoes_do_documento
            cliente_sucessoes_imutavel)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(cliente_sucessoes cliente_sucessoes_grafo)
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  # Mesmo artefato dos harness irmãos: o snapshot de 15/10 ainda tem a contagem de 8 parâmetros (prod só tem a de 10).
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + retrato de 29/10 + cadeia (até esta migration)…"
cv_montar

[ "$(P -tA -q -c "SELECT to_regprocedure('public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date)') IS NOT NULL")" = t ] \
  || { echo "❌ a cadeia não aplicou 20261107013000 (cliente_declarar_sucessao ausente)"; exit 1; }

MASTER='00000000-0000-0000-0000-00000000a001'
GER='00000000-0000-0000-0000-00000000a002'     # employee + gerencial
FARM='00000000-0000-0000-0000-00000000a003'    # employee + farmer (lê o selo, não declara)
OPER='00000000-0000-0000-0000-00000000a006'    # employee + operacional: fora do Radar e da carteira completa
CLI='00000000-0000-0000-0000-00000000a008'     # customer
UA='00000000-0000-0000-0000-0000000c0001'      # DIVIMOVEIS (o antigo)
UAL='00000000-0000-0000-0000-0000000c0002'     # alias fiscal da DIVIMOVEIS (sem profile)
UAL2='00000000-0000-0000-0000-0000000c0003'    # alias com OUTRO documento que resolve para a DIVIMOVEIS
UN1='00000000-0000-0000-0000-0000000c0011'     # MARQUES (cadastrado no meio da prova)
UN2='00000000-0000-0000-0000-0000000c0012'     # 2ª nova, que JÁ é cliente
UX='00000000-0000-0000-0000-0000000c0021'; UY='00000000-0000-0000-0000-0000000c0022'
UW1='00000000-0000-0000-0000-0000000c0031'; UW2='00000000-0000-0000-0000-0000000c0032'
UP1='00000000-0000-0000-0000-0000000c0041'; UP2='00000000-0000-0000-0000-0000000c0042'   # o par ambíguo
ANT='03166577000166'; NOV1='69491768000101'; NOV2='22222222000122'
DX='33333333000133'; DY='44444444000144'; DW1='88888888000188'; DW2='99999999000199'
AMB='66666666000166'; MESMO='77777777000177'; P2DOC='12121212000112'
ORF='13131313000113'; ENC='14141414000114'; ENCX='15151515000115'; LIVRE='55555555000155'
# Seção L (o grafo revalidado na leitura): um par de documentos por cenário.
DZ1='10000000000101'; DZ2='10000000000102'; DZ3='10000000000103'; DZ4='10000000000104'; DZ5='10000000000105'
DZ6='10000000000106'; DZ7='10000000000107'; DZ8='10000000000108'; DZ9='10000000000109'; DZA='10000000000110'
UORF='00000000-0000-0000-0000-0000000c0051'   # canônico SEM profile (alias órfão)
UORFA='00000000-0000-0000-0000-0000000c0052'
UEN='00000000-0000-0000-0000-0000000c0053'    # tem profile, mas é ele próprio alias ativo da DIVIMOVEIS
UENA='00000000-0000-0000-0000-0000000c0054'
UZ='00000000-0000-0000-0000-0000000c01'       # prefixo: UZ1..UZ9 = ${UZ}01..${UZ}09

echo "→ seed: papéis, clientes, alias, leads, pedidos…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$OPER'),('$CLI'),('$UA'),('$UAL'),('$UAL2'),
  ('$UN1'),('$UN2'),('$UX'),('$UY'),('$UW1'),('$UW2'),('$UP1'),('$UP2'),('$UORF'),('$UORFA'),('$UEN'),('$UENA'),
  ('${UZ}01'),('${UZ}02'),('${UZ}03'),('${UZ}04'),('${UZ}05'),('${UZ}06'),('${UZ}07'),('${UZ}08'),('${UZ}09');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER','master'),('$GER','employee'),('$FARM','employee'),('$OPER','employee'),('$CLI','customer');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer'),('$OPER','operacional');
INSERT INTO public.profiles (user_id, name) VALUES
  ('$MASTER','Lucas'),('$GER','Gestor'),('$FARM','Vendedor Um'),('$OPER','Operador'),('$CLI','Cliente');
-- O documento do antigo vem MASCARADO: a resolução normaliza.
INSERT INTO public.profiles (user_id, name, document) VALUES
  ('$UA','DIVIMOVEIS','03.166.577/0001-66'), ('$UN2','NOVA DOIS','$NOV2'), ('$UX','CLIENTE X','$DX'),
  ('$UY','CLIENTE Y','$DY'), ('$UW1','CLIENTE W1','$DW1'), ('$UW2','CLIENTE W2','$DW2'),
  ('$UP1','AMBIGUO UM','$AMB'), ('$UP2','AMBIGUO DOIS','$P2DOC'), ('$UEN','ENCADEADO',NULL),
  ('${UZ}01','Z1','$DZ1'), ('${UZ}02','Z2','$DZ2'), ('${UZ}03','Z3','$DZ3'), ('${UZ}04','Z4','$DZ4'), ('${UZ}05','Z5','$DZ5'),
  ('${UZ}06','Z6','$DZ6'), ('${UZ}07','Z7','$DZ7'), ('${UZ}08','Z8','$DZ8'), ('${UZ}09','Z9','$DZ9');
INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, documento, status) VALUES
  ('$UAL', '$UA', '$ANT', 'active'),
  ('$UAL2', '$UA', '$MESMO', 'active'),
  -- AMB: o profile UP1 tem o documento, e um alias ativo com o MESMO documento aponta para OUTRO canônico (UP2).
  ('00000000-0000-0000-0000-0000000c0049', '$UP2', '$AMB', 'active'),
  -- ORF: o único candidato é um canônico SEM profile (o alias ficou órfão).
  ('$UORFA', '$UORF', '$ORF', 'active'),
  -- ENC: o canônico tem profile, mas é ele próprio alias ativo (da DIVIMOVEIS, pelo documento ENCX).
  ('$UEN', '$UA', '$ENCX', 'active'),
  ('$UENA', '$UEN', '$ENC', 'active');
INSERT INTO public.radar_empresas (cnpj, razao_social, nome_fantasia, cnae_principal, ultimo_lote, ja_cliente, data_abertura) VALUES
  ('$NOV1','MARQUES PLANEJADOS LTDA','DIVIMOVEIS','3101200','2026-10',false,'2026-10-06');
-- Pedidos e itens são semente, não o objeto sob prova: sem os gatilhos de coerência items(jsonb) × order_items.
ALTER TABLE public.order_items DISABLE TRIGGER ALL;
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
-- Pedidos da DIVIMOVEIS em volta do corte de 06/10/2026 (dia = COALESCE(order_date_kpi, created_at em SP)):
INSERT INTO public.sales_orders (id, customer_user_id, status, account, order_date_kpi, created_at, deleted_at, created_by) VALUES
  ('00000000-0000-0000-0000-0000000d0001', '$UA',  'faturado',  'colacor', '2026-09-10', '2026-09-10 12:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0002', '$UAL', 'faturado',  'oben',    '2026-09-20', '2026-09-20 12:00+00', NULL, '$MASTER'),
  -- sem order_date_kpi, 02:00 UTC de 06/10 = 23:00 de 05/10 em SP → ANTES do corte (estimada)
  ('00000000-0000-0000-0000-0000000d0003', '$UA',  'faturado',  'colacor', NULL,         '2026-10-06 02:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0004', '$UA',  'faturado',  'colacor', '2026-10-06', '2026-10-06 12:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0005', '$UA',  'cancelado', 'colacor', '2026-09-01', '2026-09-01 12:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0006', '$UA',  'faturado',  'colacor', '2026-09-02', '2026-09-02 12:00+00', '2026-09-03 12:00+00', '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0007', '$UN2', 'faturado',  'oben',    '2026-10-20', '2026-10-20 12:00+00', NULL, '$MASTER'),
  -- Fora do universo de venda_linhas_pedido: recibo sem itens, item de quantidade 0, item sem produto Omie.
  ('00000000-0000-0000-0000-0000000d0008', '$UA',  'faturado',  'colacor', '2026-09-25', '2026-09-25 12:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0009', '$UA',  'faturado',  'colacor', '2026-09-26', '2026-09-26 12:00+00', NULL, '$MASTER'),
  ('00000000-0000-0000-0000-0000000d0010', '$UA',  'faturado',  'colacor', '2026-10-07', '2026-10-07 12:00+00', NULL, '$MASTER');
INSERT INTO public.order_items (id, sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
SELECT gen_random_uuid(), so.id, so.customer_user_id, x.produto, x.qtd, 10
  FROM (VALUES ('d0001', 101, 2), ('d0002', 101, 1), ('d0003', 102, 1), ('d0004', 101, 3), ('d0005', 101, 1),
               ('d0006', 101, 1), ('d0007', 103, 1), ('d0009', 101, 0), ('d0010', NULL, 2)) AS x(suf, produto, qtd)
  JOIN public.sales_orders so ON so.id = ('00000000-0000-0000-0000-0000000' || x.suf)::uuid;
ALTER TABLE public.order_items ENABLE TRIGGER ALL;
ALTER TABLE public.sales_orders ENABLE TRIGGER ALL;
COMMIT;
CREATE SCHEMA IF NOT EXISTS prova;
CREATE OR REPLACE FUNCTION prova.erro(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN EXECUTE p_sql; RETURN 'OK';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ':' || left(SQLERRM, 40); END \$f\$;
GRANT USAGE ON SCHEMA prova TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION prova.erro(text) TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — como o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
erro_como() { q_como authenticated "$1" "SELECT prova.erro(\$cmd\$$2\$cmd\$);"; }
versao() { P -tA -q -c "SELECT versao FROM private.cliente_sucessoes_grafo"; }
# porta <sql> — como DONO da tabela e com a porta das RPCs aberta na sessão: simula a escrita que passou POR FORA
# do protocolo (o que a leitura tem de revalidar) e isola a camada de auditoria da camada da porta.
porta() { P -tA -q -c "SELECT set_config('cliente_sucessoes.porta','rpc',false)" -c "$1" | tail -n1; }
# inserir_por_fora <antigo> <novo> <evento> <tipo> <corte>
inserir_por_fora() {
  porta "INSERT INTO public.cliente_sucessoes (evento_id, antigo_documento, novo_documento, tipo, data_corte, declarado_por)
         VALUES ('$3', '$1', '$2', '$4', '$5', '$MASTER') RETURNING 'ok'"
}
vig() {  # <antigo> <novo> — estado/impedimento em 2026-11-01
  P -tA -q -c "SELECT estado || '/' || COALESCE(impedimento,'-') FROM private.cliente_sucessoes_vigentes('2026-11-01')
               WHERE antigo_documento='$1' AND novo_documento='$2'"
}
# declarar <uid> <antigo> <novo> <tipo> <corte> <versao> <campo do jsonb>
declarar() {
  q_como authenticated "$1" "SELECT public.cliente_declarar_sucessao('$2', '$3', '$4', '$5', $6)->>'$7'"
}
ativas() { P -tA -q -c "SELECT count(*) FROM public.cliente_sucessoes WHERE revogado_em IS NULL AND $1"; }
selo() {  # <uid> <doc> <expressão jq-like em SQL sobre o 1º item: campo>
  q_como authenticated "$1" "SELECT public.cliente_sucessoes_do_documento('$2')->'sucessoes'->0->>'$3'"
}
previa() {  # <campo do lado antigo>
  q_como authenticated "$MASTER" "SELECT public.cliente_sucessao_previa('$ANT', '$NOV1', '2026-10-06')->'antigo'->>'$1'"
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "── A. gates (fronteira no banco) ──"
  chk A1 "farmer não declara: gate de gestor" \
    "$(erro_como "$FARM" "SELECT public.cliente_declarar_sucessao('$ANT','$NOV1','cisao','2026-10-06',0)")" "42501:forbidden: gestor/master only"
  chk A2 "customer não declara" \
    "$(erro_como "$CLI" "SELECT public.cliente_declarar_sucessao('$ANT','$NOV1','cisao','2026-10-06',0)")" "42501:forbidden: gestor/master only"
  chk A3 "anon: sem EXECUTE (ACL)" \
    "$(q_como anon '' "SELECT prova.erro(\$c\$SELECT public.cliente_declarar_sucessao('$ANT','$NOV1','cisao','2026-10-06',0)\$c\$)")" \
    "42501:permission denied for function cliente_d"
  chk A4 "farmer não vê a prévia (histórico da antiga)" \
    "$(erro_como "$FARM" "SELECT public.cliente_sucessao_previa('$ANT','$NOV1','2026-10-06')")" "42501:forbidden: gestor/master only"
  chk A5 "customer não lê o selo" \
    "$(erro_como "$CLI" "SELECT public.cliente_sucessoes_do_documento('$NOV1')")" "42501:forbidden: radar_prospectar"
  chk A6 "operacional não lê o selo" \
    "$(erro_como "$OPER" "SELECT public.cliente_sucessoes_do_documento('$NOV1')")" "42501:forbidden: radar_prospectar"
  chk A7 "farmer (Radar) lê o selo vazio, com a versão" \
    "$(q_como authenticated "$FARM" "SELECT public.cliente_sucessoes_do_documento('$NOV1')::text")" '{"versao": 0, "sucessoes": []}'
  chk A8 "farmer não revoga" \
    "$(erro_como "$FARM" "SELECT public.cliente_revogar_sucessao(gen_random_uuid(),'x',0)")" "42501:forbidden: gestor/master only"
  chk A9 "nada escrito pelas recusas" "$(ativas true)/$(versao)" "0/0"

  echo "── B. entrada inválida (22023) ──"
  chk B1 "documento curto" \
    "$(erro_como "$MASTER" "SELECT public.cliente_declarar_sucessao('0316657','$NOV1','cisao','2026-10-06',0)" | cut -d: -f1)" "22023"
  chk B2 "tipo fora de cisao|sucessao" \
    "$(erro_como "$MASTER" "SELECT public.cliente_declarar_sucessao('$ANT','$NOV1','fusao','2026-10-06',0)" | cut -d: -f1)" "22023"
  chk B3 "versão ausente" \
    "$(erro_como "$MASTER" "SELECT public.cliente_declarar_sucessao('$ANT','$NOV1','cisao','2026-10-06',NULL)" | cut -d: -f1)" "22023"
  chk B4 "mesmo documento" "$(declarar "$MASTER" "$ANT" "$ANT" cisao 2026-10-06 0 motivo)" "mesmo_documento"

  echo "── C. resolução para UMA identidade canônica ──"
  chk C1 "antigo que não é cliente (o lead)" "$(declarar "$MASTER" "$NOV1" "$DX" cisao 2026-10-06 "$(versao)" motivo)" "antigo_nao_e_cliente"
  chk C2 "antigo ambíguo (profile + alias de outro canônico)" "$(declarar "$MASTER" "$AMB" "$NOV1" cisao 2026-10-06 "$(versao)" motivo)" "antigo_ambiguo"
  chk C3 "novo ambíguo" "$(declarar "$MASTER" "$DX" "$AMB" cisao 2026-10-06 "$(versao)" motivo)" "novo_ambiguo"
  chk C4 "dois documentos do MESMO comprador (alias)" "$(declarar "$MASTER" "$ANT" "$MESMO" cisao 2026-10-06 "$(versao)" motivo)" "mesmo_comprador"
  chk C5 "resolvedor: documento mascarado no profile casa o normalizado" \
    "$(P -tA -q -c "SELECT user_id || '/' || candidatos || '/' || nome FROM private.cliente_resolver_documento('$ANT')")" "$UA/1/DIVIMOVEIS"
  chk C7 "antigo cujo canônico não tem profile (alias órfão)" "$(declarar "$MASTER" "$ORF" "$NOV1" cisao 2026-10-06 "$(versao)" motivo)" "antigo_cadastro_invalido"
  chk C8 "novo cujo canônico é, ele próprio, alias ativo" "$(declarar "$MASTER" "$DX" "$ENC" cisao 2026-10-06 "$(versao)" motivo)" "novo_cadastro_invalido"
  chk C9 "resolvedor: órfão conta 1 candidato, inválido, sem user_id" \
    "$(P -tA -q -c "SELECT COALESCE(user_id::text,'NULO') || '/' || candidatos || '/' || invalidos FROM private.cliente_resolver_documento('$ORF')")" "NULO/1/1"
  chk C6 "nenhuma recusa escreveu" "$(ativas true)/$(versao)" "0/0"

  echo "── D. declarar (cisão 1 antiga → 2 novas, versão otimista) ──"
  chk D1 "master declara DIVIMOVEIS → MARQUES (mascarado na entrada)" \
    "$(declarar "$MASTER" "03.166.577/0001-66" "$NOV1" cisao 2026-10-06 0 ok)" "true"
  chk D2 "versão do grafo subiu para 1" "$(versao)" "1"
  chk D3 "versão velha é recusada (outro gestor gravou antes)" "$(declarar "$GER" "$ANT" "$NOV2" cisao 2026-10-06 0 motivo)" "versao_mudou"
  chk D4 "gestor, com a versão atual, põe a 2ª nova no MESMO evento" \
    "$(declarar "$GER" "$ANT" "$NOV2" cisao 2026-10-06 "$(versao)" ok)/$(P -tA -q -c "SELECT count(DISTINCT evento_id) FROM public.cliente_sucessoes WHERE antigo_documento='$ANT'")" "true/1"
  chk D5 "tipo/corte divergente do evento da antiga" "$(declarar "$MASTER" "$ANT" "$DX" sucessao 2026-10-06 "$(versao)" motivo)" "evento_divergente"
  chk D6 "par já declarado" "$(declarar "$MASTER" "$ANT" "$NOV1" cisao 2026-10-06 "$(versao)" motivo)" "ja_declarada"
  chk D7 "não marca ja_cliente no Radar" "$(P -tA -q -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='$NOV1'")" "f"
  chk D8 "gravou o documento normalizado e quem declarou" \
    "$(P -tA -q -c "SELECT antigo_documento || '/' || declarado_por FROM public.cliente_sucessoes WHERE novo_documento='$NOV1'")" "$ANT/$MASTER"
  chk D9 "o MESMO par de compradores por outro documento do antigo: ja_declarada" \
    "$(declarar "$MASTER" "$MESMO" "$NOV2" cisao 2026-10-06 "$(versao)" motivo)" "ja_declarada"
  chk D10 "o evento é do COMPRADOR antigo: outro documento dele não abre 2º evento" \
    "$(declarar "$MASTER" "$MESMO" "$DX" sucessao 2026-10-06 "$(versao)" motivo)" "evento_divergente"

  echo "── E. selo e estado ──"
  chk E1 "farmer vê: papel novo, cisão de DIVIMOVEIS" \
    "$(selo "$FARM" "$NOV1" papel)/$(selo "$FARM" "$NOV1" tipo)/$(selo "$FARM" "$NOV1" antigo_nome)" "novo/cisao/DIVIMOVEIS"
  chk E2 "MARQUES sem cadastro: declarada, impedimento novo_sem_cadastro" \
    "$(selo "$FARM" "$NOV1" estado)/$(selo "$FARM" "$NOV1" impedimento)" "declarada/novo_sem_cadastro"
  chk E3 "a 2ª nova (já cliente) está ativa" "$(selo "$FARM" "$NOV2" estado)" "ativa"
  chk E4 "o antigo vê as 2 declarações, papel antigo" \
    "$(q_como authenticated "$FARM" "SELECT jsonb_array_length(public.cliente_sucessoes_do_documento('$ANT')->'sucessoes') || '/' || (public.cliente_sucessoes_do_documento('$ANT')->'sucessoes'->0->>'papel')")" "2/antigo"
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.profiles (user_id, name, document) VALUES ('$UN1','MARQUES PLANEJADOS','$NOV1')"
  chk E5 "cadastrada no Omie (profile com o documento): ativa" "$(selo "$FARM" "$NOV1" estado)" "ativa"
  chk E6 "corte futuro não ativa antes da hora (véspera do corte)" \
    "$(P -tA -q -c "SELECT estado || '/' || impedimento FROM private.cliente_sucessoes_vigentes('2026-10-05') WHERE novo_documento='$NOV1'")" "declarada/corte_futuro"
  chk E7 "no próprio dia do corte a declaração já vale" \
    "$(P -tA -q -c "SELECT estado || '/' || COALESCE(impedimento,'-') FROM private.cliente_sucessoes_vigentes('2026-10-06') WHERE novo_documento='$NOV1'")" "ativa/-"
  chk E8 "vigentes resolve os dois extremos" \
    "$(P -tA -q -c "SELECT antigo_user_id || '/' || novo_user_id FROM private.cliente_sucessoes_vigentes('2026-11-01') WHERE novo_documento='$NOV1'")" "$UA/$UN1"

  echo "── F. cadeia e ciclo recusados; fusão permitida ──"
  chk F1 "a nova não passa adiante (A→B→C)" "$(declarar "$MASTER" "$NOV2" "$DX" cisao 2026-10-10 "$(versao)" motivo)" "cadeia"
  chk F2 "quem já passou não recebe (X→A com A→B)" "$(declarar "$MASTER" "$DX" "$ANT" cisao 2026-10-10 "$(versao)" motivo)" "cadeia"
  chk F3 "ciclo B→A" "$(declarar "$MASTER" "$NOV1" "$ANT" sucessao 2026-10-10 "$(versao)" motivo)" "cadeia"
  chk F4 "fusão: outra antiga também sucede para MARQUES" "$(declarar "$MASTER" "$DY" "$NOV1" sucessao 2026-10-01 "$(versao)" ok)" "true"
  chk F6 "quem já passou não recebe por OUTRO documento do mesmo comprador" \
    "$(declarar "$MASTER" "$DX" "$MESMO" cisao 2026-10-10 "$(versao)" motivo)" "cadeia"
  chk F5 "cadeia não escreveu" "$(ativas "antigo_documento IN ('$NOV2','$DX','$NOV1')")" "0"

  echo "── G. revogar (auditado) ──"
  local id2
  id2="$(P -tA -q -c "SELECT id FROM public.cliente_sucessoes WHERE novo_documento='$NOV2' AND revogado_em IS NULL")"
  chk G1 "motivo vazio: 22023" \
    "$(erro_como "$MASTER" "SELECT public.cliente_revogar_sucessao('$id2',' ',3)" | cut -d: -f1)" "22023"
  chk G2 "id inexistente: P0002" \
    "$(erro_como "$MASTER" "SELECT public.cliente_revogar_sucessao('00000000-0000-0000-0000-000000000000','x',3)" | cut -d: -f1)" "P0002"
  chk G3 "versão velha não revoga" \
    "$(q_como authenticated "$MASTER" "SELECT public.cliente_revogar_sucessao('$id2','nao era cisao',$(( $(versao) - 1 )))->>'motivo'")" "versao_mudou"
  chk G4 "gestor revoga a 2ª nova" \
    "$(q_como authenticated "$GER" "SELECT public.cliente_revogar_sucessao('$id2','nao era cisao',$(versao))->>'ok'")" "true"
  chk G5 "a linha fica: revogada, por quem, por quê" \
    "$(selo "$FARM" "$NOV2" estado)/$(selo "$FARM" "$NOV2" revogado_por_nome)/$(selo "$FARM" "$NOV2" revogado_motivo)" "revogada/Gestor/nao era cisao"
  chk G6 "revogar de novo: ja_revogada" \
    "$(q_como authenticated "$GER" "SELECT public.cliente_revogar_sucessao('$id2','de novo',$(versao))->>'motivo'")" "ja_revogada"
  chk G7 "revogada sai das vigentes" \
    "$(P -tA -q -c "SELECT count(*) FROM private.cliente_sucessoes_vigentes('2026-11-01') WHERE novo_documento='$NOV2'")" "0"
  chk G8 "re-declarar depois de revogar é permitido (nova linha)" \
    "$(declarar "$MASTER" "$ANT" "$NOV2" cisao 2026-10-06 "$(versao)" ok)/$(P -tA -q -c "SELECT count(*) FROM public.cliente_sucessoes WHERE novo_documento='$NOV2'")" "true/2"

  echo "── H. auditoria: sem DELETE/TRUNCATE, só a revogação altera ──"
  chk H1 "DELETE direto (até o dono da tabela)" \
    "$(P -tA -q -c "SELECT prova.erro(\$c\$DELETE FROM public.cliente_sucessoes WHERE novo_documento='$NOV1'\$c\$)" | cut -d: -f1)" "23001"
  chk H2 "UPDATE da data de corte (mesmo com a porta aberta)" \
    "$(porta "SELECT prova.erro(\$c\$UPDATE public.cliente_sucessoes SET data_corte='2026-01-01' WHERE novo_documento='$NOV1'\$c\$)" | cut -d: -f1)" "23001"
  chk H3 "des-revogar (mesmo com a porta aberta)" \
    "$(porta "SELECT prova.erro(\$c\$UPDATE public.cliente_sucessoes SET revogado_em=NULL, revogado_por=NULL, revogado_motivo=NULL WHERE id='$id2'\$c\$)" | cut -d: -f1)" "23001"
  chk H4 "TRUNCATE" "$(P -tA -q -c "SELECT prova.erro(\$c\$TRUNCATE public.cliente_sucessoes\$c\$)" | cut -d: -f1)" "23001"
  chk H5 "authenticated não lê a tabela crua" \
    "$(q_como authenticated "$MASTER" "SELECT prova.erro(\$c\$SELECT 1 FROM public.cliente_sucessoes\$c\$)" | cut -d: -f1)" "42501"
  local ins="INSERT INTO public.cliente_sucessoes (evento_id, antigo_documento, novo_documento, tipo, data_corte, declarado_por) VALUES (gen_random_uuid(), '$DX', '$LIVRE', 'cisao', '2026-10-01', '$MASTER')"
  chk H6 "INSERT direto do dono, sem passar pela RPC" \
    "$(P -tA -q -c "SELECT prova.erro(\$c\$$ins\$c\$)")" "23001:cliente_sucessoes: escrita fora das RPCs"
  chk H7 "revogar sem motivo (porta aberta): a auditoria exige o porquê" \
    "$(porta "SELECT prova.erro(\$c\$UPDATE public.cliente_sucessoes SET revogado_em=now(), revogado_por='$MASTER' WHERE novo_documento='$NOV1' AND revogado_em IS NULL\$c\$)" | cut -d: -f1)" "23001"
  chk H8 "service_role não escreve direto (sem trava, versão nem regras)" \
    "$(q_como service_role '' "SELECT prova.erro(\$c\$$ins\$c\$)" | cut -d: -f1)" "42501"
  chk H9 "a declaração nasce ativa (INSERT já revogado recusado)" \
    "$(porta "SELECT prova.erro(\$c\$INSERT INTO public.cliente_sucessoes (evento_id, antigo_documento, novo_documento, tipo, data_corte, declarado_por, revogado_em, revogado_por, revogado_motivo) VALUES (gen_random_uuid(), '$DX', '$LIVRE', 'cisao', '2026-10-01', '$MASTER', now(), '$MASTER', 'x')\$c\$)" | cut -d: -f1)" "23001"
  chk H10 "nada escrito por fora" "$(ativas "novo_documento = '$LIVRE'")" "0"

  echo "── I. prévia do corte (mesmo dia de venda_linhas_pedido, sem valor) ──"
  chk I1 "antes do corte: 3 (alias conta; 23h de SP do dia 05 é antes; cancelado e apagado fora)" "$(previa pedidos_antes)" "3"
  chk I2 "a partir do corte: 1 (o próprio dia do corte)" "$(previa pedidos_a_partir)" "1"
  chk I3 "1 data estimada (sem order_date_kpi)" "$(previa datas_estimadas)" "1"
  chk I4 "recentes marcam a estimada e o lado do corte" \
    "$(q_como authenticated "$MASTER" "SELECT x->>'dia' || '/' || (x->>'estimada') || '/' || (x->>'antes_do_corte') FROM jsonb_array_elements(public.cliente_sucessao_previa('$ANT','$NOV1','2026-10-06')->'antigo'->'recentes') x WHERE (x->>'estimada')::boolean")" \
    "2026-10-05/true/true"
  # Toda chave, em QUALQUER nível (pedidos aninhados, os dois lados, o selo), tem de estar na lista do contrato.
  chk I5 "nenhuma chave fora do contrato (sem valor/preço) em todo nível da prévia e do selo" \
    "$(q_como authenticated "$MASTER" "WITH j(v) AS (SELECT public.cliente_sucessao_previa('$ANT','$NOV1','2026-10-06') UNION ALL SELECT public.cliente_sucessoes_do_documento('$ANT')),
       o(x) AS (SELECT jsonb_path_query(j.v, 'lax \$.** ? (@.type() == \"object\")') FROM j)
       SELECT COALESCE(string_agg(DISTINCT k, ',' ORDER BY k), 'LIMPO') FROM o, jsonb_object_keys(o.x) k
        WHERE k NOT IN ('data_corte','abertura_novo','antigo','novo','documento','nome','cadastrado','candidatos',
          'pedidos_antes','pedidos_a_partir','primeiro_pedido','ultimo_pedido','datas_estimadas','recentes','dia',
          'empresa','estimada','antes_do_corte','versao','sucessoes','id','evento_id','papel','antigo_documento',
          'antigo_nome','novo_documento','novo_nome','tipo','data_corte_sugerida','observacao','declarado_por_nome',
          'declarado_em','revogado_em','revogado_por_nome','revogado_motivo','estado','impedimento')")" "LIMPO"
  chk I8 "o selo e a prévia de fato têm pedidos e declarações (o I5 não passa no vazio)" \
    "$(q_como authenticated "$MASTER" "SELECT jsonb_array_length(public.cliente_sucessao_previa('$ANT','$NOV1','2026-10-06')->'antigo'->'recentes') || '/' || jsonb_array_length(public.cliente_sucessoes_do_documento('$ANT')->'sucessoes')")" "4/3"
  chk I6 "lado sem cadastro: contagens nulas (ausente ≠ zero)" \
    "$(q_como authenticated "$MASTER" "SELECT COALESCE(public.cliente_sucessao_previa('$ANT','55555555000155','2026-10-06')->'novo'->>'pedidos_antes','NULO')")" "NULO"
  chk I7 "abertura do novo sugerida" \
    "$(q_como authenticated "$MASTER" "SELECT public.cliente_sucessao_previa('$ANT','$NOV1','2026-10-06')->>'abertura_novo'")" "2026-10-06"

  echo "── J. concorrência REAL: W1→W2 × W2→W1 em duas sessões ──"
  local v0 r1 r2
  v0="$(versao)"
  concorrer "$v0" "$v0"
  r1="$(cat "$TMPD/s1.out")"; r2="$(cat "$TMPD/s2.out")"
  chk J1 "2ª sessão com a MESMA versão: versao_mudou, só 1 gravada" \
    "$r1/$r2/$(ativas "(antigo_documento, novo_documento) IN (('$DW1','$DW2'),('$DW2','$DW1'))")" "true/versao_mudou/1"
  revogar_par_w
  v0="$(versao)"
  concorrer "$v0" "$((v0 + 1))"
  r1="$(cat "$TMPD/s1.out")"; r2="$(cat "$TMPD/s2.out")"
  chk J2 "2ª sessão já com a versão de depois: vê a 1ª gravada e recusa o ciclo" \
    "$r1/$r2/$(ativas "(antigo_documento, novo_documento) IN (('$DW1','$DW2'),('$DW2','$DW1'))")" "true/cadeia/1"

  echo "── L. a leitura revalida o grafo (escrita por fora, cadastro/alias que muda depois) ──"
  inserir_por_fora "$DZ1" "$DZ2" "$(P -tA -q -c 'SELECT gen_random_uuid()')" cisao 2026-10-01 > /dev/null
  inserir_por_fora "$DZ2" "$DZ1" "$(P -tA -q -c 'SELECT gen_random_uuid()')" cisao 2026-10-01 > /dev/null
  chk L1 "ciclo escrito por fora: as DUAS linhas ficam declaradas (cadeia)" "$(vig "$DZ1" "$DZ2")|$(vig "$DZ2" "$DZ1")" "declarada/cadeia|declarada/cadeia"
  declarar "$MASTER" "$DZ3" "$DZ4" cisao 2026-10-01 "$(versao)" ok > /dev/null
  declarar "$MASTER" "$DZ5" "$DZ6" cisao 2026-10-01 "$(versao)" ok > /dev/null
  chk L2a "antes da canonicalização: duas sucessões independentes, ativas" "$(vig "$DZ3" "$DZ4")|$(vig "$DZ5" "$DZ6")" "ativa/-|ativa/-"
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, documento, status) VALUES ('${UZ}06', '${UZ}03', '$DZ6', 'active')"
  chk L2 "alias novo junta Z6 a Z3: Z5→Z3→Z4 vira cadeia nas duas" "$(vig "$DZ3" "$DZ4")|$(vig "$DZ5" "$DZ6")" "declarada/cadeia|declarada/cadeia"
  inserir_por_fora "$DZ7" "$DZ8" "$(P -tA -q -c 'SELECT gen_random_uuid()')" cisao 2026-10-01 > /dev/null
  inserir_por_fora "$DZ7" "$DZ9" "$(P -tA -q -c 'SELECT gen_random_uuid()')" cisao 2026-10-01 > /dev/null
  chk L3 "a mesma antiga em 2 eventos: evento_divergente nas duas" "$(vig "$DZ7" "$DZ8")|$(vig "$DZ7" "$DZ9")" "declarada/evento_divergente|declarada/evento_divergente"
  inserir_por_fora "$MESMO" "$NOV2" "$(P -tA -q -c "SELECT evento_id FROM public.cliente_sucessoes WHERE antigo_documento='$ANT' AND revogado_em IS NULL LIMIT 1")" cisao 2026-10-06 > /dev/null
  chk L4 "o mesmo par de compradores por 2 documentos: duplicada" "$(vig "$ANT" "$NOV2")|$(vig "$MESMO" "$NOV2")" "declarada/duplicada|declarada/duplicada"
  inserir_por_fora "$ORF" "$DZA" "$(P -tA -q -c 'SELECT gen_random_uuid()')" cisao 2026-10-01 > /dev/null
  chk L5 "antigo com cadastro inválido escrito por fora não ativa" "$(vig "$ORF" "$DZA")" "declarada/antigo_cadastro_invalido"
  chk L6 "o resto do grafo segue ativo (a revalidação não é tudo-ou-nada)" "$(vig "$ANT" "$NOV1")" "ativa/-"

  echo "── K. catálogo ──"
  chk K1 "re-aplicar a migration é no-op" "$(P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk K2 "anon sem EXECUTE no selo" \
    "$(P -tA -q -c "SELECT has_function_privilege('anon','public.cliente_sucessoes_do_documento(text)','EXECUTE')")" "f"
  chk K3 "authenticated sem EXECUTE no resolvedor privado" \
    "$(P -tA -q -c "SELECT has_function_privilege('authenticated','private.cliente_resolver_documento(text)','EXECUTE')")" "f"
  chk K4 "service_role só LÊ a tabela e não toca a versão do grafo" \
    "$(P -tA -q -c "SELECT has_table_privilege('service_role','public.cliente_sucessoes','SELECT') || '/' || has_table_privilege('service_role','public.cliente_sucessoes','INSERT,UPDATE,DELETE') || '/' || has_table_privilege('service_role','private.cliente_sucessoes_grafo','UPDATE')")" "true/false/false"
}

# concorrer <versao da 1ª> <versao da 2ª> — sessão 1 declara W1→W2 e SEGURA a transação; a 2ª, já com a trava
# da 1ª tomada (confirmada em pg_locks), declara W2→W1. Resultados em s1.out / s2.out.
concorrer() {
  local claims="{\"sub\":\"$MASTER\",\"role\":\"authenticated\"}" i
  PGAPPNAME=prova_s1 P -tA -q -v ON_ERROR_STOP=1 > "$TMPD/s1.out" 2>&1 <<SQL &
BEGIN;
SET ROLE authenticated;
SET request.jwt.claims = '$claims';
SELECT public.cliente_declarar_sucessao('$DW1', '$DW2', 'cisao', '2026-10-01', $1)->>'ok';
SELECT pg_sleep(1.5) \g /dev/null
COMMIT;
SQL
  local pid=$!
  for i in $(seq 1 100); do
    # Prontidão pela SESSÃO (já no pg_sleep, transação aberta com a escrita feita), não pela trava: a sabotagem
    # sem_trava tira a trava, e esperar por ela adiaria a 2ª sessão para depois do COMMIT (teatro).
    [ "$(P -tA -q -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='prova_s1' AND state='active' AND query LIKE 'SELECT pg_sleep%'")" -ge 1 ] && break
    sleep 0.05
  done
  q_como authenticated "$MASTER" "SELECT public.cliente_declarar_sucessao('$DW2', '$DW1', 'cisao', '2026-10-01', $2)->>'motivo'" > "$TMPD/s2.raw" || true
  wait "$pid" || true
  # A 2ª devolve 'motivo' (recusa) ou nada (gravou: motivo nulo) — nulo vira o marcador GRAVOU.
  local s2; s2="$(cat "$TMPD/s2.raw")"; [ -n "$s2" ] || s2=GRAVOU
  printf '%s' "$s2" > "$TMPD/s2.out"
  tr -d '\n' < "$TMPD/s1.out" > "$TMPD/s1.tmp" && mv "$TMPD/s1.tmp" "$TMPD/s1.out"
}
revogar_par_w() {
  P -v ON_ERROR_STOP=1 -q -c "SELECT set_config('cliente_sucessoes.porta','rpc',false)" \
    -c "UPDATE public.cliente_sucessoes SET revogado_em=now(), revogado_por='$MASTER', revogado_motivo='reset da prova'
    WHERE revogado_em IS NULL AND antigo_documento IN ('$DW1','$DW2')" \
    -c "UPDATE private.cliente_sucessoes_grafo SET versao = versao + 1" > /dev/null
}

# sabotagem <nome> — muda UMA camada no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
DECL='public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date)'
GATE_GESTOR='IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'
sabotagem() {
  case "$1" in
    sem_gate_declarar) cv_sabotar "$DECL" "$GATE_GESTOR" "IF false THEN" ;;
    sem_gate_previa) cv_sabotar 'public.cliente_sucessao_previa(text,text,date)' "$GATE_GESTOR" "IF false THEN" ;;
    selo_aberto) cv_sabotar 'public.cliente_sucessoes_do_documento(text)' \
      "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false) OR COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN" "IF false THEN" ;;
    sem_trava) cv_sabotar "$DECL" "PERFORM pg_advisory_xact_lock(hashtextextended('cliente_sucessoes:grafo', 0));" "PERFORM 1;" ;;
    sem_versao) cv_sabotar "$DECL" "IF v_versao IS DISTINCT FROM p_versao_esperada THEN" "IF false THEN" ;;
    sem_versao_revogar) cv_sabotar 'public.cliente_revogar_sucessao(uuid,text,bigint)' \
      "IF v_versao IS DISTINCT FROM p_versao_esperada THEN" "IF false THEN" ;;
    sem_cadeia) cv_sabotar "$DECL" "OR EXISTS (SELECT 1 FROM private.cliente_sucessoes_chaves() k WHERE k.chave_antigo = v_kn) THEN" "THEN" ;;
    sem_ambiguo) cv_sabotar "$DECL" "ELSIF v_a.candidatos > 1 THEN" "ELSIF false THEN" ;;
    sem_mesmo_comprador) cv_sabotar "$DECL" "IF v_n.user_id = v_a.user_id THEN" "IF false THEN" ;;
    resolvedor_sem_alias) cv_sabotar 'private.cliente_resolver_documento(text)' \
      "WHERE a.status = 'active' AND a.documento IS NOT NULL" "WHERE false AND a.documento IS NOT NULL" ;;
    previa_sem_alias) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "WHERE a.canonical_user_id = r.user_id AND a.status = 'active')" "WHERE false)" ;;
    sem_gate_revogar) cv_sabotar 'public.cliente_revogar_sucessao(uuid,text,bigint)' "$GATE_GESTOR" "IF false THEN" ;;
    sem_cadeia_recebe) cv_sabotar "$DECL" \
      "IF EXISTS (SELECT 1 FROM private.cliente_sucessoes_chaves() k WHERE k.chave_novo = v_ka)" "IF false" ;;
    sem_evento_unico) cv_sabotar "$DECL" "IF v_ev.tipo <> p_tipo OR v_ev.data_corte <> p_data_corte THEN" "IF false THEN" ;;
    sem_imutavel) P -v ON_ERROR_STOP=1 -q -c "DROP TRIGGER cliente_sucessoes_imutavel_trg ON public.cliente_sucessoes" ;;
    vigentes_sem_corte) cv_sabotar 'private.cliente_sucessoes_vigentes(date)' \
      "WHEN p_hoje IS NULL OR s.data_corte > p_hoje THEN 'corte_futuro'" "WHEN false THEN 'corte_futuro'" ;;
    previa_fuso) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)" "COALESCE(so.order_date_kpi, so.created_at::date)" ;;
    previa_zero) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "'pedidos_antes', CASE WHEN r.user_id IS NULL THEN NULL ELSE" "'pedidos_antes', CASE WHEN false THEN NULL ELSE" ;;
    anon_executa) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $DECL TO anon" ;;
    declara_chave_documento) cv_sabotar "$DECL" "v_kn := COALESCE(v_n.user_id::text, 'doc:' || v_novo);" "v_kn := 'doc:' || v_novo;" ;;
    evento_por_documento) cv_sabotar "$DECL" "WHERE v_ka = k.chave_antigo" "WHERE k.antigo_documento = v_antigo" ;;
    resolvedor_sem_profile) cv_sabotar 'private.cliente_resolver_documento(text)' \
      "EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = c.uid)" "true" ;;
    resolvedor_sem_encadeado) cv_sabotar 'private.cliente_resolver_documento(text)' \
      "WHERE x.alias_user_id = c.uid AND x.status = 'active')" "WHERE false)" ;;
    vigentes_sem_invalido) cv_sabotar 'private.cliente_sucessoes_vigentes(date)' \
      "WHEN s.antigo_user_id IS NULL THEN 'antigo_cadastro_invalido'" "WHEN false THEN 'antigo_cadastro_invalido'" ;;
    vigentes_sem_cadeia) cv_sabotar 'private.cliente_sucessoes_vigentes(date)' \
      "AND (o.chave_novo = s.chave_antigo OR o.chave_antigo = s.chave_novo)) THEN 'cadeia'" "AND false) THEN 'cadeia'" ;;
    vigentes_sem_duplicada) cv_sabotar 'private.cliente_sucessoes_vigentes(date)' \
      "AND o.chave_antigo = s.chave_antigo AND o.chave_novo = s.chave_novo) THEN 'duplicada'" "AND false) THEN 'duplicada'" ;;
    vigentes_sem_evento) cv_sabotar 'private.cliente_sucessoes_vigentes(date)' \
      "AND (o.evento_id, o.tipo, o.data_corte) IS DISTINCT FROM (s.evento_id, s.tipo, s.data_corte))" "AND false)" ;;
    sem_porta) cv_sabotar 'private.cliente_sucessoes_imutavel()' \
      "IF current_setting('cliente_sucessoes.porta', true) IS DISTINCT FROM 'rpc' THEN" "IF false THEN" ;;
    revogar_sem_motivo) cv_sabotar 'private.cliente_sucessoes_imutavel()' \
      "OR NEW.revogado_motivo IS NULL OR length(btrim(NEW.revogado_motivo)) = 0" "OR false" ;;
    nasce_revogada) cv_sabotar 'private.cliente_sucessoes_imutavel()' \
      "IF NEW.revogado_em IS NOT NULL OR NEW.revogado_por IS NOT NULL OR NEW.revogado_motivo IS NOT NULL THEN" "IF false THEN" ;;
    service_role_escreve) P -v ON_ERROR_STOP=1 -q -c "GRANT INSERT ON TABLE public.cliente_sucessoes TO service_role" ;;
    previa_item_qualquer) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "WHERE oi.sales_order_id = so.id AND oi.omie_codigo_produto IS NOT NULL AND oi.quantity > 0)" "WHERE oi.sales_order_id = so.id)" ;;
    previa_sem_itens) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "WHERE oi.sales_order_id = so.id AND" "WHERE true OR oi.sales_order_id = so.id AND" ;;
    previa_preco_aninhado) cv_sabotar 'private.cliente_sucessao_previa_lado(text,date)' \
      "'estimada', x.estimada," "'estimada', x.estimada, 'preco_unit', 1," ;;
    selo_valor) cv_sabotar 'public.cliente_sucessoes_do_documento(text)' "'tipo', s.tipo," "'tipo', s.tipo, 'valor_total', 0," ;;
    *) echo "SABOTAGEM desconhecida: $1"; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelhos>[:<ids que têm de seguir verdes>]
SABOTAGENS="sem_gate_declarar:A1,A2:A4
sem_gate_previa:A4:A1
selo_aberto:A5,A6:A7
sem_trava:J1:D3
sem_versao:D3:D1
sem_versao_revogar:G3:A8
sem_cadeia:F2:F1
sem_cadeia_recebe:F1:F2
sem_ambiguo:C2:C3
sem_mesmo_comprador:C4:C1
resolvedor_sem_alias:C2,C3,C4:C5
previa_sem_alias:I1:I2
sem_gate_revogar:A8:A1
sem_evento_unico:D5:D4
sem_imutavel:H1,H2,H3:H4
vigentes_sem_corte:E6:E7
previa_fuso:I1,I2,I4:I3
previa_zero:I6:I1
anon_executa:A3:A1
declara_chave_documento:D9,F2,F6:F1
evento_por_documento:D10:D4
resolvedor_sem_profile:C7,C9:C8
resolvedor_sem_encadeado:C8:C7
vigentes_sem_invalido:L5:L1
vigentes_sem_cadeia:L1,L2:L3
vigentes_sem_duplicada:L4:L3
vigentes_sem_evento:L3:L4
sem_porta:H6,H10:H8
revogar_sem_motivo:H7:H2
nasce_revogada:H9:H6
service_role_escreve:H8:H6
previa_item_qualquer:I1:I3
previa_sem_itens:I1:I3
previa_preco_aninhado:I5:I8
selo_valor:I5:I8"

rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ────────────────────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: o controle roda primeiro e, vermelho, aborta antes
# da primeira sabotagem.
echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_|SABOTAGEM' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
