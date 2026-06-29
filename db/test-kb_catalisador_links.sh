#!/usr/bin/env bash
# PROVA PG17 — migration 20260629150000_kb_catalisador_links.sql (casamento do catalisador, money-path/auth)
#   bash db/test-kb_catalisador_links.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Lei de Ferro: aplica a migration REAL · assert negativo via efeito/SQLSTATE · falsifica cada defesa.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="kb_catalisador_links"
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

# ── ZONA 1: pré-requisitos (app_role, user_roles, has_role) ──
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(p_uid uuid, p_role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = p_uid AND role = p_role);
$f$;
SQL

# ── ZONA 2: aplica a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260629150000_kb_catalisador_links.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3: seeds + grants ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- não-staff
  ('22222222-2222-2222-2222-222222222222'),  -- employee
  ('33333333-3333-3333-3333-333333333333')   -- master
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
GRANT SELECT ON public.kb_catalisador_links, public.user_roles TO authenticated, anon;
SQL

echo "── asserts ──"

# A1-A3 — normalizador consolida variantes (money-path: chave do lookup == chave da gravação)
eq "A1 normaliza FC.6975"   "$(Pq -c "SELECT public.kb_normalizar_catalisador('FC.6975');")"   "FC6975"
eq "A2 normaliza 'FC 6975'" "$(Pq -c "SELECT public.kb_normalizar_catalisador('FC 6975');")"   "FC6975"
eq "A3 normaliza FC.5202.RA" "$(Pq -c "SELECT public.kb_normalizar_catalisador('FC.5202.RA');")" "FC5202RA"

# A4 — master confirma FC.6975 p/ (colacor,111) → 1, grava normalizado
V=$(P -tA <<'SQL' | tail -1
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('FC.6975', '[{"account":"colacor","omie_codigo_produto":111}]'::jsonb);
SQL
)
eq "A4 confirmar retorna 1" "$V" "1"
eq "A4b norm gravado" "$(Pq -c "SELECT catalisador_codigo_norm FROM public.kb_catalisador_links WHERE account='colacor' AND omie_codigo_produto=111;")" "FC6975"

# A5 — idempotente: confirmar de novo não duplica
P -q <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('FC.6975', '[{"account":"colacor","omie_codigo_produto":111}]'::jsonb);
SQL
eq "A5 idempotente (1 linha)" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE account='colacor' AND omie_codigo_produto=111 AND status='confirmed';")" "1"

# A6 — variante 'FC 6975' p/ (colacor,222) consolida na MESMA chave normalizada
P -q <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('FC 6975', '[{"account":"colacor","omie_codigo_produto":222}]'::jsonb);
SQL
eq "A6 consolida variante (2 SKUs em FC6975)" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE catalisador_codigo_norm='FC6975' AND status='confirmed';")" "2"

# A7-A9 — RLS (2 confirmados): não-staff 0, staff vê tudo, anon 0
eq "A7 não-staff não lê"  "$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.kb_catalisador_links;" | tail -1)" "0"
eq "A8 staff lê tudo"     "$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.kb_catalisador_links;" | tail -1)" "2"
eq "A9 anon não lê"       "$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.kb_catalisador_links;" | tail -1)" "0"

# N1 — gate: employee NÃO confirma (efeito: nenhuma linha p/ 555)
P -q <<'SQL' 2>/dev/null || true
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('FC.7777', '[{"account":"colacor","omie_codigo_produto":555}]'::jsonb);
SQL
eq "N1 gate nega employee (sem linha)" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE omie_codigo_produto=555;")" "0"

# N2 — ≤1 catalisador por SKU: PC.2992 num SKU que já é FC6975 → falha (não vira 2 catalisadores)
P -q <<'SQL' 2>/dev/null || true
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('PC.2992', '[{"account":"colacor","omie_codigo_produto":111}]'::jsonb);
SQL
eq "N2 SKU não vira 2 catalisadores" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE account='colacor' AND omie_codigo_produto=111 AND status='confirmed';")" "1"

# N3 — código vazio após normalização → RAISE (efeito: nenhuma linha p/ 556)
P -q <<'SQL' 2>/dev/null || true
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('   ', '[{"account":"colacor","omie_codigo_produto":556}]'::jsonb);
SQL
eq "N3 código vazio rejeitado (sem linha)" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE omie_codigo_produto=556;")" "0"

# N4 — gate: employee NÃO desvincula (efeito: linha 111 continua)
P -q <<'SQL' 2>/dev/null || true
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
SELECT public.desvincular_catalisador('colacor', 111, 'FC 6975');
SQL
eq "N4 gate nega employee no desvincular" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE account='colacor' AND omie_codigo_produto=111 AND status='confirmed';")" "1"

# N5 — anti-stale: desvincular com norm ERRADO → 0 linhas, não remove
V=$(P -tA <<'SQL' | tail -1
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.desvincular_catalisador('colacor', 111, 'PC.2992');
SQL
)
eq "N5 anti-stale retorna 0" "$V" "0"
eq "N5b linha preservada" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE account='colacor' AND omie_codigo_produto=111 AND status='confirmed';")" "1"

# A10 — desvincular correto (variante 'FC 6975' normaliza p/ FC6975) → 1, remove
V=$(P -tA <<'SQL' | tail -1
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
SELECT public.desvincular_catalisador('colacor', 111, 'FC 6975');
SQL
)
eq "A10 desvincular retorna 1" "$V" "1"
eq "A10b linha removida (sobra só 222)" "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE catalisador_codigo_norm='FC6975' AND status='confirmed';")" "1"

# ── ZONA 5: FALSIFICAÇÃO (sabota → exige vermelho → restaura) ──
echo "── falsificação ──"

# F1 — gate master: sabota (remove has_role) → employee passa a gravar (N1 tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.confirmar_catalisador_vinculo(p_catalisador_codigo text, p_skus jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_norm text := public.kb_normalizar_catalisador(p_catalisador_codigo); v_item jsonb;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    INSERT INTO public.kb_catalisador_links(catalisador_codigo_norm, account, omie_codigo_produto, status)
    VALUES (v_norm, v_item->>'account', (v_item->>'omie_codigo_produto')::bigint, 'confirmed') ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN 1;
END $fn$;
SQL
P -q <<'SQL' 2>/dev/null || true
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
SELECT public.confirmar_catalisador_vinculo('FC.7777', '[{"account":"colacor","omie_codigo_produto":777}]'::jsonb);
SQL
case "$(Pq -c "SELECT count(*) FROM public.kb_catalisador_links WHERE omie_codigo_produto=777;")" in
  1) ok "F1 gate furado deixou employee gravar (N1 tem dente)";;
  *) bad "F1 sabotei o gate e nada mudou → N1 é fraco";;
esac
P -q -f "$MIG"; P -q -c "DELETE FROM public.kb_catalisador_links WHERE omie_codigo_produto=777;" >/dev/null

# F3 — RLS: sabota a policy (USING true) → não-staff passa a ver (A7 tem dente)
P -q <<'SQL'
DROP POLICY IF EXISTS kb_catalisador_links_select_staff ON public.kb_catalisador_links;
CREATE POLICY kb_catalisador_links_select_staff ON public.kb_catalisador_links FOR SELECT USING (true);
SQL
case "$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.kb_catalisador_links;" | tail -1)" in
  0) bad "F3 furei a RLS e não-staff AINDA vê 0 → A7 é fraco";;
  *) ok "F3 RLS furada vazou p/ não-staff (A7 tem dente)";;
esac
P -q -f "$MIG"

# F4 — normalizador: sabota (só upper, sem strip) → 'FC 6975' != 'FC6975' (A2 tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.kb_normalizar_catalisador(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT upper(coalesce(p,'')); $f$;
SQL
case "$(Pq -c "SELECT public.kb_normalizar_catalisador('FC 6975');")" in
  FC6975) bad "F4 sabotei o normalizador e ainda deu FC6975 → A2 é fraco";;
  *) ok "F4 normalizador furado não consolida 'FC 6975' (A2 tem dente)";;
esac
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
