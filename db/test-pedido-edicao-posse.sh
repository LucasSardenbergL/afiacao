#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Prova PG17 da migration 20261127120100_pedido_edicao_omie_posse_duravel.sql
# (posse durável da edição de pedido com PV no Omie — revisão /sales, leva 1, PR 2).
#
#   bash db/test-pedido-edicao-posse.sh                       → suíte (locale C)
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-pedido-edicao-posse.sh
#   bash db/test-pedido-edicao-posse.sh --falsificar          → controle verde + cada sabotagem (uma camada
#                                                               por vez), nos DOIS locales (C e pt_BR.UTF-8)
#
# Fixture = PROD no pré-voo (psql-ro 2026-11-27): a aplicar_edicao_pedido_omie de 8 args VIVA
# (db/fixtures/aplicar-edicao-pedido-omie-8args-prod.sql), o trigger de updated_at em todo UPDATE,
# has_role(uuid, app_role). As RPCs sob teste são as REAIS da migration.
# Corridas com DUAS sessões reais (a 2ª espera o lock da 1ª — conferido em pg_stat_activity).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_REAL="$REPO_ROOT/supabase/migrations/20261127120100_pedido_edicao_omie_posse_duravel.sql"
FIX_8ARGS="$REPO_ROOT/db/fixtures/aplicar-edicao-pedido-omie-8args-prod.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="indice_comum:A0 indice_comum_sem_post:R2 sem_versao:R4 sem_excluido:R5 sem_expirar:R9
    sem_token_encerrado:E2 despacho_sem_gemeo:D3 despacho_sem_ttl:D5 despacho_sem_bump:D2b
    liberar_despachada:L2 marcar_sobre_concluida:W4 aplicar_sem_deleted:W2 aplicar_sem_token:W1
    aplicar_nao_conclui:W3b excluir_sem_edicao:X1 excluir_sem_identidade:X2 trigger_sem_filtro:S1
    trigger_invoker:S1 estado_sem_gate:G1 resolver_sem_master:V1 resolver_sem_token:V2
    resolver_sem_bump:V4 encerrar_sem_cancelar:E4 lapide_outro_token:E2 grant_vaza_sem_post:G3
    regua_100min:A0 revisao_sem_posse:Q2 allowlist_fora_sem_post:G7 excluir_sem_gemeo:X5"
  LOGDIR="$(mktemp -d "/tmp/falsifica-pedido-edicao-posse.XXXXXX")"
  falhas=0; vermelhas=0
  for loc in C pt_BR.UTF-8; do
    echo "== CONTROLE ($loc) =="
    if ! LOCALE_TESTE="$loc" SABOTAGEM="" bash "$0" > "$LOGDIR/controle-$loc.log" 2>&1; then
      echo "CONTROLE VERMELHO em $loc — falsificacao abortada (log: $LOGDIR/controle-$loc.log)"
      tail -25 "$LOGDIR/controle-$loc.log"; exit 1
    fi
    grep -q '^TESTE_PEDIDO_EDICAO_POSSE_OK$' "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) sem marcador de fim"; exit 1; }
    grep -q "^LOCALE_ATIVO=$loc\$" "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) nao rodou no locale pedido"; exit 1; }
    echo "controle verde em $loc ($(grep -c '^  OK ' "$LOGDIR/controle-$loc.log") OK)"
    for par in $SABOTAGENS; do
      s="${par%%:*}"; a="${par#*:}"
      log="$LOGDIR/$s-$loc.log"
      if LOCALE_TESTE="$loc" SABOTAGEM="$s" bash "$0" > "$log" 2>&1; then
        echo "XX $s ($loc): suite ficou VERDE"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "^SABOTAGEM ATIVA: $s\$" "$log"; then
        echo "XX $s ($loc): sabotagem NAO aplicou (log: $log)"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "^  FAIL $a " "$log"; then
        echo "XX $s ($loc): vermelho, mas NAO no assert $a (log: $log)"; falhas=$((falhas+1)); continue
      fi
      vermelhas=$((vermelhas+1))
      echo "ok $s ($loc) -> vermelho em $a"
    done
  done
  echo "SABOTAGENS: $vermelhas vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] || exit 1
  echo "FALSIFICACAO_PEDIDO_EDICAO_POSSE_OK"
  exit 0
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5547}"
SLUG="pedido-edicao-posse-$$"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# ── Cópia da migration (a sabotagem só mexe na cópia) ──
MIG="$TMPD/mig.sql"
cp "$MIG_REAL" "$MIG"
sab() { sed -i.bak "$1" "$MIG"; rm -f "$MIG.bak"; }
# Antes do bloco PÓS: o GRANT sabotado entra DEPOIS dos REVOKEs da migration.
antes_do_post() { awk -v ins="$1" '/^DO \$post\$/ && !feito { print ins; feito=1 } { print }' "$MIG" > "$MIG.n" && mv "$MIG.n" "$MIG"; }
case "${SABOTAGEM:-}" in
  "") ;;
  indice_comum)           sab 's/^CREATE UNIQUE INDEX IF NOT EXISTS uq_pedido_edicao_omie_tentativa_viva_por_pv/CREATE INDEX IF NOT EXISTS uq_pedido_edicao_omie_tentativa_viva_por_pv/' ;;
  indice_comum_sem_post)  sab 's/^CREATE UNIQUE INDEX IF NOT EXISTS uq_pedido_edicao_omie_tentativa_viva_por_pv/CREATE INDEX IF NOT EXISTS uq_pedido_edicao_omie_tentativa_viva_por_pv/'
                          sab "s/RAISE EXCEPTION 'A3 FALHOU/RAISE NOTICE 'A3 FALHOU/" ;;
  sem_versao)             sab 's/^  IF v_versao IS DISTINCT FROM p_versao THEN$/  IF false THEN/' ;;
  sem_excluido)           sab '/pedido_edicao_omie_reivindicar(/,/^\$\$;/ s/^  IF v_excluido IS NOT NULL THEN$/  IF false THEN/' ;;
  sem_expirar)            sab "s/^     SET desfecho = 'expirada', desfecho_em = now()$/     SET motivo = motivo/" ;;
  sem_token_encerrado)    sab 's/^  IF EXISTS (SELECT 1 FROM public.pedido_edicao_omie_tentativa WHERE token = p_token) THEN$/  IF false THEN/' ;;
  despacho_sem_gemeo)     sab 's/^  IF v_gemeo_achou IS DISTINCT FROM p_gemeo_presente$/  IF false/'
                          sab 's/^     OR (v_gemeo_achou AND v_gemeo_status IS DISTINCT FROM p_gemeo_status) THEN$/     AND false THEN/' ;;
  despacho_sem_ttl)       sab "s/^     AND reivindicada_em >= clock_timestamp() - interval '10 minutes';$/     AND true;/" ;;
  despacho_sem_bump)      sab '/pedido_edicao_omie_despachar(/,/^\$\$;/ s/^  UPDATE public.sales_orders SET updated_at = now() WHERE id = p_sales_order_id;$/  NULL;/' ;;
  liberar_despachada)     sab 's/^   WHERE token = p_token AND despachada_em IS NULL AND desfecho IS NULL;$/   WHERE token = p_token AND desfecho IS NULL;/' ;;
  marcar_sobre_concluida) sab 's/^   WHERE token = p_token AND despachada_em IS NOT NULL AND desfecho IS NULL;$/   WHERE token = p_token AND despachada_em IS NOT NULL;/' ;;
  aplicar_sem_deleted)    sab '/p_token          uuid$/,/^\$\$;/ s/^  IF v_excluido IS NOT NULL THEN$/  IF false THEN/' ;;
  aplicar_sem_token)      sab 's/^    WHERE token = p_token$/    WHERE true/' ;;
  aplicar_nao_conclui)    sab "s/^     SET desfecho = 'concluida', desfecho_em = now()$/     SET motivo = motivo/" ;;
  excluir_sem_edicao)     sab "s/^    RETURN 'edicao_em_curso';$/    NULL;/" ;;
  excluir_sem_identidade) sab 's/^  IF v_conta IS DISTINCT FROM p_account OR v_pv IS DISTINCT FROM p_omie_pedido_id THEN$/  IF false THEN/' ;;
  trigger_sem_filtro)     sab 's/^     WHERE t.sales_order_id = OLD.id$/     WHERE false/' ;;
  trigger_invoker)        sab '/sales_orders_exclusao_respeita_edicao()$/,/^AS \$\$$/ s/^SECURITY DEFINER$/SECURITY INVOKER/' ;;
  estado_sem_gate)        sab 's/^  PERFORM public.pedido_edicao_omie_exige_equipe(false);$/  NULL;/' ;;
  resolver_sem_master)    sab 's/pedido_edicao_omie_exige_equipe(true);$/pedido_edicao_omie_exige_equipe(false);/' ;;
  resolver_sem_token)     sab 's/^   WHERE t.token = p_token$/   WHERE true/' ;;
  resolver_sem_bump)      sab '/pedido_edicao_omie_resolver(p_sales_order_id uuid, p_token uuid)$/,/^\$\$;/ s/^  UPDATE public.sales_orders SET updated_at = now() WHERE id = p_sales_order_id;$/  NULL;/' ;;
  encerrar_sem_cancelar)  sab "s/^       SET desfecho = 'abandonada', desfecho_em = now(), motivo = 'encerrado pela tela antes do despacho'$/       SET motivo = motivo/" ;;
  lapide_outro_token)     sab "s/^    VALUES (p_token, v_conta, v_pv, p_sales_order_id, v_uid, now(), 'abandonada'/    VALUES (gen_random_uuid(), v_conta, v_pv, p_sales_order_id, v_uid, now(), 'abandonada'/" ;;
  grant_vaza_sem_post)    antes_do_post 'GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid) TO authenticated;'
                          sab "s/RAISE EXCEPTION 'A6 FALHOU/RAISE NOTICE 'A6 FALHOU/" ;;
  revisao_sem_posse)      sab '/pedido_edicao_omie_registrar_revisao($/,/^\$\$;/ s/^  IF NOT FOUND THEN$/  IF false THEN/' ;;
  allowlist_fora_sem_post) sab "s/AND a.grantee::regrole::text NOT IN ('service_role', 'claude_ro') LOOP/AND false LOOP/"
                          sab "s/RAISE EXCEPTION 'A10 FALHOU/RAISE NOTICE 'A10 FALHOU/" ;;
  excluir_sem_gemeo)      sab 's/^  IF v_pv IS NOT NULL THEN$/  IF false THEN/' ;;
  regua_100min)           sab "/FUNCTION public.pedido_edicao_omie_situacao(/,/^\$\$;/ s/interval '10 minutes'/interval '100 minutes'/g" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "sabotagem $SABOTAGEM nao alterou a copia"; exit 2; fi
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

# lc_messages=C: em pt_BR o prefixo vira "ERRO:" — a sentinela de SQLSTATE é ASCII fixa nos 2 locales.
export PGOPTIONS="-c lc_messages=C"
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d postgres -q -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -At "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# Como service_role (a edge).
SR() { Pq -c "SET ROLE service_role" -c "$1"; }
# Como authenticated com auth.uid() = $1.
AU() { Pq -c "SET test.uid = '$1'" -c "SET ROLE authenticated" -c "$2"; }
# SQLSTATE do erro (ou SEM_ERRO). $1 = papel (service_role|authenticated|anon), $2 = uid, $3 = SQL.
estado_sql() {
  local saida
  if saida="$(P -v VERBOSITY=verbose -c "SET test.uid = '$2'" -c "SET ROLE $1" -c "$3" 2>&1)"; then
    echo "SEM_ERRO"
  else
    printf '%s\n' "$saida" | grep -o 'ERROR:  [0-9A-Z]\{5\}' | head -1 | sed 's/ERROR:  //'
  fi
}

echo "LOCALE_ATIVO=$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database()")"

# ── ZONA 1: base Supabase + fixture da PROD ──
P -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  account text,
  omie_pedido_id bigint,
  status text,
  hash_payload text,
  customer_user_id uuid,
  items jsonb,
  subtotal numeric,
  total numeric,
  notes text,
  omie_payload jsonb,
  omie_response jsonb,
  omie_reconciliado_em timestamptz,
  envio_omie_reivindicado_em timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid, customer_user_id uuid, product_id uuid, omie_codigo_produto bigint,
  quantity numeric NOT NULL, unit_price numeric, discount numeric, desconto_valor numeric,
  hash_payload text, omie_codigo_item bigint, created_at timestamptz
);
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql
  AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_orders, public.order_items TO service_role;
GRANT SELECT, UPDATE ON public.sales_orders TO authenticated;
-- PROD: o default ACL de public concede tudo a sandbox_exec* (BYPASSRLS) — o fecho por allowlist tem de tirar.
CREATE ROLE sandbox_exec BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sandbox_exec;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO sandbox_exec;
-- Dependência (não sob teste): a RPC de revisão de crédito VIVA tem esta assinatura (pré-flight 2026-11-27);
-- o stub grava cada chamada para provar se a revisão foi ou não registrada.
CREATE TABLE public.revisoes_registradas (sales_order_id uuid, em timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION public.credito_registrar_revisao(p_sales_order_id uuid, p_company text, p_contexto text,
  p_omie_codigo_cliente bigint, p_codigo_parcela text, p_parcela_origem text, p_itens jsonb, p_user_id uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $f$ BEGIN INSERT INTO public.revisoes_registradas (sales_order_id) VALUES (p_sales_order_id);
            RETURN jsonb_build_object('revisao', gen_random_uuid(), 'seq', 1); END $f$;
REVOKE ALL ON FUNCTION public.credito_registrar_revisao(uuid, text, text, bigint, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credito_registrar_revisao(uuid, text, text, bigint, text, text, jsonb, uuid) TO service_role;
SQL
P -f "$FIX_8ARGS" >/dev/null
P -c "REVOKE ALL ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz) TO service_role;"
# A exclusão antiga (a edge no ar a chama): presença conferida pela PÓS.
P -c "CREATE FUNCTION public.sales_order_excluir_sem_envio(p_sales_order_id uuid, p_somente_orcamento boolean DEFAULT false) RETURNS text LANGUAGE sql AS \$f\$ SELECT 'stub'::text \$f\$;"

# ── ZONA 2: aplica a migration REAL (cópia, talvez sabotada) ──
if P -f "$MIG" > "$TMPD/apply.log" 2>&1; then ok "A0 migration aplica e a postcondicao passa"
else bad "A0 migration aplica — $(grep -m1 'ERROR' "$TMPD/apply.log" || echo sem-erro)"; fi
# A2: o irmão do `db:aplicar` é o MESMO corpo (sem o envelope) — anti-deriva entre os dois caminhos.
IRMAO="$REPO_ROOT/db/2026-11-27-pedido-edicao-omie-posse-duravel.sql"
if [ -z "${SABOTAGEM:-}" ]; then
  if diff -q <(grep -v '^BEGIN;$' "$MIG_REAL" | grep -v '^COMMIT;$') <(tail -n +7 "$IRMAO") >/dev/null; then
    ok "A2 irmao do db:aplicar tem o mesmo corpo da migration"
  else
    bad "A2 irmao do db:aplicar divergiu da migration"
  fi
fi
if P -f "$MIG" > "$TMPD/reapply.log" 2>&1; then ok "A1 re-aplicar e idempotente"
else bad "A1 re-aplicar — $(grep -m1 'ERROR' "$TMPD/reapply.log" || echo sem-erro)"; fi

# ── ZONA 3: seed ──
EMP=11111111-1111-1111-1111-111111111111
MAS=22222222-2222-2222-2222-222222222222
CLI=33333333-3333-3333-3333-333333333333
P <<SQL
INSERT INTO auth.users (id) VALUES ('$EMP'), ('$MAS'), ('$CLI') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES ('$EMP', 'employee'), ('$MAS', 'master'), ('$CLI', 'customer');
SQL
# novo <id> <conta> <pv|NULL> [hash] → cria o pedido do app (recibo)
novo() { P -c "INSERT INTO public.sales_orders (id, account, omie_pedido_id, status, hash_payload, items, subtotal, total)
               VALUES ('$1', '$2', $3, 'enviado', ${4:-NULL}, '[]', 0, 0)"; }
versao() { Pq -c "SELECT updated_at FROM public.sales_orders WHERE id = '$1'"; }
tok() { Pq -c "SELECT gen_random_uuid()"; }
reiv() { SR "SELECT public.pedido_edicao_omie_reivindicar('$1', '$(versao "$1")'::timestamptz, '$2', '$EMP')"; }
desp() { SR "SELECT public.pedido_edicao_omie_despachar('$1', '$2', '$(versao "$1")'::timestamptz, ${3:-false}, ${4:-NULL})"; }
ITEMS='[{"omie_codigo_produto":1,"quantidade":2,"valor_unitario":5,"desconto":0}]'
ITENS='[{"omie_codigo_produto":1,"quantity":2,"unit_price":5,"discount":0}]'
aplicar_sql() { echo "SELECT public.aplicar_edicao_pedido_omie('$1', '$ITEMS', '$ITENS', 10, 'nota', '{}', '{}', now(), '$2')->>'posse'"; }
sit_tok() { Pq -c "SELECT coalesce(desfecho, CASE WHEN despachada_em IS NULL THEN 'sem_desfecho' ELSE 'despachada' END) FROM public.pedido_edicao_omie_tentativa WHERE token = '$1'"; }

A=aaaaaaaa-0000-0000-0000-000000000001     # PV 900 oben (recibo do app)
GA=aaaaaaaa-0000-0000-0000-000000000002    # gêmeo importado do PV 900 (outra linha)
B=aaaaaaaa-0000-0000-0000-000000000003     # PV 901 oben
SEMPV=aaaaaaaa-0000-0000-0000-000000000004
EXC=aaaaaaaa-0000-0000-0000-000000000005
novo "$A" oben 900
novo "$GA" oben 900 "'omie_oben_900'"
novo "$B" oben 901
novo "$SEMPV" oben NULL
novo "$EXC" oben 902
P -c "UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$EXC'"

echo "── reivindicar ──"
T1="$(tok)"
V_ANTES="$(versao "$A")"
eq "R1 reivindica pedido livre" "$(reiv "$A" "$T1")" "reivindicado"
eq "R1b reivindicar NAO move a versao (recusa de credito nao envelhece a tela)" "$(versao "$A")" "$V_ANTES"
eq "R2 2o token no MESMO PV fica em_edicao" "$(reiv "$A" "$(tok)")" "em_edicao"
eq "R3 gemeo do mesmo PV (outra linha) fica em_edicao" "$(reiv "$GA" "$(tok)")" "em_edicao"
eq "R4 versao velha recusa" "$(SR "SELECT public.pedido_edicao_omie_reivindicar('$B', '2000-01-01'::timestamptz, '$(tok)', NULL)")" "pedido_alterado"
eq "R5 pedido excluido recusa" "$(reiv "$EXC" "$(tok)")" "excluido"
eq "R6 sem PV recusa" "$(reiv "$SEMPV" "$(tok)")" "sem_pv"
eq "R7 pedido ausente" "$(SR "SELECT public.pedido_edicao_omie_reivindicar(gen_random_uuid(), now(), gen_random_uuid(), NULL)")" "ausente"
eq "R8 token nulo -> 22023" "$(estado_sql service_role "$EMP" "SELECT public.pedido_edicao_omie_reivindicar('$A', now(), NULL, NULL)")" "22023"

echo "── liberar / expirar ──"
eq "L1 liberar reservada" "$(SR "SELECT public.pedido_edicao_omie_liberar('$T1')")" "t"
T2="$(tok)"
eq "L1b depois de liberar, nova reivindicacao passa" "$(reiv "$A" "$T2")" "reivindicado"
P -c "UPDATE public.pedido_edicao_omie_tentativa SET reivindicada_em = now() - interval '11 minutes' WHERE token = '$T2'"
T3="$(tok)"
eq "R9 reserva vencida (edge morreu antes de despachar) nao segura o PV" "$(reiv "$A" "$T3")" "reivindicado"
eq "R9b a vencida vira expirada" "$(sit_tok "$T2")" "expirada"

echo "── despachar ──"
eq "D1 token errado perde a posse" "$(desp "$A" "$(tok)" true "'enviado'")" "perdeu_posse"
eq "D3 gemeo presente que a edge nao viu -> gemeo_alterado" "$(desp "$A" "$T3" false)" "gemeo_alterado"
eq "D3b status do gemeo diferente -> gemeo_alterado" "$(desp "$A" "$T3" true "'faturado'")" "gemeo_alterado"
V_ANTES="$(versao "$A")"
eq "D2 despacha com o gemeo como lido" "$(desp "$A" "$T3" true "'enviado'")" "despachado"
if [ "$(versao "$A")" != "$V_ANTES" ]; then ok "D2b despacho move a versao do pedido"; else bad "D2b despacho move a versao do pedido — versao igual"; fi
eq "D4 despacho de novo (mesmo token) perde a posse" "$(desp "$A" "$T3" true "'enviado'")" "perdeu_posse"
eq "L2 liberar despachada NAO libera" "$(SR "SELECT public.pedido_edicao_omie_liberar('$T3')")" "f"
eq "L2b despachada segue sem desfecho" "$(sit_tok "$T3")" "despachada"
T4="$(tok)"
eq "D5a reivindica B" "$(reiv "$B" "$T4")" "reivindicado"
P -c "UPDATE public.pedido_edicao_omie_tentativa SET reivindicada_em = now() - interval '11 minutes' WHERE token = '$T4'"
eq "D5 reserva vencida nao despacha (titular vencido sem sucessor)" "$(desp "$B" "$T4")" "perdeu_posse"

echo "── write-back (9 args) ──"
eq "W1 token errado nao grava (55000)" "$(estado_sql service_role "$EMP" "$(aplicar_sql "$A" "$(tok)")")" "55000"
eq "W1b token de OUTRO pedido nao grava (55000)" "$(estado_sql service_role "$EMP" "$(aplicar_sql "$B" "$T3")")" "55000"
eq "W3 write-back com a posse despachada conclui" "$(SR "$(aplicar_sql "$A" "$T3")")" "concluida"
eq "W3b tentativa concluida" "$(sit_tok "$T3")" "concluida"
eq "W3c itens gravados pela funcao de 8 args" "$(Pq -c "SELECT total::text || '/' || notes FROM public.sales_orders WHERE id = '$A'")" "10/nota"
eq "W4 marcar divergente depois do concluido NAO pisa (resposta perdida)" "$(SR "SELECT public.pedido_edicao_omie_marcar_divergente('$T3', 'x')")" "f"
eq "W4b segue concluida" "$(sit_tok "$T3")" "concluida"
eq "W5 depois de concluir, o PV esta livre" "$(reiv "$A" "$(tok)")" "reivindicado"
# pedido excluído no meio da edição (por fora do trigger: postgres)
C=aaaaaaaa-0000-0000-0000-000000000006
novo "$C" colacor 903
T5="$(tok)"; reiv "$C" "$T5" >/dev/null; desp "$C" "$T5" >/dev/null
P -c "ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_exclusao_respeita_edicao; UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$C'; ALTER TABLE public.sales_orders ENABLE TRIGGER trg_sales_orders_exclusao_respeita_edicao;"
eq "W2 pedido excluido durante a edicao nao grava (55000)" "$(estado_sql service_role "$EMP" "$(aplicar_sql "$C" "$T5")")" "55000"
eq "W6 token nulo (22023)" "$(estado_sql service_role "$EMP" "SELECT public.aplicar_edicao_pedido_omie('$A', '$ITEMS', '$ITENS', 10, 'n', '{}', '{}', now(), NULL)")" "22023"

echo "── divergencia ──"
DV=aaaaaaaa-0000-0000-0000-000000000007
novo "$DV" oben 904
T6="$(tok)"; reiv "$DV" "$T6" >/dev/null; desp "$DV" "$T6" >/dev/null
eq "M1 marcar divergente depois do despacho" "$(SR "SELECT public.pedido_edicao_omie_marcar_divergente('$T6', 'Omie recusou o item 2')")" "t"
eq "M2 PV divergente recusa nova edicao" "$(reiv "$DV" "$(tok)")" "divergente"
eq "M3 estado para a equipe: divergente com o token" \
   "$(AU "$EMP" "SELECT (r->>'situacao') || '/' || (r->>'token') || '/' || (r->>'motivo') FROM public.pedido_edicao_omie_estado('$DV') r")" "divergente/$T6/Omie recusou o item 2"
DV2=aaaaaaaa-0000-0000-0000-000000000008
novo "$DV2" oben 905
T7="$(tok)"; reiv "$DV2" "$T7" >/dev/null; desp "$DV2" "$T7" >/dev/null
P -c "UPDATE public.pedido_edicao_omie_tentativa SET reivindicada_em = now() - interval '20 minutes', despachada_em = now() - interval '11 minutes' WHERE token = '$T7'"
eq "M4 despachada ha > 10 min sem desfecho (edge morreu depois do Omie) = divergente" "$(reiv "$DV2" "$(tok)")" "divergente"
eq "V1 employee NAO resolve (42501)" "$(estado_sql authenticated "$EMP" "SELECT public.pedido_edicao_omie_resolver('$DV', '$T6')")" "42501"
eq "V2 master com token de OUTRA divergencia nao resolve" "$(AU "$MAS" "SELECT public.pedido_edicao_omie_resolver('$DV', '$T7')")" "nada_a_resolver"
V_ANTES="$(versao "$DV")"
eq "V3 master resolve a divergencia vista" "$(AU "$MAS" "SELECT public.pedido_edicao_omie_resolver('$DV', '$T6')")" "resolvida"
if [ "$(versao "$DV")" != "$V_ANTES" ]; then ok "V4 resolver move a versao (formulario aberto antes e recusado)"; else bad "V4 resolver move a versao — versao igual"; fi
eq "V5 resolvida libera o PV" "$(reiv "$DV" "$(tok)")" "reivindicado"
eq "V6 resolver de novo: nada a resolver" "$(AU "$MAS" "SELECT public.pedido_edicao_omie_resolver('$DV', '$T6')")" "nada_a_resolver"

echo "── encerrar o envio pela tela (prazo vencido) ──"
EN=aaaaaaaa-0000-0000-0000-000000000009
novo "$EN" oben 906
T8="$(tok)"
eq "E1 token que a edge nunca viu vira lapide" "$(AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$EN', '$T8')")" "abandonada"
eq "E2 a reivindicacao atrasada desse token cai em token_encerrado" "$(reiv "$EN" "$T8")" "token_encerrado"
eq "E2b a lapide nao segura o PV" "$(reiv "$EN" "$(tok)")" "reivindicado"
EN2=aaaaaaaa-0000-0000-0000-000000000010
novo "$EN2" oben 907
T9="$(tok)"; reiv "$EN2" "$T9" >/dev/null
eq "E3 reservada encerrada pela tela vira abandonada" "$(AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$EN2', '$T9')")" "abandonada"
eq "E4 e o despacho desse token nao passa mais" "$(desp "$EN2" "$T9")" "perdeu_posse"
EN3=aaaaaaaa-0000-0000-0000-000000000011
novo "$EN3" oben 908
T10="$(tok)"; reiv "$EN3" "$T10" >/dev/null; desp "$EN3" "$T10" >/dev/null
eq "E5 despachada: encerrar devolve em_voo (a tela espera e consulta de novo)" "$(AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$EN3', '$T10')")" "em_voo"
eq "E5b e nao muda a tentativa" "$(sit_tok "$T10")" "despachada"
eq "E6 concluida: encerrar devolve concluida" "$(AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$A', '$T3')")" "concluida"
eq "E7 token de outro pedido -> 22023" "$(estado_sql authenticated "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$B', '$T3')")" "22023"
eq "E8 cliente nao encerra (42501)" "$(estado_sql authenticated "$CLI" "SELECT public.pedido_edicao_omie_encerrar_envio('$EN3', '$T10')")" "42501"

echo "── exclusão ──"
eq "X1 exclusao conferida com edicao em voo recusa" "$(SR "SELECT public.sales_order_excluir_conferido('$EN3', false, 'oben', 908, false, NULL)")" "edicao_em_curso"
eq "X2 identidade diferente da provada recusa" "$(SR "SELECT public.sales_order_excluir_conferido('$B', false, 'oben', 999, false, NULL)")" "pedido_alterado"
eq "X3 divergente nao segura a exclusao (PV ja cancelado no Omie)" "$(SR "SELECT public.sales_order_excluir_conferido('$DV2', false, 'oben', 905, false, NULL)")" "excluido"
eq "X3b a tentativa divergente fica (sem FK)" "$(sit_tok "$T7")" "despachada"
eq "X4 orcamento: so apaga se ainda e orcamento" "$(SR "SELECT public.sales_order_excluir_conferido('$B', true, 'oben', 901, false, NULL)")" "nao_e_orcamento"
eq "S1 soft-delete do front com edicao em voo -> 55P03" "$(estado_sql authenticated "$EMP" "UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$EN3'")" "55P03"
eq "S2 soft-delete sem edicao em curso passa" "$(estado_sql authenticated "$EMP" "UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$SEMPV'")" "SEM_ERRO"

XG=aaaaaaaa-0000-0000-0000-000000000015
XGG=aaaaaaaa-0000-0000-0000-000000000016
novo "$XG" oben 911
novo "$XGG" oben 911 "'omie_oben_911'"
P -c "UPDATE public.sales_orders SET status = 'enviado' WHERE id = '$XGG'"
eq "X5 gemeo reativado pelo sync depois da prova de cancelamento recusa" "$(SR "SELECT public.sales_order_excluir_conferido('$XG', false, 'oben', 911, true, 'cancelado')")" "gemeo_alterado"
eq "X6 com o gemeo como lido, exclui" "$(SR "SELECT public.sales_order_excluir_conferido('$XG', false, 'oben', 911, true, 'enviado')")" "excluido"
eq "X7 pedido com PV sem o gemeo lido -> 22023" "$(estado_sql service_role "$EMP" "SELECT public.sales_order_excluir_conferido('$B', false, 'oben', 901, NULL, NULL)")" "22023"

echo "── revisão de crédito com posse ──"
RV=aaaaaaaa-0000-0000-0000-000000000017
novo "$RV" oben 912
TR="$(tok)"; reiv "$RV" "$TR" >/dev/null
revisao_sql() { echo "SELECT (public.pedido_edicao_omie_registrar_revisao('$1', '$2', 'oben', 'edicao', 1, '000', 'informada', '[]', NULL)) ? 'revisao'"; }
eq "Q1 tentativa reservada registra a revisao" "$(SR "$(revisao_sql "$TR" "$RV")")" "t"
eq "Q1b uma revisao gravada" "$(Pq -c "SELECT count(*) FROM public.revisoes_registradas WHERE sales_order_id = '$RV'")" "1"
AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$RV', '$TR')" >/dev/null
eq "Q2 tentativa abandonada NAO registra revisao (55000)" "$(estado_sql service_role "$EMP" "$(revisao_sql "$TR" "$RV")")" "55000"
eq "Q2b continua uma revisao so" "$(Pq -c "SELECT count(*) FROM public.revisoes_registradas WHERE sales_order_id = '$RV'")" "1"
eq "Q2c token de outro pedido nao registra (55000)" "$(estado_sql service_role "$EMP" "$(revisao_sql "$TR" "$A")")" "55000"

echo "── papéis e privilégios ──"
eq "G1 cliente nao le o estado (42501)" "$(estado_sql authenticated "$CLI" "SELECT public.pedido_edicao_omie_estado('$A')")" "42501"
eq "G2 anon nao le o estado (42501)" "$(estado_sql anon "$EMP" "SELECT public.pedido_edicao_omie_estado('$A')")" "42501"
eq "G3 authenticated nao reivindica (42501)" "$(estado_sql authenticated "$EMP" "SELECT public.pedido_edicao_omie_reivindicar('$B', now(), gen_random_uuid(), NULL)")" "42501"
eq "G4 authenticated nao le a tabela (42501)" "$(estado_sql authenticated "$EMP" "SELECT count(*) FROM public.pedido_edicao_omie_tentativa")" "42501"
eq "G5 authenticated nao grava write-back (42501)" "$(estado_sql authenticated "$EMP" "$(aplicar_sql "$A" "$T3")")" "42501"
eq "G7 sandbox_exec (BYPASSRLS, default ACL) NAO escreve a tabela (42501)" "$(estado_sql sandbox_exec "$EMP" "UPDATE public.pedido_edicao_omie_tentativa SET desfecho = 'resolvida', desfecho_em = now()")" "42501"
eq "G8 sandbox_exec NAO executa a reivindicacao (42501)" "$(estado_sql sandbox_exec "$EMP" "SELECT public.pedido_edicao_omie_reivindicar('$B', now(), gen_random_uuid(), NULL)")" "42501"
eq "G6 estado de PV livre" "$(AU "$EMP" "SELECT r->>'situacao' FROM public.pedido_edicao_omie_estado('$SEMPV') r")" "livre"

echo "── corridas (duas sessões reais) ──"
# espera_lock <rótulo>: até uma sessão (≠ esta) estar esperando lock com a query que casa o rótulo.
espera() { local _i; for _i in $(seq 1 100); do
  [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND $1")" -ge 1 ] && return 0
  sleep 0.1; done; return 1; }
# K1: reivindicação segura o lock e commita; o soft-delete que esperava vê a tentativa → 55P03.
K=aaaaaaaa-0000-0000-0000-000000000012
novo "$K" oben 909
TK="$(tok)"; VK="$(versao "$K")"
( P -c "BEGIN" -c "SET ROLE service_role" -c "SELECT public.pedido_edicao_omie_reivindicar('$K', '$VK'::timestamptz, '$TK', NULL)" \
    -c "SELECT pg_sleep(1.5) /* k1-segura */" -c "COMMIT" > "$TMPD/k1a.log" 2>&1 ) &
PA=$!
espera "query LIKE '%k1-segura%' AND state = 'active'" || bad "K1 sessao A nao chegou ao sleep"
( estado_sql authenticated "$EMP" "UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$K' /* k1-apaga */" > "$TMPD/k1b.out" ) &
PB=$!
if espera "query LIKE '%k1-apaga%' AND wait_event_type = 'Lock'"; then ok "K1a soft-delete esperou o lock da reivindicacao"; else bad "K1a soft-delete esperou o lock da reivindicacao — nao esperou"; fi
wait "$PA"; wait "$PB"
eq "K1 soft-delete que esperava ve a reivindicacao commitada (55P03)" "$(cat "$TMPD/k1b.out")" "55P03"
# K2: gêmeos do MESMO PV reivindicando ao mesmo tempo — o 2º espera a inserção do 1º e perde.
K2=aaaaaaaa-0000-0000-0000-000000000013
K2G=aaaaaaaa-0000-0000-0000-000000000014
novo "$K2" oben 910
novo "$K2G" oben 910 "'omie_oben_910'"
V2A="$(versao "$K2")"; V2B="$(versao "$K2G")"
( P -c "BEGIN" -c "SET ROLE service_role" -c "SELECT public.pedido_edicao_omie_reivindicar('$K2', '$V2A'::timestamptz, gen_random_uuid(), NULL)" \
    -c "SELECT pg_sleep(1.5) /* k2-segura */" -c "COMMIT" > "$TMPD/k2a.log" 2>&1 ) &
PA=$!
espera "query LIKE '%k2-segura%' AND state = 'active'" || bad "K2 sessao A nao chegou ao sleep"
( SR "SELECT public.pedido_edicao_omie_reivindicar('$K2G', '$V2B'::timestamptz, gen_random_uuid(), NULL) /* k2-disputa */" > "$TMPD/k2b.out" 2>&1 ) &
PB=$!
if espera "query LIKE '%k2-disputa%' AND wait_event_type = 'Lock'"; then ok "K2a o gemeo esperou a insercao do 1o"; else bad "K2a o gemeo esperou a insercao do 1o — nao esperou"; fi
wait "$PA"; wait "$PB"
eq "K2 o gemeo que esperava fica em_edicao" "$(cat "$TMPD/k2b.out")" "em_edicao"
eq "K2b uma so tentativa viva no PV" "$(Pq -c "SELECT count(*) FROM public.pedido_edicao_omie_tentativa WHERE account = 'oben' AND omie_pedido_id = 910 AND desfecho IS NULL")" "1"

# K3: a revisão de crédito segura a tentativa; o encerramento da tela que esperava só abandona DEPOIS dela.
K3=aaaaaaaa-0000-0000-0000-000000000018
novo "$K3" oben 913
T3K="$(tok)"; reiv "$K3" "$T3K" >/dev/null
( P -c "BEGIN" -c "SET ROLE service_role" -c "$(revisao_sql "$T3K" "$K3")" -c "SELECT pg_sleep(1.5) /* k3-segura */" -c "COMMIT" > "$TMPD/k3a.log" 2>&1 ) &
PA=$!
espera "query LIKE '%k3-segura%' AND state = 'active'" || bad "K3 sessao A nao chegou ao sleep"
( AU "$EMP" "SELECT public.pedido_edicao_omie_encerrar_envio('$K3', '$T3K') /* k3-encerra */" > "$TMPD/k3b.out" 2>&1 ) &
PB=$!
if espera "query LIKE '%k3-encerra%' AND wait_event_type = 'Lock'"; then ok "K3a o encerramento esperou a revisao em curso"; else bad "K3a o encerramento esperou a revisao em curso — nao esperou"; fi
wait "$PA"; wait "$PB"
eq "K3 depois da revisao, a tentativa e abandonada" "$(cat "$TMPD/k3b.out")" "abandonada"
eq "K3b e o despacho dela nao passa" "$(desp "$K3" "$T3K")" "perdeu_posse"

echo "RESULTADO: $PASS OK / $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "TESTE_PEDIDO_EDICAO_POSSE_OK"
