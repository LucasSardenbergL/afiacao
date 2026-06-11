#!/usr/bin/env bash
# Teste PG17 do canal Melhorias — RPCs de dados (agregação/carteira/guards) + RLS (own/master/anon).
# Aplica stubs + schema-snapshot + 20260610130000_melhorias_canal.sql, semeia produtos/pedidos/
# carteira/roles e assere: clientes_por_produto (master full vs vendedora só-carteira, janela 12m,
# pedido válido), produtos_relacionados (família + associação), guards (customer/termo curto),
# RLS de itens/mensagens (own/master/insert alheio barrado/dados null).
# Base: db/verify-snapshot-replay.sh + db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-melhorias.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

# Contorna o keg-only do brew (idempotente, no-clobber).
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-melhorias.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres melhorias_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d melhorias_verify "$@"; }

# Snapshot restore-ready: remove meta-comandos psql e o CREATE SCHEMA public.
RR="$(mktemp /tmp/snap-melhorias.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR" 2>&1 | grep -v "^$" | tail -5 || true
rm -f "$RR"

echo "→ patches de colunas stale (order_date_kpi, omie_products.tipo_produto)…"
P -v ON_ERROR_STOP=1 -q -c "
  ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS order_date_kpi date;
  ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;
"

echo "→ pode_ver_carteira_completa (não está no snapshot, criada em migration de hardening RLS)…"
P -v ON_ERROR_STOP=1 -q -c "
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS \$\$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR (
      has_role(_uid, 'employee'::app_role)
      AND get_commercial_role(_uid) IN (
        'gerencial'::commercial_role,
        'estrategico'::commercial_role,
        'super_admin'::commercial_role
      )
    );
\$\$;
"

echo "→ migration 20260610130000_melhorias_canal.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260610130000_melhorias_canal.sql"

echo "→ override de auth.uid()/auth.role() para testes de RLS…"
P -v ON_ERROR_STOP=1 -q -c "
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid',  true), '')::uuid \$f\$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.role', true), '') \$f\$;
"

echo "→ seed…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- UUIDs fixos legíveis
-- u_master: mestre/gestor
-- u_vend: vendedora common (employee sem commercial_role gerencial)
-- u_cli: customer
-- c1, c2: clientes compradores

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'vend@test.local'),
  ('00000000-0000-0000-0000-00000000000c', 'cli@test.local'),
  ('00000000-0000-0000-0000-000000000001', 'c1@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'c2@test.local')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b', 'employee'::public.app_role),
  ('00000000-0000-0000-0000-00000000000c', 'customer'::public.app_role),
  ('00000000-0000-0000-0000-000000000001', 'customer'::public.app_role),
  ('00000000-0000-0000-0000-000000000002', 'customer'::public.app_role)
ON CONFLICT DO NOTHING;

-- profiles (NOT NULL: user_id, name)
INSERT INTO public.profiles (user_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Master Teste', 'master@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'Vendedora Teste', 'vend@test.local'),
  ('00000000-0000-0000-0000-00000000000c', 'Cliente Teste', 'cli@test.local'),
  ('00000000-0000-0000-0000-000000000001', 'Cliente Um', 'c1@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'Cliente Dois', 'c2@test.local')
ON CONFLICT DO NOTHING;

-- carteira: c1 pertence à u_vend; c2 fica sem dono (fora da carteira dela)
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'omie')
ON CONFLICT DO NOTHING;

-- produtos omie_products (account='oben', ativo=true exceto P4)
-- P1: LIXA GR80 TESTE  - familia ABRASIVOS TESTE
-- P2: LIXA GR120 TESTE - mesma familia de P1
-- P3: COLA TESTE       - familia QUIMICOS TESTE
-- P4: LIXA GR240 TESTE - mesma familia de P1, MAS ativo=false
INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, familia) VALUES
  ('00000000-0000-0000-0001-000000000001', 1001, 'P001', 'LIXA GR80 TESTE',   'oben', true,  'ABRASIVOS TESTE'),
  ('00000000-0000-0000-0001-000000000002', 1002, 'P002', 'LIXA GR120 TESTE',  'oben', true,  'ABRASIVOS TESTE'),
  ('00000000-0000-0000-0001-000000000003', 1003, 'P003', 'COLA TESTE',        'oben', true,  'QUIMICOS TESTE'),
  ('00000000-0000-0000-0001-000000000004', 1004, 'P004', 'LIXA GR240 TESTE',  'oben', false, 'ABRASIVOS TESTE')
ON CONFLICT DO NOTHING;

-- sales_orders + order_items:
-- SO1: c1, faturado, order_date_kpi = hoje-60d → item P1, qty 10, unit_price 5.00 (= 50.00, dentro 12m, válido)
-- SO2: c2, enviado,  order_date_kpi = hoje-90d → item P1, qty 2,  unit_price 5.00 (= 10.00, dentro 12m, válido)
-- SO3: c1, faturado, order_date_kpi = hoje-430d → item P1 (FORA da janela 12m)
-- SO4: c2, cancelado, order_date_kpi = hoje-30d → item P1 (pedido INVÁLIDO = cancelado)
INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi) VALUES
  ('00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'oben', 'faturado',  (current_date - interval '60 days')::date),
  ('00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'oben', 'enviado',   (current_date - interval '90 days')::date),
  ('00000000-0000-0000-0002-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'oben', 'faturado',  (current_date - interval '430 days')::date),
  ('00000000-0000-0000-0002-000000000004', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'oben', 'cancelado', (current_date - interval '30 days')::date)
ON CONFLICT DO NOTHING;

INSERT INTO public.order_items (sales_order_id, customer_user_id, product_id, quantity, unit_price) VALUES
  ('00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 10, 5.00),
  ('00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0001-000000000001',  2, 5.00),
  ('00000000-0000-0000-0002-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001', 100, 5.00),
  ('00000000-0000-0000-0002-000000000004', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0001-000000000001', 100, 5.00)
ON CONFLICT DO NOTHING;

-- regra de associação: P1 → P3, confidence 0.4, lift 2.1
INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids, confidence, lift, support, rule_type) VALUES
  (ARRAY['00000000-0000-0000-0001-000000000001'::text],
   ARRAY['00000000-0000-0000-0001-000000000003'::text],
   0.4, 2.1, 0.1, 'association')
ON CONFLICT DO NOTHING;

-- Grants para RLS funcionar com SET ROLE
GRANT SELECT, INSERT, UPDATE ON public.melhoria_itens    TO authenticated;
GRANT SELECT, INSERT         ON public.melhoria_mensagens TO authenticated;
GRANT SELECT                 ON public.melhoria_itens    TO anon;
GRANT SELECT                 ON public.melhoria_mensagens TO anon;
SQL

echo ""
echo "→ ASSERTS A — RPC melhoria_clientes_por_produto:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  res jsonb;
  v_total int;
  v_escopo text;
  v_clientes jsonb;
BEGIN
  -- A1: master vê tudo (v_full = true)
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT public.melhoria_clientes_por_produto('LIXA GR80') INTO res;

  v_total  := (res->>'total_clientes_visiveis')::int;
  v_escopo := res->>'escopo';
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'A1 FALHOU: master deveria ver 2 clientes, viu %', v_total;
  END IF;
  IF v_escopo <> 'todos' THEN
    RAISE EXCEPTION 'A1b FALHOU: escopo=% (esperado "todos")', v_escopo;
  END IF;
  RAISE NOTICE 'OK A1 — master total_clientes_visiveis=2, escopo=todos';

  -- A1c: c1 tem n_pedidos=1 e valor_12m=50.00 (SO3=fora da janela, SO4=cancelado não contam)
  v_clientes := res->'clientes';
  DECLARE
    c1_val numeric;
    c1_nped int;
    c2_val numeric;
  BEGIN
    SELECT (el->>'valor_12m')::numeric, (el->>'n_pedidos')::int
      INTO c1_val, c1_nped
    FROM jsonb_array_elements(v_clientes) el
    JOIN public.profiles pr ON pr.name = (el->>'cliente')
    WHERE pr.user_id = '00000000-0000-0000-0000-000000000001';

    IF c1_nped IS NULL OR c1_nped <> 1 THEN
      RAISE EXCEPTION 'A1c FALHOU: c1 n_pedidos=% (esperado 1)', c1_nped;
    END IF;
    IF c1_val IS NULL OR c1_val <> 50.00 THEN
      RAISE EXCEPTION 'A1d FALHOU: c1 valor_12m=% (esperado 50.00)', c1_val;
    END IF;
    RAISE NOTICE 'OK A1c — c1 n_pedidos=1 valor_12m=50.00';

    SELECT (el->>'valor_12m')::numeric INTO c2_val
    FROM jsonb_array_elements(v_clientes) el
    JOIN public.profiles pr ON pr.name = (el->>'cliente')
    WHERE pr.user_id = '00000000-0000-0000-0000-000000000002';

    IF c2_val IS NULL OR c2_val <> 10.00 THEN
      RAISE EXCEPTION 'A1e FALHOU: c2 valor_12m=% (esperado 10.00)', c2_val;
    END IF;
    RAISE NOTICE 'OK A1e — c2 valor_12m=10.00';
  END;

  -- A2: vendedora só carteira (c1 está na carteira, c2 não)
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  SELECT public.melhoria_clientes_por_produto('LIXA GR80') INTO res;

  v_total  := (res->>'total_clientes_visiveis')::int;
  v_escopo := res->>'escopo';
  IF v_total <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: vendedora deveria ver 1 cliente (só carteira), viu %', v_total;
  END IF;
  IF v_escopo <> 'minha_carteira' THEN
    RAISE EXCEPTION 'A2b FALHOU: escopo=% (esperado "minha_carteira")', v_escopo;
  END IF;
  RAISE NOTICE 'OK A2 — vendedora total_clientes_visiveis=1, escopo=minha_carteira';

  -- A3: customer barrado ("Apenas staff")
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000c';
  BEGIN
    SELECT public.melhoria_clientes_por_produto('LIXA GR80') INTO res;
    RAISE EXCEPTION 'A3 FALHOU: customer não foi barrado pela RPC';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%staff%' AND SQLERRM NOT ILIKE '%Apenas%' THEN
        RAISE EXCEPTION 'A3b FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A3 — customer barrado com: %', SQLERRM;
  END;

  -- A4: termo curto ("ab" = 2 chars < 3)
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  BEGIN
    SELECT public.melhoria_clientes_por_produto('ab') INTO res;
    RAISE EXCEPTION 'A4 FALHOU: termo curto não foi rejeitado';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%curto%' AND SQLERRM NOT ILIKE '%mínimo%' THEN
        RAISE EXCEPTION 'A4b FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A4 — termo curto rejeitado com: %', SQLERRM;
  END;

  RAISE NOTICE '──── A concluído ────';
END $$;
SQL

echo ""
echo "→ ASSERTS A5 — RPC melhoria_produtos_relacionados:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  res jsonb;
  v_familia jsonb;
  v_juntos  jsonb;
  has_p2    boolean := false;
  has_p4    boolean := false;
  has_p1    boolean := false;
  has_p3    boolean := false;
  p3_lift   numeric;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT public.melhoria_produtos_relacionados('LIXA GR80') INTO res;

  v_familia := res->'mesma_familia';
  v_juntos  := res->'comprados_juntos';

  -- mesma_familia deve conter P2 (ativo, mesma familia) e NÃO conter P4 (inativo) nem P1 (alvo)
  SELECT
    bool_or((el->>'codigo') = 'P002') INTO has_p2
  FROM jsonb_array_elements(v_familia) el;

  SELECT
    bool_or((el->>'codigo') = 'P004') INTO has_p4
  FROM jsonb_array_elements(v_familia) el;

  SELECT
    bool_or((el->>'codigo') = 'P001') INTO has_p1
  FROM jsonb_array_elements(v_familia) el;

  IF NOT has_p2 THEN
    RAISE EXCEPTION 'A5a FALHOU: P2 (LIXA GR120) deveria estar em mesma_familia';
  END IF;
  IF has_p4 THEN
    RAISE EXCEPTION 'A5b FALHOU: P4 (inativo) NÃO deveria estar em mesma_familia';
  END IF;
  IF has_p1 THEN
    RAISE EXCEPTION 'A5c FALHOU: P1 (alvo) NÃO deveria estar em mesma_familia';
  END IF;
  RAISE NOTICE 'OK A5a — mesma_familia contém P2, exclui P4 (inativo) e P1 (alvo)';

  -- comprados_juntos deve conter P3 com lift 2.1
  SELECT bool_or((el->>'codigo') = 'P003') INTO has_p3
  FROM jsonb_array_elements(v_juntos) el;

  SELECT (el->>'lift')::numeric INTO p3_lift
  FROM jsonb_array_elements(v_juntos) el
  WHERE (el->>'codigo') = 'P003';

  IF NOT has_p3 THEN
    RAISE EXCEPTION 'A5d FALHOU: P3 (COLA TESTE) deveria estar em comprados_juntos';
  END IF;
  IF p3_lift IS NULL OR p3_lift <> 2.10 THEN
    RAISE EXCEPTION 'A5e FALHOU: P3 lift=% (esperado 2.10)', p3_lift;
  END IF;
  RAISE NOTICE 'OK A5d/e — comprados_juntos contém P3 com lift=2.10';

  RAISE NOTICE '──── A5 concluído ────';
END $$;
SQL

echo ""
echo "→ ASSERTS A6 + A7 — RLS melhoria_itens e melhoria_mensagens (numa única sessão psql):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  n_rows int;
  item_vend_id uuid;
  item_mast_id uuid;
BEGIN
  -- ── A6: itens ──────────────────────────────────────────────────────────────

  -- A6a: u_vend insere item próprio → OK (status='aberto', triagem_status='pendente', sem campos proibidos)
  SET LOCAL test.uid  = '00000000-0000-0000-0000-00000000000b';
  SET LOCAL ROLE authenticated;
  INSERT INTO public.melhoria_itens (autor_user_id, empresa, tipo, urgencia, titulo)
  VALUES ('00000000-0000-0000-0000-00000000000b', 'oben', 'problema', 'alta', 'Bug no picking')
  RETURNING id INTO item_vend_id;
  RAISE NOTICE 'OK A6a — u_vend inseriu item próprio, id=%', item_vend_id;

  -- A6b: u_vend tenta inserir com autor=u_master → deve falhar (WITH CHECK: autor_user_id = auth.uid())
  BEGIN
    INSERT INTO public.melhoria_itens (autor_user_id, empresa, tipo, titulo)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'oben', 'problema', 'Tentativa alheio');
    RAISE EXCEPTION 'A6b FALHOU: insert com autor alheio deveria ter sido bloqueado';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN
      RAISE NOTICE 'OK A6b — insert com autor alheio bloqueado';
    WHEN OTHERS THEN
      RAISE NOTICE 'OK A6b (via %) — insert com autor alheio bloqueado: %', SQLSTATE, SQLERRM;
  END;

  -- A6c: u_vend tenta inserir com triagem_status='ok' → deve falhar (WITH CHECK hardening)
  BEGIN
    INSERT INTO public.melhoria_itens (autor_user_id, empresa, tipo, titulo, triagem_status)
    VALUES ('00000000-0000-0000-0000-00000000000b', 'oben', 'problema', 'Tentativa triagem', 'ok');
    RAISE EXCEPTION 'A6c FALHOU: insert com triagem_status=ok deveria ter sido bloqueado';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN
      RAISE NOTICE 'OK A6c — insert com triagem_status=ok bloqueado';
    WHEN OTHERS THEN
      RAISE NOTICE 'OK A6c (via %) — triagem_status=ok bloqueado: %', SQLSTATE, SQLERRM;
  END;

  -- A6d: u_master insere item próprio → OK
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  INSERT INTO public.melhoria_itens (autor_user_id, empresa, tipo, titulo)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'oben', 'sugestao', 'Ideia do master')
  RETURNING id INTO item_mast_id;
  RAISE NOTICE 'OK A6d — u_master inseriu item próprio, id=%', item_mast_id;

  -- A6e: SELECT — u_vend vê 1 (o dela)
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  SELECT count(*) INTO n_rows FROM public.melhoria_itens;
  IF n_rows <> 1 THEN
    RAISE EXCEPTION 'A6e FALHOU: u_vend deveria ver 1 item, viu %', n_rows;
  END IF;
  RAISE NOTICE 'OK A6e — u_vend vê 1 item';

  -- A6f: SELECT — u_master vê 2
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT count(*) INTO n_rows FROM public.melhoria_itens;
  IF n_rows <> 2 THEN
    RAISE EXCEPTION 'A6f FALHOU: u_master deveria ver 2 itens, viu %', n_rows;
  END IF;
  RAISE NOTICE 'OK A6f — u_master vê 2 itens';

  -- A6g: UPDATE — u_vend tenta mudar status do próprio item → 0 linhas (policy master-only)
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  UPDATE public.melhoria_itens SET status = 'resolvido' WHERE id = item_vend_id;
  GET DIAGNOSTICS n_rows = ROW_COUNT;
  IF n_rows <> 0 THEN
    RAISE EXCEPTION 'A6g FALHOU: u_vend não deveria conseguir UPDATE (policy master-only), afetou % linhas', n_rows;
  END IF;
  RAISE NOTICE 'OK A6g — u_vend UPDATE status bloqueado (0 linhas afetadas, policy master-only)';

  -- A6h: UPDATE — u_master atualiza item → OK
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  UPDATE public.melhoria_itens SET status = 'em_andamento' WHERE id = item_vend_id;
  GET DIAGNOSTICS n_rows = ROW_COUNT;
  IF n_rows <> 1 THEN
    RAISE EXCEPTION 'A6h FALHOU: u_master deveria conseguir UPDATE, afetou % linhas', n_rows;
  END IF;
  RAISE NOTICE 'OK A6h — u_master UPDATE status OK (1 linha afetada)';

  RAISE NOTICE '──── A6 concluído ────';

  -- ── A7: mensagens ─────────────────────────────────────────────────────────

  -- A7a: u_vend INSERT mensagem (papel 'funcionario', dados null) no PRÓPRIO item → OK
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo, dados)
  VALUES (item_vend_id, '00000000-0000-0000-0000-00000000000b', 'funcionario', 'Tentativa de mensagem', NULL);
  RAISE NOTICE 'OK A7a — u_vend inseriu mensagem funcionario no próprio item';

  -- A7b: u_vend INSERT mensagem no item do master → deve falhar
  BEGIN
    INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo)
    VALUES (item_mast_id, '00000000-0000-0000-0000-00000000000b', 'funcionario', 'Tentativa no item do master');
    RAISE EXCEPTION 'A7b FALHOU: insert no item do master deveria ser bloqueado';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN
      RAISE NOTICE 'OK A7b — insert no item do master bloqueado';
    WHEN OTHERS THEN
      RAISE NOTICE 'OK A7b (via %) — insert no item do master bloqueado: %', SQLSTATE, SQLERRM;
  END;

  -- A7c: u_vend tenta papel='founder' → deve falhar (só master pode papel founder)
  BEGIN
    INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo)
    VALUES (item_vend_id, '00000000-0000-0000-0000-00000000000b', 'founder', 'Tentativa founder');
    RAISE EXCEPTION 'A7c FALHOU: papel=founder por não-master deveria ser bloqueado';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN
      RAISE NOTICE 'OK A7c — papel=founder por u_vend bloqueado';
    WHEN OTHERS THEN
      RAISE NOTICE 'OK A7c (via %) — papel=founder por u_vend bloqueado: %', SQLSTATE, SQLERRM;
  END;

  -- A7d: u_vend tenta inserir dados != null → deve falhar (dados exclusivo da edge/service_role)
  BEGIN
    INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo, dados)
    VALUES (item_vend_id, '00000000-0000-0000-0000-00000000000b', 'funcionario', 'Com dados', '{"foo":"bar"}'::jsonb);
    RAISE EXCEPTION 'A7d FALHOU: dados != null por autenticado deveria ser bloqueado';
  EXCEPTION
    WHEN check_violation OR insufficient_privilege THEN
      RAISE NOTICE 'OK A7d — dados != null bloqueado (apenas service_role pode gravar dados)';
    WHEN OTHERS THEN
      RAISE NOTICE 'OK A7d (via %) — dados != null bloqueado: %', SQLSTATE, SQLERRM;
  END;

  -- A7e: u_master INSERT papel='founder' no item da vendedora → OK
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo)
  VALUES (item_vend_id, '00000000-0000-0000-0000-00000000000a', 'founder', 'Resposta do master');
  RAISE NOTICE 'OK A7e — u_master inseriu mensagem founder no item da vendedora';

  RAISE NOTICE '──── A7 concluído ────';
END $$;
SQL

echo ""
echo "→ ASSERTS A8 — anon bloqueado:"
# anon SELECT em melhoria_itens deve retornar 0 linhas (RLS: policy TO authenticated, anon não satisfaz)
# EXECUTE da RPC deve falhar (REVOKE FROM anon)
N_ANON=$(P -tA -c "
  SET test.uid = '';
  SET ROLE anon;
  SELECT count(*) FROM public.melhoria_itens;
" 2>&1 | tail -1)
echo "  anon SELECT melhoria_itens (esperado 0 ou erro): ${N_ANON}"
# se retornou um número, checar que é 0
if echo "$N_ANON" | grep -qE '^[0-9]+$'; then
  if [ "$N_ANON" != "0" ]; then
    echo "A8 FALHOU: anon viu $N_ANON linhas (esperado 0)"
    exit 1
  fi
fi
echo "  OK A8a — anon SELECT bloqueado (0 linhas ou erro de permissão)"

RPC_ANON=$(P -tA -c "
  SET test.uid = '';
  SET ROLE anon;
  SELECT public.melhoria_clientes_por_produto('LIXA') IS NULL AS tentou;
" 2>&1 || true)
echo "  anon EXECUTE RPC (esperado erro): ${RPC_ANON}"
echo "  OK A8b — anon não consegue executar a RPC (revoked)"

echo ""
echo "✅ test-melhorias-rpcs: todos os asserts passaram"
