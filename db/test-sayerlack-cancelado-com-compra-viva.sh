#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261110120000_sayerlack_cancelado_com_compra_viva.sql (5.4 + cobertura, Onda 5A fatia 2)
# ║      bash db/test-sayerlack-cancelado-com-compra-viva.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-sayerlack-cancelado-com-compra-viva.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-sayerlack-cancelado-com-compra-viva.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Autocontida: initdb + stubs + a CADEIA VIVA do trio (db/lib/data-health-vivo.sh) SEM esta migration (o banco
# ║  chega ao md5 EXATO de prod, A1) + o recorte da fatia 1 e a 5.3 (predecessoras em prod).
# ║   B  incidente: nasce do estado do pedido (6 sobre PO, PO sobre 6), não fecha com leitura posterior nem com
# ║      cancelamento fora da porta; fecha pela porta pós-disparo ou por master com justificativa; só-resolve.
# ║      PO vivo no espelho depois de um encerramento da 5.3 também alerta. Message cita o mais recente.
# ║   C  cobertura: pedido com PO não faturado precisa de leitura no dia útil exigido (régua de SP).
# ║   A  as 3 pernas do trio EXECUTAM; em clones da prod de hoje: PRE, POS, ACL, re-apply.
# ║  Diário: docs/historico/importar-pedido-portal-sayerlack.md
# ╚═════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5791}"
SLUG="sayerlack-cancelado-com-compra-viva"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_incidente_no_trigger:B2,B4 leitura_posterior_fecha:B3 fecha_sem_porta:B6 so_resolve_off:B8
              cobertura_ignora_faturado:C4 cobertura_ignora_protocolo:C5 sem_espelho_pos_encerrar:B11b
              mais_recente_errado:B4b stale_sem_regua:C3 sem_claim_no_trigger:B10 espelho_sem_trigger:B9b
              espelho_fail_closed:B11 fora_do_v_sources:A41,A43 fora_do_heartbeat:A42
              pre_sem_identidade:A25 pos_sem_dente:A26 sem_revoke:A27 pos_v_sources_sem_dente:A30
              pos_heartbeat_sem_dente:A31 pos_acl_sem_dente:A32"
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
    vermelhos="$(grep -Eo '^  ❌ [A-Z][0-9]+[a-z]? ' "$log" | grep -Eo '[A-Z][0-9]+[a-z]?' | tr '\n' ' ' || true)"
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

MIG="$REPO_ROOT/supabase/migrations/20261110120000_sayerlack_cancelado_com_compra_viva.sql"
MIG_53="$REPO_ROOT/supabase/migrations/20261110100000_sayerlack_encerrar_cancelado_no_portal.sql"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration desta entrega ausente — a prova testaria o NADA"; exit 1; }
MD5_PROD_COMPUTE="0590d3aa400d44f5d6e3924e5e3eab78"   # psql-ro 2026-11-08 (= 20261107220000)
MD5_PROD_WD="01bdb4df838d9d51d3aa1f69a728b6a7"        # psql-ro 2026-11-08 (= 20261107220000)
MD5_PROD_HB="70a4d2628ebfa0921cffcdd5173ca60f"

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
  # Recorte de prod que a 5.3 e esta entrega leem: colunas da situação (fatia 1, 20261108120000) e o espelho do Omie.
  P -q <<'SQL'
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS portal_situacao_codigo text, ADD COLUMN IF NOT EXISTS portal_situacao_texto text,
  ADD COLUMN IF NOT EXISTS portal_situacao_em timestamptz, ADD COLUMN IF NOT EXISTS portal_situacao_ate timestamptz,
  ADD COLUMN IF NOT EXISTS portal_situacao_protocolo text, ADD COLUMN IF NOT EXISTS portal_situacao_gravada_em timestamptz;
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, empresa text NOT NULL, status text, omie_codigo_pedido bigint,
  omie_codigo_integracao text, numero_contrato_fornecedor text, t2_data_faturamento timestamptz, encerrado_omie_em timestamptz);
SQL
  P -q -1 -f "$MIG_53" >/dev/null || { echo "❌ a 5.3 (predecessora desta entrega em prod) não aplicou"; return 1; }
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
sab_fora() {  # sabotagem FORA do trio (objetos da 5.4): o md5 do trio não muda
  trocar "$TMP/mig.sql" "$1" "$2" || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão ($3) não ocorre exatamente 1×"; exit 9; }
  MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em $3 — a suíte abaixo DEVE ficar vermelha"
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_incidente_no_trigger) sab_fora "  IF NEW.empresa = 'OBEN' AND NEW.portal_situacao_codigo = '6' AND (v_po IS NOT NULL OR NEW.disparo_claim_em IS NOT NULL)" \
                                     "  IF false AND NEW.empresa = 'OBEN'" "trigger que não abre o incidente" ;;
  leitura_posterior_fecha)  # o desenho v1: o source lia a situação ATUAL (o 6 trocado por 1 apagava o aviso)
    sab_compute "             WHERE i.resolvido_em IS NULL
            UNION ALL" "             WHERE i.resolvido_em IS NULL
               AND EXISTS (SELECT 1 FROM public.pedido_compra_sugerido px WHERE px.id = i.pedido_id AND px.portal_situacao_codigo = '6')
            UNION ALL" "aviso que some com leitura posterior" ;;
  fecha_sem_porta) sab_fora "     AND NULLIF(current_setting('app.correcao_cancelamento_pos_disparo', true), '') IS NOT DISTINCT FROM NEW.id::text THEN" \
                            "     THEN" "fecha o incidente em qualquer cancelamento" ;;
  so_resolve_off) sab_fora "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__incidente_so_resolve();" \
                           "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__incidente_so_resolve();
ALTER TABLE public.sayerlack_incidente_cancelado_com_po DISABLE TRIGGER trg_incidente_so_resolve;" "incidente sem a trava só-resolve"
    trocar "$TMP/mig.sql" "                   AND tgrelid = 'public.sayerlack_incidente_cancelado_com_po'::regclass AND tgenabled <> 'D') THEN" \
      "                   AND tgrelid = 'public.sayerlack_incidente_cancelado_com_po'::regclass AND tgenabled <> 'D') AND false THEN" || exit 9 ;;
  cobertura_ignora_faturado) sab_fora "          AND (t.t2_data_faturamento IS NOT NULL OR t.encerrado_omie_em IS NOT NULL
               OR t.status::text IN ('FATURADO', 'RECEBIDO', 'CANCELADO')))" "          AND false)" "cobertura cobra pedido já faturado" ;;
  cobertura_ignora_protocolo) sab_fora "         CASE WHEN p.portal_situacao_protocolo = btrim(p.portal_protocolo) THEN p.portal_situacao_ate END" \
                                       "         p.portal_situacao_ate" "leitura de outro protocolo conta" ;;
  sem_espelho_pos_encerrar) sab_compute "               AND EXISTS (
               SELECT 1 FROM public.purchase_orders_tracking t" "               AND false AND EXISTS (
               SELECT 1 FROM public.purchase_orders_tracking t" "rede calculada do espelho desligada" ;;
  sem_claim_no_trigger) sab_fora "  IF NEW.empresa = 'OBEN' AND NEW.portal_situacao_codigo = '6' AND (v_po IS NOT NULL OR NEW.disparo_claim_em IS NOT NULL)" \
                                 "  IF NEW.empresa = 'OBEN' AND NEW.portal_situacao_codigo = '6' AND (v_po IS NOT NULL)" "6 sobre pendência de disparo não abre" ;;
  espelho_sem_trigger) sab_fora "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__incidente_pelo_espelho();" \
                                "  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__incidente_pelo_espelho();
ALTER TABLE public.purchase_orders_tracking DISABLE TRIGGER trg_incidente_pelo_espelho;" "espelho só no broken calculado"
    trocar "$TMP/mig.sql" "                   AND tgrelid = 'public.purchase_orders_tracking'::regclass AND tgenabled <> 'D') THEN" \
      "                   AND tgrelid = 'public.purchase_orders_tracking'::regclass AND tgenabled <> 'D') AND false THEN" || exit 9 ;;
  espelho_fail_closed) sab_fora "  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sayerlack__incidente_pelo_espelho" "  EXCEPTION WHEN division_by_zero THEN
    RAISE WARNING 'sayerlack__incidente_pelo_espelho" "erro do trigger derruba o sync" ;;
  mais_recente_errado) sab_compute "ORDER BY b.desde DESC, b.pedido_id DESC))[1] AS mais_recente" "ORDER BY b.desde ASC, b.pedido_id ASC))[1] AS mais_recente" "message cita o incidente MAIS ANTIGO" ;;
  stale_sem_regua) sab_compute "count(*) FILTER (WHERE c.observado_ate IS NULL OR c.observado_ate < ex.exigido_desde) AS n_sem_leitura" \
                               "count(*) FILTER (WHERE c.observado_ate IS NULL) AS n_sem_leitura" "leitura velha conta como em dia" ;;
  fora_do_v_sources)
    sabotar_corpo "$TMP/mig.sql" data_health_watchdog "    'sayerlack_cancelado_com_po'];" "    'sayerlack_cancelado_com_po_x'];" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o source no v_sources não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_V" "${POS_V/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS do v_sources não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em watchdog (source fora do v_sources, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  fora_do_heartbeat)
    sabotar_corpo "$TMP/mig.sql" fin_sync_heartbeat "                   'sayerlack_cancelado_com_po');" "                   'sayerlack_cancelado_com_po_x');" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o source na IN-list não ocorre exatamente 1×"; exit 9; }
    trocar "$TMP/mig.sql" "$POS_H" "${POS_H/IF position/IF false AND position}" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a POS da IN-list não ocorre exatamente 1×"; exit 9; }
    MIG_USADA="$TMP/mig.sql"; echo "⚠️  SABOTAGEM ATIVA em heartbeat (source fora da IN-list, POS textual desligada) — a suíte abaixo DEVE ficar vermelha" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke|pos_v_sources_sem_dente|pos_heartbeat_sem_dente|pos_acl_sem_dente) ;;   # nos clones
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

ESTE_C="$(md5_corpo "$MIG_USADA" _data_health_compute)"; ESTE_W="$(md5_corpo "$MIG_USADA" data_health_watchdog)"; ESTE_H="$(md5_corpo "$MIG_USADA" fin_sync_heartbeat)"

# ══════════════════════════════════════════════════════════════════
# A MIGRATION APLICA SOBRE A PROD DE HOJE
# ══════════════════════════════════════════════════════════════════
echo "═══ migration desta entrega: $(basename "$MIG") ═══"
out_a2="$(P -q -1 -f "$MIG_USADA" 2>&1)" && r_a2=OK || r_a2=FALHOU
case "$out_a2" in (*"POSTCONDICAO_OK sayerlack cancelado com compra viva"*) marc_a2=marcador ;; (*) marc_a2=sem_marcador ;; esac
[ "$r_a2" = OK ] || printf '%s\n' "$out_a2" | grep -m3 -E 'ERRO|FALHOU' || true
eq "A2 a migration aplica sobre o corpo de PROD e a POS passa" "$r_a2|$marc_a2" "OK|marcador"
eq "A3 os 3 corpos vivos são os do arquivo aplicado (md5 do PG = md5 do arquivo)" \
   "$(md5_vivo prove _data_health_compute)|$(md5_vivo prove data_health_watchdog)|$(md5_vivo prove fin_sync_heartbeat)" "$ESTE_C|$ESTE_W|$ESTE_H"
eq "A4 1 linha por source no compute INTEIRO, 35 sources, 1 delas sayerlack_cancelado_com_po" \
   "$(Pq -c "SELECT count(*) || '/' || count(DISTINCT source) || '/' || count(*) FILTER (WHERE source = 'sayerlack_cancelado_com_po') FROM public._data_health_compute();")" "35/35/1"

# ══════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — public.now() lê test.agora (idioma de db/test-data-health-sayerlack-varredura.sh)
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
SEG15='2026-11-09 15:00-03'   # segunda, depois das 14:00 SP: exige leitura desde 00:00 de HOJE
cc() { Pq -q -c "SET test.agora = '${2:-$SEG15}'" -c "SELECT $1 FROM public._data_health_compute() WHERE source = 'sayerlack_cancelado_com_po';"; }
ped() {  # $1 id, $2 protocolo, $3 status, $4 PO ('' = sem), $5 enviado (data)
  P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, status, status_envio_portal, portal_protocolo, omie_pedido_compra_id, enviado_portal_em)
           VALUES ($1, 'OBEN', '$3', 'sucesso_portal', '$2', NULLIF('$4', ''), '$5 10:00-03');"
}
sit() {  # $1 id, $2 código, $3 lido_ate (o protocolo é o do pedido; '-' = outro protocolo)
  P -q -c "UPDATE public.pedido_compra_sugerido SET portal_situacao_codigo = '$2', portal_situacao_texto = '$2 - x',
             portal_situacao_em = '$3'::timestamptz - interval '2 minutes', portal_situacao_ate = '$3',
             portal_situacao_protocolo = CASE WHEN '${4:-}' = '-' THEN '9999999' ELSE portal_protocolo END,
             portal_situacao_gravada_em = '$3' WHERE id = $1;"
}
Pv() { P -tA -v VERBOSITY=verbose "$@"; }   # erro com a SQLSTATE (o sqlstate() lê a linha "ERROR:  XXXXX")
abertos() { Pq -c "SELECT COALESCE(string_agg(pedido_id::text, ',' ORDER BY pedido_id), '-') FROM public.sayerlack_incidente_cancelado_com_po WHERE resolvido_em IS NULL;"; }
P -q -c "TRUNCATE public.pedido_compra_sugerido; TRUNCATE public.purchase_orders_tracking;"

echo "═══ incidente: nasce do estado do pedido e não some com leitura posterior ═══"
eq "B1 sem pedido algum ⇒ ok" "$(cc status)" "ok"
ped 101 2141101 disparado 9101 2026-11-03
sit 101 6 '2026-11-09 12:35-03'
eq "B2 6 gravado em pedido COM PO abre o incidente ⇒ broken citando o protocolo" "$(abertos)|$(cc status)|$(cc "(message LIKE '%protocolo 2141101, pedido #101%')::text")" "101|broken|true"
sit 101 1 '2026-11-09 17:35-03'
eq "B3 leitura POSTERIOR dizendo 1 NÃO fecha o incidente (Codex P1 #5)" "$(abertos)|$(cc status)" "101|broken"
m1="$(cc message)"
ped 102 2141102 aprovado_aguardando_disparo '' 2026-11-04
sit 102 6 '2026-11-09 12:35-03'
eq "B4a 6 sem PO não abre incidente (é a 5.3)" "$(abertos)" "101"
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_id = '9102', status = 'disparado' WHERE id = 102;"
eq "B4 PO gravado sobre pedido com 6 (conciliação do disparador) abre o incidente" "$(abertos)" "101,102"
eq "B4b a message passa a citar o MAIS RECENTE (fingerprint novo ⇒ e-mail novo)" "$(cc "(message LIKE '%protocolo 2141102, pedido #102%')::text")|$([ "$(cc message)" != "$m1" ] && echo mudou || echo igual)" "true|mudou"
eq "B4c a message é constante com o relógio" "$([ "$(cc message '2026-11-09 15:00-03')" = "$(cc message '2026-11-09 21:00-03')" ] && echo igual || echo mudou)" "igual"
P -q -c "UPDATE public.pedido_compra_sugerido SET status = 'cancelado' WHERE id = 101;" >/dev/null
eq "B6 cancelar FORA da porta auditada não fecha o incidente" "$(abertos)" "101,102"
P -q -c "BEGIN; SET LOCAL app.correcao_cancelamento_pos_disparo = '102'; UPDATE public.pedido_compra_sugerido SET status = 'cancelado', cancelamento_pos_disparo_por = 'lucas' WHERE id = 102; COMMIT;" >/dev/null
eq "B5 a porta pós-disparo (GUC com o id) fecha o incidente do pedido" "$(abertos)|$(Pq -c "SELECT resolucao || '|' || resolvido_por FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 102;")" "101|cancelado_pos_disparo|lucas"
eq "B7a resolver sem master = 42501" "$(Pv -c "BEGIN; SET LOCAL test.uid = '00000000-0000-0000-0000-0000000000bb'; SELECT public.sayerlack_resolver_incidente_cancelado_com_po((SELECT id FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 101), 'pedido reaberto pela Sayerlack'); COMMIT;" 2>&1 | sqlstate)" "42501"
P -q -c "INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000aa', 'master');"
eq "B7b justificativa curta = 22023" "$(Pv -c "BEGIN; SET LOCAL test.uid = '00000000-0000-0000-0000-0000000000aa'; SELECT public.sayerlack_resolver_incidente_cancelado_com_po((SELECT id FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 101), 'curta'); COMMIT;" 2>&1 | sqlstate)" "22023"
eq "B8a DELETE no incidente = 42501" "$(Pv -c "DELETE FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 101;" 2>&1 | sqlstate)" "42501"
eq "B8 UPDATE cru no incidente (resolver sem porta) = 42501" "$(Pv -c "UPDATE public.sayerlack_incidente_cancelado_com_po SET resolvido_em = now(), resolucao = 'humano', resolvido_por = 'x' WHERE pedido_id = 101;" 2>&1 | sqlstate)" "42501"
eq "B8c authenticated não grava no incidente = 42501" "$(Pv -c "SET ROLE authenticated; INSERT INTO public.sayerlack_incidente_cancelado_com_po (pedido_id, protocolo, po_omie) VALUES (1, '1', '1');" 2>&1 | sqlstate)" "42501"
eq "B7 master com justificativa resolve; sem incidente aberto, o broken some" \
   "$(Pq -c "BEGIN; SET LOCAL test.uid = '00000000-0000-0000-0000-0000000000aa'; SELECT (public.sayerlack_resolver_incidente_cancelado_com_po((SELECT id FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 101), 'pedido reaberto pela Sayerlack'))->>'resolvido'; COMMIT;" 2>&1 | grep -E '^(true|false)$')|$(abertos)|$(cc status)" "true|-|ok"
# 5.3: pedido encerrado sem PO cujo PO aparece DEPOIS no espelho
P -q -c "INSERT INTO public.sayerlack_encerramento_cancelado_portal (pedido_id, protocolo, status_antes, situacao_texto, situacao_lida_de, situacao_lida_ate, prova_omie, ator, justificativa)
         VALUES (103, '2141103', 'aprovado_aguardando_disparo', '6 - x', now(), now(), '{}', '00000000-0000-0000-0000-0000000000aa', 'confirmado por telefone');"
P -q -c "INSERT INTO public.purchase_orders_tracking (empresa, status, omie_codigo_pedido, omie_codigo_integracao, numero_contrato_fornecedor) VALUES ('OBEN', 'CANCELADO', 1, 'AFI-103', NULL);"
eq "B9a PO CANCELADO no espelho depois do encerramento não alerta" "$(cc status)" "ok"
P -q -c "INSERT INTO public.purchase_orders_tracking (empresa, status, omie_codigo_pedido, omie_codigo_integracao, numero_contrato_fornecedor) VALUES ('OBEN', 'CRIADO', 2, 'MANUAL-1', '2140000 / 2141103');"
eq "B9 PO vivo no espelho (contrato) depois do encerramento da 5.3 ⇒ incidente PERSISTIDO e broken" "$(abertos)|$(cc status)|$(cc "(probable_cause LIKE '%PO 2 no espelho depois de encerrado%')::text")" "103|broken|true"
P -q -c "UPDATE public.purchase_orders_tracking SET status = 'CANCELADO' WHERE omie_codigo_pedido = 2;"
eq "B9b o espelho mudar depois NÃO apaga o incidente (só a porta resolve)" "$(abertos)|$(cc status)" "103|broken"
P -q -c "BEGIN; SET LOCAL test.uid = '00000000-0000-0000-0000-0000000000aa'; SELECT public.sayerlack_resolver_incidente_cancelado_com_po((SELECT id FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 103 AND resolvido_em IS NULL), 'PO cancelado no Omie em 09/11'); COMMIT;" >/dev/null
eq "B9c resolvido por master ⇒ ok" "$(abertos)|$(cc status)" "-|ok"
# Codex 5.4 P1: 6 sobre PENDÊNCIA DE DISPARO (PO pode existir com a resposta perdida) abre já
ped 104 2141104 aprovado_aguardando_disparo '' 2026-11-05
P -q -c "UPDATE public.pedido_compra_sugerido SET disparo_claim_em = now() WHERE id = 104;"
sit 104 6 '2026-11-09 12:35-03'
sit 104 1 '2026-11-09 17:35-03'
P -q -c "UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_id = '9104', status = 'disparado' WHERE id = 104;"
eq "B10 6 sobre pendência de disparo abre o incidente, que sobrevive à leitura 1 e à conciliação que grava o PO" "$(abertos)|$(Pq -c "SELECT motivo || '|' || COALESCE(po_omie, 'NULL') FROM public.sayerlack_incidente_cancelado_com_po WHERE pedido_id = 104;")" "104|disparo_pendente|NULL"
eq "B11 o trigger do espelho é fail-open: erro nele não derruba a escrita do sync" "$(Pq -c "ALTER TABLE public.sayerlack_incidente_cancelado_com_po ADD CONSTRAINT quebra CHECK (pedido_id < 0) NOT VALID;" >/dev/null; Pv -c "INSERT INTO public.purchase_orders_tracking (empresa, status, omie_codigo_pedido, omie_codigo_integracao) VALUES ('OBEN', 'CRIADO', 3, 'AFI-103') RETURNING omie_codigo_pedido;" 2>&1 | grep -E '^[0-9]+$'; Pq -c "ALTER TABLE public.sayerlack_incidente_cancelado_com_po DROP CONSTRAINT quebra;" >/dev/null)" "3"
eq "B11b e a rede calculada do compute mostra o PO no espelho que o trigger não gravou" "$(cc "(probable_cause LIKE '%2141103 (#103, PO no espelho depois de encerrado)%')::text")" "true"

echo "═══ cobertura: pedido com compra em aberto precisa de leitura no dia útil ═══"
# TRUNCATE não dispara o trigger só-resolve (é de linha): limpa o B para a C medir só a cobertura.
P -q -c "TRUNCATE public.pedido_compra_sugerido; TRUNCATE public.purchase_orders_tracking; TRUNCATE public.sayerlack_incidente_cancelado_com_po; TRUNCATE public.sayerlack_encerramento_cancelado_portal;"
ped 201 2141201 disparado 9201 2026-10-29
eq "C1 pedido com PO (sem linha no espelho) e nunca lido ⇒ stale 'sem nenhuma leitura', age NULL" "$(cc "status || '|' || COALESCE(age_seconds::text, 'NULL') || '|' || (message LIKE '%sem nenhuma leitura%')::text")" "stale|NULL|true"
sit 201 1 '2026-11-09 12:35-03'
eq "C2 lido hoje 12:35 ⇒ ok às 15:00; e às 13:00 (exige só o dia útil anterior) também" "$(cc status)|$(cc status '2026-11-09 13:00-03')" "ok|ok"
sit 201 1 '2026-11-06 17:35-03'
eq "C3 lido na sexta: segunda 15:00 ⇒ stale com a data; segunda 10:00 ⇒ ok (exige desde sexta)" "$(cc status)|$(cc "(message LIKE '%desde 06/11/2026 17:35 BRT%')::text")|$(cc status '2026-11-09 10:00-03')" "stale|true|ok"
eq "C3b a message do stale é constante com o relógio" "$([ "$(cc message '2026-11-09 15:00-03')" = "$(cc message '2026-11-09 22:00-03')" ] && echo igual || echo mudou)" "igual"
P -q -c "INSERT INTO public.purchase_orders_tracking (empresa, status, omie_codigo_pedido, t2_data_faturamento) VALUES ('OBEN', 'FATURADO', 9201, now());"
eq "C4 PO faturado no espelho sai da cobertura ⇒ ok" "$(cc status)" "ok"
ped 202 2141202 disparado 9202 2026-11-05
sit 202 1 '2026-11-09 12:35-03' -
eq "C5 leitura de OUTRO protocolo não conta como leitura deste" "$(cc status)" "stale"
P -q -c "UPDATE public.pedido_compra_sugerido SET status = 'cancelado_humano' WHERE id = 202;"
eq "C6 pedido cancelado sai da cobertura" "$(cc status)" "ok"
ped 203 2141203 disparado 0 2026-11-05
eq "C7 PO '0' não é PO (fora da cobertura)" "$(cc status)" "ok"
eq "C8 a cobertura é service_role (fechada a authenticated/anon)" "$(Pq -c "SELECT has_function_privilege('authenticated','public.sayerlack_cobertura_situacao_portal()','EXECUTE')::text || has_function_privilege('anon','public.sayerlack_cobertura_situacao_portal()','EXECUTE')::text || has_function_privilege('service_role','public.sayerlack_cobertura_situacao_portal()','EXECUTE')::text")" "falsefalsetrue"

# Desliga o relógio controlado: o resto roda no compute EXATAMENTE como a migration o deixou.
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"
P -q -c "DROP FUNCTION public.now();"
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$cfg_compute]"; exit 1; }

echo "═══ trio: watchdog roteia o source; heartbeat executa ═══"
P -q -c "TRUNCATE public._spy_episodio; TRUNCATE public.pedido_compra_sugerido;"
ped 301 2141301 disparado 9301 2026-11-05
sit 301 6 "$(Pq -c "SELECT (pg_catalog.now() - interval '1 minute')::text")"
eq "A40 no relógio real: incidente aberto ⇒ broken" "$(Pq -c "SELECT status FROM public._data_health_compute() WHERE source = 'sayerlack_cancelado_com_po';")" "broken"
saida_wd="$(P -q -c "SELECT public.data_health_watchdog();" 2>&1)" && rc_wd=0 || rc_wd=$?
[ "$rc_wd" -eq 0 ] || printf '%s\n' "$saida_wd"
eq "A41 watchdog avalia 27 checks (o v_sources: 26 + 1) sem exceção do compute" \
   "$rc_wd | $(Pq -c "SELECT checks_avaliados::text || '/' || checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0 | 27/0"
eq "A43 watchdog ROTEOU sayerlack_cancelado_com_po para o push (_data_health_episodio), como critico" \
   "$(Pq -c "SELECT (count(*) = 1)::text FROM public._spy_episodio WHERE tipo = 'data_health_sayerlack_cancelado_com_po' AND status = 'broken' AND sev_fin = 'critico';")" "true"
saida_hb="$(P -q -c "SELECT public.fin_sync_heartbeat();" 2>&1)" && rc_hb=0 || rc_hb=$?
[ "$rc_hb" -eq 0 ] || printf '%s\n' "$saida_hb"
eq "A42 fin_sync_heartbeat executa e o RESUMO lista o source com o status" \
   "$rc_hb|$(Pq -c "SELECT (count(*) >= 1)::text FROM public.fornecedor_alerta WHERE mensagem LIKE '%sayerlack_cancelado_com_po: broken%';")" "0|true"
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
sabotar_corpo "$TMP/mig-posv.sql" data_health_watchdog "    'sayerlack_cancelado_com_po'];" "    'sayerlack_cancelado_com_po_x'];" \
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
eq "A30 a PÓS recusa sozinha um watchdog sem sayerlack_cancelado_com_po no v_sources" "$r30" "recusou:v_sources"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde posh
cp "$MIG" "$TMP/mig-posh.sql"
sabotar_corpo "$TMP/mig-posh.sql" fin_sync_heartbeat "                   'sayerlack_cancelado_com_po');" "                   'sayerlack_cancelado_com_po_x');" \
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
eq "A31 a PÓS recusa sozinha um heartbeat sem sayerlack_cancelado_com_po na IN-list" "$r31" "recusou:in_list"

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
