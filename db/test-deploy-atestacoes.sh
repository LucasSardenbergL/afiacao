#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — deploy_atestacoes (ledger de atestação de deploy + coletor)     ║
# ║  migration: 20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql          ║
# ║  Rode:  bash db/test-deploy-atestacoes.sh > /tmp/t.log 2>&1; echo $?          ║
# ║         bash db/test-deploy-atestacoes.sh --falsificar   (8 sabotagens)       ║
# ║                                                                                ║
# ║  Prova: a janela viva aceita só sonda (probe booleano true) e eco (sem probe)  ║
# ║  com forma válida; envenenamento (edge null, slug ruim, fonte lixo, corpo      ║
# ║  não-JSON, probe string/false, status 500) fica FORA sem derrubar as vizinhas; ║
# ║  o coletor é idempotente; RLS/ACL: anon não lê, customer lê 0, staff lê tudo,  ║
# ║  authenticated não escreve nem executa o coletor, service_role bypassa; a      ║
# ║  migration re-aplica sem erro e sem duplicar o cron; a query do CLI devolve    ║
# ║  1 linha por edge com desempate por request_id em `created` idêntico.         ║
# ║  Falsifica: cada sabotagem DECLARA os asserts que a acusam (lista SABOTAGENS). ║
# ║  Quatro vieram de db/test-pendencias-deploy-eco-passivo.sh, aposentado em      ║
# ║  2026-09-27: ele sabotava o SQL do CLI, que desde 2026-09-05 só lê o ledger — ║
# ║  a lógica que ele provava mora na janela viva, cujas defesas estavam SEM      ║
# ║  falsificação nenhuma.                                                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="deploy-atestacoes"
MIG="$REPO_ROOT/supabase/migrations/20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql"
# Tudo o que esta execução escreve mora AQUI (cópias sabotadas, stderr das medições, logs da
# falsificação): nome fixo em /tmp é compartilhado com as outras worktrees.
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMPD"
  return 0
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null

# A query do CLI, extraída do PRÓPRIO módulo — o teste executa o que o script executa.
SQL_CLI="$(cd "$REPO_ROOT" && bun -e "const m = await import('./scripts/pendencias-deploy.ts'); process.stdout.write(m.SQL)")"
SQL_SAUDE="$(cd "$REPO_ROOT" && bun -e "const m = await import('./scripts/pendencias-deploy.ts'); process.stdout.write(m.SQL_SAUDE_COLETOR)")"
[ -n "$SQL_CLI" ] && [ -n "$SQL_SAUDE" ] || { echo "não extraí o SQL do CLI (bun -e)"; exit 1; }
SQL_SAUDE_SEM_PONTO="${SQL_SAUDE%;}"

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'
F_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
F_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

# ── asserts: "<ID> OK" · "<ID> FALHOU" · "<ID> ERRO_DE_EXECUCAO [<linhas ERROR>]" ─────────
# Cada MEDIÇÃO (Pq) deixa o seu stderr em $ERRS e o seu status ≠0 em $ERRS_RC; o `eq` do assert
# lê os dois e os zera — a associação é da medição, e cada assert tem a SUA (o A9 roda a query uma
# vez por assert). Linha ERROR (severidade ancorada no início da linha) OU status ≠0 querem dizer
# que o valor não é resultado: o assert não julgou nada e vira ERRO_DE_EXECUCAO — nunca FALHOU,
# nem "veio []" comparável (conexão que cai também devolve vazio). Entre colchetes vão TODAS as
# linhas ERROR da medição; a falsificação só aceita esse vermelho quando ele é EXATAMENTE a
# assinatura declarada para ESTE assert — uma linha só (um NOTICE multilinha forja a segunda).
PASS=0; FAIL=0; ERRS=""; ERRS_RC=""
ok()        { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()       { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec() { FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO [$2] — $3"; }
eq() {   # "<ID> <rótulo>" <valor> <esperado>
  local id="${1%% *}" rotulo="${1#* }" erros rc
  erros="$(grep -E '^(psql:[^ ]*: )?ERROR:  ' "$ERRS" | sed -E 's/^psql:[^ ]*: //' \
             | awk 'NR > 1 { printf " ;; " } { printf "%s", $0 }' || true)"
  rc="$(tr '\n' ' ' < "$ERRS_RC")"
  : > "$ERRS"; : > "$ERRS_RC"
  if [ -n "$erros" ]; then erro_exec "$id" "$erros" "$rotulo"
  elif [ -n "$rc" ]; then erro_exec "$id" "psql saiu rc=${rc% } sem linha ERROR" "$rotulo"
  elif [ "$2" = "$3" ]; then ok "$id" "$rotulo (=$2)"
  else bad "$id" "$rotulo — esperado [$3], veio [$2]"; fi
}
recibo() { echo "PASS=${PASS}  FAIL=${FAIL}"; }

# ── prova(<migration>) — banco fresco, stubs, migration, fixtures, asserts ─────────────
prova() {
  local mig="$1" db="$2" r
  PASS=0; FAIL=0; ERRS="$TMPD/stderr-$db.txt"; ERRS_RC="$TMPD/rc-$db.txt"; : > "$ERRS"; : > "$ERRS_RC"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  # -X: sem ~/.psqlrc — ele mudaria o formato da linha ERROR que os juízes leem
  P()  { "$PGBIN/psql" -X -v VERBOSITY=default -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
  Pq() { local rc=0; P -q -tA "$@" 2>>"$ERRS" || rc=$?; if [ "$rc" -ne 0 ]; then echo "$rc" >> "$ERRS_RC"; fi; return "$rc"; }

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

  # ZONA 2: a migration (com a semente rodando sobre janela VAZIA). O apply É um assert (A0):
  # a postcondição que aborta o apply sabotado é julgada pela linha ERROR dela.
  echo "═══ apply: $(basename "$mig") ═══"
  if P -q -f "$mig" 2>>"$ERRS"; then r=aplicou; else echo "$?" >> "$ERRS_RC"; r=abortou; fi
  eq "A0 APPLY da migration" "$r" "aplicou"
  if [ "$r" != aplicou ]; then recibo; return 0; fi

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
  -- jsonb_typeof separa (é a camada que edge_sem_tipo/versao_sem_tipo removem)
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

  # A9: a query do CLI — 1 linha por edge, 6 campos, e no empate de created vence o request_id
  # maior. Cada assert roda a query DE NOVO: o erro que ele julga tem de ser o da SUA medição (uma
  # `cli=$(…)` compartilhada deixava o 1º assert consumir o erro e os outros julgarem o vazio — e,
  # atribuição simples sob `set -e`, matava a rodada inteira sem veredito).
  cli() { Pq -F '|' -c "$SQL_CLI"; }
  eq "A9a CLI: 1 linha por edge (a,b,c,d)" "$(cli | cut -d'|' -f1 | tr '\n' ',')" "edge-a,edge-b,edge-c,edge-d,"
  eq "A9b CLI: 6 campos por linha" "$(cli | awk -F'|' '{print NF}' | sort -u | tr '\n' ',')" "6,"
  eq "A9c CLI: empate de created -> request_id maior (12 = v1.0-a-bis)" "$(cli | awk -F'|' '$1=="edge-a"{print $2}')" "v1.0-a-bis"
  eq "A9d CLI: via da edge-b = eco" "$(cli | awk -F'|' '$1=="edge-b"{print $4}')" "eco"

  # A10: a saúde do coletor — sem execução = 'nunca'; com sucesso há 10 min = ~10
  eq "A10a saude sem execucao = nunca" "$(Pq -c "$SQL_SAUDE")" "nunca"
  P -q -c "INSERT INTO cron.job_run_details (jobid, runid, status, end_time) SELECT jobid, 1, 'succeeded', now() - interval '10 min' FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'"
  eq "A10b saude com sucesso ha 10 min" "$(Pq -c "SELECT ((${SQL_SAUDE_SEM_PONTO})::numeric BETWEEN 9.5 AND 10.5)::text")" "true"
  P -q -c "INSERT INTO cron.job_run_details (jobid, runid, status, end_time) SELECT jobid, 2, 'failed', now() FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'"
  eq "A10c falha recente NAO conta como saude" "$(Pq -c "SELECT ((${SQL_SAUDE_SEM_PONTO})::numeric BETWEEN 9.5 AND 10.5)::text")" "true"

  # A11: re-aplicar a migration não erra e não duplica o cron
  if P -q -f "$mig" >/dev/null 2>>"$ERRS"; then r=aplicou; else echo "$?" >> "$ERRS_RC"; r=abortou; fi
  eq "A11a re-apply sem erro" "$r" "aplicou"
  eq "A11b cron unico apos re-apply" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'deploy-atestacoes-colher'")" "1"
  eq "A11c ledger intacto apos re-apply" "$(Pq -c "SELECT count(*) FROM public.deploy_atestacoes")" "5"

  recibo
  return 0
}

# ── sabotar(<nome>) — cópia da migration com UMA defesa trocada; imprime o caminho da cópia ──
# Troca LITERAL com contagem EXATA: padrão que não ocorre n× é sabotagem NÃO APLICÁVEL (a
# migration derivou) — a rodada para antes da linha "SABOTAGEM ATIVA", e o laço acusa em vez de
# aprovar. As quatro últimas vieram do test-pendencias-deploy-eco-passivo.sh (aposentado).
sabotar() {
  local nome="$1" de para n out="$TMPD/sab-$1.sql"
  case "$nome" in
    # probe tipado (booleano true) → texto: a string "true" (id 5) passa a entrar na janela
    probe_como_texto)   de="(r.c -> 'probe') = to_jsonb(true)"; para="(r.c ->> 'probe') = 'true'"; n=2 ;;
    # sem o REVOKE de anon na tabela → a postcondição A3 da migration aborta o apply
    sem_revoke_anon)    de=$'REVOKE ALL ON public.deploy_atestacoes FROM anon;\n'; para=""; n=1 ;;
    # sem o tipo de `edge` → {"edge":12345} vira a edge '12345' (a regex aceita dígitos) e entra
    edge_sem_tipo)      de=$'    AND jsonb_typeof(r.c -> \'edge\') = \'string\'\n'; para=""; n=1 ;;
    # sem o tipo de `versao` → {"versao":7} vira '7' (length 1 passa) e entra
    versao_sem_tipo)    de=$'    AND jsonb_typeof(r.c -> \'versao\') = \'string\'\n'; para=""; n=1 ;;
    # o bug do #2103: só a sonda ATIVA conta — o eco passivo (a via maior) some da janela
    eco_exige_probe)    de="AND (NOT (r.c ? 'probe') OR (r.c -> 'probe') = to_jsonb(true))"
                        para="AND (r.c -> 'probe') = to_jsonb(true)"; n=1 ;;
    # a troca NULL-blind: chave AUSENTE devolve NULL em `<>`, o eco some — e probe:false entra
    eco_null_blind)     de="NOT (r.c ? 'probe')"; para="(r.c ->> 'probe') <> 'true'"; n=1 ;;
    # sem o CASE protetor do cast: o corpo truncado que começa com '{' (id 7) chega ao cast e
    # derruba a janela INTEIRA — e com ela o coletor e o CLI (o modo de falha do guard)
    sem_is_json_object) de="CASE WHEN content IS JSON OBJECT THEN content::jsonb END AS c"
                        para="content::jsonb AS c"; n=1 ;;
    # sem o coalesce: eco sem fingerprint (id 3) chega ao ledger com fonte NULL, e o NOT NULL
    # derruba a cópia INTEIRA — ausente ≠ zero, e o ledger para de encher
    fonte_sem_coalesce) de="coalesce(r.c ->> 'fonte', 'sem-campo')"; para="r.c ->> 'fonte'"; n=1 ;;
    *) echo "❌ SABOTAGEM NAO APLICAVEL: $nome não tem ramo em sabotar()" >&2; return 1 ;;
  esac
  python3 - "$MIG" "$out" "$de" "$para" "$n" <<'PY' || { echo "❌ SABOTAGEM NAO APLICAVEL: $nome" >&2; return 1; }
import sys
mig, out, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
s = open(mig, encoding="utf-8").read()
if s.count(de) != n:
    print("   padrão ocorre %dx, esperado %d: %r" % (s.count(de), n, de), file=sys.stderr)
    sys.exit(1)
open(out, "w", encoding="utf-8").write(s.replace(de, para))
PY
  printf '%s' "$out"
}

# ── assinatura(<MARCA>) — a linha ERROR INTEIRA que a marca declara: identidade, não palavra
# solta (`null value in column "fonte` aceitaria "fonte_errada"; só o SQLSTATE aceitaria
# qualquer NOT NULL — Codex, 2026-09-27). O servidor é initdb --locale=C: a mensagem é fixa.
assinatura() {
  case "$1" in
    pos_a3_revoke) echo 'ERROR:  A3 FALHOU: privilegio aberto no ledger (anon SELECT ou authenticated escrita) — o REVOKE por nome nao pegou' ;;
    json_invalido) echo 'ERROR:  invalid input syntax for type json' ;;
    fonte_nula)    echo 'ERROR:  null value in column "fonte" of relation "deploy_atestacoes" violates not-null constraint' ;;
    *) return 1 ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE — e que o vermelho é do assert DECLARADO.
# exit≠0 NÃO é dente (docs/historico/falsificacao-exit-nao-e-dente.md). Até 2026-09-27 este laço
# aceitava "APPLY" em qualquer aborto do apply e `grep 'A1'` em NOMES_FALHOS (que casa A10a/A11a).
# Cada sabotagem declara quem a acusa, `,` = E:
#   `ID`       — o assert fica vermelho POR RESULTADO (FALHOU);
#   `ID!MARCA` — o vermelho declarado É um erro de execução: a linha do assert traz, sozinha
#                entre colchetes, a assinatura(MARCA). Cascata legítima também se declara, par a
#                par — marca que valesse para qualquer assert aceitaria a mesma mensagem vinda de
#                outra causa.
# A rodada só conta como vermelha com as QUATRO camadas:
#   1. a sabotagem APLICOU (a linha "SABOTAGEM ATIVA: <nome>" está no log);
#   2. a suíte rodou INTEIRA e IGUAL: a mesma sequência de IDs do controle, um recibo só (só o A0
#      se o vermelho declarado é o apply) — a soma sozinha aceitaria um assert faltando e outro
#      duplicado;
#   3. cada ID declarado está verde no controle e vermelho aqui DO JEITO declarado;
#   4. TODA linha ERRO_DE_EXECUCAO da rodada é um par (ID, assinatura) que ESTA sabotagem declarou.
# O controle roda PRIMEIRO, na mesma invocação: suíte que já falha aprovaria tudo por vermelhidão.
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="probe_como_texto:A1
              sem_revoke_anon:A0!pos_a3_revoke
              edge_sem_tipo:A1
              versao_sem_tipo:A1
              eco_exige_probe:A1,A4
              eco_null_blind:A1,A4,A6
              sem_is_json_object:A1!json_invalido,A2!json_invalido,A3!json_invalido,A9a!json_invalido,A9b!json_invalido,A9c!json_invalido,A9d!json_invalido,A11a!json_invalido
              fonte_sem_coalesce:A2!fonte_nula,A3!fonte_nula,A11a!fonte_nula"
  TOTAL_ESPERADO=24   # asserts da suíte (A0…A11c): o denominador do controle
  LOGDIR="$TMPD/falsifica"; mkdir -p "$LOGDIR"
  # os IDs que uma rodada julgou, um por linha, na ordem em que rodaram
  ids_de() { { grep -Eo '^  (✅|❌) A[0-9]+[a-z]? ' "$1" || true; } | sed -E 's/^  (✅|❌) //; s/ $//'; }
  recibos_de() { grep -c '^PASS=[0-9][0-9]*  FAIL=[0-9][0-9]*$' "$1" || true; }
  # a linha começa EXATAMENTE com o prefixo (literal: a assinatura tem aspas e parênteses). O
  # prefixo vai por ENVIRON, não por `-v`: o `-v` interpreta escapes, e o awk BSD do macOS recusa
  # nele a quebra de linha que a lista de permitidos (abaixo) tem.
  comeca_com() { PREFIXO="$1" awk 'index($0, ENVIRON["PREFIXO"]) == 1 { f = 1 } END { exit !f }' "$2"; }
  # Cada rodada num SUBSHELL com `set -e` próprio: o aborto mata a rodada, não o laço, e o recibo
  # que falta vira a camada 2. Chame SEMPRE como comando simples — dentro de `if`/`||`/`&&` o bash
  # 3.2 SUSPENDE o `set -e` do subshell (medido em 2026-09-27: o `false` passa e a rodada "segue"),
  # e um aborto no meio da suíte sairia como rodada inteira. O rc fica em RC_RODADA.
  rodada() {  # <log> <nome-da-sabotagem | vazio = controle>
    set +e
    (
      set -e
      if [ -z "$2" ]; then alvo="$MIG"; else alvo="$(sabotar "$2")"; echo "SABOTAGEM ATIVA: $2"; fi
      prova "$alvo" "prova_${2:-controle}"
    ) > "$1" 2>&1
    RC_RODADA=$?
    set -e
  }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  rodada "$LOGDIR/controle.log" ""
  ids_controle="$(ids_de "$LOGDIR/controle.log")"
  if [ "$RC_RODADA" -eq 0 ] && [ "$(recibos_de "$LOGDIR/controle.log")" = 1 ] \
     && grep -q '^PASS=[0-9]*  FAIL=0$' "$LOGDIR/controle.log" \
     && [ "$(printf '%s\n' "$ids_controle" | sort -u | grep -c .)" = "$TOTAL_ESPERADO" ] \
     && [ "$(printf '%s\n' "$ids_controle" | grep -c .)" = "$TOTAL_ESPERADO" ]; then
    echo "  ✅ controle VERDE ($TOTAL_ESPERADO asserts, IDs únicos) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE não é verde com os $TOTAL_ESPERADO asserts de IDs únicos (rc=$RC_RODADA) — abortando ANTES"
    echo "     de sabotar: uma suíte que já falha aprovaria as sabotagens por vermelhidão constante."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; verm="${item#*:}"
    log="$LOGDIR/$sab.log"
    rodada "$log" "$sab"   # o veredito é das camadas abaixo, nunca do RC_RODADA
    ids_esperados="$ids_controle"; faltam=""; permitidos=""
    for x in ${verm//,/ }; do
      id="${x%%!*}"
      if ! grep -Eq "^  ✅ ${id} OK " "$LOGDIR/controle.log"; then faltam="$faltam $x(não é verde no controle)"; continue; fi
      case "$x" in
        *!*) if ! sig="$(assinatura "${x#*!}")"; then faltam="$faltam $x(marca sem assinatura)"; continue; fi
             if [ "$id" = A0 ]; then ids_esperados="A0"; fi
             prefixo="  ❌ ${id} ERRO_DE_EXECUCAO [${sig}] — "
             permitidos="${permitidos}${prefixo}"$'\n'
             comeca_com "$prefixo" "$log" || faltam="$faltam $x" ;;
        *)   grep -Eq "^  ❌ ${id} FALHOU " "$log" || faltam="$faltam $x" ;;
      esac
    done
    alheios="$(PERMITIDOS="$permitidos" awk 'BEGIN { n = split(ENVIRON["PERMITIDOS"], ok, "\n") }
                 / ERRO_DE_EXECUCAO / { bom = 0; for (i = 1; i <= n; i++) if (ok[i] != "" && index($0, ok[i]) == 1) bom = 1; if (!bom) print }' "$log")"
    vermelhos="$({ grep -Eo '^  ❌ A[0-9]+[a-z]? ' "$log" || true; } | sed -E 's/^  ❌ //; s/ $//' | tr '\n' ' ')"
    if ! grep -q "^SABOTAGEM ATIVA: ${sab}\$" "$log"; then
      echo "  ❌ $sab — a sabotagem NÃO aplicou (padrão derivou? nome sem ramo?): nenhum assert julgou nada"
      { grep -m2 -E 'NAO APLICAVEL|padrão ocorre' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(recibos_de "$log")" != 1 ] || [ "$(ids_de "$log")" != "$ids_esperados" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira e igual ao controle ($(ids_de "$log" | grep -c . || true) IDs, $(recibos_de "$log") recibo(s)): vermelho de aborto, não de assert"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$alheios" ]; then
      echo "  ❌ $sab — ERRO DE EXECUÇÃO que a sabotagem não declarou: vermelho que não é do assert não mata mutante"
      printf '%s\n' "$alheios" | sed -n '1,2s/^/       /p'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — o assert declarado não ficou vermelho do jeito declarado:$faltam"
      echo "       vermelhos desta rodada: ${vermelhos:-nenhum assert}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert declarado · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho declarado ═══"
  exit 1
fi

echo "═══ setup (PG17 :$PORT) ═══"
prova "$MIG" prova
echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
