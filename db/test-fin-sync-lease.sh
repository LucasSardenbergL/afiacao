#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — fin_sync_lease (single-flight por company) + CHECK skipped_busy  ║
# ║  Migration: supabase/migrations/20260704150000_fin_sync_lease_por_company.sql  ║
# ║  Rode:  bash db/test-fin-sync-lease.sh > /tmp/t.log 2>&1; echo "exit=$?"        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5468}"
SLUG="fin-sync-lease"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

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
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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
is_token() { if [[ "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then ok "$1 (token ok)"; else bad "$1 — esperava uuid, veio [$2]"; fi; }
is_null()  { if [ -z "$2" ]; then ok "$1 (NULL/busy)"; else bad "$1 — esperava NULL, veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══ ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria) ══
P -q <<'SQL'
-- enum app_role + user_roles (a policy staff do lease faz subselect neles)
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
-- fin_sync_log com a CONSTRAINT ATUAL de prod (a migração deve SUBSTITUÍ-la p/ incluir skipped_busy)
CREATE TABLE IF NOT EXISTS public.fin_sync_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action       text NOT NULL,
  companies    text[],
  status       text DEFAULT 'running',
  results      jsonb DEFAULT '{}'::jsonb,
  error_message text,
  triggered_by text DEFAULT 'manual',
  started_at   timestamptz DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT fin_sync_log_status_check CHECK (status = ANY (ARRAY['running','complete','error']))
);
SQL
echo "── pré-req: fin_sync_log com CHECK antiga (running/complete/error) ──"

# ══ ZONA 2 — APLICAR A MIGRATION REAL ══
MIG="$REPO_ROOT/supabase/migrations/20260704150000_fin_sync_lease_por_company.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══ ZONA 3 — SEED + GRANTS ══
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- employee (não master, mas staff)
  ('33333333-3333-3333-3333-333333333333')    -- master
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('33333333-3333-3333-3333-333333333333','master')
  ON CONFLICT DO NOTHING;
-- migration é --no-privileges; conceda p/ os asserts de RLS lerem (a RLS filtra por cima).
-- a policy staff faz subselect em user_roles → conceda SELECT nela TAMBÉM.
GRANT SELECT ON public.fin_sync_lease, public.user_roles TO authenticated, anon;
SQL

# ══ ZONA 4 — ASSERTS ══
echo "── asserts ──"

# P1 — acquire numa company LIVRE (linha não existe) → token
TOK_A=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderA');")
is_token "P1 acquire company livre" "$TOK_A"

# N1 — acquire com lease VIVO → NULL (busy). INVARIANTE CENTRAL do single-flight.
BUSY=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderB');")
is_null "N1 acquire com lease vivo = busy (NULL)" "$BUSY"

# N2 — release com TOKEN ERRADO → false e NÃO libera (token-guard)
REL_BAD=$(Pq -c "SELECT public.fin_sync_lease_release('colacor', gen_random_uuid());")
eq  "N2 release token errado = false" "$REL_BAD" "f"
STILL=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderC');")
is_null "N2b lease preservado após release errado (ainda busy)" "$STILL"

# P2 — release com TOKEN CERTO → true (libera)
REL_OK=$(Pq -c "SELECT public.fin_sync_lease_release('colacor','$TOK_A');")
eq "P2 release token certo = true" "$REL_OK" "t"

# P3 — após release, acquire de novo → token novo (livre)
TOK_B=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderD');")
is_token "P3 re-acquire após release" "$TOK_B"

# P4 — TTL EXPIRA naturalmente → outro acquire ROUBA (token rotaciona)
Pq -c "UPDATE public.fin_sync_lease SET expires_at = now() - interval '1 second' WHERE company='colacor';" >/dev/null
TOK_C=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderE');")
is_token "P4 acquire rouba lease EXPIRADO" "$TOK_C"
NEQ=$([ "$TOK_C" != "$TOK_B" ] && echo diff || echo same)
eq "P4b token rotacionou ao roubar" "$NEQ" "diff"

# N2c — o dono ROUBADO (TOK_B) tenta release → no-op (NÃO libera o TOK_C do novo dono)
REL_STOLEN=$(Pq -c "SELECT public.fin_sync_lease_release('colacor','$TOK_B');")
eq "N2c release do dono roubado = false" "$REL_STOLEN" "f"
STILL2=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','holderF');")
is_null "N2d lease do novo dono preservado (ainda busy)" "$STILL2"

# P5 — companies INDEPENDENTES: oben livre mesmo com colacor ocupado (contas Omie distintas)
TOK_OBEN=$(Pq -c "SELECT public.fin_sync_lease_acquire('oben','holderG');")
is_token "P5 oben livre com colacor ocupado (independência)" "$TOK_OBEN"

# N3a — CHECK aceita 'skipped_busy' (a migração substituiu a constraint)
INS=$(P -tA 2>&1 <<'SQL'
INSERT INTO public.fin_sync_log(action, status, completed_at) VALUES ('sync_movimentacoes','skipped_busy', NULL);
SELECT 'INSERT_OK';
SQL
)
case "$INS" in *INSERT_OK*) ok "N3a CHECK aceita skipped_busy" ;; *) bad "N3a — veio: $INS" ;; esac

# N3b — CHECK rejeita status LIXO (check_violation 23514)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.fin_sync_log(action, status) VALUES ('x','lixo_invalido');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *CHECK_MORDEU*) ok "N3b CHECK rejeita status lixo (23514)" ;; *) bad "N3b — veio: $R" ;; esac

# N3c — CHECK ainda aceita os valores legados (running/complete/error) — não regrediu
LEG=$(P -tA 2>&1 <<'SQL'
INSERT INTO public.fin_sync_log(action,status) VALUES ('x','running'),('y','complete'),('z','error');
SELECT 'LEGACY_OK';
SQL
)
case "$LEG" in *LEGACY_OK*) ok "N3c CHECK ainda aceita running/complete/error" ;; *) bad "N3c — veio: $LEG" ;; esac

# N4a — authenticated NÃO executa acquire (REVOKE → 42501)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.fin_sync_lease_acquire('oben','x');
  RAISE EXCEPTION 'GRANT_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *REVOKE_MORDEU*) ok "N4a authenticated não executa acquire (42501)" ;; *) bad "N4a — veio: $R" ;; esac

# N4b — service_role EXECUTA acquire (grant)
SVC=$(Pq -c "SET ROLE service_role; SELECT public.fin_sync_lease_acquire('colacor_sc','svc');" | tail -1)
is_token "N4b service_role executa acquire" "$SVC"

# RLS — staff (master) vê o lease; anon não vê
TOTAL=$(Pq -c "SELECT count(*) FROM public.fin_sync_lease;")
STAFF=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.fin_sync_lease;" | tail -1)
ANON=$(Pq  -c "SET ROLE anon; SELECT count(*) FROM public.fin_sync_lease;" | tail -1)
eq "RLS staff vê tudo"  "$STAFF" "$TOTAL"
eq "RLS anon vê nada"   "$ANON"  "0"

# P6 — CORRIDA REAL: 10 acquires CONCORRENTES na mesma company (recém-expirada) →
# a atomicidade do ON CONFLICT DO UPDATE ... WHERE deve deixar EXATAMENTE 1 pegar token
# (o vencedor seta expires_at futuro; os demais, ao pegar o lock de linha, re-avaliam a
# WHERE contra a versão nova → expirado? não → NULL). Prova o "active/expired race" do Codex.
Pq -c "UPDATE public.fin_sync_lease SET expires_at = now() - interval '1 second' WHERE company='oben';" >/dev/null
RACE_DIR=$(mktemp -d "/tmp/lease-race.XXXXXX")
for i in $(seq 1 10); do
  ( Pq -c "SELECT public.fin_sync_lease_acquire('oben','race$i');" > "$RACE_DIR/r$i" 2>/dev/null ) &
done
wait
WINNERS=$(cat "$RACE_DIR"/r* 2>/dev/null | grep -cE '^[0-9a-f]{8}-[0-9a-f]{4}-')
rm -rf "$RACE_DIR"
eq "P6 corrida real: exatamente 1 vencedor / 10 acquires concorrentes" "$WINNERS" "1"

# ══ ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura) ══
echo "── falsificação ──"

# F1 — acquire SEM a WHERE expires_at<=now() → rouba lease VIVO (N1 perde o dente)
Pq -c "UPDATE public.fin_sync_lease SET expires_at = now() + interval '300 seconds', token = gen_random_uuid() WHERE company='colacor';" >/dev/null
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_lease_acquire(p_company text, p_holder text, p_ttl_seconds integer DEFAULT 300)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.fin_sync_lease AS l (company, token, holder, acquired_at, expires_at, updated_at)
  VALUES (p_company, gen_random_uuid(), p_holder, now(), now()+make_interval(secs=>p_ttl_seconds), now())
  ON CONFLICT (company) DO UPDATE
     SET token=gen_random_uuid(), expires_at=now()+make_interval(secs=>p_ttl_seconds), updated_at=now()
  RETURNING token;   -- SABOTADO: sem WHERE l.expires_at<=now()
$$;
SQL
STOLEN=$(Pq -c "SELECT public.fin_sync_lease_acquire('colacor','thief');")
if [ -n "$STOLEN" ]; then ok "F1 acquire sem WHERE rouba lease vivo → N1 tem dente"; else bad "F1 sabotei o acquire e ainda deu NULL → N1 é fraco"; fi
P -q -f "$MIG"   # restaura

# F2 — release SEM o token-guard → libera com token errado (N2 perde o dente)
Pq -c "UPDATE public.fin_sync_lease SET expires_at = now() + interval '300 seconds', token = gen_random_uuid() WHERE company='colacor';" >/dev/null
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_lease_release(p_company text, p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH freed AS (
    UPDATE public.fin_sync_lease SET expires_at = now()-interval '1 second', updated_at = now()
     WHERE company = p_company   -- SABOTADO: sem AND token = p_token
    RETURNING company)
  SELECT EXISTS (SELECT 1 FROM freed);
$$;
SQL
FREED=$(Pq -c "SELECT public.fin_sync_lease_release('colacor', gen_random_uuid());")
if [ "$FREED" = "t" ]; then ok "F2 release sem token-guard libera com token errado → N2 tem dente"; else bad "F2 sabotei o release e ainda deu false → N2 é fraco"; fi
P -q -f "$MIG"   # restaura

# F3 — CHECK constraint SEM skipped_busy → inserir skipped_busy volta a falhar (N3a perde o dente)
# (limpa as linhas skipped_busy que N3a semeou, senão o ADD da constraint antiga já falha na validação)
P -q <<'SQL'
DELETE FROM public.fin_sync_log WHERE status = 'skipped_busy';
ALTER TABLE public.fin_sync_log DROP CONSTRAINT IF EXISTS fin_sync_log_status_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_status_check
  CHECK (status = ANY (ARRAY['running','complete','error']));   -- SABOTADO: sem skipped_busy
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.fin_sync_log(action, status) VALUES ('x','skipped_busy');
  RAISE NOTICE 'SABOTAGEM_ACEITOU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'AGORA_REJEITA';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *AGORA_REJEITA*) ok "F3 CHECK sem skipped_busy volta a rejeitar → N3a tem dente" ;; *) bad "F3 sabotei a CHECK e ainda aceitou → N3a fraco: $R" ;; esac
P -q -f "$MIG"   # restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
