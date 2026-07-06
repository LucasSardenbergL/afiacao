#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — fin_dre_custo_tipo (F3 ponto de equilíbrio). Money-path: RLS     ║
# ║  master-only + CHECK do tipo + CHECK observação-obrigatória (nao_operacional)  ║
# ║  + trigger de autor + resolução company>_default. Com FALSIFICAÇÃO.            ║
# ║  bash db/test-fin-dre-custo-tipo.sh > /tmp/t.log 2>&1; echo "exit=$?"          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="fin-dre-custo-tipo"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisito: user_roles (a RLS lê; a migration NÃO cria) ─────────────────────────
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role text);
SQL

# ── ZONA 2 — aplica a migration REAL ────────────────────────────────────────────────────────────
MIG="$REPO_ROOT/supabase/migrations/20260705120000_fin_dre_custo_tipo.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed + grants ──────────────────────────────────────────────────────────────────────
MASTER='33333333-3333-3333-3333-333333333333'
NAOMASTER='22222222-2222-2222-2222-222222222222'
OUTRO='99999999-9999-9999-9999-999999999999'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$NAOMASTER') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master') ON CONFLICT DO NOTHING;
-- seed como postgres (bypassa RLS): 2 linhas p/ os asserts de RLS lerem
INSERT INTO public.fin_dre_custo_tipo(company, categoria_codigo, tipo) VALUES
  ('_default','2.01.01','variavel'),
  ('oben','2.04.01','fixo');
-- migration é --no-privileges → conceda p/ os asserts de RLS (a RLS filtra por cima);
-- a policy faz subselect em user_roles → conceda SELECT nela também
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_dre_custo_tipo TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

echo "── asserts ──"

# POSITIVO: tabela existe + CHECK aceita tipos válidos (2 linhas semeadas)
V=$(Pq -c "SELECT count(*) FROM public.fin_dre_custo_tipo;")
eq "A1 tabela existe, 2 linhas semeadas" "$V" "2"

# POSITIVO: nao_operacional COM observacao é aceito
Pq -c "INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo,observacao) VALUES ('oben','2.05.03','nao_operacional','Amortização de empréstimo — financiamento (fonte: contábil).');" >/dev/null
V=$(Pq -c "SELECT tipo FROM public.fin_dre_custo_tipo WHERE company='oben' AND categoria_codigo='2.05.03';")
eq "A2 nao_operacional COM observacao aceito" "$V" "nao_operacional"

# NEGATIVO: tipo inválido → check_violation (23514)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo) VALUES ('oben','9.99','balde_invalido');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'TIPO_CHK_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *TIPO_CHK_OK*) ok "A3 CHECK rejeita tipo inválido" ;; *) bad "A3 tipo — veio: $R" ;; esac

# NEGATIVO: nao_operacional SEM observacao → check_violation (23514)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo) VALUES ('oben','2.06.94','nao_operacional');
  RAISE EXCEPTION 'OBS_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'OBS_CHK_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *OBS_CHK_OK*) ok "A4 CHECK exige observacao p/ nao_operacional (delta-E2)" ;; *) bad "A4 obs — veio: $R" ;; esac

# RLS: master vê; não-master 0; anon 0
MASTERV=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dre_custo_tipo;" | tail -1)
NMV=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dre_custo_tipo;" | tail -1)
ANONV=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_dre_custo_tipo;" | tail -1)
eq "A5 master vê as linhas"        "$MASTERV" "3"
eq "A6 não-master NÃO vê (RLS)"    "$NMV"     "0"
eq "A7 anon NÃO vê (RLS)"          "$ANONV"   "0"

# RLS: não-master NÃO escreve → 42501 (insufficient_privilege / new row violates RLS)
R=$(P -tA 2>&1 <<SQL
SET test.uid='$NAOMASTER'; SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo) VALUES ('oben','2.08.02','fixo');
  RAISE EXCEPTION 'RLS_WRITE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_WRITE_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *RLS_WRITE_OK*) ok "A8 RLS nega escrita de não-master" ;; *) bad "A8 rls-write — veio: $R" ;; esac

# TRIGGER de autor: master insere passando updated_by falso → trigger sobrescreve p/ auth.uid()
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo,updated_by) VALUES ('oben','2.03.01','fixo','$OUTRO');" >/dev/null
V=$(Pq -c "SELECT updated_by FROM public.fin_dre_custo_tipo WHERE company='oben' AND categoria_codigo='2.03.01';")
eq "A9 trigger força updated_by=auth.uid() (ignora o cliente)" "$V" "$MASTER"

# RESOLUÇÃO company>_default: 2.01.01 tem _default=variavel; adiciona oben=fixo → oben vence no read
Pq -c "INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo) VALUES ('oben','2.01.01','fixo');" >/dev/null
V=$(Pq -c "SELECT tipo FROM public.fin_dre_custo_tipo WHERE categoria_codigo='2.01.01' AND company IN ('oben','_default') ORDER BY (company='_default') LIMIT 1;")
eq "A10 resolução: company específico vence _default" "$V" "fixo"

# ══ FALSIFICAÇÃO (Lei #3) — sabota → exige VERMELHO → restaura ══
echo "── falsificação ──"

# F1: sabota a policy de SELECT (USING true) → não-master passa a VER → A6 perde o dente
P -q <<'SQL'
DROP POLICY IF EXISTS fin_dre_custo_tipo_select_master ON public.fin_dre_custo_tipo;
CREATE POLICY fin_dre_custo_tipo_select_master ON public.fin_dre_custo_tipo FOR SELECT USING (true);
SQL
NMV2=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dre_custo_tipo;" | tail -1)
if [ "$NMV2" != "0" ]; then ok "F1 policy furada (USING true) deixou não-master ver ($NMV2) → A6 tem dente"; else bad "F1 sabotei a policy e não-master AINDA não vê → A6 é fraco"; fi
P -q -f "$MIG" >/dev/null  # restaura (DROP+CREATE policy é idempotente)
NMV3=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dre_custo_tipo;" | tail -1)
eq "F1' restaurada: não-master volta a NÃO ver" "$NMV3" "0"

# F2: dropa o CHECK de observacao → nao_operacional SEM obs passa a ser aceito → A4 perde o dente
P -q -c "ALTER TABLE public.fin_dre_custo_tipo DROP CONSTRAINT fin_dre_custo_tipo_obs_nao_op_chk;"
if P -q -c "INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo) VALUES ('colacor','9.98','nao_operacional');" >/dev/null 2>&1; then
  ok "F2 sem o CHECK, nao_operacional SEM observacao passou → A4 tinha dente"
else
  bad "F2 droppei o CHECK e o INSERT AINDA falhou → A4 não provava o CHECK"
fi
# restaura o CHECK (re-aplicar a migration NÃO recria constraint em tabela existente → ALTER ADD manual)
P -q -c "DELETE FROM public.fin_dre_custo_tipo WHERE company='colacor' AND categoria_codigo='9.98';"
P -q -c "ALTER TABLE public.fin_dre_custo_tipo ADD CONSTRAINT fin_dre_custo_tipo_obs_nao_op_chk CHECK (tipo <> 'nao_operacional' OR (observacao IS NOT NULL AND length(trim(observacao)) > 0));"

# F3: dropa o trigger → updated_by passado pelo cliente NÃO é sobrescrito → A9 perde o dente
P -q -c "DROP TRIGGER IF EXISTS trg_fin_dre_custo_tipo_autor ON public.fin_dre_custo_tipo;"
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_dre_custo_tipo(company,categoria_codigo,tipo,updated_by) VALUES ('colacor','2.03.01','fixo','$OUTRO');" >/dev/null
V=$(Pq -c "SELECT updated_by FROM public.fin_dre_custo_tipo WHERE company='colacor' AND categoria_codigo='2.03.01';")
if [ "$V" = "$OUTRO" ]; then ok "F3 sem o trigger, updated_by do cliente ($OUTRO) persistiu → A9 tinha dente"; else bad "F3 droppei o trigger e updated_by AINDA foi sobrescrito → A9 não provava o trigger"; fi
P -q -f "$MIG" >/dev/null  # restaura o trigger (DROP+CREATE é idempotente)

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
