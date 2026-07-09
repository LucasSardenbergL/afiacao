#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de fin_custo_rateio (F3 v2) money-path/auth c/ FALSIFICAÇÃO ║
# ║      bash db/test-fin-custo-rateio.sh > /tmp/t.log 2>&1; echo "exit=$?"        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"     # distinto do default 5455 (paralelo com outras worktrees)
SLUG="fin-custo-rateio"
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

MASTER='33333333-3333-3333-3333-333333333333'
NAOMASTER='22222222-2222-2222-2222-222222222222'
FORJADO='99999999-9999-9999-9999-999999999999'

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (app_role enum + user_roles — a RLS faz subselect nela)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL + idempotência (2ª colagem = no-op)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260708204820_fin_custo_rateio.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "migration re-aplicável (2ª colagem no-op)"; else bad "2ª aplicação QUEBROU (não idempotente)"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (semeia como postgres; concede p/ os asserts de RLS lerem)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'), ('$NAOMASTER') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master') ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_custo_rateio TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# A1 POSITIVO: master insere e vê a própria linha (RLS master libera).
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('oben','folha',18000,'colacor_sc','70% da folha da CSC');" >/dev/null
CNT=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_custo_rateio;" | tail -1)
eq "A1 master insere e vê" "$CNT" "1"

# A2 POSITIVO money-path: trigger sobrescreve updated_by com auth.uid() (ignora o forjado).
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao,updated_by) VALUES ('oben','folha2',1,'colacor_sc','x','$FORJADO');" >/dev/null
UB=$(Pq -c "SELECT updated_by FROM public.fin_custo_rateio WHERE company='oben' AND rotulo='folha2';")
eq "A2 trigger sobrescreve updated_by" "$UB" "$MASTER"

# A3 NEGATIVO: CHECK valor >= 0 rejeita -1 (como postgres, isola do RLS). check_violation=23514.
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN
  INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('x','neg',-1,'y','z');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHECK_VALOR_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *CHECK_VALOR_MORDEU*) ok "A3 CHECK valor>=0 rejeita -1" ;; *) bad "A3 — veio: $R" ;; esac

# A4 NEGATIVO: CHECK observacao não-vazia rejeita '   ' (só espaços). check_violation=23514.
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN
  INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('x','obs',1,'y','   ');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHECK_OBS_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *CHECK_OBS_MORDEU*) ok "A4 CHECK observacao não-vazia rejeita espaços" ;; *) bad "A4 — veio: $R" ;; esac

# A5 RLS: não-master NÃO vê (SELECT filtra → 0).
DENY=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_custo_rateio;" | tail -1)
eq "A5 RLS nega não-master (SELECT vê 0)" "$DENY" "0"

# A6 RLS: não-master NÃO insere (with_check falha → 42501 insufficient_privilege).
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$NAOMASTER'; SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('oben','hack',1,'y','z');
  RAISE EXCEPTION 'RLS_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_INSERT_MORDEU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *RLS_INSERT_MORDEU*) ok "A6 RLS nega não-master (INSERT)" ;; *) bad "A6 — veio: $R" ;; esac

# A7 RLS: anon não vê (sem auth.uid() → subselect vazio → 0).
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_custo_rateio;" | tail -1)
eq "A7 anon não vê" "$ANON" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: fura a policy write_master (USING/WITH CHECK true) → A6 (RLS nega INSERT) perde o dente.
P -q <<'SQL'
DROP POLICY IF EXISTS fin_custo_rateio_write_master ON public.fin_custo_rateio;
CREATE POLICY fin_custo_rateio_write_master ON public.fin_custo_rateio FOR ALL USING (true) WITH CHECK (true);
SQL
if P -q -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('sab','rls',1,'y','z');" >/dev/null 2>&1; then
  ok "F1 policy furada deixou não-master inserir (A6 tem dente)"
else
  bad "F1 furei a RLS e o INSERT AINDA falhou → A6 é fraco"
fi
P -q -c "DELETE FROM public.fin_custo_rateio WHERE company='sab';" >/dev/null 2>&1 || true
P -q -f "$MIG"  # restaura a policy correta (DROP+CREATE idempotente)

# F2: dropa o trigger → A2 (updated_by sobrescrito) perde o dente (o forjado passa).
P -q -c "DROP TRIGGER IF EXISTS trg_fin_custo_rateio_autor ON public.fin_custo_rateio;"
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao,updated_by) VALUES ('sab','trg',1,'y','z','$FORJADO');" >/dev/null
UBSAB=$(Pq -c "SELECT updated_by FROM public.fin_custo_rateio WHERE company='sab' AND rotulo='trg';")
if [ "$UBSAB" = "$FORJADO" ]; then
  ok "F2 sem o trigger o updated_by forjado passa (A2 tem dente)"
else
  bad "F2 droppei o trigger e updated_by NÃO virou o forjado ($UBSAB) → A2 é fraco"
fi
P -q -c "DELETE FROM public.fin_custo_rateio WHERE company='sab';" >/dev/null 2>&1 || true
P -q -f "$MIG"  # restaura o trigger

# F3: dropa o CHECK do valor → A3 perde o dente (-1 passa).
P -q <<'SQL'
DO $$ DECLARE cn text; BEGIN
  SELECT conname INTO cn FROM pg_constraint
   WHERE conrelid='public.fin_custo_rateio'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) ILIKE '%valor_mensal_brl%';
  EXECUTE format('ALTER TABLE public.fin_custo_rateio DROP CONSTRAINT %I', cn);
END $$;
SQL
if P -q -c "INSERT INTO public.fin_custo_rateio(company,rotulo,valor_mensal_brl,origem_company,observacao) VALUES ('sab','negf',-1,'y','z');" >/dev/null 2>&1; then
  ok "F3 sem o CHECK, valor -1 passa (A3 tem dente)"
else
  bad "F3 droppei o CHECK e -1 AINDA falhou → A3 é fraco"
fi
P -q -c "DELETE FROM public.fin_custo_rateio WHERE company='sab';" >/dev/null 2>&1 || true
P -q -c "ALTER TABLE public.fin_custo_rateio ADD CONSTRAINT fin_custo_rateio_valor_mensal_brl_check CHECK (valor_mensal_brl >= 0);" >/dev/null

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
