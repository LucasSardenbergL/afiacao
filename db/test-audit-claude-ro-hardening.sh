#!/usr/bin/env bash
# shellcheck disable=SC2329  # `cleanup` é invocada indiretamente, pelo `trap` (o shellcheck não vê).
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA O DENTE de db/audit-claude-ro-hardening.ts (a sentinela do papel `claude_ro`).         ║
# ║                                                                                              ║
# ║  Sobe um PG17 descartável, monta nele um mundo com a topologia MEDIDA na prod em 2026-08-25  ║
# ║  (papel sem memberships, GUC preso, schemas de negócio alcançáveis, `auth`/`vault` fora,      ║
# ║  schema `net` com PUBLIC nos defaults do pg_net), e roda o audit REAL — o mesmo binário que   ║
# ║  aponta para prod — com PSQL_RO redirecionado para este PG.                                  ║
# ║                                                                                              ║
# ║  Nada de reimplementar a lógica no shell: o que está sob teste é o executável inteiro —       ║
# ║  query, parser da saída, comparação com o baseline e exit code. Cada cenário SABOTA um eixo   ║
# ║  e EXIGE vermelho; um audit que só sabe dizer "está tudo bem" não é sentinela, é enfeite.     ║
# ║                                                                                              ║
# ║   (A) topologia íntegra                          → exit 0                                    ║
# ║   (B) GRANT pg_read_all_data                     → exit 1   ← a regressão-mãe                 ║
# ║   (C) GUC via ALTER ROLE SET (rolconfig)         → exit 0   ← NÃO pode dar falso-vermelho    ║
# ║   (D) GUC removido das duas fontes               → exit 1                                    ║
# ║   (E) tabela nova em public sem GRANT            → exit 1 ; com GRANT volta a 0 ← acusa SOME  ║
# ║   (F) REVOKE em net.http_post pelo DONO          → exit 1   ← o net FECHANDO também acusa     ║
# ║   (G) função nova no schema net                  → exit 1   ← upgrade de extensão             ║
# ║   (H) GRANT USAGE ON SCHEMA auth                 → exit 1   ← catálogo E sonda executiva      ║
# ║   (I) DROP SCHEMA vault                          → exit 1   ← AUSENTE ≠ "negado com sucesso"  ║
# ║   (J) baseline pede pg_net 0.19.5, banco não tem → exit 1                                    ║
# ║   (K) psql que devolve vazio                     → exit 2   ← medição quebrada ≠ aprovação    ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PORT="${PGPORT_TEST:-5481}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$RAIZ/db/audit-claude-ro-hardening.ts"
TMP="$(mktemp -d /tmp/pgtest-clauderro.XXXXXX)"
DATA="$TMP/data"
# LC_ALL=C de propósito: a sonda executiva casa a SQLSTATE `42501`, que é ASCII e invariante a
# locale — justamente para não repetir o #1483, onde uma asserção passou num locale e falhou no
# outro. Se algum dia alguém trocar o veredito por texto ("permission denied"), este teste
# continua verde e a prod quebra calada. Está aqui como lembrete, não como muleta.
export LC_ALL=C LANG=C

CELLAR="$(brew --prefix postgresql@17)"
cp -Rn "$CELLAR"/share/postgresql/. /opt/homebrew/share/postgresql@17/ 2>/dev/null || true
mkdir -p /opt/homebrew/lib/postgresql@17
cp -Rn "$CELLAR"/lib/postgresql/. /opt/homebrew/lib/postgresql@17/ 2>/dev/null || true

cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove

# Sabotagem/restauração rodam como superuser; a MEDIÇÃO nunca (senão o audit veria tudo).
S(){ "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q "$@"; }

# ── o mundo prod-like ─────────────────────────────────────────────────────────────────────────
S <<'SQL'
CREATE ROLE supabase_admin NOSUPERUSER CREATEDB;
CREATE ROLE claude_ro LOGIN BYPASSRLS;         -- espelha os atributos medidos na prod
ALTER ROLE claude_ro IN DATABASE prove SET default_transaction_read_only = on;
GRANT CREATE ON DATABASE prove TO supabase_admin;

-- schemas de negócio, alcançáveis por GRANT nominal
CREATE SCHEMA cron;
CREATE SCHEMA supabase_migrations;
CREATE TABLE public.pedidos(id int);
CREATE TABLE public.produtos(id int);
CREATE VIEW  public.v_pedidos AS SELECT * FROM public.pedidos;
CREATE TABLE cron.job(jobid bigint, command text);
CREATE TABLE cron.job_run_details(runid bigint, status text);
CREATE TABLE supabase_migrations.schema_migrations(version text);
GRANT USAGE ON SCHEMA public, cron, supabase_migrations TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, cron, supabase_migrations TO claude_ro;

-- schemas FORA de alcance: existem, e o papel não os enxerga
CREATE SCHEMA auth;           CREATE SCHEMA vault;    CREATE SCHEMA storage;
CREATE SCHEMA realtime;       CREATE SCHEMA extensions;
CREATE SCHEMA graphql_public;
CREATE TABLE auth.refresh_tokens(id bigint, token text, revoked boolean);
CREATE VIEW  vault.decrypted_secrets AS SELECT 'x'::text AS decrypted_secret;

-- schema net com os DEFAULTS do pg_net: funções com proacl NULL (=> EXECUTE p/ PUBLIC),
-- tabelas e SEQUÊNCIA com PUBLIC nos privilégios, dono `supabase_admin`.
SET ROLE supabase_admin;
CREATE SCHEMA net;
GRANT USAGE ON SCHEMA net TO PUBLIC;
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
  headers jsonb DEFAULT '{}', timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}',
  timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE FUNCTION net.wake() RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION net.worker_restart() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE net.http_request_queue(id bigserial PRIMARY KEY, url text);
CREATE TABLE net._http_response(id bigint, status_code integer, content text);
GRANT ALL ON net.http_request_queue, net._http_response TO PUBLIC;
GRANT ALL ON SEQUENCE net.http_request_queue_id_seq TO PUBLIC;
RESET ROLE;
SQL

# ── o wrapper fake ────────────────────────────────────────────────────────────────────────────
# Conecta COMO `claude_ro` (não como postgres): a sonda executiva só prova alguma coisa se quem
# roda a consulta for o papel vigiado. E carrega um psqlrc que ecoa dois `SET`, reproduzindo o
# wrapper real — é esse eco que o prefixo `ROW|` do audit existe para descartar. Sem ele o teste
# aprovaria um parser que só funciona aqui.
cat > "$TMP/psqlrc" <<'RC'
SET default_transaction_read_only = on;
SET statement_timeout = '30s';
RC
cat > "$TMP/psql-ro-fake" <<FAKE
#!/usr/bin/env bash
exec env PSQLRC="$TMP/psqlrc" "$PGBIN/psql" -p "$PORT" -h /tmp -U claude_ro -d prove "\$@"
FAKE
chmod +x "$TMP/psql-ro-fake"

# ── o baseline de TESTE ───────────────────────────────────────────────────────────────────────
# Escrito à mão, e de propósito: derivá-lo da própria medição seria tautologia — o audit passaria
# comparando o banco consigo mesmo. Se algum ACL aqui estiver errado, o cenário (A) fica vermelho
# e o erro aparece. `pgNetVersion: AUSENTE` porque a extensão pg_net não existe num PG17 do brew;
# o eixo da versão é provado à parte, no cenário (J).
BASELINE_OK=$(cat <<'JSON'
{
  "rolattrs": "super=f bypassrls=t createrole=f createdb=f login=t",
  "memberships": 0,
  "guc": "default_transaction_read_only=on",
  "schemasComAlcance": ["public","cron","supabase_migrations","net"],
  "schemasSemAlcance": ["auth","vault","storage","realtime","graphql_public","extensions"],
  "tabelasLegiveis": ["cron.job","cron.job_run_details","net._http_response","supabase_migrations.schema_migrations"],
  "netAcl": [
    "F|http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)|DEFAULT",
    "F|http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer)|DEFAULT",
    "F|wake()|DEFAULT",
    "F|worker_restart()|DEFAULT",
    "N|net|{supabase_admin=UC/supabase_admin,=U/supabase_admin}",
    "R|_http_response|r|{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}",
    "R|http_request_queue|r|{supabase_admin=arwdDxtm/supabase_admin,=arwdDxtm/supabase_admin}",
    "R|http_request_queue_id_seq|S|{supabase_admin=rwU/supabase_admin,=rwU/supabase_admin}"
  ],
  "pgNetVersion": "AUSENTE",
  "sondasNegadas": [
    { "rotulo": "auth.refresh_tokens", "sql": "SELECT count(*) FROM auth.refresh_tokens" },
    { "rotulo": "vault.decrypted_secrets", "sql": "SELECT decrypted_secret FROM vault.decrypted_secrets LIMIT 1" }
  ]
}
JSON
)

FALHAS=0
# Roda o audit REAL e confere exit + marca. Sem pipe na captura do status: `| tail` engoliria o
# exit code e este harness fabricaria o próprio veredito (docs/historico/evidencia-positiva-shell.md).
roda(){ # $1=rótulo  $2=exit esperado  $3=marca exigida na saída (vazio = nenhuma)
  local rotulo="$1" esperado="$2" marca="${3:-}" saida rc
  set +e
  saida="$(CLAUDE_RO_BASELINE_TEST_JSON="${BASELINE_JSON:-$BASELINE_OK}" PSQL_RO="${PSQL_FAKE:-$TMP/psql-ro-fake}" \
           bun "$AUDIT" 2>&1)"
  rc=$?
  set -e
  local veredito="ok"
  [ "$rc" = "$esperado" ] || veredito="EXIT $rc (esperado $esperado)"
  if [ -n "$marca" ] && ! printf '%s' "$saida" | grep -qF -- "$marca"; then
    veredito="${veredito/ok/} sem a marca «$marca»"
  fi
  if [ "$veredito" = "ok" ]; then
    printf '  ✅ %-52s exit=%s\n' "$rotulo" "$rc"
  else
    printf '  ❌ %-52s %s\n' "$rotulo" "$veredito"
    printf '%s\n' "$saida" | sed 's/^/        /' | head -30
    FALHAS=$((FALHAS+1))
  fi
}

echo; echo "── (A) topologia íntegra ──────────────────────────────────────────────────────"
roda "estado bom" 0 "O endurecimento continua de pé"

echo; echo "── (B) a regressão-mãe: pg_read_all_data de volta ─────────────────────────────"
S -c "GRANT pg_read_all_data TO claude_ro;"
roda "membership devolvida" 1 "memberships herdadas"
S -c "REVOKE pg_read_all_data FROM claude_ro;"
roda "membership retirada de novo (a acusação SOME)" 0

echo; echo "── (C)(D) o GUC e suas DUAS fontes ────────────────────────────────────────────"
# A armadilha do histórico: o bloco aplicado usou `IN DATABASE`, então o valor foi para
# pg_db_role_setting e `pg_roles.rolconfig` ficou NULL. Um audit que lesse só `rolconfig` daria
# falso-vermelho. Aqui o GUC muda de fonte e o veredito NÃO pode mudar.
S -c "ALTER ROLE claude_ro IN DATABASE prove RESET default_transaction_read_only;"
S -c "ALTER ROLE claude_ro SET default_transaction_read_only = on;"
roda "GUC só em rolconfig (sem IN DATABASE)" 0 "GUC vem de: rolconfig"
S -c "ALTER ROLE claude_ro RESET default_transaction_read_only;"
roda "GUC removido das duas fontes" 1 "GUC read-only preso ao papel"
S -c "ALTER ROLE claude_ro IN DATABASE prove SET default_transaction_read_only = on;"

echo; echo "── (E) cobertura de leitura em public ─────────────────────────────────────────"
S -c "CREATE TABLE public.tabela_de_outro_dono(id int);"
S -c "REVOKE SELECT ON public.tabela_de_outro_dono FROM claude_ro;"
roda "tabela nova invisível ao diagnóstico" 1 "objetos de public SEM SELECT"
S -c "GRANT SELECT ON public.tabela_de_outro_dono TO claude_ro;"
roda "tabela nova concedida (a acusação SOME)" 0

echo; echo "── (F)(G) o schema net muda nos DOIS sentidos ─────────────────────────────────"
S -c "SET ROLE supabase_admin; REVOKE EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer) FROM PUBLIC;"
roda "net FECHANDO (revoke pelo dono)" 1 "ACL do schema net mudou"
S -c "SET ROLE supabase_admin; GRANT EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer) TO PUBLIC;"
# ⚠️ Um GRANT explícito a PUBLIC NÃO restaura `proacl IS NULL` — o catálogo passa a registrar o
# ACL que antes era implícito. O audit acusa, e está certo: "default" e "concedido nominalmente"
# são estados diferentes, ainda que confiram o mesmo privilégio hoje.
roda "re-GRANT explícito ≠ default (segue acusando)" 1 "ACL do schema net mudou"
S -c "SET ROLE supabase_admin; DROP FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer);
      CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
        headers jsonb DEFAULT '{}', timeout_milliseconds integer DEFAULT 5000)
        RETURNS bigint LANGUAGE sql AS \$\$ SELECT 1::bigint \$\$;"
roda "recriada com proacl NULL (a acusação SOME)" 0
S -c "SET ROLE supabase_admin; CREATE FUNCTION net.http_patch(url text) RETURNS bigint LANGUAGE sql AS \$\$ SELECT 1::bigint \$\$;"
roda "função nova em net (upgrade de extensão)" 1 "+ F|http_patch(url text)|DEFAULT"
S -c "SET ROLE supabase_admin; DROP FUNCTION net.http_patch(text);"

echo; echo "── (H) o schema auth volta a ser alcançável ───────────────────────────────────"
S -c "GRANT USAGE ON SCHEMA auth TO claude_ro; GRANT SELECT ON auth.refresh_tokens TO claude_ro;"
roda "auth reaberto: catálogo acusa" 1 "schema auth FORA de alcance"
roda "auth reaberto: sonda executiva acusa" 1 "consulta teve SUCESSO"
S -c "REVOKE ALL ON auth.refresh_tokens FROM claude_ro; REVOKE USAGE ON SCHEMA auth FROM claude_ro;"
roda "auth fechado de novo (a acusação SOME)" 0

echo; echo "── (I) objeto que SUMIU não é objeto NEGADO ───────────────────────────────────"
S -c "DROP SCHEMA vault CASCADE;"
roda "vault dropado vira AUSENTE, não NAO" 1 "AUSENTE"
S -c "CREATE SCHEMA vault; CREATE VIEW vault.decrypted_secrets AS SELECT 'x'::text AS decrypted_secret;"
roda "vault recriado (a acusação SOME)" 0

echo; echo "── (J) a versão do pg_net é asserção ──────────────────────────────────────────"
BASELINE_JSON="${BASELINE_OK/\"pgNetVersion\": \"AUSENTE\"/\"pgNetVersion\": \"0.19.5\"}" \
  roda "baseline pede 0.19.5, banco não tem" 1 "versão do pg_net"

echo; echo "── (K) medição quebrada NÃO é aprovação ───────────────────────────────────────"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/psql-mudo"; chmod +x "$TMP/psql-mudo"
PSQL_FAKE="$TMP/psql-mudo" roda "psql que devolve vazio" 2 "medição inconsistente"
printf '#!/usr/bin/env bash\nexit 3\n' > "$TMP/psql-quebrado"; chmod +x "$TMP/psql-quebrado"
PSQL_FAKE="$TMP/psql-quebrado" roda "psql que falha" 2 "falha ao consultar o banco"

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "✅ o audit acusou TODAS as regressões e não acusou nenhuma falsa. O dente existe."
  exit 0
fi
echo "❌ $FALHAS cenário(s) fora do esperado — o audit NÃO é confiável como sentinela."
exit 1
