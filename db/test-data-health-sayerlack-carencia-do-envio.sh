#!/usr/bin/env bash
# Prova PG17 da migration 20261117090000_data_health_sayerlack_carencia_do_envio: o source sayerlack_cancelado_com_po
# do _data_health_compute deixa de cobrar leitura do portal do pedido RECÉM-ENVIADO (alertas 624, 638 e 642).
#   Montagem: stubs + a CADEIA VIVA do trio (db/lib/data-health-vivo.sh) SEM esta migration → o compute chega ao md5
#   EXATO de PROD de 2026-11-17 (A1), e só então a migration real aplica sobre ele. Relógio controlado (public.now()
#   lê test.agora — idioma de db/test-sayerlack-cancelado-com-compra-viva.sh).
#   N0  o predecessor de PROD acusava o pedido disparado às 06:24 no tique das 06:30 (o alerta 642; o teste distingue);
#   N1-N4 a carência: terça 06:30 ok (message conta quem aguarda a 1ª leitura); terça 15:00 ok; quarta 10:00 ok;
#       quarta 15:00 stale 'sem nenhuma leitura' (a carência vence no dia útil seguinte às 14:00);
#   N5  fim de semana: enviado sexta à noite só é cobrado segunda às 14:00;
#   N6  o dia é o de SP: enviado 23:30 de segunda é de segunda (cobra na terça 15:00); 00:30 de terça, não;
#   N7  pedido ANTIGO nunca lido segue stale na hora (a carência não é anistia);
#   N8  sem envio confirmado não há carência: nem sem data alguma, nem só com a data do ciclo (cobra);
#   N9  carência não esconde a leitura atrasada do vizinho, não entra na lista nem troca a message;
#   N10-N11 message do ok: com e sem pedido em carência;   N12 lido uma vez, volta à régua de sempre;
#   N13 broken (cancelado com PO) continua vencendo;        N14 message do stale constante com o relógio;
#   2ª opinião do Codex (2026-11-17):
#   N15 envio no futuro ou 'infinity' não dá carência;      N16 com leitura, a data do envio não entra (nem na message);
#   N17 duas leituras atrasadas: a message cita a MAIS VELHA; N18 nunca lido vencido + leitura atrasada ⇒ 'sem nenhuma';
#   N19 fronteira 13:59:59/14:00:00;   N20 leitura exatamente à meia-noite exigida conta; 1 s antes, não;
#   N21 fuso da SESSÃO (UTC−11 e UTC+14) não muda o dia do envio (piso e teto), o dia exigido nem o "hoje";
#   Codex rodada 2: N22 a carência é POR pedido (dois nunca lidos, só o antigo é cobrado);
#   N23 carimbo regravado em corrida de qui 23:59:50 para sex 00:00:10 não empurra a cobrança de sexta para segunda;
#   G   re-aplicar = no-op; PRE recusa corpo estranho; ACL de PROD preservada; cópia de db/ = migration sem envelope.
#   bash db/test-data-health-sayerlack-carencia-do-envio.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-sayerlack-carencia-do-envio.sh   (2º idioma do servidor)
#   bash db/test-data-health-sayerlack-carencia-do-envio.sh --falsificar                  (controle verde + cada sabotagem no assert dela)
#   (NÃO pipe pra tail — engole o exit≠0.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5741}"
SLUG="data-health-sayerlack-carencia-do-envio"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC
MIG="$REPO_ROOT/supabase/migrations/20261117090000_data_health_sayerlack_carencia_do_envio.sql"
MIG_DB="$REPO_ROOT/db/2026-11-17-data-health-sayerlack-carencia-do-envio.sql"
MD5_PROD_COMPUTE="1262b63277d50a475949800d1cde15cd"   # psql-ro 2026-11-17 (= 20261111140000)

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. Sabotagem de corpo recalcula o md5 'este' (PRE/PÓS aceitam o corpo
  # errado): só o assert de comportamento pode pegar.
  SABOTAGENS="sem_carencia:N1 conta_carencia:N1 message_sem_carencia:N1b carencia_curta:N2 carencia_longa:N4
    carencia_eterna:N7 sem_data_perdoa:N8 fallback_ciclo:N8 lista_com_carencia:N9 mais_velha_com_carencia:N9
    sem_teto:N15 lido_ganha_carencia:N16 carencia_conta_lido:N16b mais_nova:N17 nunca_lido_some:N18 meia_noite:N20
    envio_fuso_sessao:N21a exigido_fuso_sessao:N21b hoje_fuso_sessao:N21c envio_teto_fuso_sessao:N21d
    correlacao:N22 sem_margem:N23 pre_cega:G2"
  N_TOT=0; F_TOT=0; LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"; porta=$PORT
  echo "== CONTROLE =="
  if ! PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 || ! grep -q "^PASS=[1-9][0-9]* FAIL=0$" "$LOGDIR/controle.log"; then
    echo "controle VERMELHO ou sem recibo — falsificacao abortada ANTES de sabotar (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"
    echo "SABOTAGENS: 0 vermelhas / 1 falhas"; exit 1
  fi
  echo "controle verde ($(grep '^PASS=' "$LOGDIR/controle.log"))"
  for s in $SABOTAGENS; do
    N_TOT=$((N_TOT+1)); a="${s#*:}"; s="${s%%:*}"; porta=$((porta+1))
    if PGPORT_TEST=$porta SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "SABOTAGEM $s ficou VERDE"; F_TOT=$((F_TOT+1)); continue
    fi
    if ! grep -q "^SABOTAGEM ATIVA: $s$" "$LOGDIR/$s.log"; then
      echo "SABOTAGEM $s vermelha SEM ter aplicado"; grep -m3 "padrao\|ERROR" "$LOGDIR/$s.log" || true; F_TOT=$((F_TOT+1))
    elif grep -q "^FAIL $a " "$LOGDIR/$s.log"; then echo "ok $s -> $a"
    else echo "SABOTAGEM $s vermelha mas NAO no assert $a"; grep "^FAIL\|ERROR" "$LOGDIR/$s.log" | head -3; F_TOT=$((F_TOT+1)); fi
  done
  echo "SABOTAGENS: $((N_TOT - F_TOT)) vermelhas / $F_TOT falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$F_TOT" -eq 0 ]; exit $?
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

# ── SABOTAGEM — sobre CÓPIA da migration; o repo nunca é tocado ──────────────────────────────────────────────
MIG_USADA="$TMP/mig.sql"; cp "$MIG" "$MIG_USADA"
md5_corpo() {  # md5 do corpo do compute no ARQUIVO (os mesmos bytes que o PG guarda em prosrc)
  python3 -I - "$1" <<'PY'
import hashlib, sys
t = open(sys.argv[1], encoding="utf-8").read()
a = t.index("AS $function$") + len("AS $function$"); b = t.index("$function$;", a)
print(hashlib.md5(t[a:b].encode("utf-8")).hexdigest())
PY
}
sab_corpo() {  # $1 de, $2 para — troca no corpo do compute (exatamente 1×) e recalcula o md5 'este' da PRE/PÓS
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import hashlib, sys
p, de, para = sys.argv[1:4]
s = open(p, encoding="utf-8").read()
def md5(t):
    a = t.index("AS $function$") + len("AS $function$"); b = t.index("$function$;", a)
    return hashlib.md5(t[a:b].encode("utf-8")).hexdigest()
if s.count(de) != 1:
    sys.exit(f"padrao ocorre {s.count(de)}x, esperado 1: {de[:70]!r}")
antes = md5(s); s = s.replace(de, para); depois = md5(s)
assert antes != depois and s.count(antes) >= 2, "md5 'este' nao achado na PRE/POS"
open(p, "w", encoding="utf-8").write(s.replace(antes, depois))
PY
  echo "SABOTAGEM ATIVA: ${SABOTAGEM:-}"
}
PISO=">= (ex.exigido_desde AT TIME ZONE 'America/Sao_Paulo')::date"
TETO="<= (now() AT TIME ZONE 'America/Sao_Paulo')::date"
ENVIO_PISO="((p.enviado_portal_em - interval '10 minutes') AT TIME ZONE 'America/Sao_Paulo')::date"
ENVIO_TETO="AND (p.enviado_portal_em AT TIME ZONE 'America/Sao_Paulo')::date"
FECHO="FROM public.pedido_compra_sugerido p WHERE p.id = k.pedido_id), false)) AS em_carencia"
SUBQ="(SELECT $ENVIO_PISO
                                               $PISO
                                         $ENVIO_TETO
                                               $TETO
                                        FROM public.pedido_compra_sugerido p WHERE p.id = k.pedido_id)"
LIDO="CASE WHEN q.observado_ate IS NOT NULL THEN q.observado_ate < ex.exigido_desde"
case "${SABOTAGEM:-}" in
  "") ;;
  sem_carencia)            sab_corpo "ELSE NOT q.em_carencia END AS devida" "ELSE true END AS devida" ;;
  conta_carencia)          sab_corpo "count(*) FILTER (WHERE c.devida) AS n_sem_leitura," "count(*) FILTER (WHERE c.devida OR c.em_carencia) AS n_sem_leitura," ;;
  message_sem_carencia)    sab_corpo "WHEN cc.n_carencia > 0
           THEN 'Portal Sayerlack: nenhum cancelado com compra viva; '" "WHEN false
           THEN 'Portal Sayerlack: nenhum cancelado com compra viva; '" ;;
  carencia_curta)          sab_corpo "$PISO" "> (ex.exigido_desde AT TIME ZONE 'America/Sao_Paulo')::date" ;;
  carencia_longa)          sab_corpo "$PISO" "$PISO - 1" ;;
  carencia_eterna)         sab_corpo "ELSE NOT q.em_carencia END AS devida" "ELSE false END AS devida" ;;
  sem_data_perdoa)         sab_corpo "$FECHO" "FROM public.pedido_compra_sugerido p WHERE p.id = k.pedido_id), true)) AS em_carencia" ;;
  fallback_ciclo)          sab_corpo "$SUBQ" "(k.enviado_em $PISO AND k.enviado_em $TETO)" ;;
  lista_com_carencia)      sab_corpo "FILTER (WHERE c.devida), 600) AS lista" "FILTER (WHERE c.devida OR c.em_carencia), 600) AS lista" ;;
  mais_velha_com_carencia) sab_corpo "CASE WHEN bool_or(c.observado_ate IS NULL) FILTER (WHERE c.devida)" "CASE WHEN bool_or(c.observado_ate IS NULL) FILTER (WHERE c.devida OR c.em_carencia)" ;;
  sem_teto)                sab_corpo "$TETO" "<= 'infinity'::date" ;;
  lido_ganha_carencia)     sab_corpo "$LIDO" "$LIDO AND NOT EXISTS (SELECT 1 FROM public.pedido_compra_sugerido p2 WHERE p2.id = q.pedido_id AND (p2.enviado_portal_em AT TIME ZONE 'America/Sao_Paulo')::date >= (ex.exigido_desde AT TIME ZONE 'America/Sao_Paulo')::date)" ;;
  carencia_conta_lido)     sab_corpo "(k.observado_ate IS NULL
                        AND COALESCE(" "(true
                        AND COALESCE(" ;;
  mais_nova)               sab_corpo "ELSE min(c.observado_ate) FILTER (WHERE c.devida) END AS leitura_mais_velha," "ELSE max(c.observado_ate) FILTER (WHERE c.devida) END AS leitura_mais_velha," ;;
  nunca_lido_some)         sab_corpo "CASE WHEN bool_or(c.observado_ate IS NULL) FILTER (WHERE c.devida)" "CASE WHEN bool_and(c.observado_ate IS NULL) FILTER (WHERE c.devida)" ;;
  meia_noite)              sab_corpo "THEN q.observado_ate < ex.exigido_desde" "THEN q.observado_ate <= ex.exigido_desde" ;;
  envio_fuso_sessao)       sab_corpo "$ENVIO_PISO" "(p.enviado_portal_em - interval '10 minutes')::date" ;;
  exigido_fuso_sessao)     sab_corpo "$PISO" ">= ex.exigido_desde::date" ;;
  hoje_fuso_sessao)        sab_corpo "$TETO" "<= now()::date" ;;
  envio_teto_fuso_sessao)  sab_corpo "$ENVIO_TETO" "AND p.enviado_portal_em::date" ;;
  correlacao)              sab_corpo "WHERE p.id = k.pedido_id)" "WHERE p.id >= k.pedido_id)" ;;
  sem_margem)              sab_corpo "(p.enviado_portal_em - interval '10 minutes')" "(p.enviado_portal_em - interval '0 minutes')" ;;
  pre_cega)                python3 -I - "$MIG_USADA" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
de = "  IF v_vivo IS NULL OR v_vivo NOT IN ("
assert s.count(de) == 1
open(p, "w", encoding="utf-8").write(s.replace(de, "  IF false AND v_vivo NOT IN ("))
PY
                           echo "SABOTAGEM ATIVA: ${SABOTAGEM:-}" ;;
  *) echo "SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 2 ;;
esac
ESTE="$(md5_corpo "$MIG_USADA")"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
DB=prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }   # -X: o ~/.psqlrc não entra
Pq() { P -tA -q "$@"; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# ── cadeia viva do trio SEM a migration desta entrega (symlinks) ─────────────────────────────────────────────
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/data-health-vivo.sh"
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_GUARDADAS=(_data_health_compute data_health_watchdog fin_sync_heartbeat)
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_INICIO=20260918200000
MIGDIR_ANTES="$TMP/migrations-antes"; mkdir -p "$MIGDIR_ANTES"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  [[ "$(basename "$f")" < "$(basename "$MIG")" ]] || continue
  ln -s "$f" "$MIGDIR_ANTES/$(basename "$f")"
done
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.uid', true), ''),
                  nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT public.has_role(_user_id, 'master') $f$;
SQL
P -q -1 -f "$REPO_ROOT/db/fixtures/get-data-health-predecessora-prod-20261005.sql" >/dev/null
# ACL MEDIDO em prod (psql-ro 2026-11-09: postgres + service_role) antes da cadeia: CREATE OR REPLACE preserva.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
echo "  -> cadeia viva (>= $DHV_INICIO que redefine ${DHV_GUARDADAS[*]}), SEM a migration desta entrega:"
dhv_aplicar_cadeia "$MIGDIR_ANTES" || { echo "a cadeia viva do trio NAO aplicou sobre os stubs"; echo "PASS=$PASS FAIL=1"; exit 1; }
eq "A1 o harness chega ao corpo de PROD de hoje (md5 do prosrc do compute)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure")" "$MD5_PROD_COMPUTE"

# ── RELÓGIO CONTROLADO — public.now() lê test.agora; liga/desliga pelo search_path do compute ────────────────
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now()) $f$;
SQL
CFG_PROD="search_path=public, pg_temp"
cfg() { Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;"; }
relogio_liga()    { P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_catalog, pg_temp;"; }
relogio_desliga() {
  P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_temp;"
  [ "$(cfg)" = "$CFG_PROD" ] || { echo "o relogio controlado NAO foi desligado: proconfig [$(cfg)]"; echo "PASS=$PASS FAIL=$((FAIL+1))"; exit 1; }
}
[ "$(cfg)" = "$CFG_PROD" ] || { echo "o compute da cadeia nao tem o search_path de PROD [$(cfg)]"; echo "PASS=$PASS FAIL=1"; exit 1; }

TER0630='2026-11-17 06:30-03'   # terça antes das 14:00 SP: exige leitura desde 00:00 de SEGUNDA
TER1500='2026-11-17 15:00-03'   # terça depois das 14:00: exige desde 00:00 de TERÇA
QUA1000='2026-11-18 10:00-03'   # quarta antes das 14:00: exige desde 00:00 de TERÇA
QUA1500='2026-11-18 15:00-03'   # quarta depois das 14:00: exige desde 00:00 de QUARTA
cc() {  # $1 expressão, $2 agora, $3 fuso da SESSÃO (default UTC, o do runner do CI; o corpo converte para SP sozinho)
  Pq -q -c "SET TimeZone = '${3:-UTC}'" -c "SET test.agora = '$2'" -c "SELECT $1 FROM public._data_health_compute() WHERE source = 'sayerlack_cancelado_com_po';"
}
limpa() {  # TRUNCATE não dispara os triggers de linha (o só-resolve do incidente inclusive)
  P -q -c "TRUNCATE public.pedido_compra_sugerido; TRUNCATE public.purchase_orders_tracking;
           TRUNCATE public.sayerlack_incidente_cancelado_com_po; TRUNCATE public.sayerlack_encerramento_cancelado_portal;"
}
ped() {  # $1 id, $2 protocolo, $3 PO, $4 enviado_portal_em (literal SQL: 'ts' ou NULL), $5 data_ciclo (literal SQL ou NULL)
  P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_protocolo, omie_pedido_compra_id, enviado_portal_em, data_ciclo)
           VALUES ($1, 'OBEN', 'disparado', 'sucesso_portal', '$2', '$3', $4, $5);"
}
sit() {  # $1 id, $2 código, $3 lido_ate (a leitura é do protocolo do próprio pedido)
  P -q -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '$2', portal_situacao_texto = '$2 - x',
             portal_situacao_em = '$3'::timestamptz - interval '2 minutes', portal_situacao_ate = '$3',
             portal_situacao_protocolo = portal_protocolo, portal_situacao_gravada_em = '$3' WHERE id = $1;"
}
SEM_LEITURA="status || '|' || COALESCE(age_seconds::text, 'NULL') || '|' || (message LIKE '%sem nenhuma leitura%')::text"
MSG_OK="Portal Sayerlack: nenhum cancelado com compra viva; "

# O pedido do alerta 642: #4448, protocolo 2151001, disparado terça 17/11 às 06:24 SP; o watchdog passou às 06:30.
limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
relogio_liga
eq "N0 predecessor de PROD: pedido disparado 06:24 era cobrado no tique das 06:30 (alerta 642)" "$(cc "$SEM_LEITURA" "$TER0630")" "stale|NULL|true"
relogio_desliga

# ── Aplica a migration (com o envelope dela, como no SQL Editor) ─────────────────────────────────────────────
out_a2="$(P -q -f "$MIG_USADA" 2>&1)" && r_a2=OK || r_a2=FALHOU
case "$out_a2" in (*"POSTCONDICAO_OK carencia do envio"*) marc_a2=marcador ;; (*) marc_a2=sem_marcador ;; esac
[ "$r_a2" = OK ] || { echo "APPLY FALHOU:"; printf '%s\n' "$out_a2" | head -20; echo "PASS=$PASS FAIL=$((FAIL+1))"; exit 1; }
eq "A2 a migration aplica sobre o corpo de PROD e a POS passa com o marcador" "$r_a2|$marc_a2" "OK|marcador"
eq "A3 o corpo vivo e o do arquivo aplicado (md5 do PG = md5 do arquivo)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure")" "$ESTE"
eq "A4 o CREATE devolveu o search_path de PROD (o relogio so liga por ALTER da prova)" "$(cfg)" "$CFG_PROD"
relogio_liga

eq "N1 terca 06:30: o recem-enviado nao e cobrado" "$(cc status "$TER0630")" "ok"
eq "N1b ...e a message do ok conta quem aguarda a 1a leitura" "$(cc message "$TER0630")" "${MSG_OK}1 pedido(s) com compra em aberto, 1 recem-enviado(s) aguardando a 1a leitura"
eq "N2 terca 15:00 (exige leitura de HOJE): enviado hoje segue em carencia" "$(cc status "$TER1500")" "ok"
eq "N3 quarta 10:00 (exige desde terca): ainda em carencia" "$(cc status "$QUA1000")" "ok"
eq "N4 quarta 15:00: a carencia venceu, nunca lido => stale 'sem nenhuma leitura', age NULL, na lista" \
   "$(cc "$SEM_LEITURA || '|' || (probable_cause LIKE '%2151001 (#4448)%')::text" "$QUA1500")" "stale|NULL|true|true"

limpa
ped 4500 2152000 12213020000 "'2026-11-13 21:00-03'" "'2026-11-13'"
eq "N5 enviado sexta 21:00: sabado 10:00 ok, segunda 10:00 ok, segunda 15:00 stale" \
   "$(cc status '2026-11-14 10:00-03')|$(cc status '2026-11-16 10:00-03')|$(cc status '2026-11-16 15:00-03')" "ok|ok|stale"

limpa
ped 4501 2152001 12213020001 "'2026-11-16 23:30-03'" "'2026-11-16'"
n6a="$(cc status "$TER1500")"
limpa
ped 4502 2152002 12213020002 "'2026-11-17 00:30-03'" "'2026-11-17'"
eq "N6 o dia do envio e o de SP: 23:30 de segunda cobra na terca 15:00; 00:30 de terca, nao" "$n6a|$(cc status "$TER1500")" "stale|ok"

limpa
ped 4201 2141201 12203460000 "'2026-10-29 10:00-03'" "'2026-10-29'"
eq "N7 pedido ANTIGO nunca lido segue stale na hora (a carencia nao e anistia)" "$(cc "$SEM_LEITURA" "$TER0630")" "stale|NULL|true"

limpa
ped 4503 2152003 12213020003 NULL NULL
n8a="$(cc "$SEM_LEITURA" "$TER0630")"
limpa
ped 4504 2152004 12213020004 NULL "'2026-11-17'"
eq "N8 sem envio confirmado nao ha carencia: sem data alguma cobra; so com a data do ciclo de hoje, cobra tambem" "$n8a|$(cc status "$TER0630")" "stale|NULL|true|stale"

limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
ped 4122 2147219 12206725360 "'2026-11-05 06:22-03'" "'2026-11-05'"
sit 4122 1 '2026-11-13 17:35-03'
eq "N9 carencia nao esconde a leitura atrasada do vizinho, nao entra na lista nem troca a message" \
   "$(cc "status || '|' || (message LIKE '%sem leitura da situacao no portal desde 13/11/2026 17:35 BRT%')::text || '|' || (probable_cause LIKE '%2147219 (#4122)%')::text || '|' || (probable_cause LIKE '%2151001%')::text" "$TER1500")" \
   "stale|true|true|false"
sit 4122 1 '2026-11-17 12:35-03'
eq "N10 vizinho lido hoje + 1 em carencia: ok, e a message separa os dois" "$(cc "status || '|' || message" "$TER1500")" \
   "ok|${MSG_OK}2 pedido(s) com compra em aberto, 1 recem-enviado(s) aguardando a 1a leitura"
P -q -c "DELETE FROM public.pedido_compra_sugerido WHERE id = 4448;"
eq "N11 sem ninguem em carencia a message do ok e a de antes" "$(cc "status || '|' || message" "$TER1500")" \
   "ok|${MSG_OK}1 pedido(s) com compra em aberto lidos no dia util"

limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
sit 4448 1 '2026-11-17 12:35-03'
eq "N12 lido uma vez, o pedido novo volta a regua de sempre: quarta 10:00 ok, quarta 15:00 stale com a data" \
   "$(cc status "$QUA1000")|$(cc "status || '|' || (message LIKE '%desde 17/11/2026 12:35 BRT%')::text" "$QUA1500")" "ok|stale|true"

limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
ped 4123 2147222 12206725409 "'2026-11-05 06:46-03'" "'2026-11-05'"
sit 4123 6 '2026-11-17 06:00-03'
eq "N13 cancelado com PO continua vencendo: broken com o pedido novo em carencia ao lado" \
   "$(cc "status || '|' || (message LIKE '%mais recente: protocolo 2147222, pedido #4123%')::text" "$TER0630")" "broken|true"

limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
eq "N14 a message do stale e constante com o relogio (fingerprint do watchdog)" \
   "$([ "$(cc message "$QUA1500")" = "$(cc message '2026-11-18 22:00-03')" ] && echo igual || echo mudou)" "igual"

# ── 2ª opinião do Codex (2026-11-17): teto da carência, ramo dos já lidos, agregados, fronteiras e fuso ───────
limpa
ped 4505 2152005 12213020005 "'2026-11-18 10:00-03'" "'2026-11-18'"
n15a="$(cc status "$TER1500")"
limpa
ped 4506 2152006 12213020006 "'infinity'" NULL
eq "N15 envio no futuro (amanha) ou 'infinity' nao da carencia: cobra" "$n15a|$(cc status "$TER1500")" "stale|stale"

limpa
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
sit 4448 1 '2026-11-16 12:35-03'
eq "N16 com leitura, a data do envio nao entra: lido segunda, envio regravado terca => stale com a data da leitura" \
   "$(cc "status || '|' || (message LIKE '%desde 16/11/2026 12:35 BRT%')::text" "$TER1500")" "stale|true"
sit 4448 1 '2026-11-17 12:35-03'
eq "N16b ...e pedido ja lido nao e contado como 'aguardando a 1a leitura'" "$(cc "status || '|' || message" "$TER1500")" \
   "ok|${MSG_OK}1 pedido(s) com compra em aberto lidos no dia util"

limpa
ped 4122 2147219 12206725360 "'2026-11-05 06:22-03'" "'2026-11-05'"
ped 4123 2147222 12206725409 "'2026-11-05 06:46-03'" "'2026-11-05'"
sit 4122 1 '2026-11-12 17:35-03'
sit 4123 1 '2026-11-13 17:35-03'
eq "N17 duas leituras atrasadas: a message cita a MAIS VELHA" \
   "$(cc "status || '|' || (message LIKE '%desde 12/11/2026 17:35 BRT%')::text" "$TER1500")" "stale|true"

limpa
ped 4201 2141201 12203460000 "'2026-10-29 10:00-03'" "'2026-10-29'"
ped 4123 2147222 12206725409 "'2026-11-05 06:46-03'" "'2026-11-05'"
sit 4123 1 '2026-11-13 17:35-03'
eq "N18 nunca lido vencido + leitura atrasada: vence o 'sem nenhuma leitura', age NULL" "$(cc "$SEM_LEITURA" "$TER1500")" "stale|NULL|true"

limpa
ped 4507 2152007 12213020007 "'2026-11-16 10:00-03'" "'2026-11-16'"
eq "N19 fronteira das 14:00: enviado segunda, terca 13:59:59 ok e 14:00:00 stale" \
   "$(cc status '2026-11-17 13:59:59-03')|$(cc status '2026-11-17 14:00:00-03')" "ok|stale"

limpa
ped 4122 2147219 12206725360 "'2026-11-05 06:22-03'" "'2026-11-05'"
sit 4122 1 '2026-11-17 00:00:00-03'
n20a="$(cc status "$TER1500")"
sit 4122 1 '2026-11-16 23:59:59-03'
eq "N20 leitura exatamente a meia-noite exigida conta; 1 s antes, nao" "$n20a|$(cc status "$TER1500")" "ok|stale"

OESTE='Pacific/Pago_Pago'    # UTC-11: 00:30 de terca em SP ainda e segunda la
LESTE='Pacific/Kiritimati'   # UTC+14: 15:00 de terca em SP ja e quarta la
limpa
ped 4502 2152002 12213020002 "'2026-11-17 00:30-03'" "'2026-11-17'"
eq "N21a fuso da sessao a oeste: o dia do ENVIO segue o de SP (00:30 de terca e terca)" "$(cc status "$TER1500" "$OESTE")" "ok"
limpa
ped 4507 2152007 12213020007 "'2026-11-16 10:00-03'" "'2026-11-16'"
eq "N21b fuso da sessao a oeste: o dia EXIGIDO segue o de SP (enviado segunda cobra na terca 15:00)" "$(cc status "$TER1500" "$OESTE")" "stale"
limpa
ped 4508 2152008 12213020008 "'2026-11-18 00:30-03'" "'2026-11-18'"
eq "N21c fuso da sessao a leste: o HOJE segue o de SP (envio de amanha nao da carencia)" "$(cc status "$TER1500" "$LESTE")" "stale"

limpa
ped 4509 2152009 12213020009 "'2026-11-17 12:00-03'" "'2026-11-17'"
eq "N21d fuso da sessao a leste: o TETO le o dia do envio em SP (enviado hoje 12:00 segue em carencia)" "$(cc status "$TER1500" "$LESTE")" "ok"

# ── Codex rodada 2 ──────────────────────────────────────────────────────────────────────────────────────────
limpa
ped 4201 2141201 12203460000 "'2026-10-29 10:00-03'" "'2026-10-29'"
ped 4448 2151001 12213018994 "'2026-11-17 06:24-03'" "'2026-11-17'"
eq "N22 a carencia e POR pedido: dois nunca lidos, so o antigo e cobrado e so ele entra na lista" \
   "$(cc "$SEM_LEITURA || '|' || (probable_cause LIKE '%2141201 (#4201)%')::text || '|' || (probable_cause LIKE '%2151001%')::text" "$TER1500")" \
   "stale|NULL|true|true|false"

limpa
ped 4510 2152010 12213020010 "'2026-11-20 00:00:10-03'" "'2026-11-19'"
eq "N23 carimbo regravado em corrida (qui 23:59:50 -> sex 00:00:10): sexta 10:00 ok, sexta 15:00 ja cobra" \
   "$(cc status '2026-11-20 10:00-03')|$(cc status '2026-11-20 15:00-03')" "ok|stale"

# Desliga o relógio: as guardas rodam no compute EXATAMENTE como a migration o deixou.
relogio_desliga
P -q -c "DROP FUNCTION public.now();"

# ── G: guardas ──────────────────────────────────────────────────────────────────────────────────────────────
eq "G1 re-aplicar sobre ela mesma passa (PRE aceita o corpo 'este')" "$(P -q -f "$MIG_USADA" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
P -q -c "CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS \$x\$ SELECT 'outra_sessao'::text, NULL::text, 'ok'::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::text,
               NULL::text, NULL::text, NULL::text \$x\$;"
g2="$(P -q -f "$MIG_USADA" 2>&1 | grep -o "PRE FALHOU: _data_health_compute vivo" || true)"
eq "G2 anti-deriva: corpo vivo de outra sessao aborta a aplicacao" "$g2" "PRE FALHOU: _data_health_compute vivo"
eq "G2b ...e nao apaga o corpo da outra sessao" "$(Pq -c "SELECT source FROM public._data_health_compute()")" "outra_sessao"
eq "G3 ACL de PROD preservada (anon/authenticated fechados, service_role aberto)" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public._data_health_compute()', 'EXECUTE')::text || has_function_privilege('authenticated', 'public._data_health_compute()', 'EXECUTE')::text || has_function_privilege('service_role', 'public._data_health_compute()', 'EXECUTE')::text")" \
   "falsefalsetrue"
g4="$(python3 -I - "$MIG" "$MIG_DB" <<'PY'
import sys
m = open(sys.argv[1], encoding="utf-8").read().split("\n")
d = open(sys.argv[2], encoding="utf-8").read().split("\n")
corpo_m = [l for l in m if l not in ("BEGIN;", "COMMIT;")]
i = d.index("-- =============================================================================")
print("igual" if d[i:] == corpo_m else "diverge")
PY
)"
eq "G4 a copia sem envelope de db/ e a migration menos BEGIN;/COMMIT;" "$g4" "igual"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
