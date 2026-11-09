#!/usr/bin/env bash
# Prova PG17 da migration 20261111140000_data_health_radar_carga_em_voo (pacote K3 do Radar): a linha radar_lote_idade
# do _data_health_compute passa a acusar a carga EM VOO parada, além da idade da foto.
#   Montagem: stubs + a CADEIA VIVA do trio (db/lib/data-health-vivo.sh) SEM esta migration → o compute chega ao md5
#   EXATO de PROD de 2026-11-09 (A1), e só então a migration real aplica sobre ele.
#   R0  o predecessor de PROD ficava VERDE com a carga parada recebendo há 13 h (o teste distingue);
#   R1-R10 cada fase: recebendo 11 h ok / 13 h stale; validada 5 h ok / 7 h stale; publicação com 2 erros seguidos ok,
#       3 broken (last_error = carga_erro); falhou num lote mais novo broken; re-run do mês vigente que falhou ok;
#       falhou antigo, superado por lote completo mais novo, ok; foto fresca sem carga ok;
#   R11 message constante com o relógio andando (fingerprint do watchdog: 13 h e 30 h dão a MESMA message);
#   R12 a foto velha (> 75 d) continua stale sem carga em voo (o check antigo não regrediu);
#   G   PRE recusa corpo estranho; re-aplicar = no-op; ACL de PROD preservada; cópia de db/ = migration sem envelope.
#   bash db/test-data-health-radar-carga-em-voo.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-radar-carga-em-voo.sh   (2º idioma do servidor)
#   bash db/test-data-health-radar-carga-em-voo.sh --falsificar                  (controle verde + cada sabotagem no assert dela)
#   (NÃO pipe pra tail — engole o exit≠0.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5661}"
SLUG="data-health-radar-carga-em-voo"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC
MIG="$REPO_ROOT/supabase/migrations/20261111140000_data_health_radar_carga_em_voo.sql"
MIG_DB="$REPO_ROOT/db/2026-11-09-data-health-radar-carga-em-voo.sql"
MD5_PROD_COMPUTE="3fe9b3ab92e202ae09ec21b19ddad54a"   # psql-ro 2026-11-09 (= 20261110120000)

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. Sabotagem de corpo recalcula o md5 'este' (PRE/PÓS aceitam o corpo
  # errado): só o assert de comportamento pode pegar.
  SABOTAGENS="sem_recebendo:R2 recebendo_curto:R1 sem_validada:R4 erro_nao_quebra:R6 erro_cedo:R5 sem_falhou:R7
    rerun_falhou_alarma:R8 falhou_antigo_alarma:R9 message_com_relogio:R11 foto_velha_esquecida:R12 pre_cega:G2"
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
case "${SABOTAGEM:-}" in
  "") ;;
  sem_recebendo)        sab_corpo "WHEN cg.carga_fase = 'recebendo' AND cg.carga_iniciada_em < now() - interval '12 hours' THEN 'recebendo'" "WHEN false THEN 'recebendo'" ;;
  recebendo_curto)      sab_corpo "cg.carga_iniciada_em < now() - interval '12 hours'" "cg.carga_iniciada_em < now() - interval '10 hours'" ;;
  sem_validada)         sab_corpo "WHEN cg.carga_fase = 'validada' AND cg.carga_validada_em < now() - interval '6 hours' THEN 'validada'" "WHEN false THEN 'validada'" ;;
  erro_nao_quebra)      sab_corpo "WHEN rl.carga_problema IN ('falhou', 'publicacao_erro') THEN 'broken'" "WHEN rl.carga_problema IN ('falhou') THEN 'broken'" ;;
  erro_cedo)            sab_corpo "COALESCE(cg.carga_tentativas, 0) >= 3" "COALESCE(cg.carga_tentativas, 0) >= 2" ;;
  sem_falhou)           sab_corpo "CASE WHEN cg.carga_fase = 'falhou' THEN 'falhou'" "CASE WHEN false THEN 'falhou'" ;;
  rerun_falhou_alarma)  sab_corpo "OR (c.carga_fase = 'falhou' AND (x.ultimo_mes IS NULL OR c.mes_referencia > x.ultimo_mes))" "OR (c.carga_fase = 'falhou' AND (x.ultimo_mes IS NULL OR c.mes_referencia >= x.ultimo_mes))" ;;
  falhou_antigo_alarma) sab_corpo "OR (c.carga_fase = 'falhou' AND (x.ultimo_mes IS NULL OR c.mes_referencia > x.ultimo_mes))" "OR (c.carga_fase = 'falhou')" ;;
  message_com_relogio)  sab_corpo "' parada recebendo (sem finalize em ' || rl.prazo_recebendo_h || ' h)'" "' parada recebendo ha ' || (SELECT extract(hour FROM now() - c.carga_iniciada_em)::int FROM public.radar_ingest_state c WHERE c.mes_referencia = rl.carga_mes) || ' h'" ;;
  foto_velha_esquecida) sab_corpo "           WHEN now() - rl.referencia > rl.teto THEN 'stale'
           ELSE 'ok' END," "           ELSE 'ok' END," ;;
  pre_cega)             python3 -I - "$MIG_USADA" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
de = "  IF v_vivo IS NULL OR v_vivo NOT IN ("
assert s.count(de) == 1
open(p, "w", encoding="utf-8").write(s.replace(de, "  IF false AND v_vivo NOT IN ("))
PY
                        echo "SABOTAGEM ATIVA: ${SABOTAGEM:-}" ;;
  *) echo "SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 2 ;;
esac

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

# ── Cenários: foto = mês passado (fresca, < 75 d), carga em voo = este mês ─────────────────────────────────
VIG="$(Pq -c "SELECT to_char(now() - interval '1 month', 'YYYY-MM')")"
NOVO="$(Pq -c "SELECT to_char(now(), 'YYYY-MM')")"
ANT="$(Pq -c "SELECT to_char(now() - interval '2 months', 'YYYY-MM')")"
rl() { Pq -c "SELECT status || '|' || message || '|' || coalesce(last_error, '-') FROM public._data_health_compute() WHERE source = 'radar_lote_idade'"; }
st() { rl | cut -d'|' -f1; }
estado() {  # $1 = SQL de estado da carga NOVO (UPDATE/INSERT), aplicado sobre a foto fresca
  P -q -c "DELETE FROM public.radar_ingest_state;
           INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, finalizado_em, carga_fase)
           VALUES ('$VIG', 'complete', 1000, now() - interval '40 days', now() - interval '40 days', 'publicada');
           $1"
}
nova() {  # $1 fase, $2 iniciada há, $3 validada há (ou NULL), $4 tentativas, $5 erro
  estado "INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, carga_fase,
            carga_iniciada_em, carga_validada_em, carga_tentativas, carga_erro, erro)
          VALUES ('$NOVO', CASE WHEN '$1' = 'falhou' THEN 'error' ELSE 'running' END, 0, now() - interval '$2', '$1',
            now() - interval '$2', $3, $4, $5, CASE WHEN '$1' = 'falhou' THEN $5 END);"
}

nova recebendo '13 hours' NULL NULL NULL
eq "R0 predecessor de PROD: carga parada recebendo ha 13 h ficava VERDE" "$(st)" "ok"

# ── Aplica a migration (com o envelope dela, como no SQL Editor) ─────────────────────────────────────────────
if ! P -q -f "$MIG_USADA" > "$TMP/apply.log" 2>&1; then
  echo "APPLY FALHOU:"; cat "$TMP/apply.log"; echo "PASS=$PASS FAIL=$((FAIL+1))"; exit 1
fi

nova recebendo '11 hours' NULL NULL NULL
eq "R1 recebendo ha 11 h (dentro do prazo de 12 h): ok" "$(st)" "ok"
nova recebendo '13 hours' NULL NULL NULL
eq "R2 recebendo ha 13 h: stale, message da carga parada" "$(rl)" "stale|Radar: carga do lote $NOVO parada recebendo (sem finalize em 12 h)|-"
nova validada '9 hours' "now() - interval '5 hours'" 0 NULL
eq "R3 validada ha 5 h: ok" "$(st)" "ok"
nova validada '12 hours' "now() - interval '7 hours'" 0 NULL
eq "R4 validada ha 7 h sem virar: stale" "$(rl)" "stale|Radar: lote $NOVO validado e sem publicar em 6 h|-"
nova validada '2 hours' "now() - interval '1 hour'" 2 "'57014: canceling statement'"
eq "R5 publicacao com 2 erros seguidos (retoma sozinha): ok" "$(st)" "ok"
nova validada '2 hours' "now() - interval '1 hour'" 3 "'57014: canceling statement'"
eq "R6 publicacao com 3 erros seguidos: broken, last_error = carga_erro" "$(rl)" "broken|Radar: publicacao do lote $NOVO falhando em tentativas seguidas|57014: canceling statement"
nova falhou '3 hours' NULL NULL "'RCARGA_QUEDA: 100 linhas contra 1000'"
eq "R7 carga do lote novo falhou: broken" "$(rl)" "broken|Radar: carga do lote $NOVO falhou e nao foi publicada|RCARGA_QUEDA: 100 linhas contra 1000"
estado "UPDATE public.radar_ingest_state SET carga_fase = 'falhou', carga_erro = 'RCARGA_RERUN_MEMBRESIA' WHERE mes_referencia = '$VIG';"
eq "R8 re-run do mes vigente que falhou (foto intacta): ok" "$(st)" "ok"
estado "INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, carga_fase, carga_erro)
        VALUES ('$ANT', 'error', 0, now() - interval '70 days', 'falhou', 'RCARGA_SUBSTITUIDA');"
eq "R9 falhou antigo, superado pela foto mais nova: ok" "$(st)" "ok"
estado ""
eq "R10 foto fresca sem carga em voo: ok" "$(st)" "ok"
nova recebendo '13 hours' NULL NULL NULL; m13="$(rl)"
nova recebendo '30 hours' NULL NULL NULL; m30="$(rl)"
eq "R11 message constante com o relogio andando (13 h = 30 h)" "$m13" "$m30"
P -q -c "DELETE FROM public.radar_ingest_state;
         INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, finalizado_em)
         VALUES ('2025-01', 'complete', 1000, '2025-02-20', '2025-02-20');"
eq "R12 foto velha (> 75 d) sem carga em voo segue stale (o check antigo nao regrediu)" "$(st)" "stale"

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
