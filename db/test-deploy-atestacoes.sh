#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — deploy_atestacoes (ledger de atestação de deploy + coletor)     ║
# ║  migration: 20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql          ║
# ║  Rode:  bash db/test-deploy-atestacoes.sh > /tmp/t.log 2>&1; echo $?          ║
# ║         bash db/test-deploy-atestacoes.sh --falsificar   (3 sabotagens)       ║
# ║                                                                                ║
# ║  Prova: a janela viva aceita só sonda (probe booleano true) e eco (sem probe)  ║
# ║  com forma válida; envenenamento (edge null, slug ruim, fonte lixo, corpo      ║
# ║  não-JSON, probe string/false, status 500) fica FORA sem derrubar as vizinhas; ║
# ║  o coletor é idempotente; RLS/ACL: anon não lê, customer lê 0, staff lê tudo,  ║
# ║  authenticated não escreve nem executa o coletor, service_role bypassa; a      ║
# ║  migration re-aplica sem erro e sem duplicar o cron; a query do CLI devolve    ║
# ║  1 linha por edge com desempate por request_id em `created` idêntico.         ║
# ║  Falsifica: (S1) probe tipado → texto: a string "true" entra; (S2) tira o      ║
# ║  REVOKE de anon: a postcondição A3 aborta o apply; (S3) tira o jsonb_typeof    ║
# ║  de edge: `{"edge":null}` derruba o coletor inteiro.                           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="deploy-atestacoes"
MIG="$REPO_ROOT/supabase/migrations/20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql"
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
  # As cópias sabotadas nascem dentro de `$(sabotar …)` — subshell, então uma lista acumulada
  # numa variável nunca chegaria aqui. O padrão do nome é o registro.
  rm -f /tmp/pg-"${SLUG}"-sab-* /tmp/pg-"${SLUG}"-apply.err /tmp/pg-"${SLUG}"-reapply.err
  return 0
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null

# A query do CLI, extraída do PRÓPRIO módulo — o teste executa o que o script executa.
SQL_CLI="$(cd "$REPO_ROOT" && bun -e "const m = await import('./scripts/pendencias-deploy.ts'); process.stdout.write(m.SQL)")"
SQL_SAUDE="$(cd "$REPO_ROOT" && bun -e "const m = await import('./scripts/pendencias-deploy.ts'); process.stdout.write(m.SQL_SAUDE_COLETOR)")"
[ -n "$SQL_CLI" ] && [ -n "$SQL_SAUDE" ] || { echo "não extraí o SQL do CLI (bun -e)"; exit 1; }

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'
F_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
F_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

PASS=0; FAIL=0; NOMES_FALHOS=""
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); NOMES_FALHOS="$NOMES_FALHOS $1"; echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ── prova(<migration>) — banco fresco, stubs, migration, fixtures, asserts ─────────────
prova() {
  local mig="$1" db="$2"
  PASS=0; FAIL=0; NOMES_FALHOS=""
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
  Pq() { P -q -tA "$@"; }

  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  # ZONA 1: o que a PROD já tem — enum/user_roles/auth, roles com o default ACL do Supabase
  # (anon/authenticated/service_role ganham ALL em tabela nova: é ISSO que o REVOKE por nome
  # precisa desfazer), pg_net e pg_cron simulados.
  P -q <<SQL
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid',  true), '')::uuid \$f\$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.role', true), '') \$f\$;
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
GRANT SELECT ON public.user_roles TO anon, authenticated;
INSERT INTO auth.users (id, email) VALUES ('$MASTER','master@t'), ('$STAFF_E','staff@t'), ('$CUST_C','cust@t');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER','master'), ('$STAFF_E','employee'), ('$CUST_C','customer');
-- pg_net simulado: só a tabela de respostas (a migration NÃO chama http_post)
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz);
-- pg_cron simulado sobre o stub cron.job
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS \$f\$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active, username)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true, 'postgres')
  RETURNING jobid;
\$f\$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS \$f\$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; \$f\$;
ALTER TABLE cron.job_run_details ADD COLUMN IF NOT EXISTS end_time timestamptz;
SQL

  # ZONA 2: a migration (com a semente rodando sobre janela VAZIA)
  echo "═══ apply: $(basename "$mig") ═══"
  if ! P -q -f "$mig" 2>"/tmp/pg-${SLUG}-apply.err"; then
    bad "APPLY: a migration abortou — $(grep -m1 -E 'FALHOU|ERROR|error' "/tmp/pg-${SLUG}-apply.err" | cut -c1-160)"
    return 0
  fi
  ok "APPLY sem erro"

  # ZONA 3: fixtures — as válidas e o envenenamento, lado a lado
  P -q <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1,  200, '{"ok":true,"probe":true,"versao":"v1.0-a","edge":"edge-a","fonte":"$F_A"}', now() - interval '60 min'),
  (2,  200, '{"ok":true,"versao":"v1.0-b","edge":"edge-b","fonte":"$F_B","imported":3}', now() - interval '30 min'),
  (3,  200, '{"ok":true,"versao":"v1.0-c","edge":"edge-c"}', now() - interval '20 min'),
  (4,  200, '{"ok":true,"probe":false,"versao":"v1.0-a","edge":"edge-a","fonte":"$F_A"}', now()),
  (5,  200, '{"ok":true,"probe":"true","versao":"v1.0-a","edge":"edge-a","fonte":"$F_A"}', now()),
  (6,  500, '{"ok":false,"probe":true,"versao":"v1.0-a","edge":"edge-a","fonte":"$F_A"}', now()),
  (7,  200, '{nao e json mas tem "edge" e "versao" no texto', now()),
  (8,  200, '{"edge":null,"versao":"v1","probe":true}', now()),
  (9,  200, '{"edge":"Bad/Slug","versao":"v1","probe":true}', now()),
  (10, 200, '{"edge":"edge-d","versao":"v1.0-d","fonte":"nao-mapeada","probe":true}', now() - interval '10 min'),
  (11, 200, '{"edge":"edge-e","versao":"v1.0-e","fonte":"zzz","probe":true}', now()),
  (12, 200, '{"edge":"edge-a","versao":"v1.0-a-bis","fonte":"$F_A","probe":true}', now() - interval '60 min'),
  (13, 200, '{"edge":"edge-f","versao":"v1","probe":true,"fonte":42}', now()),
  (14, 200, NULL, now()),
  (15, 200, '{"edge":"edge-g","versao":null,"probe":true}', now()),
  -- 16/17: NÚMERO no lugar de string — a regex/length aceitam '12345'/'7' como texto; só o
  -- jsonb_typeof separa (é a camada que a sabotagem S3/S4 remove)
  (16, 200, '{"edge":12345,"versao":"v1","probe":true,"fonte":"$F_A"}', now()),
  (17, 200, '{"edge":"edge-h","versao":7,"probe":true,"fonte":"$F_A"}', now());
-- os ids 1 e 12 têm o MESMO created (empate real de prod) — o desempate é por request_id
UPDATE net._http_response SET created = (SELECT created FROM net._http_response WHERE id = 1) WHERE id = 12;
SQL

  echo "═══ asserts ═══"
  # A1: a janela viva devolve EXATAMENTE as válidas — o envenenamento fica fora sem derrubar nada
  eq "A1 janela viva = ids validos" "$(Pq -c "SELECT string_agg(request_id::text, ',' ORDER BY request_id) FROM public.deploy_atestacoes_janela_viva()")" "1,2,3,10,12"

  # A2/A3: o coletor copia as 5 e a 2ª passagem copia 0 (idempotente)
  eq "A2 colher() copia as validas" "$(Pq -c "SELECT public.deploy_atestacoes_colher()")" "5"
  eq "A3 colher() de novo = 0 (idempotente)" "$(Pq -c "SELECT public.deploy_atestacoes_colher()")" "0"

  # A4: via — probe booleano true = sonda; sem probe = eco
  eq "A4 via: 1=sonda 2=eco" "$(Pq -c "SELECT string_agg(via, ',' ORDER BY request_id) FROM public.deploy_atestacoes WHERE request_id IN (1,2)")" "sonda,eco"

  # A5: eco sem fonte fica NOMEADO, e o sentinela do mapa entra como está
  eq "A5 fonte: 3=sem-campo 10=nao-mapeada" "$(Pq -c "SELECT string_agg(fonte, ',' ORDER BY request_id) FROM public.deploy_atestacoes WHERE request_id IN (3,10)")" "sem-campo,nao-mapeada"

  # A6: as envenenadas NÃO estão no ledger
  eq "A6 envenenadas fora do ledger" "$(Pq -c "SELECT count(*) FROM public.deploy_atestacoes WHERE request_id IN (4,5,6,7,8,9,11,13,14,15,16,17)")" "0"

  # A7: RLS/ACL
  eq "A7a anon SELECT -> 42501" "$(Pq <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM public.deploy_atestacoes;
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"
  eq "A7b customer le 0" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$CUST_C', false) \gset _
SELECT count(*) FROM public.deploy_atestacoes;
SQL
)" "0"
  eq "A7c staff le tudo" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$STAFF_E', false) \gset _
SELECT count(*) FROM public.deploy_atestacoes;
SQL
)" "5"
  eq "A7d authenticated INSERT -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
DO \$\$ BEGIN
  INSERT INTO public.deploy_atestacoes (request_id, observado_em, edge, versao, fonte, via) VALUES (99, now(), 'x', 'v', 'f', 'sonda');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"
  eq "A7e service_role INSERT ok (bypass)" "$(Pq <<'SQL'
SET ROLE service_role;
INSERT INTO public.deploy_atestacoes (request_id, observado_em, edge, versao, fonte, via) VALUES (98, now(), 'edge-z', 'v', 'f', 'eco') RETURNING 'inseriu';
SQL
)" "inseriu"
  P -q -c "DELETE FROM public.deploy_atestacoes WHERE request_id = 98"

  # A8: o coletor é FECHADO — authenticated não executa (privilégio), anon idem
  eq "A8a has_function_privilege anon/authenticated = f,f" "$(Pq -c "SELECT has_function_privilege('anon','public.deploy_atestacoes_colher()','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.deploy_atestacoes_colher()','EXECUTE')::text")" "false,false"
  eq "A8b authenticated EXECUTE colher -> 42501" "$(Pq <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.deploy_atestacoes_colher();
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

  # A9: a query do CLI — 1 linha por edge, 6 campos, e no empate de created vence o request_id maior
  local cli
  cli="$(Pq -F '|' -c "$SQL_CLI")"
  eq "A9a CLI: 1 linha por edge (a,b,c,d)" "$(printf '%s\n' "$cli" | cut -d'|' -f1 | tr '\n' ',')" "edge-a,edge-b,edge-c,edge-d,"
  eq "A9b CLI: 6 campos por linha" "$(printf '%s\n' "$cli" | awk -F'|' '{print NF}' | sort -u | tr '\n' ',')" "6,"
  eq "A9c CLI: empate de created -> request_id maior (12 = v1.0-a-bis)" "$(printf '%s\n' "$cli" | awk -F'|' '$1=="edge-a"{print $2}')" "v1.0-a-bis"
  eq "A9d CLI: via da edge-b = eco" "$(printf '%s\n' "$cli" | awk -F'|' '$1=="edge-b"{print $4}')" "eco"

  # A10: a saúde do coletor — sem execução = 'nunca'; com sucesso há 10 min = ~10
  eq "A10a saude sem execucao = nunca" "$(Pq -c "$SQL_SAUDE")" "nunca"
  P -q -c "INSERT INTO cron.job_run_details (jobid, runid, status, end_time) SELECT jobid, 1, 'succeeded', now() - interval '10 min' FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'"
  eq "A10b saude com sucesso ha 10 min" "$(Pq -c "SELECT ((${SQL_SAUDE_SEM_PONTO})::numeric BETWEEN 9.5 AND 10.5)::text")" "true"
  P -q -c "INSERT INTO cron.job_run_details (jobid, runid, status, end_time) SELECT jobid, 2, 'failed', now() FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'"
  eq "A10c falha recente NAO conta como saude" "$(Pq -c "SELECT ((${SQL_SAUDE_SEM_PONTO})::numeric BETWEEN 9.5 AND 10.5)::text")" "true"

  # A11: re-aplicar a migration não erra e não duplica o cron
  if P -q -f "$mig" >/dev/null 2>"/tmp/pg-${SLUG}-reapply.err"; then ok "A11a re-apply sem erro"; else bad "A11a re-apply errou — $(head -c 160 "/tmp/pg-${SLUG}-reapply.err")"; fi
  eq "A11b cron unico apos re-apply" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'")" "1"
  eq "A11c ledger intacto apos re-apply" "$(Pq -c "SELECT count(*) FROM public.deploy_atestacoes")" "5"

  echo "── $PASS ok · $FAIL falhas"
  return 0
}

# ── sabotagem(<nome>, <sed-expr>) — copia da migration com UMA camada removida ─────────
sabotar() {
  local nome="$1" expr="$2" out
  # ⚠️ mktemp do macOS (BSD) exige os X no FIM do template: com `.sql` depois deles o nome não
  # randomiza, e na 2ª rodada o arquivo já existe → mktemp falha, o caminho sai vazio e o
  # "apply" da sabotagem quebra por motivo errado (medido 2026-09-05: S1/S3 "abortaram" à toa).
  out="$(mktemp "/tmp/pg-${SLUG}-sab-${nome}.XXXXXX")" || { echo "  ❌ mktemp falhou para $nome"; exit 1; }
  sed -e "$expr" "$MIG" > "$out"
  if cmp -s "$MIG" "$out"; then echo "  ❌ sabotagem $nome NÃO alterou a migration (regex cega) — falsificação inválida"; exit 1; fi
  printf '%s' "$out"
}

SQL_SAUDE_SEM_PONTO="${SQL_SAUDE%;}"

if [ "${1:-}" = "--falsificar" ]; then
  echo "═══ FALSIFICAÇÃO — cada sabotagem tem de deixar ≥1 assert VERMELHO ═══"
  TOTAL_FALSIF=0
  # S1: probe tipado (booleano true) → texto: a string "true" (id 5) passa a entrar na janela
  s1="$(sabotar s1 "s/(r.c -> 'probe') = to_jsonb(true)/(r.c ->> 'probe') = 'true'/g")"
  prova "$s1" prova_s1 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'A1'; then echo "  ✅ S1 (probe como texto) → vermelho em A1"; else echo "  ❌ S1 ficou VERDE (falhas:$NOMES_FALHOS)"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi
  # S2: sem o REVOKE de anon na tabela → a postcondição A3 aborta o apply
  s2="$(sabotar s2 "/^REVOKE ALL ON public.deploy_atestacoes FROM anon;/d")"
  prova "$s2" prova_s2 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'APPLY'; then echo "  ✅ S2 (sem REVOKE anon) → a postcondição abortou o apply"; else echo "  ❌ S2 ficou VERDE (falhas:$NOMES_FALHOS)"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi
  # S3: sem o tipo de `edge` → {"edge":12345} vira a edge '12345' (a regex aceita dígitos) e entra na janela.
  #     ({"edge":null} NÃO serve para esta sabotagem: a regex sozinha já o barra — camada redundante ali.)
  s3="$(sabotar s3 "/jsonb_typeof(r.c -> 'edge') = 'string'/d")"
  prova "$s3" prova_s3 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'A1'; then echo "  ✅ S3 (sem tipo de edge) → vermelho em A1"; else echo "  ❌ S3 ficou VERDE (falhas:$NOMES_FALHOS)"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi
  # S4: sem o tipo de `versao` → {"versao":7} vira '7' (length 1 passa) e entra na janela.
  s4="$(sabotar s4 "/jsonb_typeof(r.c -> 'versao') = 'string'/d")"
  prova "$s4" prova_s4 >/dev/null
  if [ "$FAIL" -gt 0 ] && printf '%s' "$NOMES_FALHOS" | grep -q 'A1'; then echo "  ✅ S4 (sem tipo de versao) → vermelho em A1"; else echo "  ❌ S4 ficou VERDE (falhas:$NOMES_FALHOS)"; TOTAL_FALSIF=$((TOTAL_FALSIF+1)); fi
  echo "═══ falsificação: $TOTAL_FALSIF sabotagem(ns) sem vermelho ═══"
  [ "$TOTAL_FALSIF" -eq 0 ]
  exit $?
fi

echo "═══ setup (PG17 :$PORT) ═══"
prova "$MIG" prova
echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
