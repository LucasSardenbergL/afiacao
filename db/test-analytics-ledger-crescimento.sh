#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261012233500_analytics_ledger_crescimento_comparavel.sql       ║
# ║      bash db/test-analytics-ledger-crescimento.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║  (NÃO pipe pra tail — engole o exit≠0.)  Locale: LOCALE_TESTE=pt_BR.UTF-8 roda   ║
# ║  a mesma prova no outro locale (as sentinelas são ASCII, caixa fixa).            ║
# ║                                                                                ║
# ║  O ledger é SECURITY DEFINER: o gate de quem escreve vive no corpo, e plpgsql é  ║
# ║  late-bound. Prova EXECUTANDO, na cadeia real de migrations: base do outbox →   ║
# ║  20260908055405 (rota_servida) → esta. Falsifica a POSTCONDIÇÃO: sabotar a       ║
# ║  allowlist tem de abortar a migration, e a função boa tem de sobreviver.        ║
# ╚═══════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="analytics-ledger-crescimento"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ O ALTER DEFAULT PRIVILEGES abaixo NÃO é enfeite: ele reproduz o que o
# Supabase faz no schema public, e é o que dá TRABALHO REAL ao `REVOKE ... FROM
# authenticated` da migration. Sem ele, `authenticated` já não teria privilégio
# nenhum e o assert do REVOKE passaria por vacuidade — verde por ausência de
# grant, não por presença de defesa.
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);

-- espelha as colunas REAIS da prod (medidas 2026-08-25 via psql-ro):
-- id é bigint e aprovado_por é TEXT guardando e-mail — não uuid.
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id                 bigserial PRIMARY KEY,
  status             text NOT NULL,
  criado_em          timestamptz DEFAULT now(),
  atualizado_em      timestamptz DEFAULT now(),
  aprovado_em        timestamptz,
  aprovado_por       text,
  cancelado_em       timestamptz,
  condicao_origem    text,
  origem_evento_tipo text
);

-- stub do pg_cron (a migration agenda a purga).
-- ⚠️ `cron.job` já vem de db/stubs-supabase.sql, com `jobid bigint PRIMARY KEY`
-- SEM default — por isso o jobid é gerado aqui em vez de recriar a tabela (o
-- CREATE TABLE IF NOT EXISTS não teria efeito e o INSERT quebraria no NOT NULL).
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true)
  RETURNING jobid;
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; $f$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
SQL

# ════════════════════════════════════════════════════════
# ZONA 2 — CADEIA REAL DE MIGRATIONS
# ════════════════════════════════════════════════════════
M_BASE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
M_ROTA="$REPO_ROOT/supabase/migrations/20260908055405_analytics_ledger_navegacao_postcondicao_corrigida.sql"
MIG="$REPO_ROOT/supabase/migrations/20261012233500_analytics_ledger_crescimento_comparavel.sql"
P -q -f "$M_BASE"; P -q -f "$M_ROTA"; P -q -f "$MIG"
echo "cadeia aplicada: base → rota_servida → $(basename "$MIG")"

UID_A='11111111-1111-1111-1111-111111111111'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$UID_A') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$UID_A', 'master');
SQL

reg() { Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SELECT public.analytics_ledger_registrar('$1','$2','{}'::jsonb); SELECT count(*) FROM public.analytics_outbox WHERE evento='$1';" | tail -1; }

echo "── asserts ──"
eq "B1 evento novo grava" "$(reg dashboard.crescimento_comparavel_servido oben:ano_anterior)" "1"
eq "B2 mixgap continua gravando" "$(reg carteira.mixgap_servido k)" "1"
eq "B3 rota_servida continua gravando" "$(reg navegacao.rota_servida /meu-dia)" "1"
eq "B4 mesmo evento+chave no dia dedupa" "$(reg dashboard.crescimento_comparavel_servido oben:ano_anterior)" "1"
eq "B5 chave diferente (outra comparacao) e linha nova" "$(reg dashboard.crescimento_comparavel_servido oben:meses_anteriores)" "2"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$UID_A';
DO \$t\$ BEGIN
  PERFORM public.analytics_ledger_registrar('dashboard.qualquer_coisa','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ALLOW_FURADO';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENT_ALLOW_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
case "$R" in *SENT_ALLOW_OK*) ok "B6 evento fora da allowlist rejeitado (22023)";; *) bad "B6 allowlist NAO barrou — [$R]";; esac

R=$(P -tA 2>&1 <<'SQL'
SET test.uid='';
DO $t$ BEGIN
  PERFORM public.analytics_ledger_registrar('dashboard.crescimento_comparavel_servido','k','{}'::jsonb);
  RAISE NOTICE 'SENT_ANON_FURADO';
EXCEPTION
  WHEN invalid_authorization_specification THEN RAISE NOTICE 'SENT_ANON_OK';
  WHEN OTHERS THEN RAISE;
END $t$;
SQL
)
case "$R" in *SENT_ANON_OK*) ok "B7 sem autenticacao rejeitado (28000)";; *) bad "B7 anonimo passou — [$R]";; esac

V=$(Pq -c "SELECT has_function_privilege('anon', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text || ',' || has_function_privilege('authenticated', to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'), 'EXECUTE')::text;")
eq "B8 ACL: anon sem EXECUTE, authenticated com" "$V" "false,true"

echo "── falsificacao: a postcondicao tem de abortar a migration sabotada ──"
FALSIF_OK=0; FALSIF_MUDO=0
fals() { # $1 = descricao, $2 = arquivo sabotado, $3 = sentinela esperada no erro
  if R=$(P -q -f "$2" 2>&1); then FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ MUDA: $1 aplicou sem erro"
  else case "$R" in *"$3"*) FALSIF_OK=$((FALSIF_OK+1)); echo "  ✅ detectada: $1";;
                     *) FALSIF_MUDO=$((FALSIF_MUDO+1)); echo "  ❌ falhou por OUTRO motivo: $1 — [$R]";; esac
  fi
}
SAB1=$(mktemp); sed "s/, 'dashboard.crescimento_comparavel_servido') THEN/) THEN/" "$MIG" > "$SAB1"
cmp -s "$MIG" "$SAB1" && { echo "  ❌ sabotagem 1 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "allowlist SEM o evento novo" "$SAB1" "allowlist sem dashboard.crescimento_comparavel_servido"
SAB2=$(mktemp); sed "s/'navegacao.rota_servida', 'dashboard/'dashboard/" "$MIG" > "$SAB2"
cmp -s "$MIG" "$SAB2" && { echo "  ❌ sabotagem 2 nao aplicou"; FALSIF_MUDO=$((FALSIF_MUDO+1)); }
fals "recriacao que ESQUECE rota_servida" "$SAB2" "allowlist perdeu navegacao.rota_servida"
rm -f "$SAB1" "$SAB2"

# Controle: a funcao boa sobreviveu as duas tentativas (rollback da migration abortada).
eq "C1 apos as sabotagens, o evento novo ainda grava" "$(reg dashboard.crescimento_comparavel_servido oben:controle)" "3"
eq "C2 apos as sabotagens, rota_servida ainda grava" "$(reg navegacao.rota_servida /controle)" "2"

echo "  falsificacao: $FALSIF_OK detectadas / $FALSIF_MUDO mudas"
[ "$FALSIF_MUDO" = "0" ] && [ "$FALSIF_OK" = "2" ] || FAIL=$((FAIL+1))

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
