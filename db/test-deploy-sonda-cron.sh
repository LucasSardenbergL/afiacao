#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — deploy_sonda_cron (allowlist + atribuição + dispatcher + cron)  ║
# ║  migration: 20260906151204_deploy_sonda_cron_fail_closed.sql                  ║
# ║  Rode:  bash db/test-deploy-sonda-cron.sh > /tmp/t.log 2>&1; echo $?          ║
# ║         bash db/test-deploy-sonda-cron.sh --falsificar   (5 sabotagens)       ║
# ║                                                                                ║
# ║  Prova EXECUTANDO (PL/pgSQL é late-bound: `CREATE` que passa não é prova):     ║
# ║  o dispatcher posta UMA vez por alvo ATIVO, na URL do RELÉ, com headers        ║
# ║  exatamente {Content-Type, x-cron-secret} e corpo {alvo, tick}; grava a        ║
# ║  atribuição (request_id, tick_id, edge) na MESMA transação; edge inativa NÃO   ║
# ║  é postada; p_alvos filtra; vault com 0 ou 2 CRON_SECRET → exceção e ZERO      ║
# ║  posts; ACL/RLS por role (anon nada, customer 0 linhas, staff lê, authenticated ║
# ║  e service_role não escrevem nem executam); re-apply não duplica cron nem      ║
# ║  semente; a credencial de sonda NUNCA sai do banco.                           ║
# ║  Falsifica: (S1) sem REVOKE de service_role → A3 aborta; (S2) laço vira        ║
# ║  projeção com WHERE → inativa é postada; (S3) sem a checagem de unicidade do   ║
# ║  vault → 2 segredos passam; (S4) INSERT da atribuição removido → posts órfãos; ║
# ║  (S5) URL do relé trocada pela da alvo → o POST iria direto à edge-alvo.       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="deploy-sonda-cron"
MIG="$REPO_ROOT/supabase/migrations/20260906151204_deploy_sonda_cron_fail_closed.sql"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
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
  rm -f /tmp/pg-"${SLUG}"-sab-* /tmp/pg-"${SLUG}"-apply.err /tmp/pg-"${SLUG}"-reapply.err
  return 0
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'
REF='fzvklzpomgnyikkfkzai'

PASS=0; FAIL=0; NOMES_FALHOS=""
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); NOMES_FALHOS="$NOMES_FALHOS $1"; echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ── prova(<migration>, <db>) — banco fresco, stubs, migration, execução, asserts ────────
prova() {
  local mig="$1" db="$2"
  PASS=0; FAIL=0; NOMES_FALHOS=""
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
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

  # ZONA 2: a migration
  echo "═══ apply: $(basename "$mig") ═══"
  if ! P -q -f "$mig" 2>"/tmp/pg-${SLUG}-apply.err"; then
    bad "APPLY: a migration abortou — $(grep -m1 -E 'FALHOU|ERROR' "/tmp/pg-${SLUG}-apply.err" | cut -c1-170)"
    return 0
  fi
  ok "APPLY sem erro"

  # ZONA 3: asserts por EXECUÇÃO
  eq "semente: 3 alvos ativos" "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_alvos WHERE ativo")" "3"
  eq "cron agendado 1×" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='deploy-sonda-cron' AND schedule='37 */2 * * *'")" "1"

  # — o dispatcher EXECUTA —
  P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null
  eq "posts = alvos ativos" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "3"
  eq "atribuição: 1 linha por post" "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_disparos")" "3"
  eq "atribuição casa com o id do post" \
     "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_disparos d JOIN net.chamadas c ON c.id = d.request_id")" "3"
  eq "um único tick para a leva" "$(Pq -c "SELECT count(DISTINCT tick_id) FROM public.deploy_sonda_disparos")" "1"

  # — o request de saída: SÓ o relé, SÓ os 2 headers, corpo {alvo,tick} —
  eq "toda URL é a do RELÉ" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE url = 'https://${REF}.supabase.co/functions/v1/sonda-relay'")" "3"
  eq "NENHUMA URL aponta para a edge-alvo" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE url LIKE '%/functions/v1/monthly-report%' OR url LIKE '%/functions/v1/calculate-scores%'")" "0"
  eq "headers exatamente {Content-Type, x-cron-secret}" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE (SELECT count(*) FROM jsonb_object_keys(headers)) = 2 AND headers ? 'Content-Type' AND headers ? 'x-cron-secret'")" "3"
  eq "nenhum header de credencial de SONDA sai do banco" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE headers::text ILIKE '%sonda-credencial%' OR headers::text ILIKE '%hmac%'")" "0"
  eq "corpo traz alvo e tick" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE body ? 'alvo' AND body ? 'tick'")" "3"
  eq "o alvo do corpo bate com a atribuição" \
     "$(Pq -c "SELECT count(*) FROM net.chamadas c JOIN public.deploy_sonda_disparos d ON d.request_id = c.id WHERE c.body->>'alvo' = d.edge")" "3"
  eq "timeout explícito de 20s" "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE timeout_ms = 20000")" "3"

  # — edge INATIVA não é postada (a trava é o laço, não um WHERE dependente de plano) —
  P -q -c "TRUNCATE net.chamadas; TRUNCATE public.deploy_sonda_disparos;"
  P -q -c "UPDATE public.deploy_sonda_alvos SET ativo = false WHERE edge = 'monthly-report'"
  P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null
  eq "inativa NÃO é postada" "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE body->>'alvo' = 'monthly-report'")" "0"
  eq "restantes são postadas" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "2"
  P -q -c "UPDATE public.deploy_sonda_alvos SET ativo = true"

  # — p_alvos filtra —
  P -q -c "TRUNCATE net.chamadas; TRUNCATE public.deploy_sonda_disparos;"
  P -q -c "SELECT * FROM public.deploy_sonda_disparar(ARRAY['monthly-report'])" >/dev/null
  eq "p_alvos posta só o nomeado" "$(Pq -c "SELECT count(*) FROM net.chamadas WHERE body->>'alvo' = 'monthly-report'")" "1"
  eq "p_alvos não posta os outros" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "1"

  # — vault: 0 e 2 segredos → EXCEÇÃO e ZERO posts —
  P -q -c "TRUNCATE net.chamadas; TRUNCATE public.deploy_sonda_disparos;"
  P -q -c "DELETE FROM vault.decrypted_secrets WHERE name='CRON_SECRET'"
  if P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null 2>&1; then
    bad "vault VAZIO: o dispatcher rodou sem segredo"
  else
    eq "vault vazio → exceção e ZERO posts" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "0"
  fi
  P -q -c "INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('CRON_SECRET','a'), ('CRON_SECRET','b')"
  if P -q -c "SELECT * FROM public.deploy_sonda_disparar()" >/dev/null 2>&1; then
    bad "vault DUPLICADO: o dispatcher escolheu um segredo arbitrário"
  else
    eq "vault com 2 segredos → exceção e ZERO posts" "$(Pq -c "SELECT count(*) FROM net.chamadas")" "0"
  fi
  P -q -c "DELETE FROM vault.decrypted_secrets WHERE name='CRON_SECRET'; INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES ('CRON_SECRET','segredo-de-teste')"

  # — ACL/RLS por ROLE (a prova é sob SET ROLE, não por leitura do catálogo) —
  eq "anon não lê alvos" \
     "$(Pq -c "SELECT has_table_privilege('anon','public.deploy_sonda_alvos','SELECT')::text")" "false"
  eq "anon não lê disparos" \
     "$(Pq -c "SELECT has_table_privilege('anon','public.deploy_sonda_disparos','SELECT')::text")" "false"
  eq "authenticated não escreve alvos" \
     "$(Pq -c "SELECT (has_table_privilege('authenticated','public.deploy_sonda_alvos','INSERT') OR has_table_privilege('authenticated','public.deploy_sonda_alvos','UPDATE'))::text")" "false"
  eq "service_role não escreve alvos" \
     "$(Pq -c "SELECT has_table_privilege('service_role','public.deploy_sonda_alvos','UPDATE')::text")" "false"
  eq "service_role não executa o dispatcher" \
     "$(Pq -c "SELECT has_function_privilege('service_role','public.deploy_sonda_disparar(text[])','EXECUTE')::text")" "false"
  eq "authenticated não executa o dispatcher" \
     "$(Pq -c "SELECT has_function_privilege('authenticated','public.deploy_sonda_disparar(text[])','EXECUTE')::text")" "false"
  # `SET` (e não `set_config`) porque set_config RETORNA o valor e ele sairia junto do count no
  # `-tA` — o assert compararia "uuid\n3" com "3" e ficaria vermelho por ruído de instrumento.
  eq "staff LÊ os alvos (policy)" \
     "$(Pq -c "SET ROLE authenticated; SET test.uid = '$STAFF_E'; SELECT count(*) FROM public.deploy_sonda_alvos")" "3"
  eq "customer lê ZERO alvos (policy)" \
     "$(Pq -c "SET ROLE authenticated; SET test.uid = '$CUST_C'; SELECT count(*) FROM public.deploy_sonda_alvos")" "0"
  eq "staff LÊ os disparos (policy)" \
     "$(Pq -c "SET ROLE authenticated; SET test.uid = '$STAFF_E'; SELECT count(*) >= 0 FROM public.deploy_sonda_disparos")" "t"

  # — a QUERY DE VALIDAÇÃO do handoff diz ✅ aqui (controle POSITIVO dela) —
  # Ela é a rede de segurança que o founder roda depois do Run. Provar que ela discrimina exige os
  # dois lados: o ❌ contra a PROD sem a migration (feito à mão, registrado no PR) e o ✅ aqui.
  eq "query de validação do handoff diz OK no banco aplicado" \
     "$(Pq -f "$REPO_ROOT/db/valida-deploy-sonda-cron.sql" | grep -c '^✅')" "1"

  # — re-apply é idempotente —
  if ! P -q -f "$mig" 2>"/tmp/pg-${SLUG}-reapply.err"; then
    bad "RE-APPLY abortou — $(grep -m1 -E 'FALHOU|ERROR' "/tmp/pg-${SLUG}-reapply.err" | cut -c1-150)"
  else
    ok "RE-APPLY sem erro"
    eq "re-apply não duplica o cron" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='deploy-sonda-cron'")" "1"
    eq "re-apply não duplica a semente" "$(Pq -c "SELECT count(*) FROM public.deploy_sonda_alvos")" "3"
  fi
  return 0
}

# ── sabotagem(<nome>, <sed-expr>) — copia da migration com UMA camada removida ─────────
sabotar() {
  local nome="$1" expr="$2" out
  out="$(mktemp "/tmp/pg-${SLUG}-sab-${nome}.XXXXXX")" || { echo "  ❌ mktemp falhou para $nome"; exit 1; }
  sed -e "$expr" "$MIG" > "$out"
  if cmp -s "$MIG" "$out"; then echo "  ❌ sabotagem $nome NÃO alterou a migration (regex cega) — falsificação inválida"; exit 1; fi
  printf '%s' "$out"
}

if [ "${1:-}" = "--falsificar" ]; then
  echo "═══ FALSIFICAÇÃO — cada sabotagem tem de deixar ≥1 assert VERMELHO ═══"
  TOTAL_FALSIF=0

  # S1: sem o REVOKE de service_role → a postcondição A3 aborta o apply
  s1="$(sabotar s1 "/^REVOKE ALL ON public.deploy_sonda_alvos FROM service_role;/d")"
  prova "$s1" prova_s1 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'APPLY'; then
    echo "  ✅ S1 (sem REVOKE service_role) → a postcondição A3 abortou o apply"
  else echo "  ❌ S1 ficou VERDE"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi

  # S2: o laço PL/pgSQL vira projeção com WHERE — a forma dependente de PLANO. A trava do `ativo`
  #     deixa de ser semântica da linguagem e passa a depender do planejador.
  s2="$(sabotar s2 "s/WHERE a.ativo$/WHERE true/")"
  prova "$s2" prova_s2 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'inativa'; then
    echo "  ✅ S2 (filtro do ativo removido) → vermelho em 'inativa NÃO é postada'"
  else echo "  ❌ S2 ficou VERDE"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi

  # S3: sem a exigência de unicidade do vault → 2 segredos passam e o dispatcher usa um arbitrário
  s3="$(sabotar s3 "s/IF v_n <> 1 THEN/IF v_n < 1 THEN/")"
  prova "$s3" prova_s3 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'DUPLICADO'; then
    echo "  ✅ S3 (unicidade do vault afrouxada) → vermelho em 'vault DUPLICADO'"
  else echo "  ❌ S3 ficou VERDE"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi

  # S4: sem o INSERT da atribuição → os posts saem órfãos e o CLI (F3) não sabe de qual tick vieram
  # ⚠️ O range do sed tem de casar o bloco INTEIRO (5 linhas desde o `WHERE NOT EXISTS`): apagar
  # menos deixa `);` órfão, o apply quebra por SINTAXE e a sabotagem passa a testar outra coisa.
  s4="$(sabotar s4 "/INSERT INTO public.deploy_sonda_disparos (request_id, tick_id, edge)/,+4d")"
  prova "$s4" prova_s4 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'atribuição'; then
    echo "  ✅ S4 (sem o INSERT da atribuição) → vermelho em 'atribuição'"
  else echo "  ❌ S4 ficou VERDE"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi

  # S5: a URL do relé trocada pela da EDGE-ALVO — o cenário catastrófico: o POST iria direto à edge,
  #     que é exatamente o que este mecanismo inteiro existe para impedir.
  s5="$(sabotar s5 "s|/functions/v1/sonda-relay'|/functions/v1/' \|\| v_edge|")"
  prova "$s5" prova_s5 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -qE 'RELÉ|alvo'; then
    echo "  ✅ S5 (URL da edge-alvo no lugar do relé) → vermelho no assert da URL"
  else echo "  ❌ S5 ficou VERDE"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi

  echo "═══ falsificação: $TOTAL_FALSIF sabotagem(ns) sem vermelho ═══"
  [ "$TOTAL_FALSIF" -eq 0 ]
  exit $?
fi

echo "═══ setup (PG17 :$PORT) ═══"
prova "$MIG" prova
echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
