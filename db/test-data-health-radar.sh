#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — Sentinela do Radar: radar_lote_idade + radar_recruzamento_tick
# ║      bash db/test-data-health-radar.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-radar.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-radar.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Autocontida: initdb + db/stubs-supabase.sql + db/stubs-data-health-trio.sql + a CADEIA VIVA do
# ║  trio (db/lib/data-health-vivo.sh) SEM a migration desta entrega + o patch por âncora que prod
# ║  recebeu fora de migrations (db/2026-10-11-cron-reconciliar-pedidos-colacor.sql) — o banco chega ao
# ║  md5 EXATO do compute de PROD (A1) antes de a migration real aplicar sobre ele.
# ║   · relógio CONTROLADO (public.now() lê a GUC test.agora; o compute passa a resolvê-lo por
# ║     search_path, idioma de db/test-data-health-sync-reprocess.sh): lote 59 d → ok, 60 d → ok,
# ║     61 d → stale; vazio → broken; idade pela REFERÊNCIA (finalizado_em = agora não rejuvenesce;
# ║     lote running mais novo não conta); ledger 47 h → ok, 49 h → stale, vazio → broken, linha de
# ║     erro mais nova não conta como sucesso; message constante com o relógio andando (fingerprint);
# ║   · as 3 pernas do trio EXECUTAM: watchdog roteia os 2 sources (spy do episódio) e conta 25;
# ║   · em clones da prod de hoje: a PRE recusa corpo estranho, a POS tem dente, o REVOKE fecha ACL
# ║     aberto; reaplicar = no-op.
# ║  Diário: docs/historico/radar-sentinela-lote-idade-e-recruzamento.md
# ╚═════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5641}"
SLUG="data-health-radar"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar),
# e cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle),
# (3) CADA assert declarado estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o
# controle não tem. docs/historico/falsificacao-exit-nao-e-dente.md
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="limiar_73:A6,A8 referencia_finalizado:A9 janela_72h:A29 erro_conta_como_sucesso:A15
              fora_do_v_sources:A19,A21 fora_do_heartbeat:A22 pre_sem_identidade:A25 pos_sem_dente:A26 sem_revoke:A27
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

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_radar_lote_e_recruzamento.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration desta entrega ausente — a prova testaria o NADA"; exit 1; }
MD5_PROD_COMPUTE="ca824f4f04b38e57402320a9f354b169"   # psql-ro 2026-10-20 (20261005220100 + patch colacor/operational/orders)
MD5_PROD_WD="633a9b716ca9d2957816cd115fca304e"
MD5_PROD_HB="6be719aafa51f2d569ab8c643ac29951"

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
  # O patch por âncora que prod recebeu FORA de migrations (db/2026-10-11-cron-reconciliar-pedidos-
  # colacor.sql, só a parte da função): sem ele a cadeia pára 1 linha antes do corpo de PROD.
  P -q <<'SQL'
DO $patch$
DECLARE
  v_fn   constant text := 'public._data_health_compute()';
  v_anc  constant text := E'                 (''colacor'',      ''status_produtos'',      ''sku_status_omie'',                30),\n';
  v_nova constant text := E'                 (''colacor'',      ''operational'',          ''orders'',                          4),\n';
  v_def  text;
BEGIN
  v_def := pg_get_functiondef(to_regprocedure(v_fn));
  IF (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'patch: a ancora (colacor/status_produtos) nao aparece 1x no corpo vivo';
  END IF;
  IF position(v_nova IN v_def) > 0 THEN
    RAISE EXCEPTION 'patch: a chave colacor/operational/orders ja esta no catalogo';
  END IF;
  EXECUTE replace(v_def, v_anc, v_anc || v_nova);
END $patch$;
SQL
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
POS_V="    IF position('''' || v_src || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % fora do v_sources"
POS_H="    IF position('''' || v_src || '''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % fora da IN-list"
case "${SABOTAGEM:-}" in
  "") ;;
  limiar_73)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "             interval '75 days' AS teto," "             interval '73 days' AS teto," \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o limiar do lote não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (limiar do lote 75 → 73 dias, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  referencia_finalizado)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "                  THEN (to_date(x.ultimo_mes, 'YYYY-MM') + interval '1 month' - interval '1 day')::date::timestamptz" \
      "                  THEN (SELECT max(s2.finalizado_em) FROM public.radar_ingest_state s2 WHERE s2.status = 'complete')" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a referência do lote não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (idade do lote por finalizado_em, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  janela_72h)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "             interval '50 hours' AS janela" "             interval '72 hours' AS janela" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a janela do tick não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (janela do tick 50 → 72 h, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  erro_conta_como_sucesso)
    sabotar_corpo "$TMP/mig.sql" _data_health_compute "FILTER (WHERE ae.status = 'sucesso') AS ultimo_sucesso" "AS ultimo_sucesso" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o filtro de sucesso não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em corpo (ledger sem filtro de status, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  fora_do_v_sources)
    sabotar_corpo "$TMP/mig.sql" data_health_watchdog "    'radar_lote_idade','radar_recruzamento_tick'];" "    'radar_recruzamento_tick'];" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o par no v_sources não ocorre exatamente 1×"; exit 9; }
    # a POS textual pegaria antes do watchdog rodar — desliga-se SÓ ela, para medir o dente do assert
    trocar "$TMP/mig.sql" "$POS_V" "${POS_V/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS do v_sources não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em watchdog (radar_lote_idade fora do v_sources, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  fora_do_heartbeat)
    sabotar_corpo "$TMP/mig.sql" fin_sync_heartbeat "                   'radar_lote_idade','radar_recruzamento_tick');" "                   'radar_lote_idade');" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o par na IN-list não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_H" "${POS_H/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS da IN-list não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em heartbeat (radar_recruzamento_tick fora da IN-list, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
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
eq "A4 1 linha por source no compute INTEIRO, 33 sources, 2 delas radar_%" \
   "$(Pq -c "SELECT count(*) || '/' || count(DISTINCT source) || '/' || count(*) FILTER (WHERE source LIKE 'radar\_%') FROM public._data_health_compute();")" "33/33/2"

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
# cada leitura na SUA sessão (o SET morre com ela)
lote()   { Pq -q -c "SET test.agora = '$1'" -c "SELECT $2 FROM public._data_health_compute() WHERE source = 'radar_lote_idade';"; }
tick()   { Pq -q -c "SET test.agora = '$1'" -c "SELECT $2 FROM public._data_health_compute() WHERE source = 'radar_recruzamento_tick';"; }
# referência do lote 2026-08 = 31/08/2026 00:00 no fuso da SESSÃO (o mesmo cast do compute), lido do
# próprio servidor — a prova não assume fuso.
REF="$(Pq -c "SELECT ('2026-08-31'::date::timestamptz)::text;")"
em() { Pq -c "SELECT ('$REF'::timestamptz + interval '$1')::text;"; }

echo "═══ radar_lote_idade (idade pela REFERÊNCIA do dump, limiar 75 dias) ═══"
eq "A5 tabela VAZIA ⇒ broken, age NULL (ausente ≠ zero)" "$(lote "$(em '1 day')" "status || '|' || COALESCE(age_seconds::text, 'NULL')")" "broken|NULL"
P -q -c "INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, finalizado_em)
         VALUES ('2026-05', 'complete', 526176, '2026-06-13 11:00+00', '2026-06-13 11:52+00'),
                ('2026-08', 'complete', 501380, '2026-10-19 16:00+00', '2026-10-19 16:40+00');"
eq "A6 lote 2026-08 com 74 dias desde 31/08 ⇒ ok, age=74 d" "$(lote "$(em '74 days')" "status || '|' || age_seconds")" "ok|$((74*86400))"
eq "A7 76 dias ⇒ stale (o limiar é 75, pela referência)"     "$(lote "$(em '76 days')" "status || '|' || age_seconds")" "stale|$((76*86400))"
eq "A8 75 dias exatos ⇒ ok (> 75, não ≥)"                    "$(lote "$(em '75 days')" "status")" "ok"
eq "A33 domain vendas (o front valida fail-closed), expected_max_age = 75 d, severity warning" \
   "$(lote "$(em '1 day')" "domain || '|' || expected_max_age_seconds || '|' || severity")" "vendas|$((75*86400))|warning"
# idade pela REFERÊNCIA: reprocessar o lote hoje (finalizado_em = agora) não rejuvenesce a foto, e um
# lote `running` de mês mais novo não conta (só complete).
P -q -c "UPDATE public.radar_ingest_state SET finalizado_em = '$(em '76 days')'::timestamptz WHERE mes_referencia = '2026-08';
         INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em)
         VALUES ('2026-09', 'running', 0, '$(em '76 days')'::timestamptz - interval '1 hour');"
eq "A9 finalizado_em = agora E lote 2026-09 running ⇒ continua stale (referência é o dump, só complete conta)" \
   "$(lote "$(em '76 days')" "status || '|' || age_seconds")" "stale|$((76*86400))"
M1="$(lote "$(em '76 days')" "message")"; M2="$(lote "$(em '76 days 5 hours')" "message")"
eq "A10 message do stale é CONSTANTE com o relógio andando (fingerprint do watchdog, sem idade corrente)" "$([ "$M1" = "$M2" ] && echo igual || echo mudou)" "igual"
eq "A11 message cita o mês e a data de referência (31/08/2026), não a de finalizado_em" \
   "$(printf '%s' "$M1" | grep -c '2026-08.*31/08/2026' || true)" "1"
P -q -c "UPDATE public.radar_ingest_state SET status = 'error', erro = 'HTTP 500 na sonda' WHERE mes_referencia = '2026-09';"
eq "A12 last_error traz o erro do lote em error MAIS NOVO que o completo; probable_cause/how_to_fix apontam Action e secret" \
   "$(lote "$(em '76 days')" "last_error || '|' || (probable_cause LIKE '%radar-carga-mensal%' AND probable_cause LIKE '%RADAR_CRON_SECRET%')::text || '|' || (how_to_fix LIKE '%gh workflow run radar-carga-mensal.yml%')::text")" \
   "HTTP 500 na sonda|true|true"
P -q -c "UPDATE public.radar_ingest_state SET mes_referencia = '2026-06' WHERE mes_referencia = '2026-09';"
eq "A34 erro de um mês MAIS VELHO que o último completo não vira last_error (junho não explica setembro)" \
   "$(lote "$(em '76 days')" "status || '|' || COALESCE(last_error, 'NULL')")" "stale|NULL"
P -q -c "DELETE FROM public.radar_ingest_state WHERE status = 'complete';"
eq "A35 só lotes em error (Action quebrada desde o 1º dia) ⇒ broken COM o last_error" \
   "$(lote "$(em '1 day')" "status || '|' || COALESCE(last_error, 'NULL')")" "broken|HTTP 500 na sonda"
P -q -c "TRUNCATE public.radar_ingest_state;
         INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido) VALUES ('2026-13', 'complete', 1);"
eq "A36 mes_referencia inválido (o CHECK aceita 2026-13) ⇒ broken com message própria, e o compute NÃO cai (33 linhas)" \
   "$(lote "$(em '1 day')" "status || '|' || (message LIKE '%invalido%2026-13%')::text")|$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "broken|true|33"
# aritmética de mês fora de agosto: fevereiro tem 28 dias — '+ 1 month - 1 day' dá 28/02, e uma
# sabotagem "30 dias fixos" (01/02 + 30 d = 03/03) passaria todos os asserts de agosto.
P -q -c "TRUNCATE public.radar_ingest_state;
         INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido) VALUES ('2026-02', 'complete', 1);"
REF2="$(Pq -c "SELECT ('2026-02-28'::date::timestamptz)::text;")"
em2() { Pq -c "SELECT ('$REF2'::timestamptz + interval '$1')::text;"; }
eq "A37 lote 2026-02: referência 28/02 — 74 dias depois ⇒ ok" "$(lote "$(em2 '74 days')" "status || '|' || (message LIKE '%28/02/2026%')::text")" "ok|true"
eq "A38 lote 2026-02: 76 dias depois de 28/02 ⇒ stale (30 dias fixos daria 73 e passaria)" "$(lote "$(em2 '76 days')" "status || '|' || age_seconds")" "stale|$((76*86400))"

echo "═══ radar_recruzamento_tick (sucesso nas últimas 50 h = 2 cadências + folga) ═══"
T0="$(em '0 days')"
eq "A13 ledger VAZIO ⇒ broken, age NULL" "$(tick "$T0" "status || '|' || COALESCE(age_seconds::text, 'NULL')")" "broken|NULL"
P -q -c "INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
         VALUES ('radar.recruzar_ja_cliente', 'automatica', '$T0'::timestamptz - interval '47 hours 10 seconds',
                 '$T0'::timestamptz - interval '47 hours', 'sucesso', '{\"marcados\": 8}'),
                ('outra.acao', 'automatica', '$T0'::timestamptz - interval '1 hour', '$T0'::timestamptz - interval '1 hour', 'sucesso', '{}');"
eq "A14 sucesso há 47 h ⇒ ok (outro slug não conta); expected_max_age = 50 h; domain vendas" \
   "$(tick "$T0" "status || '|' || age_seconds || '|' || expected_max_age_seconds || '|' || domain")" "ok|$((47*3600))|$((50*3600))|vendas"
eq "A39 sucesso há 49 h ⇒ ainda ok (1 rodada perdida + jitter não alarma)" "$(tick "$(em '2 hours')" "status")" "ok"
eq "A29 sucesso há 51 h ⇒ stale (numerado fora de ordem: o laço só lê A<n>)" "$(tick "$(em '4 hours')" "status || '|' || age_seconds")" "stale|$((51*3600))"
P -q -c "INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
         VALUES ('radar.recruzar_ja_cliente', 'manual', '$T0'::timestamptz + interval '1 hour', '$T0'::timestamptz + interval '1 hour', 'erro', '{\"erro\": \"x\"}');"
eq "A15 linha de ERRO mais nova não conta como sucesso ⇒ segue stale pelo último sucesso" \
   "$(tick "$(em '4 hours')" "status || '|' || age_seconds")" "stale|$((51*3600))"
M3="$(tick "$(em '4 hours')" "message")"; M4="$(tick "$(em '9 hours')" "message")"
eq "A16 message do stale é CONSTANTE com o relógio andando e cita o último sucesso em BRT" \
   "$([ "$M3" = "$M4" ] && echo igual || echo mudou)|$(printf '%s' "$M3" | grep -c 'sem sucesso desde .* BRT$' || true)" "igual|1"
eq "A17 how_to_fix aponta cron.job_run_details pelo jobname e o tick à mão" \
   "$(tick "$(em '4 hours')" "(how_to_fix LIKE '%cron.job_run_details%radar-recruzar-ja-cliente-diario%')::text || '|' || (how_to_fix LIKE '%radar_recruzar_ja_cliente_tick()%')::text")" "true|true"

# Desliga o relógio controlado: o resto roda no compute EXATAMENTE como a migration o deixou.
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"
P -q -c "DROP FUNCTION public.now();"
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$cfg_compute]"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# AS 3 PERNAS DO TRIO EXECUTAM (late-bound: CREATE não prova nada)
# ══════════════════════════════════════════════════════════════════
echo "═══ trio: watchdog roteia os 2 sources; heartbeat executa ═══"
# estado real: lote de 2026-08 está a >60 d do relógio de verdade (hoje ≥ 2026-10-31? não — por isso
# o lote vai para 2026-01) e o ledger sem sucesso ⇒ os 2 checks não-ok.
P -q -c "TRUNCATE public.radar_ingest_state; TRUNCATE public.acoes_execucoes; TRUNCATE public._spy_episodio;
         INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido) VALUES ('2026-01', 'complete', 10);"
eq "A18 no relógio real: lote 2026-01 stale, ledger vazio broken" \
   "$(Pq -c "SELECT string_agg(source || '=' || status, ',' ORDER BY source) FROM public._data_health_compute() WHERE source LIKE 'radar\_%';")" \
   "radar_lote_idade=stale,radar_recruzamento_tick=broken"
saida_wd="$(P -q -c "SELECT public.data_health_watchdog();" 2>&1)" && rc_wd=0 || rc_wd=$?
[ "$rc_wd" -eq 0 ] || printf '%s\n' "$saida_wd"
eq "A19 watchdog avalia 25 checks (o v_sources: 23 + 2) sem exceção do compute" \
   "$rc_wd | $(Pq -c "SELECT checks_avaliados::text || '/' || checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0 | 25/0"
eq "A20 watchdog ROTEOU radar_recruzamento_tick para o push (_data_health_episodio)" \
   "$(Pq -c "SELECT (count(*) = 1)::text FROM public._spy_episodio WHERE tipo = 'data_health_radar_recruzamento_tick' AND status = 'broken';")" "true"
eq "A21 watchdog ROTEOU radar_lote_idade para o push" \
   "$(Pq -c "SELECT (count(*) = 1)::text FROM public._spy_episodio WHERE tipo = 'data_health_radar_lote_idade' AND status = 'stale';")" "true"
saida_hb="$(P -q -c "SELECT public.fin_sync_heartbeat();" 2>&1)" && rc_hb=0 || rc_hb=$?
[ "$rc_hb" -eq 0 ] || printf '%s\n' "$saida_hb"
eq "A22 fin_sync_heartbeat executa e o RESUMO que ele grava em fornecedor_alerta lista os 2 sources com o status" \
   "$rc_hb|$(Pq -c "SELECT (count(*) >= 1)::text FROM public.fornecedor_alerta WHERE mensagem LIKE '%radar_lote_idade: stale%' AND mensagem LIKE '%radar_recruzamento_tick: broken%';")" "0|true"
eq "A23 os 2 sources estão no v_sources do watchdog (texto vivo)" \
   "$(Pq -c "SELECT (d LIKE '%''radar_lote_idade''%' AND d LIKE '%''radar_recruzamento_tick''%')::text FROM (SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure) d) s;")" "true"
eq "A24 o trio segue FECHADO a anon/authenticated/PUBLIC (só service_role executa)" \
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
  IF (length(v_def) - length(replace(v_def, '  WITH checks AS (', ''))) / length('  WITH checks AS (') <> 1 THEN
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
sabotar_corpo "$TMP/mig-posv.sql" data_health_watchdog "    'radar_lote_idade','radar_recruzamento_tick'];" "    'radar_recruzamento_tick'];" \
  || { echo "❌ o par no v_sources mudou de forma — o A30 não monta o caso"; exit 1; }
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
eq "A30 a PÓS recusa sozinha um watchdog sem radar_lote_idade no v_sources" "$r30" "recusou:v_sources"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde posh
cp "$MIG" "$TMP/mig-posh.sql"
sabotar_corpo "$TMP/mig-posh.sql" fin_sync_heartbeat "                   'radar_lote_idade','radar_recruzamento_tick');" "                   'radar_lote_idade');" \
  || { echo "❌ o par na IN-list mudou de forma — o A31 não monta o caso"; exit 1; }
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
eq "A31 a PÓS recusa sozinha um heartbeat sem radar_recruzamento_tick na IN-list" "$r31" "recusou:in_list"

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
