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
# ║  ── a reconciliação de 2026-09-06 (#2275): `private` + a ponte de view ───────────────────    ║
# ║   (L) REVOKE USAGE ON SCHEMA private             → exit 1   ← a perda de 25/08 que passou     ║
# ║   (M) DROP de uma das 3 MVs                      → exit 1   ← AUSENTE, não schema vazio       ║
# ║   (N) MV nova em private sem GRANT               → exit 1   ← cobertura "0 sem SELECT"        ║
# ║   (O) ponte recriada SEM o WITH (invoker reset)  → exit 1   ← §4: o REPLACE RESETA a opção    ║
# ║   (P) ponte recriada com `= true`                → exit 0   ← NÃO pode dar falso-vermelho     ║
# ║   (Q) ponte passa a projetar `token`             → exit 1   ← reabre a escalada (P0)          ║
# ║   (R) GRANT SELECT (token) em auth.refresh_tokens→ exit 1   ← a 2ª barreira caindo            ║
# ║   (S) DROP da ponte                              → exit 1   ← telemetria morta ≠ "tudo bem"   ║
# ║   (T) REVOKE SELECT na ponte                     → exit 1   ← só a sonda EXECUTIVA percebe    ║
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
-- As 9 colunas MEDIDAS na prod: 7 de telemetria + `token`/`parent`, que são a escalada.
CREATE TABLE auth.refresh_tokens(
  instance_id uuid, id bigint, token text, user_id text, revoked boolean,
  created_at timestamptz, updated_at timestamptz, parent text, session_id uuid);
INSERT INTO auth.refresh_tokens(id, token, revoked) VALUES (1,'segredo',false);
-- O GRANT por COLUNA de 25/08: as 7 de telemetria, e SÓ elas. `token`/`parent` ficam sem ACL
-- próprio — é essa ausência que a ponte com `security_invoker=on` transforma em 2ª barreira.
GRANT SELECT (created_at, id, instance_id, revoked, session_id, updated_at, user_id)
  ON auth.refresh_tokens TO claude_ro;
CREATE VIEW  vault.decrypted_secrets AS SELECT 'x'::text AS decrypted_secret;

-- schema `private`: as 3 MVs de diagnóstico que caíram no fecho de 25/08 sem ninguém notar.
CREATE SCHEMA private;
CREATE MATERIALIZED VIEW private.mv_oportunidade_badge AS SELECT 1 AS n;
CREATE MATERIALIZED VIEW private.customer_metrics_mv AS SELECT 1 AS n;
CREATE MATERIALIZED VIEW private.mv_sku_ranking_negociacao_paralela AS SELECT 1 AS n;

-- A PONTE. `security_invoker = on` é o ponto todo: a leitura roda como o CALLER, então o ACL por
-- COLUNA acima continua sendo barreira. Note que `claude_ro` NÃO tem USAGE em `auth` e ainda
-- assim lê esta view — o rewriter não re-checa USAGE de schema ao expandir uma view, e é
-- exatamente esse comportamento que o cenário (A) prova de verdade neste PG17.
CREATE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS
  SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id
    FROM auth.refresh_tokens;

GRANT USAGE ON SCHEMA private TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA private TO claude_ro;

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
  "schemasComAlcance": ["public","private","cron","supabase_migrations","net"],
  "schemasSemAlcance": ["auth","vault","storage","realtime","graphql_public","extensions"],
  "tabelasLegiveis": ["private.mv_oportunidade_badge","private.customer_metrics_mv",
    "private.mv_sku_ranking_negociacao_paralela","private.auth_refresh_tokens_diag",
    "cron.job","cron.job_run_details","net._http_response","supabase_migrations.schema_migrations"],
  "schemasCobertura": ["public","private"],
  "ponte": {
    "schema": "private",
    "relacao": "auth_refresh_tokens_diag",
    "invokerAceitos": ["security_invoker=on","security_invoker=true"],
    "colunas": ["created_at","id","instance_id","revoked","session_id","updated_at","user_id"],
    "colunasProibidas": ["token","parent"]
  },
  "authColAcl": {
    "schema": "auth",
    "tabela": "refresh_tokens",
    "entradas": [
      "created_at|{claude_ro=r/postgres}",
      "id|{claude_ro=r/postgres}",
      "instance_id|{claude_ro=r/postgres}",
      "parent|SEM_ACL",
      "revoked|{claude_ro=r/postgres}",
      "session_id|{claude_ro=r/postgres}",
      "token|SEM_ACL",
      "updated_at|{claude_ro=r/postgres}",
      "user_id|{claude_ro=r/postgres}"
    ]
  },
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
    { "rotulo": "vault.decrypted_secrets", "sql": "SELECT decrypted_secret FROM vault.decrypted_secrets LIMIT 1" },
    { "rotulo": "token na ponte", "sqlstate": "42703",
      "sql": "SELECT token FROM private.auth_refresh_tokens_diag LIMIT 1" }
  ],
  "sondasPermitidas": [
    { "rotulo": "ponte de telemetria", "sql": "SELECT count(*) FROM private.auth_refresh_tokens_diag" }
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
# ⚠️ MEDIDO em PG17, e é armadilha de prod, não detalhe de teste: `REVOKE ALL ON <tabela>` NÃO se
# limita ao nível de TABELA — apaga os GRANTs por COLUNA junto (e `REVOKE SELECT ON <tabela>` faz
# exatamente o mesmo). Ou seja: um "vamos apertar mais" colado no SQL Editor destrói de lambuja o
# GRANT das 7 colunas de 25/08 e mata a ponte de telemetria, sem erro nenhum. Aqui o efeito seria
# pior que um cenário vermelho: sem re-conceder as colunas, a 2ª barreira ficaria destruída e TODO
# cenário seguinte sairia vermelho por herança — falha em cascata lida como 11 bugs diferentes.
S -c "REVOKE ALL ON auth.refresh_tokens FROM claude_ro; REVOKE USAGE ON SCHEMA auth FROM claude_ro;
      GRANT SELECT (created_at, id, instance_id, revoked, session_id, updated_at, user_id)
        ON auth.refresh_tokens TO claude_ro;"
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

# ╔═ a reconciliação de 2026-09-06 (#2275): `private` + a ponte de view ═════════════════════════╗
# Cada cenário abaixo sabota UM eixo e exige vermelho, e cada um é seguido do controle "a acusação
# SOME" — sem esse controle uma asserção sempre-vermelha aprovaria tudo (falsificacao-sem-linha-de-
# base.md). A ORDEM importa: `private` primeiro, ponte depois, ACL de coluna por último, porque a
# ponte depende do schema e o ACL de coluna só é barreira enquanto o invoker estiver `on`.
VDEF="SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id FROM auth.refresh_tokens"

echo; echo "── (L) o USAGE em private revogado — a perda de 25/08 que passou 13 dias ──────"
# ⚠️ Aqui o CATÁLOGO por si não bastaria: `has_table_privilege` não enxerga o USAGE do schema, então
# as 4 relações de `private` continuam respondendo SIM e a cobertura continua "0 sem SELECT". Quem
# percebe é o eixo de schema E a sonda EXECUTIVA — é a lição do §1 em forma de teste.
S -c "REVOKE USAGE ON SCHEMA private FROM claude_ro;"
roda "private inalcançável: sonda executiva acusa" 1 "o alcance caiu"
roda "private inalcançável: catálogo de schema acusa" 1 "medido:   NAO"
S -c "GRANT USAGE ON SCHEMA private TO claude_ro;"
roda "USAGE devolvido (a acusação SOME)" 0

echo; echo "── (M) DROP de uma das 3 MVs de diagnóstico ──────────────────────────────────"
S -c "DROP MATERIALIZED VIEW private.mv_oportunidade_badge;"
roda "MV sumida vira AUSENTE, não 'schema vazio'" 1 "medido:   AUSENTE"
S -c "CREATE MATERIALIZED VIEW private.mv_oportunidade_badge AS SELECT 1 AS n;
      GRANT SELECT ON private.mv_oportunidade_badge TO claude_ro;"
roda "MV recriada (a acusação SOME)" 0

echo; echo "── (N) relação nova em private sem GRANT ─────────────────────────────────────"
S -c "CREATE MATERIALIZED VIEW private.mv_recem_nascida AS SELECT 1 AS n;
      REVOKE SELECT ON private.mv_recem_nascida FROM claude_ro;"
roda "MV nova invisível ao diagnóstico" 1 "objetos de private SEM SELECT"
S -c "DROP MATERIALIZED VIEW private.mv_recem_nascida;"
roda "MV nova removida (a acusação SOME)" 0

echo; echo "── (O) a ponte recriada SEM o WITH: o invoker RESETA (§4) ────────────────────"
S -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag AS $VDEF;"
roda "invoker resetado: a view voltou a ler como OWNER" 1 "perdeu o security_invoker"
S -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS $VDEF;"
roda "WITH reposto (a acusação SOME)" 0

echo; echo "── (P) '= true' é o MESMO desenho que '= on' — não pode dar falso-vermelho ───"
# `reloptions` preserva o LITERAL do WITH (§4): casar só `=on` classificaria uma ponte perfeitamente
# segura como regressão. Sentinela que grita à toa é desligada — este cenário é o freio disso.
S -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = true) AS $VDEF;"
roda "ponte com literal 'true' segue VERDE" 0 "security_invoker=true"
S -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS $VDEF;"

echo; echo "── (Q) a ponte passa a projetar 'token' — reabre a escalada ──────────────────"
# A marca é «REABRE a escalada», NÃO «projeta token»: o ramo VERDE emite "não projeta token/parent",
# que CONTÉM "projeta token" — casar essa string faria o assert passar pela própria sentinela
# (a regra anti-teatro do CLAUDE.md). `CREATE OR REPLACE VIEW` só acrescenta coluna NO FIM.
S -c "DROP VIEW private.auth_refresh_tokens_diag;
      CREATE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS
        SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id, token
          FROM auth.refresh_tokens;
      GRANT SELECT ON private.auth_refresh_tokens_diag TO claude_ro;"
roda "ponte com token: a asserção de projeção acusa" 1 "REABRE a escalada"
S -c "DROP VIEW private.auth_refresh_tokens_diag;
      CREATE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS $VDEF;
      GRANT SELECT ON private.auth_refresh_tokens_diag TO claude_ro;"
roda "ponte sem token (a acusação SOME)" 0

echo; echo "── (R) a 2ª barreira: GRANT SELECT (token) na tabela-fonte ───────────────────"
S -c "GRANT SELECT (token) ON auth.refresh_tokens TO claude_ro;"
roda "token ganhou ACL próprio" 1 "ACL por coluna de auth.refresh_tokens mudou"
S -c "REVOKE SELECT (token) ON auth.refresh_tokens FROM claude_ro;"
roda "ACL de token revogado (a acusação SOME)" 0

echo; echo "── (S) a ponte APAGADA não é 'tudo bem' ──────────────────────────────────────"
S -c "DROP VIEW private.auth_refresh_tokens_diag;"
roda "ponte apagada: a telemetria morreu" 1 "NÃO EXISTE"
S -c "CREATE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS $VDEF;
      GRANT SELECT ON private.auth_refresh_tokens_diag TO claude_ro;"
roda "ponte recriada (a acusação SOME)" 0

echo; echo "── (T) só a sonda EXECUTIVA percebe o SELECT revogado na ponte ───────────────"
S -c "REVOKE SELECT ON private.auth_refresh_tokens_diag FROM claude_ro;"
roda "SELECT revogado: a sonda positiva acusa" 1 "o alcance caiu"
S -c "GRANT SELECT ON private.auth_refresh_tokens_diag TO claude_ro;"
roda "SELECT devolvido (a acusação SOME)" 0

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "✅ o audit acusou TODAS as regressões e não acusou nenhuma falsa. O dente existe."
  exit 0
fi
echo "❌ $FALHAS cenário(s) fora do esperado — o audit NÃO é confiável como sentinela."
exit 1
