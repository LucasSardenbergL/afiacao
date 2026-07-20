#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — FU4: split do FOR ALL broad-staff em sales_orders + filhas      ║
# ║ Migration: supabase/migrations/20260724120000_authz_sales_orders_split_...   ║
# ║ Spec: docs/superpowers/specs/2026-07-20-sales-orders-bfla-split-escrita-...  ║
# ║                                                                              ║
# ║   bash db/test-authz-sales-orders-split-escrita.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="so-split"
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

MASTER='11111111-1111-1111-1111-111111111111'
EMPL='22222222-2222-2222-2222-222222222222'
CUST_A='33333333-3333-3333-3333-333333333333'
CUST_B='44444444-4444-4444-4444-444444444444'
SO_FAT='aaaaaaaa-0000-0000-0000-000000000001'   # faturado, omie_pedido_id preenchido
SO_ORC='aaaaaaaa-0000-0000-0000-000000000002'   # orçamento, sem omie_pedido_id

# Roda um comando como <role> com o GUC do JWT. Devolve stdout+stderr (o SQLSTATE
# do permission denied sai no stderr) SEM abortar o script.
as_role() { # $1=uid $2=role $3=sql
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -v ON_ERROR_STOP=0 2>&1 <<SQL
SET test.uid='$1'; SET ROLE $2;
$3
SQL
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: reproduzir o estado REAL da prod (medido 2026-07-20)
# ⚠️ O harness tem de espelhar a PROD, não o design (§4: "stub que espelha o
#    design nasce fechado por acidente e prova o mundo que você queria ter").
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $$;

-- as 28 colunas da prod, na ordem medida
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  customer_user_id uuid,
  created_by uuid,
  items jsonb,
  subtotal numeric,
  discount numeric,
  total numeric,
  status text,
  notes text,
  omie_pedido_id bigint,
  omie_numero_pedido text,
  omie_payload jsonb,
  omie_response jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  account text,
  hash_payload text,
  customer_address text,
  customer_phone text,
  ready_by_date date,
  deleted_at timestamptz,
  order_date_kpi date,
  checkout_id uuid,
  origem text,
  atendimento_id uuid,
  pedido_programado_envio_id uuid,
  customer_document text,
  whatsapp_conversation_id uuid
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid,
  product_id uuid,
  omie_codigo_produto text,
  quantity numeric,
  unit_price numeric,
  discount numeric,
  created_at timestamptz DEFAULT now(),
  hash_payload text
);

CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY,
  customer_user_id uuid,
  product_id uuid,
  unit_price numeric,
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.sales_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_price_history ENABLE ROW LEVEL SECURITY;
-- prod: relforcerowsecurity=false, relowner=postgres (NÃO ligar FORCE — mudaria
-- a premissa do #1416 e o harness provaria outro mundo)

-- ── ACL: espelha o relacl medido em prod ──────────────────────────────────────
-- order_items / sales_price_history: authenticated=arwdDxtm (DML completo + SELECT)
GRANT ALL ON public.order_items, public.sales_price_history TO anon, authenticated, service_role;
-- sales_orders: authenticated=awdDxtm — SEM 'r' table-level (REVOKE do PR0.0-bis
-- 20260709163500), SELECT vem por GRANT de COLUNA nas 25 não-sensíveis.
GRANT ALL ON public.sales_orders TO anon, authenticated, service_role;
REVOKE SELECT ON public.sales_orders FROM anon, authenticated;
GRANT SELECT (
  id, customer_user_id, created_by, items, subtotal, discount, total, status, notes,
  omie_pedido_id, omie_numero_pedido, created_at, updated_at, account, hash_payload,
  customer_address, customer_phone, ready_by_date, deleted_at, order_date_kpi,
  checkout_id, origem, atendimento_id, pedido_programado_envio_id, customer_document
) ON public.sales_orders TO authenticated;
-- a policy avalia com privilégio do CALLER → user_roles precisa ser legível
GRANT SELECT ON public.user_roles TO anon, authenticated, service_role;

-- ── POLICIES ORIGINAIS (o estado que a migration vai substituir) ──────────────
CREATE POLICY "Staff can manage sales orders" ON public.sales_orders
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Customers can view their own sales orders" ON public.sales_orders
  FOR SELECT TO authenticated USING (auth.uid() = customer_user_id);

CREATE POLICY "Staff can manage order items" ON public.order_items
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Customers can view their own order items" ON public.order_items
  FOR SELECT TO authenticated USING (auth.uid() = customer_user_id);

CREATE POLICY "Staff can manage sales price history" ON public.sales_price_history
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Customers can view their own price history" ON public.sales_price_history
  FOR SELECT TO authenticated USING (auth.uid() = customer_user_id);
SQL
echo "pré-requisitos: schema + ACL + policies ORIGINAIS (espelho da prod)"

# ── B0: o estado ANTES é o BFLA que dizemos existir (senão provamos outro mundo) ──
echo "── B0: linha de base (o BFLA existe antes da migration) ──"
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$EMPL'),('$CUST_A'),('$CUST_B') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'),('$EMPL','employee'),('$CUST_A','customer'),('$CUST_B','customer');
INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account)
VALUES ('$SO_FAT','$CUST_A','$EMPL','faturado',1000,1000,987654,'oben');
SQL
B0=$(as_role "$EMPL" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "B0 ANTES: employee APAGA pedido faturado (o BFLA é real)" "$B0" "0"
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account) VALUES ('$SO_FAT','$CUST_A','$EMPL','faturado',1000,1000,987654,'oben');"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260724120000_authz_sales_orders_split_escrita_fu4.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account)
VALUES ('$SO_ORC','$CUST_A','$EMPL','orcamento',500,500,NULL,'oben');
INSERT INTO public.order_items(id,sales_order_id,customer_user_id,quantity,unit_price)
VALUES ('bbbbbbbb-0000-0000-0000-000000000001','$SO_FAT','$CUST_A',2,500);
INSERT INTO public.sales_price_history(id,customer_user_id,sales_order_id,unit_price)
VALUES ('cccccccc-0000-0000-0000-000000000001','$CUST_A','$SO_FAT',500);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A: caminho feliz preservado (a operação não quebra) ──"

A1=$(as_role "$EMPL" authenticated "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,account) VALUES ('aaaaaaaa-0000-0000-0000-0000000000f1','$CUST_A','$EMPL','rascunho',10,10,'oben'); SELECT count(*) FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-0000000000f1';" | tail -1)
eq "A1 employee INSERT pedido (balcão preservado)" "$A1" "1"

A2=$(as_role "$EMPL" authenticated "UPDATE public.sales_orders SET total=1200, subtotal=1200, notes='editado' WHERE id='$SO_FAT'; SELECT total::int FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "A2 employee UPDATE (edição de pedido preservada)" "$A2" "1200"

A3=$(as_role "$EMPL" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_ORC'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_ORC';" | tail -1)
eq "A3 employee DELETE orçamento (SalesQuotes.tsx preservado)" "$A3" "0"
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account) VALUES ('$SO_ORC','$CUST_A','$EMPL','orcamento',500,500,NULL,'oben');"

# A4: cada uma das 11 colunas da allowlist tem de ser gravável (allowlist estreita
# demais quebraria o front em SILÊNCIO — e todo assert de SEGURANÇA ficaria mais
# verde, não mais vermelho; por isso este assert existe)
A4FAIL=0
for col_val in "items:'[]'::jsonb" "subtotal:1" "total:1" "notes:'x'" "customer_document:'1'" \
               "customer_address:'r'" "customer_phone:'9'" "ready_by_date:'2026-01-01'::date" \
               "omie_payload:'{}'::jsonb" "deleted_at:now()" "status:'rascunho'"; do
  c="${col_val%%:*}"; v="${col_val#*:}"
  R=$(as_role "$EMPL" authenticated "UPDATE public.sales_orders SET $c=$v WHERE id='$SO_ORC';")
  echo "$R" | grep -q "permission denied" && { bad "A4 allowlist: coluna [$c] NEGADA (front quebraria)"; A4FAIL=1; }
done
[ "$A4FAIL" = "0" ] && ok "A4 as 11 colunas da allowlist são graváveis pelo employee"
P -q -c "UPDATE public.sales_orders SET deleted_at=NULL, status='orcamento' WHERE id='$SO_ORC';"

A5=$(as_role "$MASTER" authenticated "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,account) VALUES ('aaaaaaaa-0000-0000-0000-0000000000f2','$CUST_A','$MASTER','rascunho',10,10,'oben'); SELECT count(*) FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-0000000000f2';" | tail -1)
eq "A5 master INSERT pedido" "$A5" "1"

A6=$(Pq -c "SET ROLE service_role; DELETE FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-0000000000f2'; SELECT count(*) FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-0000000000f2';" | tail -1)
eq "A6 service_role DELETE pedido (edge excluir_pedido preservada)" "$A6" "0"

A7=$(Pq -c "SET ROLE service_role; INSERT INTO public.order_items(id,sales_order_id,customer_user_id,quantity,unit_price) VALUES ('bbbbbbbb-0000-0000-0000-0000000000f1','$SO_FAT','$CUST_A',1,1); SELECT count(*) FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-0000000000f1';" | tail -1)
eq "A7 service_role escreve em order_items (sync-reprocess preservado)" "$A7" "1"

echo "── B: a defesa morde ──"

B1=$(as_role "$EMPL" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "B1 employee NÃO apaga pedido faturado" "$B1" "1"

B2=$(as_role "$MASTER" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "B2 master TAMBÉM não apaga (predicado sem exceção de ator)" "$B2" "1"

# B3: as colunas FORA da allowlist são ingraváveis.
# ⚠️ Mede o EFEITO (o valor não mudou), não a REDAÇÃO da mensagem: quando o role
# não tem UPDATE table-level, o PG nega com "permission denied for table", não
# "...for column <c>" — casar a string exata dá vermelho com a defesa FUNCIONANDO
# (§4: valide o efeito/valor, nunca a representação textual do catálogo/erro).
for c in omie_pedido_id customer_user_id created_by; do
  R=$(as_role "$EMPL" authenticated "UPDATE public.sales_orders SET $c=NULL WHERE id='$SO_FAT';")
  V=$(Pq -c "SELECT ($c IS NULL)::text FROM public.sales_orders WHERE id='$SO_FAT';")
  # ::text de boolean devolve 'false'/'true' (≠ 'f'/'t' do formato aligned)
  if echo "$R" | grep -q "permission denied" && [ "$V" = "false" ]; then
    ok "B3 employee NÃO atualiza [$c] (negado + valor intacto)"
  else
    bad "B3 [$c]: negado=$(echo "$R" | grep -c 'permission denied') virou_null=$V — allowlist furada"
  fi
done

B4=$(as_role "$EMPL" authenticated "DELETE FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-000000000001';")
echo "$B4" | grep -q "permission denied" && ok "B4 employee NÃO apaga order_items (2ª barreira)" || bad "B4 employee apagou order_items"

B5=$(as_role "$EMPL" authenticated "UPDATE public.sales_price_history SET unit_price=1 WHERE id='cccccccc-0000-0000-0000-000000000001';")
echo "$B5" | grep -q "permission denied" && ok "B5 employee NÃO altera sales_price_history" || bad "B5 employee alterou sales_price_history"

B6=$(as_role "$CUST_A" authenticated "SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "B6 customer A vê o PRÓPRIO pedido" "$B6" "1"
B7=$(as_role "$CUST_B" authenticated "SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
eq "B7 customer B NÃO vê pedido alheio" "$B7" "0"

echo "── C: preservação (o que a migration NÃO pode ter quebrado) ──"

# C1 é o assert do risco que quase passou: REVOKE ALL (em vez de REVOKE UPDATE)
# teria levado junto os grants de SELECT por coluna do PR0.0-bis.
C1=$(Pq -c "SELECT count(*) FROM unnest(ARRAY['id','customer_user_id','total','status','items','account','deleted_at']) c WHERE has_column_privilege('authenticated','public.sales_orders',c,'SELECT');")
eq "C1 SELECT por coluna do PR0.0-bis PRESERVADO" "$C1" "7"

C2=$(Pq -c "SELECT count(*) FROM unnest(ARRAY['omie_payload','omie_response','whatsapp_conversation_id']) c WHERE has_column_privilege('authenticated','public.sales_orders',c,'SELECT');")
eq "C2 as 3 colunas sensíveis seguem ILEGÍVEIS" "$C2" "0"

C3=$(Pq -c "SELECT has_table_privilege('authenticated','public.order_items','SELECT')::text;")
eq "C3 front continua LENDO order_items" "$C3" "true"

C4=$(Pq -c "SELECT count(*) FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('authenticated','public.order_items',p);")
eq "C4 authenticated sem DML nem TRUNCATE em order_items" "$C4" "0"

C5=$(Pq -c "SELECT count(*) FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) p WHERE has_table_privilege('service_role','public.sales_orders',p) AND has_table_privilege('service_role','public.order_items',p);")
eq "C5 service_role intacto nas 3 (edges/RPC seguem escrevendo)" "$C5" "3"

C6=$(Pq -c "SELECT has_table_privilege('authenticated','public.sales_orders','TRUNCATE')::text;")
eq "C6 TRUNCATE revogado em sales_orders (RLS não se aplica a ele)" "$C6" "false"

echo "── D: catálogo (drift que a matriz de acesso NÃO pega) ──"

D1=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('sales_orders','order_items','sales_price_history') AND cmd='ALL';")
eq "D1 zero policies FOR ALL nas 3" "$D1" "0"

D2=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders';")
eq "D2 sales_orders tem 5 policies (4 staff + 1 customer)" "$D2" "5"

D3=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('sales_orders','order_items','sales_price_history') AND roles::text <> '{authenticated}';")
eq "D3 nenhuma policy alargou o role (TO public/anon)" "$D3" "0"

# §4: o detector é ILIKE '%select%' (com espaço) — '%(select%' dá falso-0 porque
# o pg_get_expr renderiza o sublink como "( SELECT"
D4=$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('sales_orders','order_items','sales_price_history') AND COALESCE(qual,with_check) NOT ILIKE '%select%';")
eq "D4 todas as policies wrapped em InitPlan" "$D4" "0"

# valores, não sintaxe (pg_get_expr re-serializa — §4)
D5=$(Pq -c "SELECT (qual ~ 'omie_pedido_id' AND qual ~ 'orcamento')::text FROM pg_policies WHERE tablename='sales_orders' AND cmd='DELETE';")
eq "D5 o predicado de estado está no USING do DELETE" "$D5" "true"

D6=$(Pq -c "SELECT (pg_get_functiondef('private.cap_pedido_escrever(uuid)'::regprocedure) ~ 'employee' AND pg_get_functiondef('private.cap_pedido_escrever(uuid)'::regprocedure) !~ 'gerencial|estrategico|carteira')::text;")
eq "D6 a capability inclui employee e não vazou outro gate" "$D6" "true"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── F: falsificação (sabota → exige VERMELHO → restaura) ──"

# F1 — sem o predicado de estado, o employee volta a apagar pedido faturado.
P -q <<'SQL'
DROP POLICY sales_orders_delete_staff ON public.sales_orders;
CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));
SQL
F1=$(as_role "$EMPL" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
[ "$F1" = "0" ] && ok "F1 sem o predicado o furo REABRE (B1 tem dente)" || bad "F1 sem o predicado o furo NÃO reabriu — B1 não mede o predicado"
P -q <<'SQL'
DROP POLICY sales_orders_delete_staff ON public.sales_orders;
CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid())))
         AND omie_pedido_id IS NULL AND status IN ('orcamento','rascunho'));
SQL
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account) VALUES ('$SO_FAT','$CUST_A','$EMPL','faturado',1000,1000,987654,'oben') ON CONFLICT DO NOTHING;"

# F2 — o bug do #1434: FOR ALL USING+WITH CHECK NÃO separa leitura de escrita,
# porque DELETE consulta só o USING.
P -q <<'SQL'
DROP POLICY sales_orders_delete_staff ON public.sales_orders;
DROP POLICY sales_orders_update_staff ON public.sales_orders;
DROP POLICY sales_orders_insert_staff ON public.sales_orders;
CREATE POLICY sales_orders_forall_bug ON public.sales_orders FOR ALL TO authenticated
  USING (true)   -- "capability de LEITURA" (larga)
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));  -- "de ESCRITA"
SQL
F2=$(as_role "$CUST_B" authenticated "DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
[ "$F2" = "0" ] && ok "F2 USING+WITH CHECK: quem só LÊ apaga (repro do #1434)" || bad "F2 não reproduziu o #1434 — a falsificação não morde"
P -q <<'SQL'
DROP POLICY sales_orders_forall_bug ON public.sales_orders;
CREATE POLICY sales_orders_insert_staff ON public.sales_orders FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));
CREATE POLICY sales_orders_update_staff ON public.sales_orders FOR UPDATE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));
CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid())))
         AND omie_pedido_id IS NULL AND status IN ('orcamento','rascunho'));
SQL
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account) VALUES ('$SO_FAT','$CUST_A','$EMPL','faturado',1000,1000,987654,'oben') ON CONFLICT DO NOTHING;"

# F3 — O BYPASS DE DOIS PASSOS, exercitado de verdade. Regrantar UPDATE
# table-wide (= desfazer a allowlist) tem de reabrir o caminho PATCH→DELETE.
P -q -c "GRANT UPDATE ON public.sales_orders TO authenticated;"
F3=$(as_role "$EMPL" authenticated "UPDATE public.sales_orders SET omie_pedido_id=NULL, status='rascunho' WHERE id='$SO_FAT'; DELETE FROM public.sales_orders WHERE id='$SO_FAT'; SELECT count(*) FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
[ "$F3" = "0" ] && ok "F3 sem a allowlist o bypass PATCH→DELETE FUNCIONA (B3 tem dente)" || bad "F3 o bypass não reabriu — B3 não mede a allowlist"
P -q <<'SQL'
REVOKE UPDATE ON public.sales_orders FROM authenticated, anon;
GRANT UPDATE (items,subtotal,total,notes,customer_document,customer_address,customer_phone,
              ready_by_date,omie_payload,deleted_at,status) ON public.sales_orders TO authenticated;
SQL
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,created_by,status,total,subtotal,omie_pedido_id,account) VALUES ('$SO_FAT','$CUST_A','$EMPL','faturado',1000,1000,987654,'oben') ON CONFLICT DO NOTHING;"

# F4 — a allowlist não pode ser LARGA demais: incluir omie_pedido_id reabre F3.
P -q -c "GRANT UPDATE (omie_pedido_id) ON public.sales_orders TO authenticated;"
F4=$(as_role "$EMPL" authenticated "UPDATE public.sales_orders SET omie_pedido_id=NULL WHERE id='$SO_FAT'; SELECT omie_pedido_id IS NULL FROM public.sales_orders WHERE id='$SO_FAT';" | tail -1)
[ "$F4" = "t" ] && ok "F4 allowlist larga (com omie_pedido_id) reabre o furo" || bad "F4 não reabriu — o assert não mede a composição da allowlist"
P -q -c "REVOKE UPDATE (omie_pedido_id) ON public.sales_orders FROM authenticated;"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id=987654 WHERE id='$SO_FAT';"

# F5 — camadas separadas em order_items (§4/#1422): recriar SÓ a policy não basta,
# porque o REVOKE segura; recriar policy E regrant reabre. Sem (a) não se sabe se
# a 2ª camada existe; sem (b) não se sabe se o assert mede alguma coisa.
P -q -c "CREATE POLICY oi_bug ON public.order_items FOR ALL TO authenticated USING (true) WITH CHECK (true);"
F5a=$(as_role "$EMPL" authenticated "DELETE FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-000000000001';")
echo "$F5a" | grep -q "permission denied" && ok "F5a só a policy de volta: o REVOKE ainda barra (2ª camada é REAL)" || bad "F5a a policy sozinha já reabriu — o REVOKE não está fazendo nada"
P -q -c "GRANT ALL ON public.order_items TO authenticated;"
F5b=$(as_role "$EMPL" authenticated "DELETE FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-000000000001'; SELECT count(*) FROM public.order_items WHERE id='bbbbbbbb-0000-0000-0000-000000000001';" | tail -1)
[ "$F5b" = "0" ] && ok "F5b policy + grant: o furo REABRE (B4 tem dente)" || bad "F5b tirando as 2 camadas o furo não reabriu — B4 não mede nada"
P -q <<'SQL'
DROP POLICY oi_bug ON public.order_items;
REVOKE ALL PRIVILEGES ON public.order_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_items TO authenticated;
SQL

# F6 — REVOKE ALL em sales_orders (o que o Codex sugeriu) destruiria os grants de
# SELECT por COLUNA do PR0.0-bis. C1 tem de ficar vermelho.
P -q -c "REVOKE ALL PRIVILEGES ON public.sales_orders FROM authenticated;"
F6=$(Pq -c "SELECT count(*) FROM unnest(ARRAY['id','customer_user_id','total','status','items','account','deleted_at']) c WHERE has_column_privilege('authenticated','public.sales_orders',c,'SELECT');")
[ "$F6" = "0" ] && ok "F6 REVOKE ALL destrói os column grants do PR0.0-bis (C1 tem dente)" || bad "F6 REVOKE ALL não destruiu os column grants — C1 não mede a preservação"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
