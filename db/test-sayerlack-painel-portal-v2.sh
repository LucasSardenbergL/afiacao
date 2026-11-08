#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261109100000_sayerlack_painel_portal_v2.sql (Onda 6, Sessão B)   ║
# ║  Card do portal: "nada pendente" só com rodada efetiva do modo importar, espera, ║
# ║  dedupe por protocolo, cancelado_humano fora, pedidos do app incluídos, totais,  ║
# ║  sensor de alíquota, cancelados no portal; gate; falsificação.                   ║
# ║      bash db/test-sayerlack-painel-portal-v2.sh > /tmp/t.log 2>&1; echo $?       ║
# ║  2º locale (lição #1483):                                                       ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-painel-portal-v2.sh           ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5476}"
SLUG="sayerlack-painel-portal-v2"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
SAB="$TMPD/sabotada.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG="$REPO_ROOT/supabase/migrations/20261109100000_sayerlack_painel_portal_v2.sql"
[ -f "$MIG" ] || { echo "INFRA: ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
P()  { PGOPTIONS='-c client_min_messages=error' "$PGBIN/psql" -X -v VERBOSITY=default -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$(Pq -c "SHOW lc_messages")" "$HARNESS_LC"

# ZONA 1 — stubs mínimos do schema de prod (só as colunas que a RPC lê).
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role IN ('employee','master'))
$f$;
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL, origem text, iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz, status text NOT NULL, detalhes jsonb
);
CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text NOT NULL DEFAULT 'OBEN', status text NOT NULL, status_envio_portal text NOT NULL DEFAULT 'sucesso_portal',
  portal_protocolo text, importado_portal_em timestamptz, importado_portal_por uuid, enviado_portal_em timestamptz,
  omie_pedido_compra_id text, omie_pedido_compra_numero text, valor_total numeric,
  portal_situacao_codigo text, portal_situacao_texto text, portal_situacao_em timestamptz
);
CREATE TABLE public.sayerlack_varredura_falha (
  protocolo text PRIMARY KEY, mensagem text, primeira_em timestamptz DEFAULT now(), ultima_em timestamptz DEFAULT now(),
  tentativas integer DEFAULT 1, notificado_em timestamptz, resolvido_em timestamptz
);
CREATE TABLE public.sku_fornecedor_externo (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, sku_omie text, ativo boolean);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, ncm text);
CREATE TABLE public.ipi_aliquota_ncm (ncm text PRIMARY KEY, aliquota_pct numeric);
-- A postcondição executa o corpo como alguém de compras.
INSERT INTO public.user_roles VALUES ('11111111-1111-1111-1111-111111111111', 'employee'), ('22222222-2222-2222-2222-222222222222', 'customer');
-- Chamador: devolve o JSON, ou ERR_<SQLSTATE> (só a SQLSTATE esperada vira resultado; o resto RE-LANÇA).
CREATE OR REPLACE FUNCTION public.painel_como(p_uid text) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
BEGIN
  PERFORM set_config('test.uid', coalesce(p_uid, ''), true);
  RETURN public.sayerlack_painel_portal()::text;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 'ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.painel_como(text) TO PUBLIC;
SQL

P -q -f "$MIG"
eq "M0 a migration aplica e é re-aplicável (postcondição verde na 2ª colada)" "$(P -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"

U="'11111111-1111-1111-1111-111111111111'"
J() { Pq -c "SELECT (public.painel_como($U)::jsonb) $1"; }

echo "── gate ──"
eq "G1 sem auth.uid: 42501" "$(Pq -c "SELECT public.painel_como(NULL)")" "ERR_42501"
eq "G2 customer (sem cap_compras_ler): 42501" "$(Pq -c "SELECT public.painel_como('22222222-2222-2222-2222-222222222222')")" "ERR_42501"
eq "G3 anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.sayerlack_painel_portal()','EXECUTE')")" "f"
eq "G4 PUBLIC sem EXECUTE" "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid='public.sayerlack_painel_portal()'::regprocedure AND a.grantee=0")" "0"
eq "G5 authenticated com EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','public.sayerlack_painel_portal()','EXECUTE')")" "t"

echo "── banco vazio: nada pendente, mas SEM rodada (não é verde) ──"
eq "V1 versão 2 e pendentes_unicos 0" "$(J "->>'versao'")/$(J "->>'pendentes_unicos'")" "2/0"
eq "V2 sem rodada efetiva → em_dia false, ultima_efetiva null" "$(J "->'rodada'->>'em_dia'")/$(J "->'rodada'->'ultima_efetiva'")" "false/null"
eq "V3 chaves do v1 seguem listas (front antigo não quebra)" "$(J "->'pendencias'")/$(J "->'sem_po'")/$(J "->'importados'")" "[]/[]/[]"

echo "── rodada efetiva = modo importar com prova ──"
seed_rodadas() {
P -q <<'SQL'
TRUNCATE public.acoes_execucoes;
-- listar recente com prova ok: NÃO conta (B9 — ler o portal não é importar).
INSERT INTO public.acoes_execucoes (acao, iniciado_em, finalizado_em, status, detalhes) VALUES
 ('reposicao.varrer_portal_sayerlack', now() - interval '5 minutes', now() - interval '4 minutes', 'sucesso',
  '{"modo":"listar","prova_leitura":"ok","lidos":9}');
SQL
}
seed_rodadas
eq "R1 só listar recente → sem rodada efetiva" "$(J "->'rodada'->>'em_dia'")/$(J "->'rodada'->'ultima_efetiva'")" "false/null"
P -q <<'SQL'
-- importar antigo (6 dias) com prova: efetiva, mas fora do dia exigido.
INSERT INTO public.acoes_execucoes (acao, iniciado_em, finalizado_em, status, detalhes) VALUES
 ('reposicao.varrer_portal_sayerlack', now() - interval '6 days', now() - interval '6 days', 'sucesso',
  '{"modo":"importar","prova_leitura":"ok","lidos":4,"adiados":[],"indeterminados":[]}');
SQL
eq "R2 efetiva de 6 dias atrás → existe mas em_dia false" "$(J "->'rodada'->'ultima_efetiva'->>'lidos'")/$(J "->'rodada'->>'em_dia'")" "4/false"
P -q <<'SQL'
-- importar recente SEM prova (total não anunciado): não conta; erro é a última decidida.
INSERT INTO public.acoes_execucoes (acao, iniciado_em, finalizado_em, status, detalhes) VALUES
 ('reposicao.varrer_portal_sayerlack', now() - interval '3 hours', now() - interval '3 hours', 'erro',
  '{"modo":"importar","prova_leitura":"total_nao_anunciado","causa_pre_protocolo":"prova:total_nao_anunciado","erro":"sem total"}');
SQL
eq "R3 rodada sem prova não é efetiva; a última (erro) aparece com a causa" \
  "$(J "->'rodada'->>'em_dia'")/$(J "->'rodada'->'ultima'->>'status'")/$(J "->'rodada'->'ultima'->>'causa'")" "false/erro/prova:total_nao_anunciado"
P -q <<'SQL'
-- importar recente COM prova e com espera: efetiva e em dia.
INSERT INTO public.acoes_execucoes (acao, iniciado_em, finalizado_em, status, detalhes) VALUES
 ('reposicao.varrer_portal_sayerlack', now() - interval '2 hours', now() - interval '2 hours', 'sucesso',
  '{"modo":"importar","prova_leitura":"ok","lidos":7,"importados":[{"p":1}],"falhas":[],"adiados":["1","2"],"indeterminados":[{"protocolo":"3"}],
    "carencia_presa":[{"protocolo":"4"}],"contagem":{"ja_no_app":3,"carencia_primeira_vista":2,"carencia_aguarda_sync":1}}');
SQL
eq "R4 importar com prova recente → em_dia true" "$(J "->'rodada'->>'em_dia'")/$(J "->'rodada'->'ultima_efetiva'->>'lidos'")" "true/7"
eq "R5 espera da efetiva: adiados/indeterminados/carência/carência presa/importados" \
  "$(J "->'rodada'->'ultima_efetiva'->>'adiados'")/$(J "->'rodada'->'ultima_efetiva'->>'indeterminados'")/$(J "->'rodada'->'ultima_efetiva'->>'carencia'")/$(J "->'rodada'->'ultima_efetiva'->>'carencia_presa'")/$(J "->'rodada'->'ultima_efetiva'->>'importados'")" "2/1/3/1/1"
eq "R6 a última decidida agora é a efetiva (sucesso), não o erro de antes" "$(J "->'rodada'->'ultima'->>'status'")" "sucesso"
P -q <<'SQL'
-- legado (sem prova_leitura, sucesso, lidos>0, sem modo) conta; legado sem lista de adiados → null (ausente ≠ zero).
TRUNCATE public.acoes_execucoes;
INSERT INTO public.acoes_execucoes (acao, iniciado_em, finalizado_em, status, detalhes) VALUES
 ('reposicao.varrer_portal_sayerlack', now() - interval '1 hour', now() - interval '1 hour', 'sucesso', '{"lidos":6}'),
 ('reposicao.varrer_portal_sayerlack', now() - interval '10 minutes', now() - interval '10 minutes', 'sucesso', '{"modo":"importar","pulado":"portal_fechado"}');
SQL
eq "R7 legado com lidos>0 é efetiva; sem lista → espera null" "$(J "->'rodada'->>'em_dia'")/$(J "->'rodada'->'ultima_efetiva'->'adiados'")/$(J "->'rodada'->'ultima_efetiva'->'carencia'")" "true/null/null"
eq "R8 rodada pulada aparece como a última, com o motivo" "$(J "->'rodada'->'ultima'->>'pulado'")" "portal_fechado"
P -q -c "TRUNCATE public.acoes_execucoes; INSERT INTO public.acoes_execucoes (acao, status, detalhes) VALUES ('reposicao.varrer_portal_sayerlack','sucesso','{\"lidos\":0}')"
eq "R9 legado com 0 lidos (o incidente de 23/10) não é efetiva" "$(J "->'rodada'->'ultima_efetiva'")" "null"

echo "── pedidos: app incluído, espera de 1 h, cancelado_humano fora, cancelados no portal ──"
seed_pedidos() {
P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido, public.sayerlack_varredura_falha;
INSERT INTO public.pedido_compra_sugerido (id, status, portal_protocolo, importado_portal_em, enviado_portal_em, omie_pedido_compra_id, omie_pedido_compra_numero, portal_situacao_codigo, portal_situacao_texto, portal_situacao_em) VALUES
 (1, 'aprovado_aguardando_disparo', '7000001', NULL, now() - interval '3 hours', NULL, NULL, '1', 'Aberto', now()),   -- do APP, sem PO, > 1 h
 (2, 'aprovado_aguardando_disparo', '7000002', NULL, now() - interval '10 minutes', NULL, NULL, NULL, NULL, NULL),  -- do app, < 1 h: espera
 (3, 'falha_envio', '7000003', now() - interval '2 days', now() - interval '2 days', '0', NULL, NULL, NULL, NULL),  -- importado, PO '0' = sem PO
 (4, 'cancelado_humano', '7000004', NULL, now() - interval '3 days', NULL, NULL, NULL, NULL, NULL),             -- cancelado à mão: fora
 (5, 'aprovado_aguardando_disparo', '7000005', NULL, now() - interval '5 hours', NULL, NULL, '6', 'Cancelado', now()), -- cancelado no portal, sem PO
 (6, 'disparado', '7000006', NULL, now() - interval '5 days', '9991', '1291', '6', 'Cancelado', now()),             -- cancelado no portal COM PO
 (7, 'disparado', '7000007', now() - interval '1 day', now() - interval '1 day', '9992', '1292', '3', 'Atendido Total', now()), -- ok
 (8, 'cancelado', '7000008', NULL, now() - interval '5 days', NULL, NULL, NULL, NULL, NULL);                     -- cancelado: fora
INSERT INTO public.sayerlack_varredura_falha (protocolo, mensagem, tentativas, resolvido_em) VALUES
 ('7000001', 'disparo falhou', 3, NULL),        -- mesmo protocolo do pedido 1: vai DENTRO da linha (dedupe)
 ('8000001', 'NCM sem alíquota', 2, NULL),      -- só pendência
 ('8000002', 'já resolvido', 1, now());          -- resolvido: fora
SQL
}
seed_pedidos
eq "P1 sem PO: pedido do app (>1 h) e importado com PO '0'; nunca cancelado_humano/cancelado/cancelado no portal" "$(J "->'sem_po'" | python3 -c 'import json,sys; print(",".join(str(x["pedido_id"])+":"+x["origem"] for x in json.load(sys.stdin)))')" "1:app,3:importado"
eq "P2 pedido do app com < 1 h fica em espera, não em pendência" "$(J "->'aguardando_disparo'->>'total'")" "1"
eq "P3 dedupe: a falha do protocolo do pedido 1 vai na linha dele" "$(J "->'sem_po'" | python3 -c 'import json,sys; d={x["pedido_id"]:x for x in json.load(sys.stdin)}; print(d[1]["pendencia_mensagem"], d[1]["pendencia_tentativas"])')" "disparo falhou 3"
eq "P4 pendências: só o protocolo sem linha de pedido (e não o resolvido)" "$(J "->'pendencias'" | python3 -c 'import json,sys; print(",".join(x["protocolo"] for x in json.load(sys.stdin)))')/$(J "->>'total_pendencias'")" "8000001/1"
eq "P5 cancelado no portal sem PO e com PO, cada um na sua lista" "$(J "->'cancelado_sem_po'->0->>'pedido_id'")/$(J "->'cancelado_com_po'->0->>'omie_numero'")/$(J "->>'total_cancelado_sem_po'")/$(J "->>'total_cancelado_com_po'")" "5/1291/1/1"
eq "P6 pendentes_unicos = protocolos distintos (8000001, 7000001, 7000003, 7000005, 7000006)" "$(J "->>'pendentes_unicos'")" "5"
eq "P7 totais acompanham as listas" "$(J "->>'total_sem_po'")" "2"

echo "── truncamento visível ──"
P -q -c "INSERT INTO public.sayerlack_varredura_falha (protocolo, mensagem) SELECT (9000000+g)::text, 'x' FROM generate_series(1,60) g"
eq "T1 lista com teto 50, total sem teto" "$(J "->'pendencias'" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')/$(J "->>'total_pendencias'")" "50/61"

echo "── sensor de alíquota (6.8) ──"
P -q <<'SQL'
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, ativo) VALUES
 ('OBEN', 'RENNER SAYERLACK S/A', '100', true), ('OBEN', 'RENNER SAYERLACK S/A', '101', true),
 ('OBEN', 'RENNER SAYERLACK S/A', '102', false), ('OBEN', 'OUTRO', '103', true);
INSERT INTO public.omie_products VALUES (100, 'oben', '3209.10.10'), (101, 'oben', '32110000'), (102, 'oben', '27101230'), (103, 'oben', '27101230');
INSERT INTO public.ipi_aliquota_ncm VALUES ('32110000', 6.5);
SQL
eq "A1 SKU Sayerlack ativo sem alíquota (inativo e outro fornecedor não contam)" "$(J "->'sem_aliquota'->>'skus'")/$(J "->'sem_aliquota'->'ncms'->>0")" "1/32091010"

echo "── falsificação (uma camada por vez; controle verde antes e depois) ──"
restaura() { P -q -f "$MIG" >/dev/null; }
sabota() { # $1 = expressão sed · $2 = rótulo
  sed -e "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then bad "$2: sabotagem NÃO casou — falsificação seria teatro"; return 1; fi
  P -q -f "$SAB" >/dev/null
}
eq "FC0 controle antes: dedupe e cancelado_humano corretos" "$(J "->>'pendentes_unicos'")" "65"
if sabota "s/^     AND COALESCE(ae.detalhes ->> 'modo', 'importar') = 'importar'$/     AND true/" "F1"; then
  seed_rodadas
  eq "F1 sem o filtro de modo, a rodada listar vira efetiva (o assert R1 pega)" "$(J "->'rodada'->>'em_dia'")" "true"
fi
restaura
if sabota "s/'expirado_sem_aprovacao', 'cancelado_humano')/'expirado_sem_aprovacao')/" "F2"; then
  eq "F2 sem excluir cancelado_humano, ele vira 'sem PO' (o assert P1 pega)" "$(J "->>'total_sem_po'")" "3"
fi
restaura
if sabota "s/^    pend AS (SELECT f.\* FROM falhas f WHERE f.protocolo NOT IN (SELECT protocolo FROM com_linha)),$/    pend AS (SELECT f.* FROM falhas f),/" "F3"; then
  eq "F3 sem o dedupe, o protocolo do pedido 1 aparece também em pendências (o P4 pega)" "$(J "->>'total_pendencias'")" "62"
fi
restaura
if sabota "s/^  IF auth.uid() IS NULL OR NOT private.cap_compras_ler(auth.uid()) THEN$/  IF false THEN/" "F4"; then
  eq "F4 sem o gate, customer lê o painel (o G2 pega)" "$(Pq -c "SELECT public.painel_como('22222222-2222-2222-2222-222222222222') LIKE 'ERR_%'")" "f"
fi
restaura
sed -e "s/^      'sem_aliquota', (SELECT jsonb_build_object('skus', a.skus, 'ncms', a.ncms) FROM aliq a)$/      'sem_aliq', 1/" "$MIG" > "$SAB"
if cmp -s "$MIG" "$SAB"; then
  bad "F5 sabotagem NÃO casou o contrato — falsificação seria teatro"
elif P -q -f "$SAB" >/dev/null 2>"$SAB.err"; then
  bad "F5 postcondição NÃO abortou com a chave faltando"
else
  F5="$(grep -oE '(ERROR|ERRO):  .*' "$SAB.err" | head -1 || true)"
  case "$F5" in
    "ERROR:  P6 FALHOU: contrato v2 sem a chave sem_aliquota"|"ERRO:  P6 FALHOU: contrato v2 sem a chave sem_aliquota")
      ok "F5 postcondição aborta o apply quando o contrato perde uma chave" ;;
    *) bad "F5 ERRO ALHEIO à postcondição — veio [${F5:-<nenhuma linha ERROR>}]" ;;
  esac
fi
restaura
eq "FC1 controle depois: gate volta" "$(Pq -c "SELECT public.painel_como('22222222-2222-2222-2222-222222222222')")" "ERR_42501"
eq "FC2 controle depois: contrato e dedupe voltam" "$(J "->>'total_pendencias'")/$(J "->>'total_sem_po'")" "61/2"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
