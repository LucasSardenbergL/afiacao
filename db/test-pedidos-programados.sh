#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da 20260702120000_pedidos_programados (money-path)      ║
# ║   bash db/test-pedidos-programados.sh > /tmp/pp-sql.log 2>&1; echo "exit=$?"  ║
# ║  5 tabelas staff-only (RLS) + bucket privado + seed de config por empresa.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="pedidos-programados"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

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
Pq() { P -qtA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT ALL ON SCHEMA public TO authenticated, anon;
-- No Supabase real, authenticated/anon já têm GRANT de tabela default em public (é como o
-- projeto é provisionado) — RLS é o ÚNICO gate. A migration nova em si NUNCA tem GRANT
-- explícito (confirmado: grep no arquivo não acha nenhum). Emula o default aqui ANTES de
-- aplicar a migration, pra tabela futura já nascer acessível (e o RLS ser o que de fato barra).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ════════ ZONA 1 — pré-requisitos (app_role/has_role/user_roles JÁ existem no stub? não —
#           criar aqui; omie_products, update_updated_at_column() e storage.* a migration referencia
#           e o stub genérico não tem) ════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
GRANT SELECT ON public.user_roles TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;

CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint,
  codigo text,
  descricao text,
  ativo boolean DEFAULT true,
  account text DEFAULT 'oben'
);

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
SQL

# ════════ ZONA 2 — aplicar a migration REAL (arquivo, sem copiar/colar) ════════
MIG="$REPO_ROOT/supabase/migrations/20260702120000_pedidos_programados.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ════════ ZONA 3 — seed de teste (cenário criado pelo staff via superuser) ════════
STAFF="33333333-3333-3333-3333-333333333333"
CUST="44444444-4444-4444-4444-444444444444"
PP_ID="55555555-5555-5555-5555-555555555555"
PRODUTO_ID="a1111111-1111-1111-1111-111111111111"
P -q <<SQL
INSERT INTO public.user_roles VALUES
  ('$STAFF','employee'),
  ('$CUST','customer');

INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, ativo, account) VALUES
  ('$PRODUTO_ID', 12345, 'ABC-123', 'Lixa 100 grãos', true, 'oben');

INSERT INTO public.pedidos_programados
  (id, cliente_ref, arquivo_path, numero_pedido_compra, status, created_by)
VALUES
  ('$PP_ID', 'lider', 'pedidos-programados/lider/2026-07-02.pdf', 'PC-9001', 'ativo', '$STAFF');
SQL
echo "seed: pedido_programado=$PP_ID criado por staff=$STAFF; customer=$CUST"

# ════════ ZONA 4 — asserts RLS (SET ROLE authenticated + GUC test.uid) ════════
echo "── asserts RLS ──"

# R1 — staff SELECT vê o header (count=1)
eq "R1 staff SELECT pedidos_programados count=1" \
  "$(Pq -c "SET ROLE authenticated; SET test.uid='$STAFF'; SELECT count(*) FROM public.pedidos_programados;")" "1"
P -q -c "RESET ROLE;" >/dev/null

# R2 — customer SELECT count=0
eq "R2 customer SELECT pedidos_programados count=0" \
  "$(Pq -c "SET ROLE authenticated; SET test.uid='$CUST'; SELECT count(*) FROM public.pedidos_programados;")" "0"
P -q -c "RESET ROLE;" >/dev/null

# R3 — customer INSERT barrado (42501 insufficient_privilege; re-lança qualquer outra exceção)
R3=$(P -tA 2>&1 <<SQL || true
SET ROLE authenticated;
SET test.uid='$CUST';
DO \$\$
BEGIN
  INSERT INTO public.pedidos_programados (cliente_ref, arquivo_path, created_by)
  VALUES ('lider', 'pedidos-programados/lider/intruso.pdf', '$CUST');
  RAISE EXCEPTION 'XCUSTOMERINSERIUX';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'CUSTOMERBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
RESET ROLE;
SQL
)
case "$R3" in *CUSTOMERBARRADO*) ok "R3 customer INSERT barrado (42501/insufficient_privilege)";; *) bad "R3 gate furado — [$R3]";; esac
P -q -c "RESET ROLE;" >/dev/null

# R4 — anon (uid vazio) count=0
eq "R4 anon (test.uid vazio) SELECT count=0" \
  "$(Pq -c "SET ROLE authenticated; SET test.uid=''; SELECT count(*) FROM public.pedidos_programados;")" "0"
P -q -c "RESET ROLE;" >/dev/null

# R5 — staff consegue INSERT em cliente_item_mapa (positivo de escrita)
MAPA_ID=$(Pq -c "
SET ROLE authenticated; SET test.uid='$STAFF';
INSERT INTO public.cliente_item_mapa (cliente_ref, codigo_item_cliente, omie_product_id, ultimo_preco)
VALUES ('lider', 'ITEM-001', '$PRODUTO_ID', 42.50)
RETURNING id;
")
if [ -n "$MAPA_ID" ]; then ok "R5 staff INSERT cliente_item_mapa OK (id=$MAPA_ID)"; else bad "R5 staff INSERT cliente_item_mapa falhou"; fi
P -q -c "RESET ROLE;" >/dev/null

# R6 — staff consegue INSERT em pedidos_programados_envios (positivo de escrita)
ENVIO_ID=$(Pq -c "
SET ROLE authenticated; SET test.uid='$STAFF';
INSERT INTO public.pedidos_programados_envios (pedido_programado_id, data_envio)
VALUES ('$PP_ID', current_date + 1)
RETURNING id;
")
if [ -n "$ENVIO_ID" ]; then ok "R6 staff INSERT pedidos_programados_envios OK (id=$ENVIO_ID)"; else bad "R6 staff INSERT pedidos_programados_envios falhou"; fi
P -q -c "RESET ROLE;" >/dev/null

# ════════ ZONA 5 — asserts de constraint (superuser, RESET ROLE) ════════
echo "── asserts de constraint ──"

# C1 — status inválido no header → 23514 check_violation
C1=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.pedidos_programados (cliente_ref, arquivo_path, status, created_by)
  VALUES ('lider', 'x.pdf', 'status_inexistente', '$STAFF');
  RAISE EXCEPTION 'XSTATUSPASSOUX';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'STATUSBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$C1" in *STATUSBARRADO*) ok "C1 status inválido no header → check_violation (23514)";; *) bad "C1 — [$C1]";; esac

# C2 — preco_final = 0 em itens → check_violation (o CHECK permite NULL, proíbe 0)
C2=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.pedidos_programados_itens
    (pedido_programado_id, codigo_item_cliente, descricao_cliente, quantidade, preco_final)
  VALUES ('$PP_ID', 'ITEM-ZERO', 'Item preco zero', 1, 0);
  RAISE EXCEPTION 'XPRECOZEROPASSOUX';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'PRECOZEROBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$C2" in *PRECOZEROBARRADO*) ok "C2 preco_final=0 em itens → check_violation (23514)";; *) bad "C2 — [$C2]";; esac

# C2b — preco_final = NULL PASSA (o CHECK só proíbe 0, não NULL)
ITEM_NULL_ID=$(Pq -c "
INSERT INTO public.pedidos_programados_itens
  (pedido_programado_id, codigo_item_cliente, descricao_cliente, quantidade, preco_final)
VALUES ('$PP_ID', 'ITEM-NULO', 'Item sem preco ainda', 1, NULL)
RETURNING id;
")
if [ -n "$ITEM_NULL_ID" ]; then ok "C2b preco_final=NULL em itens PASSA (id=$ITEM_NULL_ID)"; else bad "C2b preco_final=NULL foi barrado indevidamente"; fi

# C3 — quantidade = 0 → check_violation
C3=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.pedidos_programados_itens
    (pedido_programado_id, codigo_item_cliente, descricao_cliente, quantidade)
  VALUES ('$PP_ID', 'ITEM-QTD-ZERO', 'Item qtd zero', 0);
  RAISE EXCEPTION 'XQTDZEROPASSOUX';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'QTDZEROBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$C3" in *QTDZEROBARRADO*) ok "C3 quantidade=0 em itens → check_violation (23514)";; *) bad "C3 — [$C3]";; esac

# C4 — de-para duplicado (cliente_ref, codigo_item_cliente) → 23505 unique_violation
C4=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.cliente_item_mapa (cliente_ref, codigo_item_cliente, omie_product_id)
  VALUES ('lider', 'ITEM-001', '$PRODUTO_ID');
  RAISE EXCEPTION 'XDEDUPEPASSOUX';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'DEDUPEBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$C4" in *DEDUPEBARRADO*) ok "C4 de-para duplicado (cliente_ref,codigo_item_cliente) → unique_violation (23505)";; *) bad "C4 — [$C4]";; esac

# C5 — status de envio inválido → check_violation
C5=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  INSERT INTO public.pedidos_programados_envios (pedido_programado_id, data_envio, status)
  VALUES ('$PP_ID', current_date + 2, 'status_invalido');
  RAISE EXCEPTION 'XENVIOSTATUSPASSOUX';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'ENVIOSTATUSBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$C5" in *ENVIOSTATUSBARRADO*) ok "C5 status inválido em envios → check_violation (23514)";; *) bad "C5 — [$C5]";; esac

# ════════ ZONA 6 — asserts de seed ════════
echo "── asserts de seed ──"

eq "S1 config oben codigo_cliente_omie = 8689689628" \
  "$(Pq -c "SELECT codigo_cliente_omie FROM public.pedidos_programados_config WHERE account='oben';")" "8689689628"

eq "S2 config colacor existe com codigo NULL" \
  "$(Pq -c "SELECT (codigo_cliente_omie IS NULL) FROM public.pedidos_programados_config WHERE account='colacor';")" "t"

eq "S3 bucket pedidos-programados existe com public=false" \
  "$(Pq -c "SELECT public FROM storage.buckets WHERE id='pedidos-programados';")" "f"

# ════════ ZONA 7 — falsificação (sabota → exige vermelho → restaura) ════════
# A migration não é idempotente (CREATE TABLE): não dá pra sabotar/restaurar em cima do
# banco "prove" já usado nas zonas 1-6 sem recriar tudo. A falsificação roda num banco
# SEPARADO ("sabota"), aplicando a migration REAL (sabotada via sed) do zero.
echo "── falsificação ──"

P -q -c "DROP DATABASE IF EXISTS sabota;" >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres sabota
SB()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d sabota -v ON_ERROR_STOP=1 "$@"; }
SBq() { SB -qtA "$@"; }

# base idêntica à zona 1-2 (stubs + pré-requisitos), SEM a migration ainda.
SB -q -f "$REPO_ROOT/db/stubs-supabase.sql"
SB -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT ALL ON SCHEMA public TO authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
GRANT SELECT ON public.user_roles TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, codigo text, descricao text,
  ativo boolean DEFAULT true, account text DEFAULT 'oben'
);
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
SQL
SB -q <<SQL
INSERT INTO public.user_roles VALUES ('$STAFF','employee'), ('$CUST','customer');
SQL

# F1 — RLS é o que barra o customer (R2). Sabota comentando o ENABLE ROW LEVEL SECURITY
#      de pedidos_programados: sem RLS, customer passa a ver o header (count>0, não 0).
sed 's/^ALTER TABLE public\.pedidos_programados        ENABLE ROW LEVEL SECURITY;/-- SABOTADO: &/' "$MIG" > /tmp/sab-pp-rls.sql
SB -q -f /tmp/sab-pp-rls.sql
SB -q <<SQL
INSERT INTO public.pedidos_programados (cliente_ref, arquivo_path, status, created_by)
VALUES ('lider', 'x.pdf', 'ativo', '$STAFF');
SQL
RLS_SABOTADO=$(SBq -c "SET ROLE authenticated; SET test.uid='$CUST'; SELECT count(*) FROM public.pedidos_programados;")
SB -q -c "RESET ROLE;" >/dev/null
if [ "$RLS_SABOTADO" != "0" ]; then ok "F1 RLS sabotado (comentado) → customer PASSA A VER o header (R2 tem dente, count=$RLS_SABOTADO)"; else bad "F1 sabotagem não mudou a visibilidade → R2 é teatro [veio $RLS_SABOTADO]"; fi
SB -q -c "DROP DATABASE sabota" 2>/dev/null || true
P -q -c "DROP DATABASE IF EXISTS sabota;" >/dev/null

# F1b — reverte a sabotagem no MESMO arquivo (migration real, intocada) e confirma que o
#       banco "prove" original (zonas 1-6, migration real desde o início) segue barrando o
#       customer — isto é, a prova positiva R2 já É o "restaurado" desta falsificação.
eq "F1b migration real (sem sabotagem) → customer segue com count=0 em pedidos_programados" \
  "$(Pq -c "SET ROLE authenticated; SET test.uid='$CUST'; SELECT count(*) FROM public.pedidos_programados;")" "0"
P -q -c "RESET ROLE;" >/dev/null

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
