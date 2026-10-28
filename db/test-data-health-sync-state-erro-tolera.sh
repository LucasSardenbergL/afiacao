#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — sync_state_saude: 1 run que falhou NÃO é "Sync Omie PARADO"
# ║      bash db/test-data-health-sync-state-erro-tolera.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-sync-state-erro-tolera.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-sync-state-erro-tolera.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Autocontida: initdb + stubs + a CADEIA VIVA do trio (db/lib/data-health-vivo.sh) SEM a migration
# ║  desta entrega — o banco chega ao md5 EXATO do compute de PROD (A1) antes de ela aplicar.
# ║   · relógio CONTROLADO (public.now() lê a GUC test.agora, idioma de db/test-data-health-radar.sh);
# ║   · 'error' em par com SLA: dentro do SLA ⇒ ok; além ⇒ broken (falhou); par fora da lista, writer
# ║     que carimba last_sync_at no erro e last_sync_at NULL seguem broken na hora (fail-closed);
# ║   · reposicao_estoque_full/oben ganha o eixo de estagnação (16h); 'partial' não muda;
# ║   · message constante com o relógio andando (fingerprint do watchdog);
# ║   · em clones da prod de hoje: a PRE recusa corpo estranho, reaplicar = no-op, o REVOKE fecha ACL.
# ║  Diário: docs/historico/sync-state-saude-erro-tolera-um-ciclo.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5671}"
SLUG="data-health-sync-state-erro-tolera"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar),
# e cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle),
# (3) CADA assert declarado estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o
# controle não tem. docs/historico/falsificacao-exit-nao-e-dente.md
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_tolerancia:A6,A7,A10 sla_estoque_12h:A7 sem_guarda_carimbo:A13 eixo1_sem_null:A14
              estoque_fora_da_lista:A6,A9 pre_sem_identidade:A20 sem_revoke:A22"
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

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_sync_state_erro_tolera_um_ciclo.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration desta entrega ausente — a prova testaria o NADA"; exit 1; }
MD5_PROD_COMPUTE="193a1dbbee51221c96876a003b2a4003"   # psql-ro 2026-10-28 (= 20261020101636)
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
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  [ "$f" = "$MIG" ] && continue
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
POS_LISTA="  IF position('(''reposicao_estoque_full'',''oben'',           16)' IN v_def) = 0"
case "${SABOTAGEM:-}" in
  "") ;;
  sem_tolerancia)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "                           AND (r1.sla_h IS NULL" "                           AND (true OR r1.sla_h IS NULL" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a tolerância não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (todo 'error' volta a ser broken na hora, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  sla_estoque_12h)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "            ('reposicao_estoque_full','oben',           16)" "            ('reposicao_estoque_full','oben',           12)" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o SLA do estoque não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_LISTA" "${POS_LISTA/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS da lista não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (SLA do estoque 16 → 12 h, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  sem_guarda_carimbo)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "                                OR ss.last_sync_at >= COALESCE(ss.updated_at, ss.created_at) - interval '1 minute'
" "" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a guarda do carimbo não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (sem a guarda do writer que carimba no erro, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  eixo1_sem_null)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "                                OR ss.last_sync_at IS NULL
" "" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o ramo NULL não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (eixo 1 sem o ramo last_sync_at NULL, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  estoque_fora_da_lista)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "            ('inventory',       'servicos',              6), -- sync-inventory-servicos-1h         25 * * * *" \
      "            ('inventory',       'servicos',              6)  -- sync-inventory-servicos-1h         25 * * * *
            , ('reposicao_estoque_full_X','oben',           16)" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o fim da lista não ocorre exatamente 1×"; exit 9; }
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "            ('reposicao_estoque_full','oben',           16)  --" "            --" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o par do estoque não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_LISTA" "${POS_LISTA/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS da lista não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (reposicao_estoque_full fora da lista, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  pre_sem_identidade|sem_revoke) ;;   # nos clones (A20, A22)
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
P -q <<SQL
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS \$f\$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now()) \$f\$;
ALTER FUNCTION public._data_health_compute() SET search_path = $sp_relogio;
SQL
AG='2026-10-28 09:00:00+00'
# cada leitura na SUA sessão (o SET morre com ela); $2 = agora (default AG)
ck() { Pq -q -c "SET test.agora = '${2:-$AG}'" -c "SELECT $1 FROM public._data_health_compute() WHERE source = 'sync_state_saude';"; }
# Todos os pares da lista com SLA saudáveis (sucesso há 10 min); $1 = SQL do cenário por cima.
cenario() {
  P -q -c "TRUNCATE public.sync_state;" -c "
    INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, updated_at, created_at)
    SELECT v.et, v.acc, 'complete', '$AG'::timestamptz - interval '10 minutes',
           '$AG'::timestamptz - interval '10 minutes', '$AG'::timestamptz - interval '30 days'
      FROM (VALUES ('customers','vendas'), ('customers','colacor_vendas'), ('customers','servicos'),
                   ('products_metadados','oben'), ('products_metadados','colacor'), ('products','colacor_vendas'),
                   ('inventory','vendas'), ('inventory','colacor_vendas'), ('inventory','servicos'),
                   ('reposicao_estoque_full','oben')) AS v(et, acc);" -c "$1"
}
# 'error' gravado há $3 com o último sucesso há $4 (o writer preserva last_sync_at no erro)
erro() { printf "UPDATE public.sync_state SET status = 'error', error_message = 'TimeoutError: Signal timed out.', updated_at = '%s'::timestamptz - interval '%s', last_sync_at = '%s'::timestamptz - interval '%s' WHERE entity_type = '%s' AND account = '%s';" "$AG" "$3" "$AG" "$4" "$1" "$2"; }
SV="status || '|' || message"
PARADO_ESTOQUE="broken|Sync Omie PARADO: reposicao_estoque_full/oben (falhou)"

echo "═══ sync_state_saude: 'error' em par com SLA tolera 1 ciclo ═══"
cenario "SELECT 1"
eq "A5 todos os pares saudáveis ⇒ ok" "$(ck "$SV")" "ok|Syncs Omie: todos os marcadores saudaveis"
cenario "$(erro reposicao_estoque_full oben '1 minute' '2 hours')"
eq "A6 estoque: 1 intraday falhou, último sucesso há 2h ⇒ ok (o incidente de 27/10)" "$(ck "$SV")" "ok|Syncs Omie: todos os marcadores saudaveis"
cenario "$(erro reposicao_estoque_full oben '13 hours 20 minutes' '15 hours 25 minutes')"
eq "A7 estoque: o das 19:40Z falhou e ainda é 09:00Z (último sucesso há 15h25m) ⇒ ok" "$(ck "$SV")" "ok|Syncs Omie: todos os marcadores saudaveis"
cenario "$(erro reposicao_estoque_full oben '1 minute' '16 hours 30 minutes')"
eq "A8 estoque: 2º run seguido falhou (último sucesso há 16h30m > 16h) ⇒ broken (falhou)" "$(ck "$SV")" "$PARADO_ESTOQUE"
cenario "UPDATE public.sync_state SET last_sync_at = '$AG'::timestamptz - interval '17 hours', updated_at = '$AG'::timestamptz - interval '17 hours' WHERE entity_type = 'reposicao_estoque_full';"
eq "A9 estoque 'complete' mas sem sucesso há 17h (marcador parou) ⇒ broken pelo eixo de estagnação NOVO" \
   "$(ck "status || '|' || (message LIKE 'Sync Omie PARADO: reposicao\_estoque\_full/oben (sem sucesso desde %')::text")" "broken|true"
cenario "$(erro inventory vendas '5 minutes' '1 hour')"
eq "A10 inventory/vendas: 1 run falhou, último sucesso há 1h (SLA 3h) ⇒ ok" "$(ck "$SV")" "ok|Syncs Omie: todos os marcadores saudaveis"
cenario "$(erro inventory vendas '5 minutes' '4 hours')"
eq "A11 inventory/vendas: falha persiste há 4h (> SLA 3h) ⇒ broken (falhou)" "$(ck "$SV")" "broken|Sync Omie PARADO: inventory/vendas (falhou)"
cenario "INSERT INTO public.sync_state (entity_type, account, status, error_message, last_sync_at, updated_at, created_at)
         VALUES ('pedidos_compra_encerrados', 'oben', 'error', 'x', '$AG'::timestamptz - interval '10 minutes',
                 '$AG'::timestamptz - interval '1 minute', '$AG'::timestamptz - interval '30 days');"
eq "A12 par FORA da lista (cadência desconhecida) ⇒ broken na hora, como antes" "$(ck "$SV")" "broken|Sync Omie PARADO: pedidos_compra_encerrados/oben (falhou)"
cenario "UPDATE public.sync_state SET status = 'error', error_message = 'x', last_sync_at = '$AG'::timestamptz - interval '5 minutes', updated_at = '$AG'::timestamptz - interval '5 minutes' WHERE entity_type = 'inventory' AND account = 'vendas';"
eq "A13 writer que CARIMBA last_sync_at no próprio erro ⇒ broken na hora (fail-closed)" "$(ck "$SV")" "broken|Sync Omie PARADO: inventory/vendas (falhou)"
cenario "UPDATE public.sync_state SET status = 'error', error_message = 'x', last_sync_at = NULL WHERE entity_type = 'inventory' AND account = 'vendas';"
eq "A14 'error' com last_sync_at NULL ⇒ broken pelo eixo 1 (falhou), não só pela idade inferida" "$(ck "$SV")" "broken|Sync Omie PARADO: inventory/vendas (falhou)"
cenario "UPDATE public.sync_state SET status = 'partial' WHERE entity_type = 'inventory' AND account = 'vendas';"
eq "A15 'partial' não muda: stale (coleta parcial)" "$(ck "$SV")" "stale|Sync Omie degradado: inventory/vendas (coleta parcial)"
cenario "$(erro reposicao_estoque_full oben '1 minute' '16 hours 30 minutes')"
# +2h, nao +3h: os pares semeados saudaveis tambem envelhecem, e inventory/vendas tem SLA de 3h.
eq "A16 message constante com o relógio andando 2h (fingerprint do watchdog não re-emaila)" \
   "$(ck message '2026-10-28 11:00:00+00')" "${PARADO_ESTOQUE#broken|}"
eq "A17 severity segue critical" "$(ck severity)" "critical"

# relógio desligado: o search_path volta ao da migration
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"

# ══════════════════════════════════════════════════════════════════
# EM CLONES DA PROD DE HOJE (molde): PRE, re-apply, ACL
# ══════════════════════════════════════════════════════════════════
echo "═══ em clones da prod de hoje (molde): PRE, re-apply, ACL ═══"
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

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
