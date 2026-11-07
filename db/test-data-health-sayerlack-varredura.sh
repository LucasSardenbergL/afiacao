#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — Sentinela sayerlack_varredura_portal (vigia do cron da varredura do portal, Onda 4)
# ║      bash db/test-data-health-sayerlack-varredura.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-sayerlack-varredura.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-sayerlack-varredura.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Autocontida: initdb + db/stubs-supabase.sql + db/stubs-data-health-trio.sql + a CADEIA VIVA do
# ║  trio (db/lib/data-health-vivo.sh) SEM a migration desta entrega — o banco chega ao md5 EXATO dos 3
# ║  corpos de PROD (A1) antes de a migration real aplicar sobre ele.
# ║   · relógio CONTROLADO (public.now() lê a GUC test.agora): dia útil exigido em SP (seg–sex ≥14:00 →
# ║     hoje; antes disso e no fim de semana → o dia útil anterior, seg/sáb/dom → sexta); rodada efetiva =
# ║     prova_leitura='ok' ou legada com lidos>0 (0 lidos sem prova NÃO conta — o incidente); falha antes
# ║     do protocolo na ÚLTIMA rodada decidida ⇒ broken com a causa; 'executando' e pulada não decidem;
# ║     erro DEPOIS da prova não é broken; message constante com o relógio e com a mesma causa;
# ║   · as 3 pernas do trio EXECUTAM: watchdog roteia o source (spy do episódio) e conta 26;
# ║   · em clones da prod de hoje: a PRE recusa corpo estranho, a POS tem dente, o REVOKE fecha ACL
# ║     aberto; reaplicar = no-op.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5671}"
SLUG="data-health-sayerlack-varredura"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar),
# e cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle),
# (3) CADA assert declarado estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o
# controle não tem. docs/historico/falsificacao-exit-nao-e-dente.md
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="hora_18:A8 segunda_menos_1:A7 legado_zero_conta:A10 erro_pos_prova_broken:A13 executando_decide:A18
              pulado_decide:A19 message_com_hora:A15 sem_causa_na_message:A17 fora_do_v_sources:A41,A43
              fora_do_heartbeat:A42 pre_sem_identidade:A25 pos_sem_dente:A26 sem_revoke:A27
              pos_v_sources_sem_dente:A30 pos_heartbeat_sem_dente:A31 pos_acl_sem_dente:A32"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# SETUP
# ══════════════════════════════════════════════════════════════════
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
DB=prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }   # -X: o ~/.psqlrc não entra
Pq() { P -tA "$@"; }
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 -I - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PYSAB
}
md5_corpo() {  # $1 arquivo, $2 função → md5 do prosrc definido no arquivo (= md5(prosrc) do PG)
  python3 -I - "$1" "$2" <<'PY'
import hashlib, sys
s = open(sys.argv[1], encoding='utf-8').read()
i = s.index(f'CREATE OR REPLACE FUNCTION public.{sys.argv[2]}(')
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
print(hashlib.md5(s[a:b].encode('utf-8')).hexdigest())
PY
}
# Sabotagem no CORPO de uma função: troca o texto E recalcula o md5 "este" no arquivo (PRE e POS
# aceitam o corpo errado) — só o assert de comportamento pode pegar.
sabotar_corpo() {  # $1 arquivo, $2 função, $3 de, $4 para
  local antes depois
  antes="$(md5_corpo "$1" "$2")"
  trocar "$1" "$3" "$4" || return 1
  depois="$(md5_corpo "$1" "$2")"
  [ "$antes" != "$depois" ] || { echo "   a troca não mudou o corpo de $2" >&2; return 1; }
  python3 -I - "$1" "$antes" "$depois" <<'PY'
import sys
p, de, para = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
assert s.count(de) >= 2, s.count(de)   # PRE + POS (o md5 tambem aparece na mensagem da POS)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}
md5_vivo() { Pd "$1" -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.$2()'::regprocedure;"; }

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_sayerlack_varredura_portal.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration desta entrega ausente — a prova testaria o NADA"; exit 1; }
MD5_PROD_COMPUTE="ded4fd5b5f9d4731c9b9893b1ffba3ba"   # psql-ro 2026-11-07 (= 20261031191715)
MD5_PROD_WD="b325d2afbc7e69739210ca417af074ca"        # psql-ro 2026-11-07 (= 20261020101636)
MD5_PROD_HB="f5defcdea6477db2baba54027d7f423c"

# ── cadeia viva do trio SEM a migration desta entrega (symlinks), para medir o "antes" ──
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/data-health-vivo.sh"
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_GUARDADAS=(_data_health_compute data_health_watchdog fin_sync_heartbeat)
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_INICIO=20260918200000
MIGDIR_ANTES="$TMP/migrations-antes"; mkdir -p "$MIGDIR_ANTES"
# "Antes" = estritamente ANTERIOR à migration desta entrega: uma posterior que recrie o trio com trava
# de identidade (PRE por md5) recusaria, com razão, o corpo de antes desta — e a prova quebraria na
# chegada da migration seguinte, não por defeito desta (#3373: a 20261028000116 derrubou esta prova).
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  [[ "$(basename "$f")" < "$(basename "$MIG")" ]] || continue
  ln -s "$f" "$MIGDIR_ANTES/$(basename "$f")"
done

STUBADAS="'_data_health_episodio','_tint_cobertura_bases_lista_email','_vendas_familia_ausente_lista_email','refresh_customer_metrics','tint_marcar_bases_mixmachine'"
assinatura_stubadas() {
  Pq -c "SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ' ' ORDER BY p.proname, p.oid)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ($STUBADAS);"
}
montar_banco() {
  local stubadas
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
  # ACL MEDIDO em prod (psql-ro 2026-10-20) antes da cadeia: CREATE OR REPLACE preserva, e a POS mede o
  # que a migration faz com ele, não o default do harness.
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
  stubadas="$(assinatura_stubadas)"
  echo "  → cadeia viva (≥ $DHV_INICIO que redefine ${DHV_GUARDADAS[*]}), SEM a migration desta entrega:"
  dhv_aplicar_cadeia "$MIGDIR_ANTES" || { echo "❌ a cadeia viva do trio NÃO aplicou sobre os stubs"; return 1; }
  [ "$(assinatura_stubadas)" = "$stubadas" ] \
    || { echo "❌ a cadeia redefiniu uma função que esta prova STUBA ($STUBADAS) — re-stube-a depois da cadeia"; return 1; }
}

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
montar_banco
eq "A1 o harness chega ao corpo de PROD de hoje (compute | watchdog | heartbeat, md5 do prosrc)" \
   "$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)" \
   "$MD5_PROD_COMPUTE|$MD5_PROD_WD|$MD5_PROD_HB"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde   # a prod de hoje, para os clones

# ══════════════════════════════════════════════════════════════════
# SABOTAGEM — sobre CÓPIAS da migration; o repo nunca é tocado.
# ══════════════════════════════════════════════════════════════════
MIG_USADA="$MIG"
cp "$MIG" "$TMP/mig.sql"
POS_V="  IF position('''' || v_src || '''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: % fora do v_sources"
POS_H="  IF position('''' || v_src || '''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: % fora da IN-list"
sab_compute() {  # $1 de, $2 para, $3 descrição
  sabotar_corpo "$TMP/mig.sql" _data_health_compute "$1" "$2" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão ($3) não ocorre exatamente 1×"; exit 9; }
  MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo ($3, md5 recalculado) — a suíte abaixo DEVE ficar vermelha"
}
case "${SABOTAGEM:-}" in
  "") ;;
  hora_18) sab_compute "rl.sp::time >= time '14:00'" "rl.sp::time >= time '18:00'" "corte do dia útil 14:00 → 18:00" ;;
  segunda_menos_1) sab_compute "WHEN extract(isodow FROM rl.sp) = 1 THEN rl.sp::date - 3" "WHEN extract(isodow FROM rl.sp) = 1 THEN rl.sp::date - 1" "segunda exige domingo" ;;
  legado_zero_conta) sab_compute "AND (ae.detalhes ->> 'lidos')::bigint > 0))" "AND (ae.detalhes ->> 'lidos')::bigint >= 0))" "legada com 0 lidos conta como efetiva" ;;
  erro_pos_prova_broken) sab_compute "CASE WHEN d.status = 'erro' AND COALESCE(d.detalhes ->> 'prova_leitura', '') <> 'ok'" "CASE WHEN d.status = 'erro'" "erro depois da prova vira causa" ;;
  executando_decide) sab_compute "AND d.status IN ('sucesso', 'erro')" "AND d.status IN ('sucesso', 'erro', 'executando')" "tentativa em curso decide" ;;
  pulado_decide) sab_compute "          AND d.detalhes ->> 'pulado' IS NULL
" "" "rodada pulada decide" ;;
  message_com_hora) sab_compute "THEN 'Portal Sayerlack: a varredura parou antes de ler os pedidos (causa ' || sv.causa || ')'" \
                                "THEN 'Portal Sayerlack: a varredura parou antes de ler os pedidos (causa ' || sv.causa || ') ' || to_char(now(), 'HH24:MI')" "hora corrente na message" ;;
  sem_causa_na_message) sab_compute "(causa ' || sv.causa || ')'" "(causa registrada)'" "message sem a causa" ;;
  fora_do_v_sources)
    sabotar_corpo "$TMP/mig.sql" data_health_watchdog "    'sayerlack_varredura_portal'];" "    'sayerlack_varredura_portal_x'];" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o source no v_sources não ocorre exatamente 1×"; exit 9; }
    # a POS textual pegaria antes do watchdog rodar — desliga-se SÓ ela, para medir o dente do assert
    trocar "$TMP/mig.sql" "$POS_V" "${POS_V/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS do v_sources não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em watchdog (source fora do v_sources, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  fora_do_heartbeat)
    sabotar_corpo "$TMP/mig.sql" fin_sync_heartbeat "                   'sayerlack_varredura_portal');" "                   'sayerlack_varredura_portal_x');" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o source na IN-list não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_H" "${POS_H/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS da IN-list não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em heartbeat (source fora da IN-list, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke|pos_v_sources_sem_dente|pos_heartbeat_sem_dente|pos_acl_sem_dente) ;;   # nos clones (A25–A27, A30–A32)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

ESTE_C="$(md5_corpo "$MIG_USADA" _data_health_compute)"; ESTE_W="$(md5_corpo "$MIG_USADA" data_health_watchdog)"; ESTE_H="$(md5_corpo "$MIG_USADA" fin_sync_heartbeat)"

# ══════════════════════════════════════════════════════════════════
# A MIGRATION APLICA SOBRE A PROD DE HOJE
# ══════════════════════════════════════════════════════════════════
echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A2 a migration aplica sobre o corpo de PROD e a POS passa" "$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"
eq "A3 os 3 corpos vivos são os do arquivo aplicado (md5 do PG = md5 do arquivo; sob sabotagem de corpo o md5 foi recalculado nele)" \
   "$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)" "$ESTE_C|$ESTE_W|$ESTE_H"
eq "A4 1 linha por source no compute INTEIRO, 34 sources, 1 delas sayerlack_varredura_portal" \
   "$(Pq -c "SELECT count(*) || '/' || count(DISTINCT source) || '/' || count(*) FILTER (WHERE source = 'sayerlack_varredura_portal') FROM public._data_health_compute();")" "34/34/1"

# ══════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — public.now() lê test.agora; o compute resolve now() por search_path
# (public ANTES de pg_catalog). Idioma de db/test-data-health-sync-reprocess.sh.
# ══════════════════════════════════════════════════════════════════
cfg_compute="$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")"
sp_compute="$(Pq -c "SELECT substring(c FROM '^search_path=(.*)\$') FROM pg_proc p, unnest(p.proconfig) c WHERE p.oid = 'public._data_health_compute()'::regprocedure AND c LIKE 'search_path=%';")"
sp_relogio="$(printf '%s' "$sp_compute" | sed -E 's/(^|, )public(,|$)/\1public, pg_catalog\2/')"
[ -n "$sp_compute" ] && [ "$sp_relogio" != "$sp_compute" ] \
  || { echo "❌ relógio controlado: o compute não tem public no search_path [$sp_compute]"; exit 1; }
P -q <<SQL
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS \$f\$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now()) \$f\$;
ALTER FUNCTION public._data_health_compute() SET search_path = $sp_relogio;
SQL
# cada leitura na SUA sessão (o SET morre com ela). Horários em SP com offset explícito (-03, sem DST).
sv()  { Pq -q -c "SET test.agora = '$1'" -c "SELECT $2 FROM public._data_health_compute() WHERE source = 'sayerlack_varredura_portal';"; }
rod() {  # $1 iniciado_em, $2 status, $3 detalhes (json)
  P -q -c "INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
           VALUES ('reposicao.varrer_portal_sayerlack', 'automatica', '$1'::timestamptz,
                   CASE WHEN '$2' = 'executando' THEN NULL ELSE '$1'::timestamptz + interval '2 minutes' END, '$2', '$3'::jsonb);"
}
EFETIVA='{"modo":"importar","versao":"v1.5","prova_leitura":"ok","lidos":6}'

echo "═══ sayerlack_varredura_portal: dia útil exigido (relógio de SP) ═══"
eq "A5 ledger VAZIO ⇒ stale 'nunca registrou', age NULL (ausente ≠ zero)" \
   "$(sv '2026-11-06 15:00-03' "status || '|' || COALESCE(age_seconds::text, 'NULL') || '|' || (message LIKE '%nunca registrou%')::text")" "stale|NULL|true"
P -q -c "INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
         VALUES ('outra.acao', 'automatica', '2026-11-09 12:30-03', '2026-11-09 12:32-03', 'sucesso', '{\"prova_leitura\":\"ok\"}');"
rod '2026-11-06 12:30-03' sucesso "$EFETIVA"
eq "A6 sex 12:30 efetiva ⇒ sex 15:00 ok (outro slug não conta)" "$(sv '2026-11-06 15:00-03' status)" "ok"
eq "A7 sáb 10:00, dom 20:00 e seg 13:59 seguem ok pela de sexta (fim de semana e manhã exigem o dia útil anterior)" \
   "$(sv '2026-11-07 10:00-03' status)|$(sv '2026-11-08 20:00-03' status)|$(sv '2026-11-09 13:59-03' status)" "ok|ok|ok"
eq "A8 seg 14:00 sem efetiva de segunda ⇒ stale, message com a última efetiva em BRT" \
   "$(sv '2026-11-09 14:00-03' "status || '|' || message")" "stale|Portal Sayerlack: sem varredura efetiva desde 06/11/2026 12:32 BRT"
eq "A9 message do stale é CONSTANTE com o relógio andando (seg 14:00 = ter 09:00), severity critical, domain estoque" \
   "$([ "$(sv '2026-11-09 14:00-03' message)" = "$(sv '2026-11-10 09:00-03' message)" ] && echo igual || echo mudou)|$(sv '2026-11-09 14:00-03' "severity || '|' || domain")" "igual|critical|estoque"
rod '2026-11-09 12:30-03' sucesso '{"modo":"importar","versao":"v1.4","lidos":0}'
rod '2026-11-09 12:40-03' sucesso '{"modo":"importar","versao":"v1.5","pulado":"bloqueado"}'
eq "A10 rodada LEGADA com 0 lidos (sem prova) e rodada pulada não são efetivas ⇒ seg 15:00 segue stale (o incidente)" "$(sv '2026-11-09 15:00-03' status)" "stale"
rod '2026-11-09 17:30-03' sucesso '{"modo":"importar","versao":"v1.4","lidos":6}'
eq "A11 rodada LEGADA com lidos>0 é efetiva ⇒ seg 18:00 ok" "$(sv '2026-11-09 18:00-03' status)" "ok"
rod '2026-11-10 12:30-03' erro '{"modo":"importar","versao":"v1.6","prova_leitura":"ok","lidos":6,"erro":"1 pedido nao entrou no Omie"}'
eq "A13 erro DEPOIS da prova (falha por protocolo, já avisada) não é broken e conta como efetiva ⇒ ter 15:00 ok" \
   "$(sv '2026-11-10 15:00-03' status)" "ok"

echo "═══ falha ANTES do protocolo ⇒ broken com a causa (1 e-mail por causa) ═══"
rod '2026-11-10 17:30-03' erro '{"modo":"importar","versao":"v1.6","causa_pre_protocolo":"leitura:LOGIN_FAILED","erro":"Leitura do portal falhou (LOGIN_FAILED): senha recusada"}'
eq "A14 última rodada decidida falhou antes de ler ⇒ broken, message com a causa, last_error com o erro" \
   "$(sv '2026-11-10 18:00-03' "status || '|' || message || '|' || last_error")" \
   "broken|Portal Sayerlack: a varredura parou antes de ler os pedidos (causa leitura:LOGIN_FAILED)|Leitura do portal falhou (LOGIN_FAILED): senha recusada"
M1="$(sv '2026-11-10 18:00-03' message)"
rod '2026-11-10 22:30-03' erro '{"modo":"importar","versao":"v1.6","causa_pre_protocolo":"leitura:LOGIN_FAILED","erro":"Leitura do portal falhou (LOGIN_FAILED): outra tentativa"}'
M2="$(sv '2026-11-11 10:00-03' message)"
eq "A15 mesma causa em rodada nova e relógio andando ⇒ message IGUAL (fingerprint do watchdog: 1 e-mail, não 3/dia)" \
   "$([ "$M1" = "$M2" ] && echo igual || echo mudou)" "igual"
rod '2026-11-11 12:30-03' erro '{"modo":"importar","versao":"v1.6","causa_pre_protocolo":"config_ausente","erro":"Configuração ausente: BROWSERLESS_TOKEN"}'
M3="$(sv '2026-11-11 13:00-03' message)"
eq "A17 causa NOVA ⇒ message muda (re-emite)" "$([ "$M3" != "$M2" ] && echo mudou || echo igual)|$(printf '%s' "$M3" | grep -c '(causa config_ausente)$' || true)" "mudou|1"
rod '2026-11-11 17:30-03' executando '{}'
eq "A18 rodada 'executando' mais nova é TENTATIVA, não desfecho ⇒ segue broken pela config_ausente" \
   "$(sv '2026-11-11 17:31-03' "status || '|' || (message LIKE '%config_ausente%')::text")" "broken|true"
rod '2026-11-14 12:30-03' sucesso '{"modo":"importar","versao":"v1.6","pulado":"portal_fechado"}'
eq "A19 rodada PULADA mais nova (portal fechado) não resolve ⇒ sáb 13:00 segue broken" "$(sv '2026-11-14 13:00-03' status)" "broken"
rod '2026-11-16 12:30-03' erro '{"modo":"importar","versao":"v1.5","erro":"Leitura do portal falhou (REDE): timeout"}'
eq "A20 rodada de edge velha (sem causa_pre_protocolo) que falhou antes da prova ⇒ broken com causa nao_classificada" \
   "$(sv '2026-11-16 13:00-03' "status || '|' || message")" "broken|Portal Sayerlack: a varredura parou antes de ler os pedidos (causa nao_classificada)"
rod '2026-11-16 13:00-03' erro "{\"modo\":\"importar\",\"causa_pre_protocolo\":\"leitura:x y,z;DROP $(printf 'A%.0s' $(seq 1 80))\"}"
eq "A22 causa saneada (só [A-Za-z0-9_:.-]) e cortada em 60 caracteres" \
   "$(sv '2026-11-16 13:10-03' "substring(message FROM '\\(causa (.*)\\)\$')")" "leitura:x_y_z_DROP_$(printf 'A%.0s' $(seq 1 41))"
eq "A23 how_to_fix aponta o ledger pelo slug e o cron pelo jobname" \
   "$(sv '2026-11-16 12:59-03' "(how_to_fix LIKE '%reposicao.varrer_portal_sayerlack%')::text || '|' || (how_to_fix LIKE '%jobname = ''sayerlack-varrer-pedidos-portal''%')::text")" "true|true"
rod '2026-11-16 17:30-03' sucesso "$EFETIVA"
eq "A21 efetiva nova ⇒ ok (resolve), problema zerado" \
   "$(sv '2026-11-16 18:00-03' "status || '|' || COALESCE(last_error, 'NULL') || '|' || COALESCE(probable_cause, 'NULL')")" "ok|NULL|NULL"


# Desliga o relógio controlado: o resto roda no compute EXATAMENTE como a migration o deixou.
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"
P -q -c "DROP FUNCTION public.now();"
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$cfg_compute]"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# AS 3 PERNAS DO TRIO EXECUTAM (late-bound: CREATE não prova nada)
# ══════════════════════════════════════════════════════════════════
echo "═══ trio: watchdog roteia o source; heartbeat executa ═══"
# relógio REAL: uma falha antes do protocolo agora ⇒ broken, qualquer que seja o dia.
P -q -c "TRUNCATE public.acoes_execucoes; TRUNCATE public._spy_episodio;
         INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
         VALUES ('reposicao.varrer_portal_sayerlack', 'automatica', now() - interval '5 minutes', now() - interval '3 minutes', 'erro',
                 '{\"causa_pre_protocolo\":\"leitura:LOGIN_FAILED\",\"erro\":\"Leitura do portal falhou (LOGIN_FAILED)\"}');"
eq "A40 no relógio real: falha antes do protocolo ⇒ broken" \
   "$(Pq -c "SELECT status FROM public._data_health_compute() WHERE source = 'sayerlack_varredura_portal';")" "broken"
saida_wd="$(P -q -c "SELECT public.data_health_watchdog();" 2>&1)" && rc_wd=0 || rc_wd=$?
[ "$rc_wd" -eq 0 ] || printf '%s\n' "$saida_wd"
eq "A41 watchdog avalia 26 checks (o v_sources: 25 + 1) sem exceção do compute" \
   "$rc_wd | $(Pq -c "SELECT checks_avaliados::text || '/' || checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0 | 26/0"
eq "A43 watchdog ROTEOU sayerlack_varredura_portal para o push (_data_health_episodio), como critico" \
   "$(Pq -c "SELECT (count(*) = 1)::text FROM public._spy_episodio WHERE tipo = 'data_health_sayerlack_varredura_portal' AND status = 'broken' AND sev_fin = 'critico';")" "true"
saida_hb="$(P -q -c "SELECT public.fin_sync_heartbeat();" 2>&1)" && rc_hb=0 || rc_hb=$?
[ "$rc_hb" -eq 0 ] || printf '%s\n' "$saida_hb"
eq "A42 fin_sync_heartbeat executa e o RESUMO que ele grava em fornecedor_alerta lista o source com o status" \
   "$rc_hb|$(Pq -c "SELECT (count(*) >= 1)::text FROM public.fornecedor_alerta WHERE mensagem LIKE '%sayerlack_varredura_portal: broken%';")" "0|true"
eq "A44 o trio segue FECHADO a anon/authenticated/PUBLIC (só service_role executa)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE has_function_privilege(r.papel, f.fn, 'EXECUTE')) || '/' || count(*)
              FROM (VALUES ('anon'), ('authenticated'), ('public')) r(papel)
              CROSS JOIN (VALUES ('public._data_health_compute()'), ('public.data_health_watchdog()'), ('public.fin_sync_heartbeat()')) f(fn);")|$(Pq -c "SELECT has_function_privilege('service_role', 'public._data_health_compute()', 'EXECUTE')::text;")" "0/9|true"

# ══════════════════════════════════════════════════════════════════
# EM CLONES DA PROD DE HOJE (molde): PRE, POS, ACL, re-apply
# ══════════════════════════════════════════════════════════════════
echo "═══ em clones da prod de hoje (molde): PRE, POS, ACL ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pre
Pd pre -q <<'SQL'
DO $x$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public._data_health_compute()'::regprocedure);
  IF (length(v_def) - length(replace(v_def, '  WITH checks AS (', ''))) / length('  WITH checks AS (') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'o inicio do corpo mudou de forma';
  END IF;
  EXECUTE replace(v_def, '  WITH checks AS (', '  WITH checks AS ( -- corpo estranho');
END $x$;
SQL
estranho="$(md5_vivo pre _data_health_compute)"
cp "$MIG_USADA" "$TMP/mig-pre.sql"
if [ "${SABOTAGEM:-}" = "pre_sem_identidade" ]; then
  trocar "$TMP/mig-pre.sql" "    IF NOT (r.vivo = ANY (r.aceitos)) THEN" "    IF false AND NOT (r.vivo = ANY (r.aceitos)) THEN" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out25="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out25" in
  *"PRE FALHOU"*) r25="recusou" ;;
  *"POS OK"*) r25="aplicou" ;;
  *) r25="erro:$(printf '%s\n' "$out25" | sqlstate)" ;;
esac
eq "A25 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r25|$(md5_vivo pre _data_health_compute)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG_USADA" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "  WITH checks AS (" "  WITH checks AS ( -- corpo que nao e o desta versao" \
  || { echo "❌ o início do corpo mudou de forma — o A26 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "  IF v_md5 IS DISTINCT FROM '$ESTE_C' THEN" "  IF false AND v_md5 IS DISTINCT FROM '$ESTE_C' THEN" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o md5 do compute) — a suíte abaixo DEVE ficar vermelha"
fi
out26="$(Pd pos -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out26" in
  *"POSTCONDICAO FALHOU md5"*) r26="recusou:md5" ;;
  *"POSTCONDICAO FALHOU"*) r26="recusou:outro_motivo" ;;
  *"POS OK"*) r26="aplicou" ;;
  *) r26="erro:$(printf '%s\n' "$out26" | sqlstate)" ;;
esac
eq "A26 a POS recusa um corpo que não é o desta versão (md5)" "$r26" "recusou:md5"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
Pd acl -q -c "GRANT EXECUTE ON FUNCTION public._data_health_compute() TO PUBLIC, anon, authenticated;"
cp "$MIG_USADA" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE não ocorre exatamente 1×"; exit 9; }
  trocar "$TMP/mig-acl.sql" "  IF v_vazado <> 0 THEN" "  IF false AND v_vazado <> 0 THEN" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS de ACL não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE do compute (POS de ACL desligada) — a suíte abaixo DEVE ficar vermelha"
fi
r27="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
vaz27="$(Pd acl -tA -c "SELECT count(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
                         WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');")"
eq "A27 com o EXECUTE aberto (deriva de ACL), aplicar a migration o fecha para PUBLIC/anon/authenticated" "$r27|$vaz27" "OK|0"

# A PÓS (3) e (4) pegam SOZINHAS? Clones com uma migration cujo CORPO tem o defeito (md5 recalculado,
# PRE/POS de identidade aceitam) — só a PÓS específica pode recusar.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde posv
cp "$MIG" "$TMP/mig-posv.sql"     # do ORIGINAL: estes clones medem a PÓS, não a sabotagem de corpo em curso
sabotar_corpo "$TMP/mig-posv.sql" data_health_watchdog "    'sayerlack_varredura_portal'];" "    'sayerlack_varredura_portal_x'];" \
  || { echo "❌ o source no v_sources mudou de forma — o A30 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_v_sources_sem_dente" ]; then
  trocar "$TMP/mig-posv.sql" "$POS_V" "${POS_V/IF position/IF false AND position}" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a PÓS do v_sources não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PÓS (v_sources sem dente) — a suíte abaixo DEVE ficar vermelha"
fi
out30="$(Pd posv -q -1 -f "$TMP/mig-posv.sql" 2>&1 || true)"
case "$out30" in
  *"fora do v_sources"*) r30="recusou:v_sources" ;;
  *"POSTCONDICAO FALHOU"*) r30="recusou:outro_motivo" ;;
  *"POS OK"*) r30="aplicou" ;;
  *) r30="erro:$(printf '%s\n' "$out30" | sqlstate)" ;;
esac
eq "A30 a PÓS recusa sozinha um watchdog sem sayerlack_varredura_portal no v_sources" "$r30" "recusou:v_sources"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde posh
cp "$MIG" "$TMP/mig-posh.sql"
sabotar_corpo "$TMP/mig-posh.sql" fin_sync_heartbeat "                   'sayerlack_varredura_portal');" "                   'sayerlack_varredura_portal_x');" \
  || { echo "❌ o source na IN-list mudou de forma — o A31 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_heartbeat_sem_dente" ]; then
  trocar "$TMP/mig-posh.sql" "$POS_H" "${POS_H/IF position/IF false AND position}" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a PÓS da IN-list não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PÓS (IN-list sem dente) — a suíte abaixo DEVE ficar vermelha"
fi
out31="$(Pd posh -q -1 -f "$TMP/mig-posh.sql" 2>&1 || true)"
case "$out31" in
  *"fora da IN-list"*) r31="recusou:in_list" ;;
  *"POSTCONDICAO FALHOU"*) r31="recusou:outro_motivo" ;;
  *"POS OK"*) r31="aplicou" ;;
  *) r31="erro:$(printf '%s\n' "$out31" | sqlstate)" ;;
esac
eq "A31 a PÓS recusa sozinha um heartbeat sem sayerlack_varredura_portal na IN-list" "$r31" "recusou:in_list"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde posacl
Pd posacl -q -c "GRANT EXECUTE ON FUNCTION public._data_health_compute() TO PUBLIC, anon, authenticated;"
cp "$MIG" "$TMP/mig-posacl.sql"
trocar "$TMP/mig-posacl.sql" "REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;" "" \
  || { echo "❌ o REVOKE do compute mudou de forma — o A32 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_acl_sem_dente" ]; then
  trocar "$TMP/mig-posacl.sql" "  IF v_vazado <> 0 THEN" "  IF false AND v_vazado <> 0 THEN" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a PÓS de ACL não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PÓS (ACL sem dente) — a suíte abaixo DEVE ficar vermelha"
fi
out32="$(Pd posacl -q -1 -f "$TMP/mig-posacl.sql" 2>&1 || true)"
case "$out32" in
  *"com EXECUTE"*) r32="recusou:acl" ;;
  *"POSTCONDICAO FALHOU"*) r32="recusou:outro_motivo" ;;
  *"POS OK"*) r32="aplicou" ;;
  *) r32="erro:$(printf '%s\n' "$out32" | sqlstate)" ;;
esac
eq "A32 a PÓS recusa sozinha um apply que deixa o compute executável por PUBLIC" "$r32" "recusou:acl"

antes28="$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)"
r28="$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A28 reaplicar é no-op (a PRE aceita esta versão; os 3 corpos não mudam)" \
   "$r28|$([ "$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)" = "$antes28" ] && echo igual || echo mudou)" "OK|igual"

echo
# Recibo no formato do runner (db/roda-nucleo-ci.sh): sem uma linha de contagem que ele saiba ler,
# uma prova trocada por `exit 0` passaria.
echo "PASS=${PASS}  FAIL=${FAIL}"
echo "═══ ${PASS} passaram · ${FAIL} falharam ═══"
[ "$FAIL" -eq 0 ] || exit 1
