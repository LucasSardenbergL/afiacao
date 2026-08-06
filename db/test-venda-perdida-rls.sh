#!/usr/bin/env bash
# Prova PG17 — RLS de venda_perdida_log + view v_sku_classe_sb (migration 20260802120000).
# Rodar: bash db/test-venda-perdida-rls.sh > log 2>&1; echo "exit=$?"   (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica a MIGRATION REAL; RLS provada sob SET ROLE authenticated + GUC (superuser bypassaria);
# FALSIFICA (sabota a policy de INSERT -> exige vermelho -> restaura).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="venda-perdida-rls"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260802120000_venda_perdida_e_classe_sb.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ── ZONA 1: roles + auth stub (GUC) + has_role REAL sobre user_roles + fontes da view ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;   -- prod tem (harness tao permissivo quanto a prod)
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- fonte da view SB: stub minimo de venda_items_history + a view efetivo 1:1 (o assunto aqui e a
-- RLS/estrutura, nao a consolidacao N->1 — provada em harness proprio)
CREATE TABLE public.venda_items_history (empresa text, sku_codigo_omie bigint, data_emissao timestamptz, quantidade numeric);
ALTER TABLE public.venda_items_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.venda_items_history TO authenticated;
CREATE POLICY vih_staff_sel ON public.venda_items_history FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
-- espelha a PROD (conferido 2026-07-30 via psql-ro): a efetivo real é security_invoker=on.
-- Stub sem o WITH roda como owner e BYPASSA a RLS da base — inventaria um vazamento que não existe.
CREATE VIEW public.v_venda_items_history_efetivo WITH (security_invoker=on) AS SELECT * FROM public.venda_items_history;
GRANT SELECT ON public.v_venda_items_history_efetivo TO authenticated;
SQL
echo "stubs ok"

# ── ZONA 2: migration REAL ──
P -q -f "$MIG"
echo "migration aplicada"

# ── ZONA 3: seeds (staff + customer + vendas p/ a view SB) ──
P -q <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES
 ('11111111-1111-1111-1111-111111111111', 'employee'),
 ('22222222-2222-2222-2222-222222222222', 'customer');
INSERT INTO public.venda_items_history (empresa, sku_codigo_omie, data_emissao, quantidade) VALUES
 ('OBEN', 9001, '2026-05-01', 10), ('OBEN', 9001, '2026-05-20', 2), ('OBEN', 9001, '2026-07-01', 30);
SQL

# helper: roda um SQL sob authenticated com uid setado; imprime resultado ou SQLSTATE
como() { # $1=uid  $2=sql
  Pq -c "SET ROLE authenticated; SET test.uid = '$1'; $2" 2>&1 | tail -1
}

echo "=== RLS venda_perdida_log ==="
# guard anti-teatro: o SET ROLE de fato vale dentro da MESMA sessao psql
eq "guard current_user=authenticated" "$(Pq -c "SET ROLE authenticated; SELECT current_user;")" "authenticated"

# staff INSERT ok
R=$(como 11111111-1111-1111-1111-111111111111 "INSERT INTO public.venda_perdida_log (sku_codigo_omie, quantidade, motivo) VALUES ('9001', 5, 'sem_estoque') RETURNING 'INSERIU';")
eq "staff INSERT permitido" "$R" "INSERIU"
# staff SELECT ve
R=$(como 11111111-1111-1111-1111-111111111111 "SELECT count(*) FROM public.venda_perdida_log;")
eq "staff SELECT ve 1" "$R" "1"
# customer INSERT negado (RLS 42501)
R=$(como 22222222-2222-2222-2222-222222222222 "INSERT INTO public.venda_perdida_log (sku_codigo_omie, quantidade) VALUES ('9001', 1);" )
case "$R" in *"42501"*|*"row-level security"*) ok "customer INSERT negado (RLS)";; *) bad "customer INSERT deveria ser negado — veio [$R]";; esac
# customer SELECT 0 linhas (RLS filtra, nao erra)
R=$(como 22222222-2222-2222-2222-222222222222 "SELECT count(*) FROM public.venda_perdida_log;")
eq "customer SELECT ve 0" "$R" "0"
# anon: sem grant -> permission denied
R=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.venda_perdida_log;" 2>&1 | tail -1)
case "$R" in *"permission denied"*) ok "anon sem acesso (permission denied)";; *) bad "anon deveria ser negado — veio [$R]";; esac

echo "=== view v_sku_classe_sb ==="
eq "view existe c/ security_invoker" "$(Pq -c "SELECT 'security_invoker=on' = ANY(reloptions) FROM pg_class WHERE relname='v_sku_classe_sb';")" "t"
# staff le e o quadrante sai (3 dias de venda, ADI alto, CV2 alto -> lumpy)
R=$(como 11111111-1111-1111-1111-111111111111 "SELECT quadrante FROM public.v_sku_classe_sb WHERE sku_codigo_omie = 9001;")
eq "staff le a view (quadrante lumpy)" "$R" "lumpy"
# customer: invoker herda a RLS da base -> 0 linhas (a view nao vaza)
R=$(como 22222222-2222-2222-2222-222222222222 "SELECT count(*) FROM public.v_sku_classe_sb;")
eq "customer ve 0 na view (invoker herda RLS)" "$R" "0"

echo "=== FALSIFICACAO: policy de INSERT sabotada p/ WITH CHECK (true) -> o assert de negacao TEM de ficar vermelho ==="
P -q -c "DROP POLICY venda_perdida_ins ON public.venda_perdida_log; CREATE POLICY venda_perdida_ins ON public.venda_perdida_log FOR INSERT TO authenticated WITH CHECK (true);"
R=$(como 22222222-2222-2222-2222-222222222222 "INSERT INTO public.venda_perdida_log (sku_codigo_omie, quantidade) VALUES ('9001', 1) RETURNING 'INSERIU';")
if [ "$R" = "INSERIU" ]; then ok "FALSIF pegou: com a policy sabotada o customer INSERE (o assert original tem dente)"; else bad "FALSIF invalida — sabotagem nao mudou o comportamento [$R]"; fi
# restaura a policy REAL re-aplicando a migration (DROP POLICY IF EXISTS + CREATE dela)
P -q -f "$MIG"
R=$(como 22222222-2222-2222-2222-222222222222 "INSERT INTO public.venda_perdida_log (sku_codigo_omie, quantidade) VALUES ('9001', 1);" )
case "$R" in *"42501"*|*"row-level security"*) ok "restaurada: customer negado de novo";; *) bad "restauracao falhou — [$R]";; esac

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
