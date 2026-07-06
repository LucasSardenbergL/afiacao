#!/usr/bin/env bash
# Prova PG17 da migration 20260705211043_omie_identidade_por_conta.sql (P0-B).
# RPC omie_cliente_upsert_mapping: backfill guardado do espelho (inserted/noop/contested, NUNCA overwrite)
# + gate money-path (só service_role executa). Falsificação: overwrite + gate furado.
#   bash db/test-omie-identidade-backfill.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="omie-identidade-backfill"
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
contains() { case "$2" in *"$1"*) ok "$3";; *) bad "$3 — nao achou [$1] em: $2";; esac; }

UA='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
UB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
FN='public.omie_cliente_upsert_mapping(uuid,text,bigint,bigint)'
echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos (o que a migração LÊ/ALTERA) ──
# Reproduz o default-privilege do Supabase (functions novas → EXECUTE p/ anon/authenticated/service_role),
# senão o REVOKE FROM anon,authenticated da migration vira no-op e o gate dá FALSO-VERDE (database.md §5).
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- stub mínimo p/ o ALTER TABLE ... ADD COLUMN customer_document
CREATE TABLE public.sales_orders (id uuid);
-- omie_clientes FIEL: colunas + os DOIS unique indexes reais (o RPC depende deles)
CREATE TABLE public.omie_clientes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_cliente_integracao text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  omie_codigo_vendedor bigint,
  empresa_omie text DEFAULT 'colacor' NOT NULL,
  CONSTRAINT omie_clientes_empresa_omie_check CHECK (empresa_omie = ANY (ARRAY['colacor','oben','colacor_sc']))
);
CREATE UNIQUE INDEX idx_omie_clientes_codigo_empresa ON public.omie_clientes (omie_codigo_cliente, empresa_omie);
CREATE UNIQUE INDEX idx_omie_clientes_user_empresa  ON public.omie_clientes (user_id, empresa_omie);
SQL

# ── ZONA 2: aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260705211043_omie_identidade_por_conta.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

echo "── asserts ──"
# A0 — a coluna âncora existe
COL=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='sales_orders' AND column_name='customer_document';")
eq "A0 sales_orders.customer_document existe" "$COL" "1"

# P1 — tabela vazia → inserted + linha correta
V=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UA','oben',100,9);"); eq "P1 inserted" "$V" "inserted"
N=$(Pq -c "SELECT count(*) FROM omie_clientes;"); eq "P1 criou 1 linha" "$N" "1"
ROW=$(Pq -c "SELECT omie_codigo_cliente||'/'||coalesce(omie_codigo_vendedor::text,'-') FROM omie_clientes WHERE user_id='$UA' AND empresa_omie='oben';")
eq "P1 linha = 100/9" "$ROW" "100/9"

# P2 — repetir idêntico → noop, sem nova linha
V=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UA','oben',100,9);"); eq "P2 noop" "$V" "noop"
N=$(Pq -c "SELECT count(*) FROM omie_clientes;"); eq "P2 continua 1 linha" "$N" "1"

# N1 — mesmo (user,empresa) com código DIFERENTE → contested, NÃO sobrescreve
V=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UA','oben',200,9);"); eq "N1 contested (codigo diferente)" "$V" "contested"
ROW=$(Pq -c "SELECT omie_codigo_cliente FROM omie_clientes WHERE user_id='$UA' AND empresa_omie='oben';")
eq "N1 NAO sobrescreve (fica 100)" "$ROW" "100"

# N2 — outro user tentando o código 100 (já do UA) → contested, sem linha nova
V=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UB','oben',100,5);"); eq "N2 contested (codigo de outro user)" "$V" "contested"
N=$(Pq -c "SELECT count(*) FROM omie_clientes;"); eq "N2 sem linha nova (continua 1)" "$N" "1"

# N3 — argumento nulo → RAISE 22004 (sentinela anti-teatro, não contém o texto do código)
R=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.omie_cliente_upsert_mapping(NULL, 'oben', 100, 9);
  RAISE NOTICE 'SENT_NAO_RAISOU';
EXCEPTION
  WHEN sqlstate '22004' THEN RAISE NOTICE 'SENT_OK_22004';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
contains "SENT_OK_22004" "$R" "N3 arg nulo dispara RAISE 22004"

# Gate money-path: só service_role executa
G1a=$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');");          eq "G1 anon NAO executa" "$G1a" "f"
G1b=$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');"); eq "G1 authenticated NAO executa" "$G1b" "f"
G2=$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');");   eq "G2 service_role executa" "$G2" "t"

# ── ZONA 5: FALSIFICAÇÃO (sabota → exige que o invariante quebre → restaura) ──
echo "── falsificação ──"

# F1 — sabota o ramo 'código diferente' p/ SOBRESCREVER; prova que N1 tem dente.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_cliente_upsert_mapping(p_user_id uuid, p_empresa text, p_codigo_cliente bigint, p_codigo_vendedor bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_existing_codigo bigint;
BEGIN
  SELECT omie_codigo_cliente INTO v_existing_codigo FROM public.omie_clientes WHERE user_id=p_user_id AND empresa_omie=p_empresa;
  IF FOUND THEN
    IF v_existing_codigo = p_codigo_cliente THEN RETURN 'noop'; END IF;
    UPDATE public.omie_clientes SET omie_codigo_cliente=p_codigo_cliente WHERE user_id=p_user_id AND empresa_omie=p_empresa; -- BUG: overwrite
    RETURN 'updated';
  END IF;
  INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente, omie_codigo_vendedor) VALUES (p_user_id,p_empresa,p_codigo_cliente,p_codigo_vendedor);
  RETURN 'inserted';
END; $$;
SQL
Vf=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UA','oben',200,9);")
ROWf=$(Pq -c "SELECT omie_codigo_cliente FROM omie_clientes WHERE user_id='$UA' AND empresa_omie='oben';")
eq "F1 sabotagem SOBRESCREVE (prova que N1 morde)" "$ROWf" "200"
# restaura a versão real e confirma o invariante de novo
P -q -f "$MIG"
Vr=$(Pq -c "SELECT public.omie_cliente_upsert_mapping('$UA','oben',300,9);")
eq "F1 restaurado: contested" "$Vr" "contested"
ROWr=$(Pq -c "SELECT omie_codigo_cliente FROM omie_clientes WHERE user_id='$UA' AND empresa_omie='oben';")
eq "F1 restaurado: NAO sobrescreve (fica 200)" "$ROWr" "200"

# F3 — sabota o gate: grant explícito a anon/authenticated (= o que 'REVOKE só FROM PUBLIC' deixaria).
P -q -c "GRANT EXECUTE ON FUNCTION $FN TO anon, authenticated;"
Ff=$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")
eq "F3 gate furado: authenticated AINDA executa (prova que G1 morde)" "$Ff" "t"
# restaura o REVOKE real
P -q -c "REVOKE ALL ON FUNCTION $FN FROM anon, authenticated;"
Fr=$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")
eq "F3 restaurado: authenticated NAO executa" "$Fr" "f"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
