#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — as views anon-readable com `security_invoker=true` NÃO vazam         ║
# ║  bash db/test-views-anon-invoker-literal.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  CONTEXTO (o porquê deste harness existir)                                     ║
# ║  Depois do #1375/#1378, uma varredura estrutural apontou ~19 views em         ║
# ║  `public` como "security_invoker=off + owner=postgres + toca tabela-RLS +     ║
# ║  legível por anon" — 2 delas (order_feed, v_grupo_contas_receber) como        ║
# ║  suspeitas ALTAS de vazamento SEM LOGIN.                                       ║
# ║                                                                               ║
# ║  Medição na PROD (psql-ro, 2026-07-17) desmentiu a premissa: as 4 suspeitas   ║
# ║  têm `security_invoker=true` — LIGADO. O detector casava o literal            ║
# ║  `%security_invoker=on%` e classificava `=true` como "off". As "~19 views"    ║
# ║  são EXATAMENTE o bucket que gravou o literal `true` (51 gravaram `on`).      ║
# ║  É a armadilha do #1308 (reloptions preserva o LITERAL, não normaliza)        ║
# ║  mordendo de novo — desta vez no DETECTOR, não na validação pós-apply.        ║
# ║                                                                               ║
# ║  Este harness prova o elo que sustenta o veredito "não vaza", em vez de       ║
# ║  deduzi-lo do parser booleano do Postgres:                                     ║
# ║    §1  `=true` ativa o invoker de fato (idêntico a `=on`) — EXECUTANDO.       ║
# ║    §2  o detector textual `%=on%` dá falso-positivo em `=true` (a origem      ║
# ║        das 19) e um detector normalizado acerta.                              ║
# ║    §3  order_feed com a topologia REAL (FROM sales_orders direto + UNION      ║
# ║        ALL orders + LEFT JOIN profiles): anon/customer barrados, staff lê.    ║
# ║    §4  v_grupo_contas_receber REAL (FROM cliente_grupos + CTE lendo           ║
# ║        fin_contas_receber; gate fail-closed via fin_user_can_access).         ║
# ║    §5  FALSIFICAÇÃO: com `=false` o vazamento APARECE nas duas — provando     ║
# ║        que a topologia é genuinamente perigosa e que só o invoker a segura    ║
# ║        (o brief estava certo na ESTRUTURA, errado no ESTADO).                 ║
# ║                                                                               ║
# ║  Lei de Ferro:                                                                ║
# ║   1. Topologia REAL (pg_depend recursivo + pg_get_viewdef da prod), não um    ║
# ║      stub da view lendo a tabela direto — stub mente nos DOIS sentidos.       ║
# ║      As expressões de PROJEÇÃO (jsonb_array_elements, agregações) foram       ║
# ║      simplificadas de propósito: não afetam autorização. O que é reproduzido  ║
# ║      fielmente é o que decide o veredito: a relação-raiz do FROM, por qual    ║
# ║      JOIN cada tabela-RLS entra, as policies REAIS e os GRANTS REAIS.         ║
# ║   2. Assert negativo distingue 0-linhas de permission-denied; nada de         ║
# ║      WHEN OTHERS mudo.                                                         ║
# ║   3. Falsificação: sabota (=false) → exige VERMELHO → restaura.               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="invokerliteral"
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT COALESCE(nullif(current_setting('test.role', true), ''), CURRENT_USER::text) $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: reproduz o estado de PROD (medido via psql-ro 2026-07-17)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE app_role AS ENUM ('master','employee','customer');
CREATE TABLE user_roles (user_id uuid NOT NULL, role app_role NOT NULL);

CREATE FUNCTION has_role(_user_id uuid, _role app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = _user_id AND ur.role = _role)
$f$;

-- fin_permissoes + fin_user_can_access: corpo VERBATIM da prod (pg_get_functiondef).
-- É o gate que o brief julgou ausente ("nenhuma policy usa has_role/auth.uid") —
-- ele existe, só mora DENTRO da função SECDEF, não no texto da policy.
CREATE TABLE fin_permissoes (user_id uuid PRIMARY KEY, pode_ver_todas_empresas boolean, empresas text[]);
CREATE FUNCTION fin_user_can_access(check_company text DEFAULT NULL::text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_perm RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('master','employee')) THEN
    RETURN true;
  END IF;
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$function$;

-- ── Tabelas-base da cadeia de order_feed (policies VERBATIM da prod) ──────────
CREATE TABLE sales_orders (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), account text,
  omie_numero_pedido text, omie_pedido_id bigint, customer_user_id uuid,
  status text, subtotal numeric, total numeric, deleted_at timestamptz
);
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers can view their own sales orders" ON sales_orders
  FOR SELECT TO authenticated USING (auth.uid() = customer_user_id);
CREATE POLICY "Staff can manage sales orders" ON sales_orders
  FOR ALL TO authenticated USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));

CREATE TABLE orders (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), user_id uuid,
  status text, subtotal numeric, total numeric
);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own orders" ON orders
  FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "Employees can view all orders" ON orders
  FOR SELECT TO public USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));

CREATE TABLE profiles (user_id uuid PRIMARY KEY, name text);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT TO public USING (auth.uid() = user_id);
CREATE POLICY "Employees can view all profiles" ON profiles
  FOR SELECT TO public USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));

-- ── Tabelas-base de v_grupo_contas_receber (policies VERBATIM da prod) ────────
CREATE TABLE fin_contas_receber (
  id bigserial PRIMARY KEY, cnpj_cpf text, saldo numeric, data_vencimento date,
  status_titulo text, company text
);
ALTER TABLE fin_contas_receber ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_cr_select  ON fin_contas_receber FOR SELECT TO authenticated USING (fin_user_can_access(company));
CREATE POLICY fin_cr_service ON fin_contas_receber FOR ALL    TO public        USING (auth.role() = 'service_role');

CREATE TABLE cliente_grupos (id bigserial PRIMARY KEY, nome text, ativo boolean DEFAULT true);
ALTER TABLE cliente_grupos ENABLE ROW LEVEL SECURITY;
CREATE POLICY cliente_grupos_fin_access ON cliente_grupos FOR ALL TO public USING (fin_user_can_access());
CREATE POLICY cliente_grupos_service    ON cliente_grupos FOR ALL TO public USING (auth.role() = 'service_role');

CREATE TABLE cliente_grupo_membros (id bigserial PRIMARY KEY, grupo_id bigint, documento text);
ALTER TABLE cliente_grupo_membros ENABLE ROW LEVEL SECURITY;
CREATE POLICY cgm_fin_access ON cliente_grupo_membros FOR ALL TO public USING (fin_user_can_access());
CREATE POLICY cgm_service    ON cliente_grupo_membros FOR ALL TO public USING (auth.role() = 'service_role');
SQL

# ── As views, com o reloptions REAL da prod: `security_invoker=true` ───────────
# Topologia fiel ao pg_get_viewdef da prod (projeções simplificadas — não afetam autz).
P -q <<'SQL'
CREATE VIEW order_feed WITH (security_invoker = true) AS
  WITH feed AS (
    SELECT 'sales'::text AS origin, so.id, so.created_at, so.account,
           so.omie_numero_pedido AS order_number, so.omie_pedido_id,
           so.customer_user_id, so.status, so.subtotal, so.total
      FROM sales_orders so
     WHERE so.deleted_at IS NULL          -- ⚠️ FROM = tabela-RLS DIRETO
    UNION ALL
    SELECT 'afiacao'::text, o.id, o.created_at, 'colacor_sc'::text,
           NULL::text, NULL::bigint, o.user_id, o.status, o.subtotal, o.total
      FROM orders o                        -- ⚠️ FROM = tabela-RLS DIRETO
  )
  SELECT f.origin, f.id, f.created_at, f.account, f.order_number, f.omie_pedido_id,
         f.customer_user_id, p.name AS customer_name, f.status, f.subtotal, f.total
    FROM feed f
    LEFT JOIN profiles p ON p.user_id = f.customer_user_id;   -- LEFT JOIN não filtra

CREATE VIEW v_grupo_contas_receber WITH (security_invoker = true) AS
  WITH tit AS (
    SELECT regexp_replace(fcr.cnpj_cpf, '\D', '', 'g') AS doc, fcr.saldo, fcr.data_vencimento
      FROM fin_contas_receber fcr
     WHERE fcr.status_titulo <> ALL (ARRAY['RECEBIDO'::text,'CANCELADO'::text])  -- sem gate de identidade no corpo
  )
  SELECT g.id AS grupo_id, g.nome,
         count(DISTINCT m.documento) FILTER (WHERE t.doc IS NOT NULL) AS documentos_com_titulo,
         COALESCE(sum(t.saldo), 0::numeric) AS total_aberto
    FROM cliente_grupos g                                   -- FROM = tabela-RLS
    JOIN cliente_grupo_membros m ON m.grupo_id = g.id
    LEFT JOIN tit t ON t.doc = m.documento                  -- LEFT JOIN no CTE que lê fin_contas_receber
   WHERE g.ativo = true
   GROUP BY g.id, g.nome;

-- GRANTS FIÉIS À PROD (medidos): as views são anon-readable; nas tabelas-base o
-- anon TEM grant — quem barra é o RLS — EXCETO sales_orders (anon_grant=false).
GRANT SELECT ON order_feed, v_grupo_contas_receber TO anon, authenticated;
GRANT SELECT ON orders, profiles                   TO anon, authenticated;
GRANT SELECT ON sales_orders                       TO authenticated;   -- anon SEM grant (fiel à prod)
GRANT SELECT ON fin_contas_receber, cliente_grupos, cliente_grupo_membros TO anon, authenticated;
GRANT SELECT ON user_roles, fin_permissoes         TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public           TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public        TO service_role;

INSERT INTO user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','customer'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');
SQL

# seed do dado sensível (service_role tem BYPASSRLS)
P -q <<'SQL'
SET ROLE service_role;
INSERT INTO sales_orders(account, omie_numero_pedido, customer_user_id, status, subtotal, total)
VALUES ('oben','P-001','11111111-1111-1111-1111-111111111111','faturado',100,110),
       ('oben','P-002','33333333-3333-3333-3333-333333333333','faturado',200,220);
INSERT INTO orders(user_id, status, subtotal, total)
VALUES ('11111111-1111-1111-1111-111111111111','concluido',50,55);
INSERT INTO profiles(user_id, name) VALUES
  ('11111111-1111-1111-1111-111111111111','CLIENTE UM LTDA'),
  ('33333333-3333-3333-3333-333333333333','CLIENTE TRES LTDA');
INSERT INTO cliente_grupos(nome, ativo) VALUES ('GRUPO CONFIDENCIAL', true);
INSERT INTO cliente_grupo_membros(grupo_id, documento) VALUES (1,'11222333000144');
INSERT INTO fin_contas_receber(cnpj_cpf, saldo, data_vencimento, status_titulo, company)
VALUES ('11.222.333/0001-44', 9999.99, CURRENT_DATE + 10, 'A VENCER', 'oben');
RESET ROLE;
SQL

# Helper de impersonação.
# ⚠️ SET LOCAL só vale dentro de transação — fora dela vira WARNING e a sessão SEGUE
# superuser (o teste pintaria verde medindo o postgres). Daí o BEGIN/COMMIT.
# Distingue 0-linhas de permission-denied: com invoker=on + sem grant na base, o
# Postgres NEGA a query inteira (42501) em vez de devolver 0 — é um resultado
# diferente, e um assert que os confunde não prova o que diz provar.
_conta() {  # $1 = SQL de identidade, $2 = relação
  local out
  out="$(P -tAq <<SQL 2>&1 || true
BEGIN;
$1
SELECT count(*) FROM $2;
COMMIT;
SQL
)"
  if echo "$out" | grep -qi 'permission denied'; then echo "DENIED"; return; fi
  echo "$out" | grep -E '^[0-9]+$' | tail -1
}
como_customer() { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';" "$1"; }
como_staff()    { _conta "SET LOCAL ROLE authenticated; SET LOCAL test.role='authenticated'; SET LOCAL test.uid = '22222222-2222-2222-2222-222222222222';" "$1"; }
como_anon()     { _conta "SET LOCAL ROLE anon; SET LOCAL test.role='anon';" "$1"; }

echo ""
echo '═══ 1. O ELO CENTRAL: security_invoker=true ATIVA o invoker (não deduzir — executar) ═══'
# Se este bloco falhar, as ~19 views do bucket `=true` estão TODAS vazando e o
# veredito deste harness se inverte. É a asserção da qual todo o resto depende.
eq "o literal gravado é mesmo 'true' (não normaliza p/ 'on' — armadilha #1308)" \
   "$(Pq -c "SELECT split_part(o,'=',2) FROM pg_class c, unnest(c.reloptions) o WHERE c.relname='order_feed' AND o LIKE 'security_invoker%';")" "true"
P -q <<'SQL'
CREATE TABLE _lit_base (id int, segredo text);
ALTER TABLE _lit_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY _lit_staff ON _lit_base FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'employee') OR has_role(auth.uid(),'master'));
CREATE VIEW _lit_true  WITH (security_invoker = true) AS SELECT * FROM _lit_base;
CREATE VIEW _lit_on    WITH (security_invoker = on)   AS SELECT * FROM _lit_base;
CREATE VIEW _lit_false WITH (security_invoker = false) AS SELECT * FROM _lit_base;
GRANT SELECT ON _lit_base, _lit_true, _lit_on, _lit_false TO authenticated, anon;
INSERT INTO _lit_base VALUES (1,'CUSTO INTERNO');
SQL
eq "view '=true':  customer NÃO lê  → invoker ATIVO"        "$(como_customer _lit_true)"  "0"
eq "view '=on':    customer NÃO lê  → invoker ATIVO"        "$(como_customer _lit_on)"    "0"
eq "view '=true':  staff LÊ         → não quebrou ninguém"  "$(como_staff _lit_true)"     "1"
eq "view '=on':    staff LÊ         → paridade com '=true'" "$(como_staff _lit_on)"       "1"
# contraprova: o literal que REALMENTE desliga
eq "view '=false':  customer LÊ  → ESTE sim é o off (contraprova)" "$(como_customer _lit_false)" "1"

echo ""
echo "═══ 2. A ORIGEM DAS ~19: o detector textual '%=on%' mente em '=true' ═══"
# Reproduz o bug do detector que gerou o relatório de '~19 views invoker=off'.
eq "detector TEXTUAL '%security_invoker=on%' classifica '=true' como OFF (falso-positivo)" \
   "$(Pq -c "SELECT (NOT (reloptions::text ILIKE '%security_invoker=on%'))::text FROM pg_class WHERE relname='_lit_true';")" "true"
eq "detector NORMALIZADO (parse booleano) classifica '=true' como LIGADO (correto)" \
   "$(Pq -c "SELECT (lower(COALESCE((SELECT split_part(o,'=',2) FROM pg_class c2, unnest(c2.reloptions) o WHERE c2.relname='_lit_true' AND o LIKE 'security_invoker%'),'off')) IN ('on','true','1','yes'))::text;")" "true"

echo ""
echo "═══ 3. order_feed REAL (FROM sales_orders direto + UNION ALL orders + LEFT JOIN profiles) ═══"
eq "anon NÃO lê order_feed SEM LOGIN"                 "$(como_anon order_feed)"     "DENIED"
eq "customer vê SÓ os pedidos DELE (1 sales + 1 order)" "$(como_customer order_feed)" "2"
eq "staff vê o feed inteiro (2 sales + 1 order)"      "$(como_staff order_feed)"    "3"

echo ""
echo "═══ 4. v_grupo_contas_receber REAL (gate fail-closed via fin_user_can_access) ═══"
eq "anon NÃO lê v_grupo_contas_receber SEM LOGIN"   "$(como_anon v_grupo_contas_receber)"     "0"
eq "customer (sem fin_permissoes) NÃO lê"           "$(como_customer v_grupo_contas_receber)" "0"
eq "staff (employee) LÊ o grupo"                    "$(como_staff v_grupo_contas_receber)"    "1"
eq "fin_user_can_access é FAIL-CLOSED p/ anon (auth.uid() IS NULL)" \
   "$(_conta "SET LOCAL ROLE anon; SET LOCAL test.role='anon';" "(SELECT 1 WHERE fin_user_can_access('oben')) x")" "0"

echo ""
echo "═══ 5. FALSIFICAÇÃO (Lei #3) — sabota o invoker e EXIGE o vazamento ═══"
# Se estes NÃO ficarem vermelhos, o cenário não tem dente: os zeros de §3/§4
# seriam acaso do seed, não efeito do invoker — e o harness inteiro seria teatro.
P -q -c "ALTER VIEW public.order_feed SET (security_invoker = false);"
n="$(como_anon order_feed)"
if [ "$n" = "3" ]; then
  ok "FALSIFICAÇÃO A: com invoker=false o anon lê o feed INTEIRO (=$n) sem login — a topologia É perigosa; só o invoker a segura"
else
  bad "FALSIFICAÇÃO A: sabotei o invoker e o anon NÃO vazou (=$n) — o assert de §3 não prova o invoker"
fi
P -q -c "ALTER VIEW public.order_feed SET (security_invoker = true);"
eq "restaurado após falsificação A" "$(como_anon order_feed)" "DENIED"

P -q -c "ALTER VIEW public.v_grupo_contas_receber SET (security_invoker = false);"
n="$(como_anon v_grupo_contas_receber)"
if [ "$n" = "1" ]; then
  ok "FALSIFICAÇÃO B: com invoker=false o anon lê o grupo (=$n) sem login — o gate real é o invoker+RLS"
else
  bad "FALSIFICAÇÃO B: sabotei o invoker e o anon NÃO vazou (=$n) — o assert de §4 não prova o invoker"
fi
P -q -c "ALTER VIEW public.v_grupo_contas_receber SET (security_invoker = true);"
eq "restaurado após falsificação B" "$(como_anon v_grupo_contas_receber)" "0"

# Falsificação C: o customer também precisa ter dente no order_feed — se a policy
# own-scope sumir, ele para de ver os próprios pedidos (prova que é o RLS que decide).
P -q -c "DROP POLICY \"Customers can view their own sales orders\" ON sales_orders;"
n="$(como_customer order_feed)"
if [ "$n" = "2" ]; then
  bad "FALSIFICAÇÃO C: dropei a policy own-scope e o customer seguiu vendo 2 — o assert não prova RLS"
else
  ok "FALSIFICAÇÃO C: sem a policy own-scope o customer cai p/ =$n — quem autoriza é o RLS, não o acaso do seed"
fi
P -q -c "CREATE POLICY \"Customers can view their own sales orders\" ON sales_orders FOR SELECT TO authenticated USING (auth.uid() = customer_user_id);"
eq "restaurado após falsificação C" "$(como_customer order_feed)" "2"

echo ""
echo "═══════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
