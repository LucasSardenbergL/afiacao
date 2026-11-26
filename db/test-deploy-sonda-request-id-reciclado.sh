#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — deploy_sonda com identidade (request_id, tick_id)                 ║
# ║  migration: 20261126220000_deploy_sonda_request_id_reciclado.sql                ║
# ║  Rode:  bash db/test-deploy-sonda-request-id-reciclado.sh > /tmp/t.log 2>&1; echo $?
# ║         bash db/test-deploy-sonda-request-id-reciclado.sh --falsificar          ║
# ║                                                                                  ║
# ║  O pg_net RECICLA o id (a sequência reinicia). Prova EXECUTANDO, sobre as duas  ║
# ║  migrations de base reais: (1) disparo com id reciclado é GRAVADO (antes: pulado ║
# ║  em silêncio pelo NOT EXISTS); (2) a resposta nova casa só com o disparo novo — ║
# ║  o antigo de mesmo id não é sobrescrito; (3) resposta purgada pelo pg_net não   ║
# ║  rebaixa resultado colhido para NULL; (4) re-apply idempotente.                  ║
# ╚═════════════════════════════════════════════════════════════════════════════════
set -euo pipefail


REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="deploy-sonda-request-id-reciclado"
MIG="$REPO_ROOT/supabase/migrations/20261126220000_deploy_sonda_request_id_reciclado.sql"
BASE1="$REPO_ROOT/supabase/migrations/20260906151204_deploy_sonda_cron_fail_closed.sql"
BASE2="$REPO_ROOT/supabase/migrations/20260906180303_deploy_sonda_resultados.sql"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"   # dir ÚNICO desta rodada (o trap apaga): temporário mora aqui, nunca em /tmp/<nome-fixo>
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")"
  return 0
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'

PASS=0; FAIL=0; NOMES_FALHOS=""
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); NOMES_FALHOS="$NOMES_FALHOS $1"; echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ── prova(<migration>, <db>) — banco fresco, stubs, migration, execução, asserts ────────
prova() {
  local mig="$1" db="$2"
  PASS=0; FAIL=0; NOMES_FALHOS=""
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
  Pq() { P -q -tA "$@"; }

  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

  # ZONA 1: o que a PROD já tem — roles com o default ACL do Supabase (é ISSO que o REVOKE por
  # nome precisa desfazer), auth, user_roles, pg_net e pg_cron simulados, e o VAULT.
  P -q <<SQL
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid',  true), '')::uuid \$f\$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.role', true), '') \$f\$;
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
GRANT SELECT ON public.user_roles TO anon, authenticated;
INSERT INTO auth.users (id, email) VALUES ('$MASTER','master@t'), ('$STAFF_E','staff@t'), ('$CUST_C','cust@t');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER','master'), ('$STAFF_E','employee'), ('$CUST_C','customer');

-- O LEDGER (dependência que a postcondição A8 exige)
CREATE TABLE IF NOT EXISTS public.deploy_atestacoes (
  request_id bigint NOT NULL, observado_em timestamptz NOT NULL, edge text NOT NULL,
  versao text NOT NULL, fonte text NOT NULL, via text NOT NULL,
  PRIMARY KEY (request_id, observado_em));

-- pg_net simulado: http_post REGISTRA a chamada e devolve um id crescente. É o instrumento —
-- sem ele o teste veria "não deu erro" e chamaria isso de prova.
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net.chamadas (
  id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_ms integer, quando timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                                         headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql VOLATILE AS \$f\$
  INSERT INTO net.chamadas (url, headers, body, timeout_ms) VALUES (url, headers, body, timeout_milliseconds) RETURNING id;
\$f\$;

-- VAULT simulado
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (id bigserial PRIMARY KEY, name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('CRON_SECRET', 'segredo-de-teste');

-- pg_cron simulado sobre o stub cron.job
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS \$f\$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active, username, database)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true, 'postgres', current_database())
  RETURNING jobid;
\$f\$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS \$f\$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; \$f\$;
SQL

  # pg_net: a tabela de respostas que o coletor lê (o TTL de 6 h é simulado com DELETE).
  P -q -c "CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code integer, content text, created timestamptz NOT NULL DEFAULT now());"

  echo "═══ apply: bases + $(basename "$mig") ═══"
  P -q -f "$BASE1" >/dev/null 2>"$RODADA/base1.err" || { bad "APPLY BASE1 — $(head -c 200 "$RODADA/base1.err")"; return 0; }
  P -q -f "$BASE2" >/dev/null 2>"$RODADA/base2.err" || { bad "APPLY BASE2 — $(head -c 200 "$RODADA/base2.err")"; return 0; }
  P -q -c "SELECT cron.unschedule('deploy-sonda-cron'); UPDATE public.deploy_sonda_alvos SET ativo = (edge = 'monthly-report');" >/dev/null
  if ! P -q -f "$mig" >/dev/null 2>"$RODADA/apply.err"; then
    bad "APPLY: a migration abortou — $(grep -m1 -E 'FALHOU|ERROR' "$RODADA/apply.err" | sed "s|.*ERROR: *||" | cut -c1-220)"
    return 0
  fi
  ok "APPLY sem erro"
  if P -q -f "$mig" >/dev/null 2>"$RODADA/apply2.err"; then ok "RE-APPLY idempotente"; else bad "RE-APPLY quebrou — $(head -c 200 "$RODADA/apply2.err")"; fi

  eq "PK de disparos = (request_id, tick_id)" \
     "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.deploy_sonda_disparos'::regclass AND contype='p'")" "PRIMARY KEY (request_id, tick_id)"
  eq "PK de resultados = (request_id, tick_id)" \
     "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.deploy_sonda_resultados'::regclass AND contype='p'")" "PRIMARY KEY (request_id, tick_id)"

  # — 1º disparo (o ANTIGO): id 1, respondeu 200 atestando —
  P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null
  P -q -c "UPDATE public.deploy_sonda_disparos SET enfileirado_em = now() - interval '3 hours'"
  P -q -c "INSERT INTO net._http_response (id, status_code, content, created) VALUES (1, 200, '{\"probe\":true,\"edge\":\"monthly-report\",\"versao\":\"v1\"}', now() - interval '3 hours' + interval '2 seconds')"
  P -q -c "SELECT public.deploy_sonda_resultados_colher()" >/dev/null
  eq "antigo colhido como atestou" "$(Pq -c "SELECT classe FROM public.deploy_sonda_resultados WHERE request_id = 1")" "atestou"

  # — TTL do pg_net: a resposta some; o coletor roda de novo —
  P -q -c "DELETE FROM net._http_response"
  P -q -c "SELECT public.deploy_sonda_resultados_colher()" >/dev/null
  eq "resposta purgada NÃO rebaixa o resultado colhido" \
     "$(Pq -c "SELECT coalesce(status_code::text,'NULL') || '/' || coalesce(classe,'NULL') FROM public.deploy_sonda_resultados WHERE request_id = 1")" "200/atestou"

  # — o pg_net REINICIA a sequência: o próximo disparo recebe o MESMO id 1 —
  P -q -c "TRUNCATE net.chamadas; ALTER SEQUENCE net.chamadas_id_seq RESTART WITH 1;"
  P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null 2>"$RODADA/disp2.err" || bad "disparo com id reciclado ERROU — $(head -c 200 "$RODADA/disp2.err")"
  eq "disparo com id reciclado é GRAVADO (2 disparos com id 1)" \
     "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_disparos WHERE request_id = 1")" "2"
  eq "ticks distintos" "$(Pq -c "SELECT count(DISTINCT tick_id) FROM public.deploy_sonda_disparos WHERE request_id = 1")" "2"

  # — a resposta NOVA (id 1, relé recusou) casa só com o disparo novo —
  P -q -c "INSERT INTO net._http_response (id, status_code, content, created) VALUES (1, 401, '{\"classe\":\"rele-401\"}', now() + interval '1 second')"
  P -q -c "SELECT public.deploy_sonda_resultados_colher()" >/dev/null
  eq "resultado do disparo NOVO = 401/rele-401" \
     "$(Pq -c "SELECT r.status_code || '/' || r.classe FROM public.deploy_sonda_resultados r JOIN public.deploy_sonda_disparos d USING (request_id, tick_id) WHERE r.request_id = 1 ORDER BY d.enfileirado_em DESC LIMIT 1")" "401/rele-401"
  eq "resultado do disparo ANTIGO intacto = 200/atestou" \
     "$(Pq -c "SELECT r.status_code || '/' || r.classe FROM public.deploy_sonda_resultados r JOIN public.deploy_sonda_disparos d USING (request_id, tick_id) WHERE r.request_id = 1 ORDER BY d.enfileirado_em ASC LIMIT 1")" "200/atestou"
  eq "2 resultados para o id 1" "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_resultados WHERE request_id = 1")" "2"

  # — ACL preservado —
  eq "anon/authenticated não executam o dispatcher nem o coletor" \
     "$(Pq -c "SELECT (has_function_privilege('anon','public.deploy_sonda_disparar(text[])','EXECUTE') OR has_function_privilege('authenticated','public.deploy_sonda_disparar(text[])','EXECUTE') OR has_function_privilege('anon','public.deploy_sonda_resultados_colher()','EXECUTE') OR has_function_privilege('authenticated','public.deploy_sonda_resultados_colher()','EXECUTE'))::text")" "false"
}

sabotar() {
  local nome="$1" expr="$2" out
  out="$(mktemp "$RODADA/sab-${nome}.XXXXXX")" || { echo "  ❌ mktemp falhou para $nome"; exit 1; }
  sed -e "$expr" "$MIG" > "$out"
  if cmp -s "$MIG" "$out"; then echo "  ❌ sabotagem $nome NÃO alterou a migration (regex cega) — falsificação inválida"; exit 1; fi
  printf '%s' "$out"
}

if [ "${1:-}" = "--falsificar" ]; then
  echo "═══ FALSIFICAÇÃO — controle VERDE primeiro, depois cada sabotagem tem de deixar ≥1 VERMELHO ═══"
  TOTAL_FALSIF=0
  prova "$MIG" prova_controle >/dev/null
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 12 ]; then echo "  ✅ CONTROLE verde ($PASS ok)"; else echo "  ❌ CONTROLE não está verde ($PASS ok, $FAIL falhas:$NOMES_FALHOS) — falsificação inválida"; exit 1; fi

  verm() { # verm <rótulo> <regex-esperada-em-NOMES_FALHOS>
    if [ "$FAIL" -gt 0 ] && grep -qE "$2" <<<"$NOMES_FALHOS"; then echo "  ✅ $1 → vermelho ($2)"
    else echo "  ❌ $1 ficou VERDE (ou vermelho errado:$NOMES_FALHOS)"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi
  }

  # S1: o NOT EXISTS de volta, como estava → a postcondição aborta o apply
  s1="$(sabotar s1 "s/^    VALUES (v_req, v_tick, v_edge);/    SELECT v_req, v_tick, v_edge WHERE NOT EXISTS (SELECT 1 FROM public.deploy_sonda_disparos d WHERE d.request_id = v_req);/")"
  prova "$s1" prova_s1 >/dev/null; verm "S1 (NOT EXISTS restaurado)" "APPLY"

  # S2: o mesmo filtro escrito em minúsculas (escapa da postcondição textual) → o assert de EXECUÇÃO pega
  s2="$(sabotar s2 "s/^    VALUES (v_req, v_tick, v_edge);/    select v_req, v_tick, v_edge where not exists (select 1 from public.deploy_sonda_disparos d where d.request_id = v_req);/")"
  prova "$s2" prova_s2 >/dev/null; verm "S2 (filtro disfarçado)" "GRAVADO"

  # S3: sem casar a resposta com o disparo MAIS RECENTE → o antigo é sobrescrito pela resposta nova
  s3="$(sabotar s3 "/AND NOT EXISTS ($/,/AND d2.enfileirado_em <= r.created)/d")"
  prova "$s3" prova_s3 >/dev/null; verm "S3 (sem desempate pelo disparo mais recente)" "ANTIGO"

  # S4: a trava de rebaixamento neutralizada (o texto fica, a semântica sai) → o assert de EXECUÇÃO pega
  s4="$(sabotar s4 "s/WHERE EXCLUDED.status_code IS NOT NULL$/WHERE EXCLUDED.status_code IS NOT NULL OR true/")"
  prova "$s4" prova_s4 >/dev/null; verm "S4 (rebaixamento liberado)" "purgada"

  # S5: a troca de PK pulada → a postcondição aborta o apply
  s5="$(sabotar s5 "s/       IS DISTINCT FROM 'PRIMARY KEY (request_id, tick_id)' THEN$/       IS NOT DISTINCT FROM 'PRIMARY KEY (request_id, tick_id)' THEN/")"
  prova "$s5" prova_s5 >/dev/null; verm "S5 (PK não trocada)" "APPLY"

  echo "═══ falsificação: $TOTAL_FALSIF sabotagem(ns) sem vermelho ═══"
  [ "$TOTAL_FALSIF" -eq 0 ]
  exit $?
fi

echo "═══ setup (PG17 :$PORT) ═══"
prova "$MIG" prova
echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
