#!/usr/bin/env bash
# Prova PG17 do PR-4 (migration 20260713040000_whatsapp_proposta_cotacao):
# - aplica as 4 migrations do programa EM ORDEM (010000 → 020000 → 030000 → 040000) —
#   a mesma ordem do deploy manual do founder;
# - asserts da recotação: praticado VÁLIDO mais recente vence tabela; praticado inválido
#   (0) ignorado → cai pra tabela; tabela 0 → preco NULL (ausente ≠ zero, NUNCA fabrica);
#   NaN não vaza como preço (em numeric NaN > 0 é TRUE — o guard explícito tem de morder);
#   estoque NULL retorna NULL (desconhecido ≠ 0); inativo/conta errada/SKU inexistente;
# - RLS sob SET ROLE: não-staff NÃO enxerga o praticado de terceiro (cai pra tabela);
#   anon 42501;
# - FALSIFICAÇÃO A: RPC sabotada com COALESCE(preco, 0) → assert do NULL TEM de ficar
#   vermelho (zero fabricado é o risco de negócio nº1 do money-path);
# - FALSIFICAÇÃO B: RPC sabotada SEM o guard de NaN no praticado → assert do NaN vermelho.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5446
DATA="$(mktemp -d /tmp/pgtest-waprop.XXXXXX)/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-waprop.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres waprop_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d waprop_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-waprop.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ grants de prod + auth.uid() fiel…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
SQL

echo "→ migrations do programa EM ORDEM (010000 → 020000 → 030000 → 040000)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713010000_whatsapp_templates_hsm.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713020000_whatsapp_pendentes_rpc.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713030000_whatsapp_funil.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713040000_whatsapp_proposta_cotacao.sql" >/dev/null

echo "→ seed (staff, cliente com histórico, outro cliente; catálogo com casos de borda)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1'),  -- staff (employee)
  ('00000000-0000-0000-0000-0000000bbbb2'),  -- outro cliente (não-staff)
  ('00000000-0000-0000-0000-0000000cccc3')   -- cliente da proposta
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1', 'employee');

-- catálogo oben: cada SKU um caso de borda
INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, unidade, valor_unitario, estoque, ativo, account) VALUES
  ('00000000-0000-0000-0000-00000000a101', 101, 'C101', 'LIXA A275',      'UN', 99,      100,  true,  'oben'),
  ('00000000-0000-0000-0000-00000000a102', 102, 'C102', 'THINNER 4403',   'UN', 45,      100,  true,  'oben'),
  ('00000000-0000-0000-0000-00000000a103', 103, 'C103', 'SEM TABELA',     'UN', 0,       100,  true,  'oben'),
  ('00000000-0000-0000-0000-00000000a104', 104, 'C104', 'TABELA NAN',     'UN', 'NaN',   100,  true,  'oben'),
  ('00000000-0000-0000-0000-00000000a105', 105, 'C105', 'ESTOQUE NULL',   'UN', 20,      NULL, true,  'oben'),
  ('00000000-0000-0000-0000-00000000a106', 106, 'C106', 'INATIVO',        'UN', 30,      100,  false, 'oben'),
  ('00000000-0000-0000-0000-00000000a107', 107, 'C107', 'OUTRA CONTA',    'UN', 10,      100,  true,  'colacor');

-- pedidos-pai (order_items exige sales_order_id)
INSERT INTO public.sales_orders (id, customer_user_id, created_by, total, status, created_at) VALUES
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000cccc3', '00000000-0000-0000-0000-0000000aaaa1', 100, 'confirmado', now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000cccc3', '00000000-0000-0000-0000-0000000aaaa1', 100, 'confirmado', now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000bbbb2', '00000000-0000-0000-0000-0000000aaaa1', 100, 'confirmado', now() - interval '1 day');

-- praticados do cccc3: 101 antigo 8.00 / recente 10.50 (recente vence);
-- 102 praticado 0 (INVÁLIDO → ignora); 104 praticado NaN (INVÁLIDO → ignora)
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, created_at) VALUES
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000cccc3', 101, 1, 8.00,  now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000cccc3', 101, 1, 10.50, now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000cccc3', 102, 1, 0,     now() - interval '1 day'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000cccc3', 104, 1, 'NaN', now() - interval '1 day');

-- praticado de OUTRO cliente (bbbb2) no MESMO SKU 101 — não pode contaminar o cccc3
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, created_at) VALUES
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000bbbb2', 101, 1, 7.77, now() - interval '1 hour');
SQL

echo "→ asserts da recotação sob SET ROLE authenticated (staff)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; n int; BEGIN
  -- 101: praticado recente (10.50) vence antigo (8.00), tabela (99) e o praticado de OUTRO cliente (7.77)
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[101]::bigint[]);
  IF r.preco IS DISTINCT FROM 10.50 OR r.fonte_preco IS DISTINCT FROM 'praticado'
    THEN RAISE EXCEPTION 'FALHA 101: esperava 10.50/praticado, veio %/%', r.preco, r.fonte_preco; END IF;

  -- 102: praticado 0 é INVÁLIDO → tabela 45
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[102]::bigint[]);
  IF r.preco IS DISTINCT FROM 45 OR r.fonte_preco IS DISTINCT FROM 'tabela'
    THEN RAISE EXCEPTION 'FALHA 102: praticado 0 tinha de ser ignorado (tabela 45), veio %/%', r.preco, r.fonte_preco; END IF;

  -- 103: tabela 0 → preco NULL (ausente ≠ zero — NUNCA fabricar)
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[103]::bigint[]);
  IF r.preco IS NOT NULL OR r.fonte_preco IS NOT NULL
    THEN RAISE EXCEPTION 'FALHA 103: esperava NULL/NULL (ausente≠zero), veio %/%', r.preco, r.fonte_preco; END IF;

  -- 104: NaN nem como praticado nem como tabela (numeric: NaN > 0 é TRUE — guard tem de morder)
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[104]::bigint[]);
  IF r.preco IS NOT NULL
    THEN RAISE EXCEPTION 'FALHA 104: NaN vazou como preço (%)', r.preco; END IF;

  -- 105: estoque NULL = desconhecido (≠ 0) — retorna NULL fielmente
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[105]::bigint[]);
  IF r.estoque IS NOT NULL OR r.preco IS DISTINCT FROM 20
    THEN RAISE EXCEPTION 'FALHA 105: esperava estoque NULL + preco 20, veio %/%', r.estoque, r.preco; END IF;

  -- 106: inativo retorna ativo=false (a trava é do consumidor)
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[106]::bigint[]);
  IF r.ativo THEN RAISE EXCEPTION 'FALHA 106: esperava ativo=false'; END IF;

  -- 107 (conta colacor) e 108 (inexistente) não retornam linha na consulta por oben
  SELECT count(*) INTO n FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[101,102,103,104,105,106,107,108]::bigint[]);
  IF n <> 6 THEN RAISE EXCEPTION 'FALHA catálogo: esperava 6 linhas (101–106), veio %', n; END IF;

  -- consulta pela conta colacor acha o 107
  SELECT count(*) INTO n FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'colacor', ARRAY[101,107]::bigint[]);
  IF n <> 1 THEN RAISE EXCEPTION 'FALHA conta colacor: esperava 1 linha (107), veio %', n; END IF;
END $$;
ROLLBACK;

-- RLS: bbbb2 (não-staff) consulta o cccc3 → order_items de terceiro INVISÍVEL ⇒ o
-- praticado 10.50 NÃO vaza; cai pra tabela 99 (catálogo é visível a authenticated)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000bbbb2","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[101]::bigint[]);
  IF r.fonte_preco IS DISTINCT FROM 'tabela' OR r.preco IS DISTINCT FROM 99
    THEN RAISE EXCEPTION 'FALHA RLS: praticado de terceiro vazou pra não-staff (%/%)', r.preco, r.fonte_preco; END IF;
END $$;
ROLLBACK;

-- anon: EXECUTE revogado por nome → 42501
BEGIN;
SET LOCAL ROLE anon;
DO $$ DECLARE x numeric; BEGIN
  SELECT preco INTO x FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[101]::bigint[]);
  RAISE EXCEPTION 'FALHA: anon EXECUTOU a RPC de recotação';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: anon negado 42501'; END $$;
ROLLBACK;
SQL

echo "→ FALSIFICAÇÃO A: RPC sabotada com COALESCE(preco, 0) → assert do NULL TEM de ficar vermelho…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(
  p_customer_user_id uuid, p_account text, p_skus bigint[]
)
RETURNS TABLE (omie_codigo_produto bigint, product_id uuid, codigo text, descricao text,
               unidade text, ativo boolean, estoque numeric, preco numeric, fonte_preco text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT p.omie_codigo_produto, p.id, p.codigo, p.descricao, p.unidade, p.ativo, p.estoque,
         COALESCE(NULLIF(p.valor_unitario, 0), 0) AS preco,  -- SABOTADO: fabrica 0
         'tabela'::text AS fonte_preco
    FROM public.omie_products p
   WHERE p.account = p_account AND p.omie_codigo_produto = ANY(p_skus);
$$;
SQL
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[103]::bigint[]);
  IF r.preco IS NOT NULL THEN RAISE EXCEPTION 'sabotagem detectada (preco=%)', r.preco; END IF;
END $$;
ROLLBACK;
SQL
then
  echo "✗ FALSIFICAÇÃO A FALHOU: RPC que fabrica 0 passou no assert do NULL"; exit 1
else
  echo "ok: zero fabricado deixa o assert vermelho — ausente≠zero morde"
fi

echo "→ FALSIFICAÇÃO B: RPC sabotada SEM o guard de NaN (predicado ingênuo > 0) → assert do NaN vermelho…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(
  p_customer_user_id uuid, p_account text, p_skus bigint[]
)
RETURNS TABLE (omie_codigo_produto bigint, product_id uuid, codigo text, descricao text,
               unidade text, ativo boolean, estoque numeric, preco numeric, fonte_preco text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH praticado AS (
    SELECT DISTINCT ON (oi.omie_codigo_produto) oi.omie_codigo_produto, oi.unit_price
      FROM public.order_items oi
     WHERE oi.customer_user_id = p_customer_user_id
       AND oi.omie_codigo_produto = ANY(p_skus)
       AND oi.unit_price > 0                       -- SABOTADO: NaN > 0 é TRUE em numeric
     ORDER BY oi.omie_codigo_produto, oi.created_at DESC NULLS LAST, oi.id DESC
  )
  SELECT p.omie_codigo_produto, p.id, p.codigo, p.descricao, p.unidade, p.ativo, p.estoque,
         pr.unit_price AS preco,
         CASE WHEN pr.unit_price IS NOT NULL THEN 'praticado' END AS fonte_preco
    FROM public.omie_products p
    LEFT JOIN praticado pr ON pr.omie_codigo_produto = p.omie_codigo_produto
   WHERE p.account = p_account AND p.omie_codigo_produto = ANY(p_skus);
$$;
SQL
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[104]::bigint[]);
  IF r.preco IS NOT NULL THEN RAISE EXCEPTION 'sabotagem detectada (preco=%)', r.preco; END IF;
END $$;
ROLLBACK;
SQL
then
  echo "✗ FALSIFICAÇÃO B FALHOU: sem o guard de NaN o assert continuou verde"; exit 1
else
  echo "ok: sem o guard de NaN o assert fica vermelho — 'NaN > 0 é TRUE' está coberto"
fi

echo "→ restaura a migration real e re-prova o caminho feliz…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713040000_whatsapp_proposta_cotacao.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_proposta_cotacao(
    '00000000-0000-0000-0000-0000000cccc3', 'oben', ARRAY[101]::bigint[]);
  IF r.preco IS DISTINCT FROM 10.50 THEN RAISE EXCEPTION 'FALHA pós-restauração: %', r.preco; END IF;
END $$;
ROLLBACK;
SQL

echo "✅ prova PG17 do PR-4 recotação: verde (praticado▸tabela▸NULL, NaN/0 barrados, RLS, anon, 2 falsificações)"
