#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — saldo_bancario CONTA A CONTA, e saldo_atual sem DEFAULT 0 (plano v3, item 2)
# ║      bash db/test-data-health-saldo-bancario-conta-a-conta.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-saldo-bancario-conta-a-conta.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-saldo-bancario-conta-a-conta.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Autocontida: initdb + stubs + a CADEIA VIVA do trio (db/lib/data-health-vivo.sh) SEM a migration
# ║  desta entrega — o banco chega ao md5 EXATO do compute de PROD (A1) antes de ela aplicar.
# ║   · relógio CONTROLADO (public.now() lê a GUC test.agora), sessão UTC e SP;
# ║   · o defeito de antes reproduzido no corpo de prod (A23: UMA conta fresca escondia a velha);
# ║   · a régua de classificarSaldoConta conta a conta: 03:59:59 × 04:00:00 SP, 22h SP (UTC já é
# ║     amanhã), desconhecida (NULL, NaN, futura), inativa fora, nenhuma ativa, broken > stale;
# ║   · message constante com o relógio andando (fingerprint), age/expected = 28 h na borda;
# ║   · em clones da prod de hoje: a PRE recusa corpo estranho, reaplicar = no-op, o REVOKE fecha ACL;
# ║   · DROP DEFAULT: o upsert do omie-financeiro (as colunas do payload, como o PostgREST) com conta
# ║     NOVA sem extrato grava NULL/NULL (antes 0/NULL), a existente preserva, sucesso com zero grava 0.
# ║  Diário: docs/historico/saldo-cc-fresco-e-ncg-leitura-pontual.md
# ╚═══════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5691}"
SLUG="data-health-saldo-bancario-conta-a-conta"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar),
# e cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle),
# (3) CADA assert declarado estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o
# controle não tem. docs/historico/falsificacao-exit-nao-e-dente.md
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="ontem_vale_o_dia:A6,A8 sem_as_4h:A7 dia_utc:A7 futura_aceita:A13 sem_filtro_ativo:A14
              sem_desconhecida:A11,A16 nan_aceito:A12 pre_sem_identidade:A20 sem_revoke:A22
              sem_drop_default:A25"
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

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_saldo_bancario_conta_a_conta.sql" | sort | tail -1)"
MIG_DEFAULT="$(find "$REPO_ROOT/supabase/migrations" -name "*_fin_contas_correntes_saldo_atual_sem_default.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] && [ -n "$MIG_DEFAULT" ] && [ -f "$MIG_DEFAULT" ] \
  || { echo "❌ migration desta entrega ausente — a prova testaria o NADA"; exit 1; }
MD5_PROD_COMPUTE="1eb65dcd92766fcc4533dc3d166af350"   # psql-ro 2026-10-31 (= 20261028000116)
MD5_PROD_WD="b325d2afbc7e69739210ca417af074ca"
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
# de identidade (PRE por md5) recusaria, com razão, o corpo de antes desta (#3373).
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
# SABOTAGEM — sobre CÓPIAS das migrations; o repo nunca é tocado.
# ══════════════════════════════════════════════════════════════════
MIG_USADA="$MIG"
cp "$MIG" "$TMP/mig.sql"
REGUA_VELHA="interval '4 hours') AT TIME ZONE 'America/Sao_Paulo')::date THEN 'velha'"
sab_corpo() {  # $1 de, $2 para, $3 descrição
  sabotar_corpo "$TMP/mig.sql" _data_health_compute "$1" "$2" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× ($3)"; exit 9; }
  MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo ($3, md5 recalculado) — a suíte abaixo DEVE ficar vermelha"
}
case "${SABOTAGEM:-}" in
  "") ;;
  ontem_vale_o_dia) sab_corpo "$REGUA_VELHA" "${REGUA_VELHA/4 hours/28 hours}" "o saldo de ontem vale o dia inteiro" ;;
  sem_as_4h)        sab_corpo "$REGUA_VELHA" "${REGUA_VELHA/4 hours/0 hours}" "sem a tolerância das 4 h" ;;
  dia_utc)          sab_corpo "$REGUA_VELHA" "${REGUA_VELHA/America\/Sao_Paulo/UTC}" "minimo em dia UTC" ;;
  futura_aceita)    sab_corpo "                          OR cc.saldo_data > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'desconhecida'" \
                              "                          THEN 'desconhecida'" "data futura aceita" ;;
  sem_filtro_ativo) sab_corpo "FROM public.fin_contas_correntes cc WHERE cc.ativo = true
            ) k" "FROM public.fin_contas_correntes cc
            ) k" "conta inativa entra" ;;
  sem_desconhecida) sab_corpo "CASE WHEN sb.n_ativas = 0 OR sb.n_desconhecidas > 0 THEN 'broken'" \
                              "CASE WHEN sb.n_ativas = 0 THEN 'broken'" "desconhecida não acende broken" ;;
  nan_aceito)       sab_corpo "OR cc.saldo_atual IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)" \
                              "OR cc.saldo_atual IN ('Infinity'::numeric, '-Infinity'::numeric)" "NaN aceito" ;;
  pre_sem_identidade|sem_revoke|sem_drop_default) ;;   # nos clones (A20, A22, A25)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
ESTE_C="$(md5_corpo "$MIG_USADA" _data_health_compute)"

# ══════════════════════════════════════════════════════════════════
# A MIGRATION APLICA SOBRE A PROD DE HOJE
# ══════════════════════════════════════════════════════════════════
echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A2 a migration aplica sobre o corpo de PROD e a POS passa" "$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"
eq "A3 o corpo vivo é o do arquivo aplicado; watchdog e heartbeat intocados" \
   "$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)" "$ESTE_C|$MD5_PROD_WD|$MD5_PROD_HB"
eq "A4 1 linha por source no compute INTEIRO, 33 sources" \
   "$(Pq -c "SELECT count(*) || '/' || count(DISTINCT source) FROM public._data_health_compute();")" "33/33"

# ══════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — public.now() lê test.agora; o compute resolve now() por search_path
# ══════════════════════════════════════════════════════════════════
sp_compute="$(Pq -c "SELECT substring(c FROM '^search_path=(.*)\$') FROM pg_proc p, unnest(p.proconfig) c WHERE p.oid = 'public._data_health_compute()'::regprocedure AND c LIKE 'search_path=%';")"
sp_relogio="$(printf '%s' "$sp_compute" | sed -E 's/(^|, )public(,|$)/\1public, pg_catalog\2/')"
[ -n "$sp_compute" ] && [ "$sp_relogio" != "$sp_compute" ] \
  || { echo "❌ relógio controlado: o compute não tem public no search_path [$sp_compute]"; exit 1; }
relogio_on() {  # $1 banco
  Pd "$1" -q <<SQL
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS \$f\$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now()) \$f\$;
ALTER FUNCTION public._data_health_compute() SET search_path = $sp_relogio;
SQL
}
relogio_on prove
AG='2026-10-28 15:00:00+00'          # 12h SP de 28/10: hoje = minimo = 28/10
ANTES_VIRADA='2026-10-28 06:59:59+00' # 03:59:59 SP: o de ontem (27/10) ainda vale
VIRADA='2026-10-28 07:00:00+00'       # 04:00:00 SP: só o de hoje
# cada leitura na SUA sessão (o SET morre com ela); $2 = agora (default AG), $3 = fuso da sessão, $4 = banco
ck() { Pd "${4:-prove}" -tA -q -c "SET TimeZone = '${3:-UTC}'" -c "SET test.agora = '${2:-$AG}'" \
         -c "SELECT $1 FROM public._data_health_compute() WHERE source = 'saldo_bancario';"; }
# $1 = VALUES de (company, omie_ncodcc, saldo_data, saldo_atual, ativo); $2 = banco
contas() { Pd "${2:-prove}" -q -c "TRUNCATE public.fin_contas_correntes;" \
             -c "INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, saldo_data, saldo_atual, ativo) VALUES $1;"; }
quatro() {  # 4 contas ativas com saldo_data $1, e a $2-ésima trocada pela tupla $3
  local t=("('colacor', 1, '$1', 100, true)" "('colacor', 2, '$1', 0, true)" "('colacor_sc', 3, '$1', -50, true)" "('oben', 4, '$1', 10, true)")
  [ -n "${2:-}" ] && t[$2]="$3"
  local IFS=,; printf '%s' "${t[*]}"
}
SV="status || '|' || message"

echo "═══ saldo_bancario: conta a conta, pela régua do saldo ═══"
contas "$(quatro 2026-10-28)"
eq "A5 4 contas ativas, todas com o extrato de hoje ⇒ ok" "$(ck "$SV")" "ok|Saldo bancário: 4 contas com extrato de 28/10"
contas "$(quatro 2026-10-28 0 "('colacor', 1, '2026-10-27', 100, true)")"
eq "A6 UMA conta velha entre frescas ⇒ stale (antes a fresca a escondia)" "$(ck "$SV")" \
   "stale|Saldo bancário: 1 de 4 contas sem o extrato de hoje (colacor 1); a mais antiga de 27/10"
contas "$(quatro 2026-10-27)"
eq "A7 03:59:59 SP, saldo de ontem ⇒ ok (o sync das 03h ainda é o último possível)" "$(ck "$SV" "$ANTES_VIRADA")" \
   "ok|Saldo bancário: 4 contas com extrato de 27/10"
eq "A8 04:00:00 SP, o mesmo saldo de ontem ⇒ stale" "$(ck "$SV" "$VIRADA")" \
   "stale|Saldo bancário: 4 de 4 contas sem o extrato de hoje (colacor 2, colacor_sc 1, oben 1); a mais antiga de 27/10"
eq "A9 a borda não depende do fuso da SESSÃO (A7|A8 com TimeZone America/Sao_Paulo)" \
   "$(ck status "$ANTES_VIRADA" America/Sao_Paulo)|$(ck status "$VIRADA" America/Sao_Paulo)" "ok|stale"
contas "$(quatro 2026-10-28)"
eq "A10 22h SP de 28/10 (o dia UTC já é 29), saldo de 28/10 ⇒ ok" "$(ck "$SV" '2026-10-29 01:00:00+00')" \
   "ok|Saldo bancário: 4 contas com extrato de 28/10"
contas "$(quatro 2026-10-28 3 "('oben', 4, NULL, 0, true)")"
eq "A11 conta sem saldo_data (o DEFAULT 0 da conta cujo extrato nunca respondeu) ⇒ broken" "$(ck "$SV")" \
   "broken|Saldo bancário: 1 de 4 contas sem saldo do extrato (oben 1)"
contas "$(quatro 2026-10-28 2 "('colacor_sc', 3, '2026-10-28', 'NaN', true)")"
eq "A12 saldo_atual NaN ⇒ broken (desconhecida, não fresca)" "$(ck "$SV")" \
   "broken|Saldo bancário: 1 de 4 contas sem saldo do extrato (colacor_sc 1)"
contas "$(quatro 2026-10-28 0 "('colacor', 1, '2026-10-29', 100, true)")"
eq "A13 saldo_data no futuro ⇒ broken (incoerente, não fresca)" "$(ck "$SV")" \
   "broken|Saldo bancário: 1 de 4 contas sem saldo do extrato (colacor 1)"
contas "$(quatro 2026-10-28),('colacor', 5, '2026-10-20', 7, false),('oben', 6, '2026-10-20', 7, NULL),('oben', 7, NULL, 0, false)"
eq "A14 conta inativa (false ou NULL) não entra, velha ou sem extrato ⇒ ok com 4 contas" "$(ck "$SV")" \
   "ok|Saldo bancário: 4 contas com extrato de 28/10"
contas "('colacor', 5, '2026-10-28', 7, false)"
eq "A15 nenhuma conta ativa ⇒ broken" "$(ck "$SV")" "broken|Saldo bancário: nenhuma conta corrente ativa"
contas "$(quatro 2026-10-28 3 "('oben', 4, NULL, 0, true)"),('colacor', 9, '2026-10-25', 1, true)"
eq "A16 velha + desconhecida ⇒ broken vence stale" "$(ck "$SV")" \
   "broken|Saldo bancário: 1 de 5 contas sem saldo do extrato (oben 1)"
contas "$(quatro 2026-10-27)"
eq "A17 age × expected na borda: 03:59:59 = 28 h − 1 s; 04:00:00 = 28 h (velha a partir dela)" \
   "$(ck "age_seconds || '/' || expected_max_age_seconds" "$ANTES_VIRADA")|$(ck "age_seconds || '/' || expected_max_age_seconds" "$VIRADA")" \
   "100799/100800|100800/100800"
contas "$(quatro 2026-10-28 0 "('colacor', 1, '2026-10-27', 100, true)")"
eq "A18 message constante com o relógio andando 8 h (fingerprint do watchdog)" "$(ck message '2026-10-28 23:00:00+00')" \
   "Saldo bancário: 1 de 4 contas sem o extrato de hoje (colacor 1); a mais antiga de 27/10"
contas "$(quatro 2026-10-28 1 "('colacor', 2, '2026-10-27', 0, true)")"
eq "A19 antes das 04h, frescas de dois dias ⇒ ok com a faixa de datas" "$(ck "$SV" "$ANTES_VIRADA")" \
   "ok|Saldo bancário: 4 contas com extrato de 27/10 a 28/10"
eq "A26 severity e base de frescor" "$(ck "severity || '|' || freshness_basis")" "critical|pior_conta_saldo_data"
contas "$(quatro 2026-10-28 3 "('oben', 4, '2026-10-28', NULL, true)")"
eq "A27 saldo_atual NULL com saldo_data ⇒ broken" "$(ck "$SV")" "broken|Saldo bancário: 1 de 4 contas sem saldo do extrato (oben 1)"

# relógio desligado: o search_path volta ao da migration
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"

# ══════════════════════════════════════════════════════════════════
# EM CLONES DA PROD DE HOJE (molde): o defeito de antes, PRE, re-apply, ACL
# ══════════════════════════════════════════════════════════════════
echo "═══ em clones da prod de hoje (molde): o defeito de antes, PRE, re-apply, ACL ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde antes
relogio_on antes
contas "$(quatro 2026-10-28 0 "('colacor', 1, '2026-10-20', 100, true)")" antes
eq "A23 controle: o corpo de PROD diz ok com 1 conta parada há 8 dias (a fresca a esconde)" "$(ck status "$AG" UTC antes)" "ok"

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
  trocar "$TMP/mig-pre.sql" "  IF NOT (v_vivo = ANY (ARRAY[" "  IF false AND NOT (v_vivo = ANY (ARRAY[" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out20="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out20" in *"PRE FALHOU: public._data_health_compute() tem corpo md5"*) r20=recusou ;; *) r20=passou ;; esac
eq "A20 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r20|$(md5_vivo pre _data_health_compute)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde reap
r21="$(Pd reap -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && Pd reap -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A21 aplicar 2× = no-op (a PRE aceita o próprio corpo, a POS passa de novo)" "$r21|$(md5_vivo reap _data_health_compute)" "OK|$ESTE_C"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
Pd acl -q -c "GRANT EXECUTE ON FUNCTION public._data_health_compute() TO PUBLIC, anon, authenticated;"
cp "$MIG_USADA" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE não ocorre exatamente 1×"; exit 9; }
  trocar "$TMP/mig-acl.sql" "  IF v_vazado <> 0 THEN" "  IF false AND v_vazado <> 0 THEN" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS de ACL não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE (sem o REVOKE, POS de ACL desligada) — a suíte abaixo DEVE ficar vermelha"
fi
r22="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
vaz22="$(Pd acl -tA -c "SELECT count(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
                         WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');")"
eq "A22 com o EXECUTE aberto (deriva de ACL), aplicar a migration o fecha para PUBLIC/anon/authenticated" "$r22|$vaz22" "OK|0"

# ══════════════════════════════════════════════════════════════════
# DROP DEFAULT de saldo_atual — pelo upsert que o omie-financeiro faz
# ══════════════════════════════════════════════════════════════════
echo "═══ $(basename "$MIG_DEFAULT"): conta nova sem extrato nasce NULL ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde dflt
# a tabela como em prod (psql-ro 2026-10-31): DEFAULT 0 e a UNIQUE do onConflict
Pd dflt -q -c "ALTER TABLE public.fin_contas_correntes ALTER COLUMN saldo_atual SET DEFAULT 0;" \
           -c "CREATE UNIQUE INDEX fin_contas_correntes_company_omie_ncodcc_key ON public.fin_contas_correntes (company, omie_ncodcc);" \
           -c "TRUNCATE public.fin_contas_correntes;"
# O upsert do PostgREST: INSERT só das colunas do payload + ON CONFLICT DO UPDATE dessas colunas.
# Extrato falhou → o payload não tem saldo_atual/saldo_data.
upsert_sem_saldo() { Pd dflt -q -c "INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, ativo, updated_at)
  VALUES ('oben', $1, 'conta $1', true, now())
  ON CONFLICT (company, omie_ncodcc) DO UPDATE SET company = EXCLUDED.company, omie_ncodcc = EXCLUDED.omie_ncodcc,
    descricao = EXCLUDED.descricao, ativo = EXCLUDED.ativo, updated_at = EXCLUDED.updated_at;"; }
upsert_com_saldo() { Pd dflt -q -c "INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, ativo, updated_at, saldo_atual, saldo_data)
  VALUES ('oben', $1, 'conta $1', true, now(), $2, '$3')
  ON CONFLICT (company, omie_ncodcc) DO UPDATE SET company = EXCLUDED.company, omie_ncodcc = EXCLUDED.omie_ncodcc,
    descricao = EXCLUDED.descricao, ativo = EXCLUDED.ativo, updated_at = EXCLUDED.updated_at,
    saldo_atual = EXCLUDED.saldo_atual, saldo_data = EXCLUDED.saldo_data;"; }
linha() { Pd dflt -tA -c "SELECT COALESCE(saldo_atual::text, '(null)') || '/' || COALESCE(saldo_data::text, '(null)')
                            FROM public.fin_contas_correntes WHERE company = 'oben' AND omie_ncodcc = $1;"; }
padrao() { Pd dflt -tA -c "SELECT COALESCE(column_default, '(null)') FROM information_schema.columns
                             WHERE table_schema = 'public' AND table_name = 'fin_contas_correntes' AND column_name = 'saldo_atual';"; }
upsert_sem_saldo 101
eq "A24 controle: com o DEFAULT 0, a conta nova sem extrato nasce R\$ 0 sem data" "$(padrao)|$(linha 101)" "0|0.00/(null)"
cp "$MIG_DEFAULT" "$TMP/mig-default.sql"
if [ "${SABOTAGEM:-}" = "sem_drop_default" ]; then
  trocar "$TMP/mig-default.sql" "ALTER TABLE public.fin_contas_correntes ALTER COLUMN saldo_atual DROP DEFAULT;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o DROP DEFAULT não ocorre exatamente 1×"; exit 9; }
  trocar "$TMP/mig-default.sql" "  IF v_default IS NOT NULL OR" "  IF false AND v_default IS NOT NULL OR" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS do default não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em DROP DEFAULT (sem o DROP, POS desligada) — a suíte abaixo DEVE ficar vermelha"
fi
r25="$(Pd dflt -q -1 -f "$TMP/mig-default.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
upsert_sem_saldo 102
eq "A25 depois: sem default, e a conta nova sem extrato nasce NULL/NULL" "$r25|$(padrao)|$(linha 102)" "OK|(null)|(null)/(null)"
upsert_com_saldo 103 1500 2026-10-27
upsert_sem_saldo 103
upsert_com_saldo 104 0 2026-10-28
eq "A28 conta existente com extrato falho preserva; sucesso com saldo zero grava 0 e a data" "$(linha 103)|$(linha 104)" \
   "1500.00/2026-10-27|0.00/2026-10-28"
eq "A29 aplicar o DROP DEFAULT 2× = no-op" "$(Pd dflt -q -1 -f "$TMP/mig-default.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)|$(padrao)" "OK|(null)"

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
