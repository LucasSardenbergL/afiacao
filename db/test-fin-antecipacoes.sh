#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — fin_antecipacoes (F4 antecipação de recebíveis). Money-path:     ║
# ║  RLS master-only + CHECK do líquido (P1-1 igualdade VÁLIDA) + CHECK do prazo   ║
# ║  + unique de dedup + trigger de autor (created_by/updated_by). Com             ║
# ║  FALSIFICAÇÃO. bash db/test-fin-antecipacoes.sh > /tmp/t.log 2>&1; echo $?     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="fin-antecipacoes"
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

# ── ZONA 2 — aplica a migration REAL (Lei #1) ─────────────────────────────────────────────────────
MIG="$REPO_ROOT/supabase/migrations/20260708120000_fin_antecipacoes.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed + grants ──────────────────────────────────────────────────────────────────────
MASTER='33333333-3333-3333-3333-333333333333'
NAOMASTER='22222222-2222-2222-2222-222222222222'
OUTRO='99999999-9999-9999-9999-999999999999'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$NAOMASTER') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master') ON CONFLICT DO NOTHING;
-- seed como postgres (bypassa RLS): 2 linhas p/ os asserts de RLS lerem. A 2ª tem líquido==bruto (custo 0, P1-1).
INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento,referencia) VALUES
  ('oben','Itaú','duplicata',100000,0,97000,'2026-01-01','2026-01-31','DUP-1'),
  ('oben','Itaú','linha',     50000,0,50000,'2026-02-01','2026-04-02','LINHA-1');
-- migration é --no-privileges → conceda p/ os asserts de RLS (a RLS filtra por cima)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_antecipacoes TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

echo "── asserts ──"

# A1 POSITIVO: tabela existe, 2 linhas (inclui a de custo zero — P1-1 igualdade VÁLIDA)
V=$(Pq -c "SELECT count(*) FROM public.fin_antecipacoes;")
eq "A1 tabela existe, 2 linhas (uma com líquido==bruto, custo 0)" "$V" "2"

# A2 NEGATIVO: líquido > bruto+avulsos → check_violation (P1-1: inválido SÓ quando MAIOR)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',100000,0,100001,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'LIQ_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'LIQ_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *LIQ_BARROU*) ok "A2 CHECK rejeita líquido > bruto+avulsos" ;; *) bad "A2 liq — veio: $R" ;; esac

# A3 POSITIVO: líquido == bruto+avulsos é ACEITO (custo zero é válido, não inválido)
Pq -c "INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento) VALUES ('colacor','duplicata',10000,100,10100,'2026-03-01','2026-04-01');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_antecipacoes WHERE company='colacor';")
eq "A3 líquido == bruto+avulsos aceito (P1-1)" "$V" "1"

# A4 NEGATIVO: prazo não-positivo (venc <= operação) → check_violation
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,990,'2026-01-10','2026-01-10');
  RAISE EXCEPTION 'PRAZO_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PRAZO_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *PRAZO_BARROU*) ok "A4 CHECK exige prazo positivo" ;; *) bad "A4 prazo — veio: $R" ;; esac

# A5 NEGATIVO: dedup — mesma (company,banco,referencia) viva → unique_violation
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia)
    VALUES ('oben','Itaú','duplicata',100000,97000,'2026-05-01','2026-06-01','DUP-1');
  RAISE EXCEPTION 'DEDUP_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'DEDUP_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *DEDUP_BARROU*) ok "A5 unique parcial dedup por referência" ;; *) bad "A5 dedup — veio: $R" ;; esac

# A6 RLS: master vê; A7 não-master 0; A8 anon 0  (3 linhas: 2 oben + 1 colacor do A3)
MASTERV=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
NMV=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
ANONV=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
eq "A6 master vê"           "$MASTERV" "3"
eq "A7 não-master NÃO vê"   "$NMV"     "0"
eq "A8 anon NÃO vê"         "$ANONV"   "0"

# A9 RLS: não-master NÃO escreve → insufficient_privilege
R=$(P -tA 2>&1 <<SQL
SET test.uid='$NAOMASTER'; SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,990,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'RLS_WRITE_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_WRITE_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *RLS_WRITE_BARROU*) ok "A9 RLS nega escrita de não-master" ;; *) bad "A9 rls-write — veio: $R" ;; esac

# A10 TRIGGER: master insere passando created_by/updated_by falsos → trigger sobrescreve p/ auth.uid()
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,created_by,updated_by) VALUES ('oben','duplicata',2000,1900,'2026-07-01','2026-08-01','$OUTRO','$OUTRO');" >/dev/null
V=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT updated_by||'/'||created_by FROM public.fin_antecipacoes WHERE company='oben' AND valor_bruto=2000;" | tail -1)
eq "A10 trigger força created_by/updated_by=auth.uid()" "$V" "$MASTER/$MASTER"

# ── P2-b (Codex): mais dentes de CHECK/dedup ──────────────────────────────────────────────────
# A11 valores: custos_avulsos < 0 → check_violation (isola o CHECK de valores; liquido_chk passa)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,custos_avulsos,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,-1,900,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'AVULSOS_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'AVULSOS_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *AVULSOS_BARROU*) ok "A11 CHECK rejeita custos_avulsos < 0" ;; *) bad "A11 avulsos — veio: $R" ;; esac

# A12 valores: valor_liquido <= 0 → check_violation (liquido=0, bruto=1000: só o valores_chk falha)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento)
    VALUES ('oben','duplicata',1000,0,'2026-01-01','2026-02-01');
  RAISE EXCEPTION 'LIQZERO_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'LIQZERO_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *LIQZERO_BARROU*) ok "A12 CHECK rejeita valor_liquido <= 0" ;; *) bad "A12 liq-zero — veio: $R" ;; esac

# A13 dedup com banco NULL: coalesce(banco,'') deduplica mesmo sem banco (2ª igual → unique_violation)
Pq -c "INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia) VALUES ('colacor','duplicata',5000,4900,'2026-01-01','2026-02-01','NB-1');" >/dev/null
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia)
    VALUES ('colacor','duplicata',5000,4900,'2026-03-01','2026-04-01','NB-1');
  RAISE EXCEPTION 'NB_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'NB_BARROU'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *NB_BARROU*) ok "A13 dedup com banco NULL (coalesce '')" ;; *) bad "A13 nb — veio: $R" ;; esac

# A14 dedup libera re-registro APÓS soft-delete (índice parcial WHERE deleted_at IS NULL)
Pq -c "INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia) VALUES ('colacor_sc','Itaú','duplicata',3000,2900,'2026-01-01','2026-02-01','SD-1');" >/dev/null
Pq -c "UPDATE public.fin_antecipacoes SET deleted_at=now() WHERE company='colacor_sc' AND referencia='SD-1';" >/dev/null
if P -q -c "INSERT INTO public.fin_antecipacoes(company,banco,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,referencia) VALUES ('colacor_sc','Itaú','duplicata',3000,2900,'2026-03-01','2026-04-01','SD-1');" >/dev/null 2>&1; then
  ok "A14 dedup libera re-registro após soft-delete"
else
  bad "A14 re-registro após soft-delete foi bloqueado (índice não exclui deletados)"
fi

# ══ FALSIFICAÇÃO (Lei #3) — sabota → exige VERMELHO → restaura ══
echo "── falsificação ──"

# F1: policy SELECT furada (USING true) → não-master passa a VER → A7 perde o dente
P -q <<'SQL'
DROP POLICY IF EXISTS fin_antecipacoes_select_master ON public.fin_antecipacoes;
CREATE POLICY fin_antecipacoes_select_master ON public.fin_antecipacoes FOR SELECT USING (true);
SQL
NMV2=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
if [ "$NMV2" != "0" ]; then ok "F1 policy furada deixou não-master ver ($NMV2) → A7 tem dente"; else bad "F1 sabotei e não-master AINDA não vê → A7 fraco"; fi
P -q -f "$MIG" >/dev/null
NMV3=$(Pq -c "SET test.uid='$NAOMASTER'; SET ROLE authenticated; SELECT count(*) FROM public.fin_antecipacoes;" | tail -1)
eq "F1' restaurada: não-master volta a NÃO ver" "$NMV3" "0"

# F2: dropa o CHECK do líquido → líquido > bruto+avulsos passa → A2 perde o dente
P -q -c "ALTER TABLE public.fin_antecipacoes DROP CONSTRAINT fin_antecipacoes_liquido_chk;"
if P -q -c "INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento) VALUES ('colacor_sc','duplicata',100,200,'2026-01-01','2026-02-01');" >/dev/null 2>&1; then
  ok "F2 sem o CHECK, líquido > bruto passou → A2 tinha dente"
else
  bad "F2 droppei o CHECK e o INSERT AINDA falhou → A2 não provava o CHECK"
fi
P -q -c "DELETE FROM public.fin_antecipacoes WHERE company='colacor_sc';"
P -q -c "ALTER TABLE public.fin_antecipacoes ADD CONSTRAINT fin_antecipacoes_liquido_chk CHECK (valor_liquido <= valor_bruto + custos_avulsos);"

# F3: dropa o trigger → created_by do cliente NÃO é sobrescrito → A10 perde o dente
P -q -c "DROP TRIGGER IF EXISTS trg_fin_antecipacoes_autor ON public.fin_antecipacoes;"
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.fin_antecipacoes(company,tipo,valor_bruto,valor_liquido,data_operacao,data_vencimento,created_by) VALUES ('colacor','linha',3000,2900,'2026-09-01','2026-10-01','$OUTRO');" >/dev/null
V=$(Pq -c "SELECT created_by FROM public.fin_antecipacoes WHERE company='colacor' AND valor_bruto=3000;")
if [ "$V" = "$OUTRO" ]; then ok "F3 sem o trigger, created_by do cliente persistiu → A10 tinha dente"; else bad "F3 droppei o trigger e created_by AINDA foi sobrescrito → A10 fraco"; fi
P -q -f "$MIG" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
