#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260712150000_carteira_membership_ledger_fatia0                 ║
# ║  P0-B-bis Fatia 0: tabela carteira_membership_ledger (backfill + trigger AFTER ║
# ║  INSERT em omie_clientes + RLS espelhando omie_clientes). Aditivo: NINGUÉM lê   ║
# ║  o ledger ainda — o risco desta fatia é só "a fundação está certa".            ║
# ║                                                                                ║
# ║  Espelha db/test-recencia-fonte-trigger-backfill.sh (trigger+backfill+        ║
# ║  created_at) pro arranque PG17; o padrão de RLS (SET ROLE authenticated + GUC  ║
# ║  request.jwt.claim.sub + has_role/user_roles reais) vem de                     ║
# ║  db/test-profiles-prevent-self-approval.sh / .claude/skills/prove-sql-money-   ║
# ║  path/references/assert-patterns.md.                                          ║
# ║                                                                                ║
# ║  Rode:  heavy bash db/test-carteira-membership-ledger.sh > /tmp/cml.log 2>&1;  ║
# ║         echo $?           (NÃO pipe pra tail — engole o exit≠0; §2 CLAUDE.md)  ║
# ║                                                                                ║
# ║  FALSIFICAÇÃO (Lei #3) — feita por FORA deste script, editando o texto da      ║
# ║  migration (não embutida numa ZONA 5 inline): remova o `CHECK (identity_state  ║
# ║  IN (...))` de supabase/migrations/20260712150000_..._fatia0.sql e re-rode     ║
# ║  este harness do zero → o assert A8 (CHECK identity_state) deve FALHAR/abortar ║
# ║  o script com SQLSTATE ausente (exit≠0 = vermelho). Reverta a sabotagem e      ║
# ║  re-rode → volta a verde. Motivo de não sabotar inline: o assert negativo usa  ║
# ║  um bloco DO/EXCEPTION (Lei #2) — se a defesa realmente cair, o RAISE de       ║
# ║  re-lançamento propaga como erro real do psql (-v ON_ERROR_STOP=1) e, sob      ║
# ║  `set -e`, aborta o script ali mesmo; restaurar o CHECK depois exigiria        ║
# ║  recriar a constraint com ALTER TABLE (CREATE TABLE IF NOT EXISTS não          ║
# ║  reaplica), o que é mais frágil que re-rodar o harness do zero duas vezes.     ║
# ║                                                                                ║
# ║  Lei de Ferro: 1) migration REAL  2) negativo com SQLSTATE + re-raise          ║
# ║                3) FALSIFICAÇÃO (sabota → exige vermelho → restaura)            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5482}"
SLUG="carteira-membership-ledger"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# roles base do Supabase (anon/authenticated/service_role) + schema auth/auth.users
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

# auth.uid() lê o GUC request.jwt.claim.sub — igual ao Supabase real em runtime (não test.uid).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (app_role/user_roles/has_role — assinatura real, confirmada
# via psql-ro em prod: pg_get_functiondef('public.has_role(uuid, app_role)')) +
# omie_clientes (só as colunas que a migration lê) + SEED SUJO do espelho (u1, u2)
# ANTES da migration → o backfill embutido nela precisa capturá-los.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');

CREATE TABLE public.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- espelho Omie (prod: unique_user_omie UNIQUE(user_id) — 1 linha por user_id; created_at NOT NULL DEFAULT now())
CREATE TABLE public.omie_clientes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE,
  omie_codigo_cliente bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- atores: u1/u2 já no espelho (backfill), u3 chega DEPOIS da migration (trigger), staff = employee
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- u1 (backfill, data-alvo do assert de first_seen_at)
  ('22222222-2222-2222-2222-222222222222'),  -- u2 (backfill, RLS own-scope)
  ('33333333-3333-3333-3333-333333333333'),  -- u3 (trigger, inserido pós-migration)
  ('44444444-4444-4444-4444-444444444444'),  -- u4 (não entra no espelho — alvo do INSERT rejeitado por CHECK)
  ('99999999-9999-9999-9999-999999999999')   -- staff (employee, RLS all-scope)
  ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles(user_id, role) VALUES
  ('99999999-9999-9999-9999-999999999999','employee');

INSERT INTO public.omie_clientes(user_id, omie_codigo_cliente, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 9001, '2026-03-01T09:00:00Z'),
  ('22222222-2222-2222-2222-222222222222', 9002, '2026-03-02T09:00:00Z');
SQL
echo "seed sujo aplicado (pré-migration): u1@2026-03-01, u2@2026-03-02 no espelho"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) — cria tabela+RLS, roda o backfill
# embutido sobre o seed acima, cria a trigger.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260712150000_carteira_membership_ledger_fatia0.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# migration --no-privileges (Supabase concede em runtime) → conceda pros asserts de RLS lerem/escreverem;
# a RLS filtra por cima. has_role() é SECURITY DEFINER: não precisa de GRANT em user_roles pro caller.
P -q -c "GRANT SELECT, INSERT, UPDATE, DELETE ON public.carteira_membership_ledger TO authenticated;
         GRANT SELECT ON public.carteira_membership_ledger TO anon;"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A0: anti-drift (db/carteira-membership-ledger.sql == corpo da migration) ──"
DIFF=$(diff \
  <(sed -n '/^CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger/,$p' "$MIG") \
  <(sed -n '/^CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger/,$p' "$REPO_ROOT/db/carteira-membership-ledger.sql") || true)
if [ -z "$DIFF" ]; then ok "A0 db/carteira-membership-ledger.sql idêntico ao corpo da migration"; else bad "A0 DIVERGÊNCIA — corrija o handoff: $DIFF"; fi

echo "── asserts: BACKFILL (efeito do apply) ──"
V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger;")
eq "A1 backfill: 2 linhas (u1+u2 já estavam no espelho)" "$V" "2"

V=$(Pq -c "SELECT to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD') FROM public.carteira_membership_ledger WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A2 backfill preserva first_seen_at = created_at do espelho (NÃO now())" "$V" "2026-03-01"

V=$(Pq -c "SELECT source FROM public.carteira_membership_ledger WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A3 backfill grava source='backfill'" "$V" "backfill"

V=$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A3b default identity_state='verified'" "$V" "verified"

echo "── assert: TRIGGER (insert pós-migration) ──"
P -q -c "INSERT INTO public.omie_clientes(user_id, omie_codigo_cliente, created_at) VALUES ('33333333-3333-3333-3333-333333333333', 9003, '2026-07-10T14:00:00Z');"
V=$(Pq -c "SELECT to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD')||'|'||source FROM public.carteira_membership_ledger WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A4 trigger captura user_id novo (first_seen_at=2026-07-10, source=trigger)" "$V" "2026-07-10|trigger"

V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger;")
eq "A5 ledger tem 3 linhas após o trigger (u1,u2,u3)" "$V" "3"

echo "── assert: IDEMPOTÊNCIA (re-rodar o INSERT..SELECT..ON CONFLICT do backfill) ──"
P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
         SELECT user_id, created_at, 'backfill' FROM public.omie_clientes
         ON CONFLICT (user_id) DO NOTHING;"

V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger;")
eq "A6 backfill re-rodado NÃO duplica (segue 3, mesmo com u3 agora no espelho)" "$V" "3"

V=$(Pq -c "SELECT source FROM public.carteira_membership_ledger WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A7 backfill re-rodado NÃO sobrescreve source='trigger' de u3 (ON CONFLICT DO NOTHING)" "$V" "trigger"

V=$(Pq -c "SELECT to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD') FROM public.carteira_membership_ledger WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A7b backfill re-rodado NÃO sobrescreve first_seen_at de u3" "$V" "2026-07-10"

echo "── assert NEGATIVO: CHECK identity_state (23514) ──"
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  UPDATE public.carteira_membership_ledger SET identity_state='xpto' WHERE user_id='11111111-1111-1111-1111-111111111111';
  RAISE EXCEPTION 'CHECK_IDENTITY_NAO_BARROU';   -- chegou aqui = o CHECK não rejeitou = BUG
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_IDENTITY_OK';  -- 23514 = o erro ESPERADO
  WHEN OTHERS THEN RAISE;                         -- qualquer outro erro: RELANÇA (não engole)
END $$;
SQL
)
case "$R" in *CHECK_IDENTITY_OK*) ok "A8 CHECK identity_state rejeita valor fora do enum (23514)" ;; *) bad "A8 — veio: $R" ;; esac
V=$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A8b UPDATE rejeitado não alterou identity_state (segue verified)" "$V" "verified"

echo "── assert NEGATIVO: CHECK source (23514) ──"
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
  VALUES ('44444444-4444-4444-4444-444444444444', now(), 'foo');
  RAISE EXCEPTION 'CHECK_SOURCE_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_SOURCE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *CHECK_SOURCE_OK*) ok "A9 CHECK source rejeita valor fora do enum (23514)" ;; *) bad "A9 — veio: $R" ;; esac
V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
eq "A9b INSERT rejeitado não deixou linha órfã" "$V" "0"

echo "── assert RLS (SET ROLE authenticated + GUC request.jwt.claim.sub — psql é superuser e BYPASSA RLS sem isso) ──"
OWN=$(Pq -c "SET request.jwt.claim.sub='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.carteira_membership_ledger;" | tail -1)
eq "A10 não-staff (u2) enxerga SÓ a própria linha" "$OWN" "1"

STAFF=$(Pq -c "SET request.jwt.claim.sub='99999999-9999-9999-9999-999999999999'; SET ROLE authenticated; SELECT count(*) FROM public.carteira_membership_ledger;" | tail -1)
eq "A11 staff (employee via has_role) enxerga TODAS as linhas" "$STAFF" "3"

ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.carteira_membership_ledger;" | tail -1)
eq "A12 anon (sem request.jwt.claim.sub) não enxerga nenhuma linha" "$ANON" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
