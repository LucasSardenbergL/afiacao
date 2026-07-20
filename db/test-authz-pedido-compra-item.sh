#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F 2b — prova PG17: pedido_compra_item fecha em cap_compras_ler (4 policies)║
# ╚════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE PROVA. A tabela é OPERACIONAL (≠ as 9 irmãs, que são log só-SELECT): o frontend lê E apaga.
# Por isso a falsificação decisiva aqui é a F2 — sabota SÓ o DELETE de volta para `has_role` e exige
# que o farmer volte a APAGAR. Ela pega o meio-fix "fechei a leitura, o resto tanto faz", que
# deixaria um employee sem poder ver o preço mas ainda podendo destruir o item do pedido.
#
# Pré-requisitos: brew install postgresql@17 pgvector
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="pci-2b"
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

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — estado de prod ANTES desta migration
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- private.cap_compras_ler REAL (verbatim do #1434): MASTER-ONLY, desacoplado do papel comercial.
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false); $f$;
REVOKE ALL     ON FUNCTION private.cap_compras_ler(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated, service_role;
GRANT  USAGE   ON SCHEMA private TO authenticated, anon, service_role;

CREATE TABLE IF NOT EXISTS public.pedido_compra_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid,
  omie_codigo_produto bigint,
  quantidade numeric,
  preco_unitario numeric,
  preco_sem_desconto numeric
);
ALTER TABLE public.pedido_compra_item ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.pedido_compra_item TO anon, authenticated, service_role;

-- As 4 policies no estado PRÉ-migration (staff amplo, has_role CRU — sem wrap InitPlan, como em prod)
CREATE POLICY staff_pedido_compra_item_select ON public.pedido_compra_item FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
CREATE POLICY staff_pedido_compra_item_insert ON public.pedido_compra_item FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
CREATE POLICY staff_pedido_compra_item_update ON public.pedido_compra_item FOR UPDATE TO authenticated
  USING      (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
CREATE POLICY staff_pedido_compra_item_delete ON public.pedido_compra_item FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
SQL

# GUARD ANTI-FALSO-VERDE: psql conecta como superuser, que BYPASSA RLS.
GUARD=$(Pq -c "SET ROLE authenticated; SELECT current_user;" | tail -1)
[ "$GUARD" = "authenticated" ] || { echo "❌ ABORT: SET ROLE não pegou (current_user=$GUARD)"; exit 1; }
echo "  🔒 guard SET ROLE ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723140000_authz_pedido_compra_item_cap_compras.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
M_UID='11111111-1111-1111-1111-111111111111'   # master → cap_compras_ler = TRUE
F_UID='22222222-2222-2222-2222-222222222222'   # employee/farmer → FALSE

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$M_UID'),('$F_UID') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$M_UID','master'::public.app_role), ('$F_UID','employee'::public.app_role);
INSERT INTO public.pedido_compra_item(id, omie_codigo_produto, quantidade, preco_unitario, preco_sem_desconto) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 5001, 10, 47.30, 52.00),
  ('aaaaaaaa-0000-0000-0000-000000000002', 5002,  4, 118.90, 118.90);
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# M1: AS QUATRO policies migraram; nenhuma antiga; nenhuma 5ª; todas wrapped.
CAP=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item' AND coalesce(qual,with_check) ILIKE '%cap_compras_ler%';")
eq "M1a as 4 policies exigem cap_compras_ler" "$CAP" "4"
OLD=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item' AND coalesce(qual,with_check) ILIKE '%has_role%';")
eq "M1b nenhuma policy antiga sobrou" "$OLD" "0"
TOT=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item';")
eq "M1c exatamente 4 policies (nenhuma 5ª permissiva)" "$TOT" "4"
WRAP=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item' AND coalesce(qual,with_check) ILIKE '%( select%';")
eq "M1d wrap InitPlan nas 4 (era has_role CRU antes)" "$WRAP" "4"

# M2: o UPDATE tem as DUAS cláusulas fechadas (USING governa quais linhas; WITH CHECK, o resultado)
UPD=$(Pq -c "SELECT (qual ILIKE '%cap_compras_ler%' AND with_check ILIKE '%cap_compras_ler%') FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item' AND cmd='UPDATE';")
eq "M2 UPDATE fechado no USING e no WITH CHECK" "$UPD" "t"

# P1: master opera normalmente (lê e apaga)
MST=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT count(*) FROM public.pedido_compra_item;" | tail -1)
eq "P1 master lê os itens" "$MST" "2"
MST_P=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT preco_unitario FROM public.pedido_compra_item WHERE omie_codigo_produto=5001;" | tail -1)
eq "P1b master vê o preço do fornecedor" "$MST_P" "47.30"

# P2: service_role (edges/cron) preservado
SVC=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.pedido_compra_item;" | tail -1)
eq "P2 service_role preservado (BYPASSRLS)" "$SVC" "2"

# N1: farmer não LÊ
FRM=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.pedido_compra_item;" | tail -1)
eq "N1 farmer NÃO lê preço de fornecedor" "$FRM" "0"

# N2/N3/N4: farmer não ESCREVE. ROW_COUNT (não FOUND — FOUND carrega estado de comando anterior).
for OP in "UPDATE public.pedido_compra_item SET preco_unitario = 1|N2 UPDATE" \
          "DELETE FROM public.pedido_compra_item|N3 DELETE"; do
  SQL_CMD="${OP%%|*}"; LABEL="${OP##*|}"
  R=$(P -tA 2>&1 <<SQL
DO \$\$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('test.uid','$F_UID',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE '$SQL_CMD';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE NOTICE 'ZZ_SENTINELA_OK';
  ELSE RAISE NOTICE 'ZZ_FALHOU_ESCREVEU_%_LINHAS', v_rows; END IF;
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ZZ_SENTINELA_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in *ZZ_SENTINELA_OK*) ok "$LABEL negado ao farmer";; *) bad "$LABEL PASSOU — [$R]";; esac
done

# N4: INSERT negado (WITH CHECK)
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  PERFORM set_config('test.uid','$F_UID',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE 'INSERT INTO public.pedido_compra_item(omie_codigo_produto, preco_unitario) VALUES (9999, 1)';
  RAISE NOTICE 'ZZ_FALHOU_FARMER_INSERIU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ZZ_SENTINELA_N4_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *ZZ_SENTINELA_N4_OK*) ok "N4 INSERT negado ao farmer (WITH CHECK)";; *) bad "N4 farmer INSERIU — [$R]";; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — sabota o SELECT de volta: N1 tem de ficar vermelho.
P -q <<'SQL'
DROP POLICY IF EXISTS staff_pedido_compra_item_select ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_select ON public.pedido_compra_item FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
SQL
F1=$(Pq -c "SET test.uid='$F_UID'; SET ROLE authenticated; SELECT count(*) FROM public.pedido_compra_item;" | tail -1)
eq "F1 sabotagem detectada: farmer volta a LER" "$F1" "2"

# F2 — A DECISIVA para esta tabela. Restaura o SELECT (fechado) e sabota SÓ o DELETE.
# Se o teste seguisse verde, o meio-fix "fecho a leitura e deixo a escrita" passaria batido —
# um employee sem poder VER o preço, mas ainda podendo APAGAR o item do pedido.
P -q <<'SQL'
DROP POLICY IF EXISTS staff_pedido_compra_item_select ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_select ON public.pedido_compra_item FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
DROP POLICY IF EXISTS staff_pedido_compra_item_delete ON public.pedido_compra_item;
CREATE POLICY staff_pedido_compra_item_delete ON public.pedido_compra_item FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
SQL
R=$(P -tA 2>&1 <<SQL
DO \$\$
DECLARE v_rows integer;
BEGIN
  PERFORM set_config('test.uid','$F_UID',true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  EXECUTE 'DELETE FROM public.pedido_compra_item';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'ZZ_APAGOU_%_LINHAS', v_rows;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ZZ_BARRADO';
END \$\$;
SQL
)
case "$R" in
  *ZZ_APAGOU_2_LINHAS*) ok "F2 sabotagem detectada: com o DELETE aberto o farmer APAGA sem poder ler (meio-fix pego)";;
  *) bad "F2 SEM DENTE: sabotei o DELETE e o farmer não apagou — [$R]";;
esac

# restaura tudo reaplicando a migration (prova idempotência de brinde)
P -q -f "$MIG"
F2R=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='pedido_compra_item' AND coalesce(qual,with_check) ILIKE '%cap_compras_ler%';")
eq "F2r reaplicar restaura as 4 (idempotente)" "$F2R" "4"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
