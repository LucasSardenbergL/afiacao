#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261016120000_raio_x_estoque_parado                         ║
# ║  raio_x_estoque_fatos + RLS de raio_x_decisao / raio_x_classificacao_manual  ║
# ║      bash db/test-raio-x-fatos.sh > logs/rx1.log 2>&1; echo "exit=$?"        ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-raio-x-fatos.sh  (2o ambiente)              ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocacao + sabotagens sobre COPIA da migration (o repo nunca e tocado).
# Asserções em ASCII, caixa fixa, sem -i. SQLSTATE capturada exata (re-lança o resto).
#
# Escolhas do preparo (espelham prod so no que a prova exige):
#  - Os stubs reproduzem so as colunas usadas, com os tipos de prod. v_venda_items_history_efetivo e
#    TABELA aqui (em prod e view security_invoker); o RLS das tabelas-fonte de prod nao e modelado
#    (as roles leem tudo): o achado de RLS de prod (inventory_position exige cap_custo_ler) esta no relatorio.
#  - public.has_role(uuid,text): em prod o 2o arg e o enum app_role; a migration passa literal, text basta.
#  - ALTER DEFAULT PRIVILEGES concede EXECUTE (funcoes) e ALL (tabelas) a anon/authenticated, como o Supabase;
#    sem isso a sabotagem "tirar anon do REVOKE" ficaria verde-falsa e o INSERT do customer cairia em
#    "permission denied" em vez de RLS.
#  - lc_messages=C no servidor: a mensagem de RLS nao pode depender do locale do ambiente.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5476}"
SLUG="raio-x-fatos"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C -c timezone=UTC" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_STAFF="22222222-2222-2222-2222-222222222222"
U_MASTER="11111111-1111-1111-1111-111111111111"
U_CUST="44444444-4444-4444-4444-444444444444"
U_EST="55555555-5555-5555-5555-555555555555"   # employee COM commercial_role estrategico
# U_STAFF = employee SEM commercial_role (nao le custo em prod)

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
-- Como o Supabase: privilegios por default para anon/authenticated (funcoes e tabelas).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;

GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;  -- Supabase concede; auth.uid() precisa
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
-- Espelha prod (psql-ro 2026-10-16): authenticated tem USAGE em private e EXECUTE em cap_custo_ler; anon nao.
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id AND r.role = _role) $$;

CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master')
      OR (
        public.has_role(_uid, 'employee')
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                     WHERE cr.user_id = _uid AND cr.commercial_role IN ('estrategico','super_admin'))
      )
    ), false);
$$;
REVOKE ALL ON FUNCTION private.cap_custo_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_custo_ler(uuid) TO authenticated;
-- Espelha prod: so master le compras (policy cap_compras_ler em pedido_compra_item/pedido_compra_sugerido).
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'), false);
$$;
REVOKE ALL ON FUNCTION private.cap_compras_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated;

CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (
  omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc character(1), tipo_reposicao text,
  habilitado_reposicao_automatica boolean);
CREATE TABLE public.v_venda_items_history_efetivo (
  empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.pedido_compra_sugerido (id bigint PRIMARY KEY, empresa text, status text, split_parent_id bigint);
CREATE TABLE public.pedido_compra_item (id bigserial, pedido_id bigint, sku_codigo_omie text, criado_em timestamptz);
ALTER TABLE public.pedido_compra_sugerido ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_compra_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY cap_compras_ler ON public.pedido_compra_sugerido FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
CREATE POLICY cap_compras_ler ON public.pedido_compra_item FOR SELECT TO authenticated
  USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))));
CREATE TABLE public.warehouses (id uuid PRIMARY KEY, code text);
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY, razao_social_emitente text, data_emissao date, warehouse_id uuid);
CREATE TABLE public.nfe_recebimento_itens (id uuid DEFAULT gen_random_uuid(), nfe_recebimento_id uuid, produto_omie_id bigint);

-- Captura SO a SQLSTATE esperada (o resto propaga e derruba a prova). Roda como o chamador (INVOKER).
CREATE FUNCTION public.t_lanca(q text, st text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = st THEN RETURN SQLSTATE || '|' || SQLERRM; END IF;
  RAISE;
END $$;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('44444444-4444-4444-4444-444444444444','customer'),
  ('55555555-5555-5555-5555-555555555555','employee');
INSERT INTO public.commercial_roles VALUES ('55555555-5555-5555-5555-555555555555','estrategico');

DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- Estoque oben. sku 1: 2 linhas (a mais recente vence). sku 7: a mais recente tem saldo 0 -> some.
  INSERT INTO inventory_position VALUES
    (1, 5, 10, 10, 'oben', now() - interval '3 days'),
    (1, 9, 12, 12, 'oben', now() - interval '1 hour'),
    (2, 7, 5, 5, 'vendas', now()),
    (3, 20, 2.5, 2.5, 'oben', now()),
    (3, 99, 9, 9, 'vendas', now()),
    (3, 4, 3, 3, 'colacor_vendas', now()),
    (4, 3, 0, 0, 'oben', now()),
    (5, 3, NULL, NULL, 'oben', now()),
    (6, 8, 1, 1, 'oben', now()),
    (7, 5, 1, 1, 'oben', now() - interval '2 days'),
    (7, 0, 1, 1, 'oben', now());
  -- 1.200 fillers oben (1000..2199) => 5 visiveis especificos (1,3,4,5,6) + 1200 = 1205
  INSERT INTO inventory_position
    SELECT g, 2, 1.5, 1.5, 'oben', now() FROM generate_series(1000, 2199) g;
  -- Colacor: 10 SKUs (5001..5010) + sku 3; o 5002 tem cmc 0.
  INSERT INTO inventory_position
    SELECT g, 1, CASE WHEN g = 5002 THEN 0 ELSE 1 END, 1, 'colacor_vendas', now() FROM generate_series(5001, 5010) g;

  INSERT INTO omie_products VALUES
    (1, 'P1', 'PROD UM', 'UN', true, 'FAM', 'oben', '00', '{}', now() - interval '400 days'),
    (3, 'P3', 'PROD TRES OBEN', 'UN', true, 'FAM', 'oben', '00', '{}', now() - interval '300 days'),
    (3, 'P3C', 'PROD TRES COLACOR', 'CX', true, 'FAM', 'colacor', '08', '{}', now() - interval '200 days'),
    (4, 'P4', 'PROD QUATRO', 'UN', true, 'FAM', 'oben', '01', '{}', now()),
    (5, 'P5', 'PROD CINCO', 'UN', true, 'FAM', 'oben', '01', '{}', now()),
    (5001, 'C1', 'COLA UM', 'UN', true, 'FAM', 'colacor', '08', '{}', now());

  INSERT INTO sku_parametros VALUES
    ('OBEN', 1, 'FORN SP', 'B', 'automatico', true),
    ('OBEN', 3, NULL, 'A', 'automatico', false);

  INSERT INTO v_venda_items_history_efetivo VALUES
    ('OBEN', h - 10, 101, 'CLI A', 3, 'UN', 6, 60, 10),
    ('OBEN', h - 5,  102, 'CLI B', 3, 'CX', 4, 60, 15),
    ('OBEN', h - 400, 103, 'CLI C', 3, 'UN', 100, 100, 1),
    ('COLACOR', h - 3, 999, 'CLI Z', 3, 'UN', 50, 500, 10),
    -- sku 1: dois clientes HOMONIMOS (codigos 201/202) e um cliente (203) cujo nome mudou entre NFs
    ('OBEN', h - 2, 201, 'HOMONIMO', 1, 'UN', 3, 30, 10),
    ('OBEN', h - 1, 202, 'HOMONIMO', 1, 'UN', 2, 20, 10),
    ('OBEN', h - 9, 203, 'NOME ANTIGO', 1, 'UN', 1, 10, 10),
    ('OBEN', h - 3, 203, 'NOME NOVO', 1, 'UN', 1, 10, 10);

  INSERT INTO warehouses VALUES
    ('cccccccc-0000-0000-0000-00000000000b', 'OB'),
    ('cccccccc-0000-0000-0000-00000000000c', 'CC');
  INSERT INTO nfe_recebimentos VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'FORN VELHO', h - 100, 'cccccccc-0000-0000-0000-00000000000b'),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'FORN NOVO', h - 20, 'cccccccc-0000-0000-0000-00000000000b'),
    ('aaaaaaaa-0000-0000-0000-000000000003', 'FORN CC', h - 5, 'cccccccc-0000-0000-0000-00000000000c'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'EMPATE A', h - 30, 'cccccccc-0000-0000-0000-00000000000b'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'EMPATE B', h - 30, 'cccccccc-0000-0000-0000-00000000000b');
  INSERT INTO nfe_recebimento_itens (nfe_recebimento_id, produto_omie_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 3),
    ('aaaaaaaa-0000-0000-0000-000000000002', 3),
    ('aaaaaaaa-0000-0000-0000-000000000003', 3),
    ('bbbbbbbb-0000-0000-0000-000000000001', 6),
    ('bbbbbbbb-0000-0000-0000-000000000002', 6);
END $f$;
SQL
}

# Sessão simulada: $1 = uuid ('' = sem claims), $2 = SQL (uma consulta). Roda como authenticated.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then
      echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true) AS c \\gset"
    fi
    echo "$2;"
    echo "COMMIT;"
  } | Pq
}

falhas=0
oks() { # $1 uuid, $2 SQL, $3 esperado, $4 rotulo. Erro de psql vira valor distinto (nunca mascara).
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

FOB="public.raio_x_estoque_fatos('oben')"
FCO="public.raio_x_estoque_fatos('colacor')"
FSIG="public.raio_x_estoque_fatos(text)"
RLSMSG='42501|new row violates row-level security policy for table "raio_x_decisao"'

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }
  # Re-colar a migration inteira de novo (idempotencia do re-apply) tambem tem de passar.
  P -f "$1" || { echo "APLICACAO FALHOU (2o apply): $1"; return 99; }
  P -c "INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, destino) VALUES ('oben', 1, 'liquidar')"
  P -c "INSERT INTO public.raio_x_classificacao_manual (empresa, sku_codigo_omie, categoria, motivo) VALUES ('oben', 1, 'uso_consumo', 'teste')"

  # (a) dedup: sku 1 tem 2 linhas, volta 1 vez com a mais recente; sku 7 (mais recente saldo 0) some
  oks "$U_EST" "SELECT count(*) || '|' || max(saldo) || '|' || max(cmc) FROM $FOB WHERE sku_codigo_omie = 1" "1|9|12" "a sku1 uma linha com o saldo mais recente"
  oks "$U_EST" "SELECT count(*) FROM $FOB WHERE sku_codigo_omie = 7" "0" "a sku7 mais recente com saldo 0 nao aparece"

  # (b) conta vendas nunca aparece
  oks "$U_EST" "SELECT count(*) FROM $FOB WHERE sku_codigo_omie = 2" "0" "b sku so da conta vendas nunca aparece"
  oks "$U_EST" "SELECT saldo FROM $FOB WHERE sku_codigo_omie = 3" "20" "b sku3 oben usa o saldo da conta oben"

  # (c) colacor: estoque colacor_vendas; q12/ncli/ult_venda/clientes (e derivados) NULL
  oks "$U_EST" "SELECT saldo || '|' || tipo_produto || '|' || no_motor FROM $FCO WHERE sku_codigo_omie = 3" "4|08|false" "c colacor sku3 le colacor_vendas e cadastro colacor"
  oks "$U_EST" "SELECT (q12 IS NULL AND ncli IS NULL AND ult_venda IS NULL AND clientes IS NULL AND preco_medio_12m IS NULL AND unidades_venda IS NULL) FROM $FCO WHERE sku_codigo_omie = 3" "t" "c colacor q12 ncli ult_venda clientes IS NULL"
  oks "$U_EST" "SELECT count(*) FROM $FCO" "11" "c colacor 11 skus"

  # oben com venda: sku 3 (janela de 12m ignora a NF de 400 dias e a de COLACOR)
  oks "$U_EST" "SELECT q12 || '|' || ncli || '|' || (ult_venda = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) || '|' || preco_medio_12m FROM $FOB WHERE sku_codigo_omie = 3" "10|2|true|12.0000" "c oben sku3 q12 ncli ult_venda preco"
  oks "$U_EST" "SELECT (clientes->0->>'nome') || '|' || (clientes->0->>'qtd') || '|' || jsonb_array_length(clientes) || '|' || array_to_string(unidades_venda, ',') FROM $FOB WHERE sku_codigo_omie = 3" "CLI A|6|2|CX,UN" "c oben sku3 clientes top e unidades"
  oks "$U_EST" "SELECT (q12 = 0 AND ncli = 0 AND ult_venda IS NULL AND clientes = '[]'::jsonb) FROM $FOB WHERE sku_codigo_omie = 6" "t" "c oben sem venda: q12 0, clientes vazio"
  oks "$U_EST" "SELECT no_motor || '|' || fornecedor || '|' || classe_abc FROM $FOB WHERE sku_codigo_omie = 1" "true|FORN SP|B" "c oben sku1 motor e fornecedor do motor"
  oks "$U_EST" "SELECT no_motor || '|' || fornecedor || '|' || (ult_entrada = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20) FROM $FOB WHERE sku_codigo_omie = 3" "true|FORN NOVO|true" "c oben sku3 fornecedor da ultima NF de entrada"

  # NF de entrada por armazem: mesmo produto 3 com NF no CC (mais nova) e no OB
  oks "$U_EST" "SELECT fornecedor || '|' || (ult_entrada = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20) FROM $FOB WHERE sku_codigo_omie = 3" "FORN NOVO|true" "c oben pega so a NF do armazem OB"
  oks "$U_EST" "SELECT fornecedor || '|' || (ult_entrada = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) FROM $FCO WHERE sku_codigo_omie = 3" "FORN CC|true" "c colacor pega so a NF do armazem CC"
  oks "$U_EST" "SELECT fornecedor FROM $FOB WHERE sku_codigo_omie = 6" "EMPATE B" "c empate de data na NF desempata por id desc"
  # clientes por codigo: homonimos nao fundem; nome = NF mais recente
  oks "$U_EST" "SELECT jsonb_array_length(clientes) || '|' || (SELECT count(*) FROM jsonb_array_elements(clientes) e WHERE e->>'nome' = 'HOMONIMO') || '|' || (SELECT count(*) FROM jsonb_array_elements(clientes) e WHERE e->>'nome' = 'NOME NOVO') || '|' || (SELECT count(*) FROM jsonb_array_elements(clientes) e WHERE e->>'nome' = 'NOME ANTIGO') FROM $FOB WHERE sku_codigo_omie = 1" "3|2|1|0" "c clientes homonimos nao fundem e nome da NF mais recente"

  # (d) cmc 0 / ausente => NULL
  oks "$U_EST" "SELECT (cmc IS NULL) FROM $FOB WHERE sku_codigo_omie = 4" "t" "d cmc zero volta NULL (oben)"
  oks "$U_EST" "SELECT (cmc IS NULL) FROM $FOB WHERE sku_codigo_omie = 5" "t" "d cmc ausente volta NULL (oben)"
  oks "$U_EST" "SELECT (cmc IS NULL) FROM $FCO WHERE sku_codigo_omie = 5002" "t" "d cmc zero volta NULL (colacor)"
  oks "$U_EST" "SELECT cmc FROM $FOB WHERE sku_codigo_omie = 3" "2.5" "d cmc positivo preservado"

  # (e) sem omie_products: nao some, tipo_produto NULL
  oks "$U_EST" "SELECT count(*) || '|' || bool_and(tipo_produto IS NULL AND codigo IS NULL) FROM $FOB WHERE sku_codigo_omie = 6" "1|true" "e sku sem omie_products volta com tipo_produto NULL"

  # R17: habilitado_reposicao_automatica de sku_parametros; sem linha / colacor -> NULL
  oks "$U_EST" "SELECT habilitado_reposicao_automatica FROM $FOB WHERE sku_codigo_omie = 3" "f" "r17 habilitado false volta false"
  oks "$U_EST" "SELECT habilitado_reposicao_automatica FROM $FOB WHERE sku_codigo_omie = 1" "t" "r17 habilitado true volta true"
  oks "$U_EST" "SELECT (habilitado_reposicao_automatica IS NULL) FROM $FOB WHERE sku_codigo_omie = 6" "t" "r17 sem linha em sku_parametros volta NULL"
  oks "$U_EST" "SELECT (habilitado_reposicao_automatica IS NULL) FROM $FCO WHERE sku_codigo_omie = 3" "t" "r17 colacor volta NULL"

  # (f) 1.205 SKUs, ordem estritamente crescente
  oks "$U_EST" "SELECT count(*) || '|' || count(DISTINCT sku_codigo_omie) FROM $FOB" "1205|1205" "f oben 1205 skus distintos"
  oks "$U_EST" "SELECT (array_agg(s) = array_agg(s ORDER BY s)) FROM (SELECT sku_codigo_omie AS s FROM $FOB) t" "t" "f ordem crescente por sku"
  oks "$U_MASTER" "SELECT count(*) FROM $FOB" "1205" "f master tambem le"

  # (g) empresa invalida / nula
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''colacor_sc'')', '22023')" "22023|RAIO_X_EMPRESA_INVALIDA: colacor_sc" "g empresa colacor_sc erro 22023"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(NULL)', '22023')" "22023|RAIO_X_EMPRESA_INVALIDA: <null>" "g empresa nula erro 22023"

  # (h) gate staff + ACL
  oks "$U_CUST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "h customer barrado 42501"
  oks "$U_STAFF" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "h employee sem commercial_role barrado 42501"
  oks "$U_EST" "SELECT count(*) FROM $FOB" "1205" "h employee com estrategico passa"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "h sem claims barrado 42501"
  okp "SELECT has_function_privilege('anon','$FSIG','EXECUTE')" "f" "h anon sem EXECUTE"
  okp "SELECT has_function_privilege('public','$FSIG','EXECUTE')" "f" "h public sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$FSIG','EXECUTE')" "t" "h authenticated com EXECUTE"

  # (i) RLS das tabelas novas
  oks "$U_EST" "SELECT count(*) FROM public.raio_x_decisao" "1" "i controle: estrategico ve a linha de raio_x_decisao"
  oks "$U_STAFF" "SELECT count(*) FROM public.raio_x_decisao" "0" "i employee sem commercial_role ve 0 linhas em raio_x_decisao (custo)"
  oks "$U_STAFF" "SELECT count(*) FROM public.raio_x_classificacao_manual" "1" "i classificacao_manual segue staff"
  oks "$U_CUST" "SELECT count(*) FROM public.raio_x_decisao" "0" "i customer ve 0 linhas em raio_x_decisao"
  oks "$U_CUST" "SELECT count(*) FROM public.raio_x_classificacao_manual" "0" "i customer ve 0 linhas em raio_x_classificacao_manual"
  oks "$U_CUST" "SELECT public.t_lanca('INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (''oben'', 9)', '42501')" "$RLSMSG" "i customer insert barrado por RLS"
  oks "$U_EST" "SELECT public.t_lanca('INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (''oben'', 9)', '42501')" "$RLSMSG" "i staff tambem nao escreve direto"

  # ---- Task 3: raio_x_medicao ----
  # decisoes: sku1 oben decidido no dia h-3 (NF do proprio dia NAO conta: fronteira estrita); sku3 oben sem foto;
  # sku3 colacor; sku7 oben (saldo mais recente 0); sku9999 oben sem linha de estoque; sku6 so contagem (destino NULL).
  P -c "DO \$m\$ DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; BEGIN
    UPDATE public.raio_x_decisao SET decidido_em = ((h - 3)::timestamp + time '15:00') AT TIME ZONE 'America/Sao_Paulo',
      foto_saldo = 5, foto_cmc = 10, foto_valor = 50, foto_categoria = 'mercadoria', foto_em = now(), credito_troca = 7
     WHERE empresa = 'oben' AND sku_codigo_omie = 1;
    INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_em) VALUES
      ('oben', 3, 'venda_dirigida', now() - interval '7 days'),
      ('colacor', 3, 'trocar', now() - interval '7 days'),
      ('oben', 7, 'liquidar', now() - interval '7 days'),
      ('oben', 9999, 'liquidar', now() - interval '7 days');
    INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, qtd_contada) VALUES ('oben', 6, 2);
    INSERT INTO public.pedido_compra_sugerido VALUES (1, 'OBEN', 'disparado', NULL), (2, 'OBEN', 'cancelado', NULL),
      (3, 'OBEN', 'expirado_sem_aprovacao', NULL), (4, 'COLACOR', 'disparado', NULL),
      (5, 'OBEN', 'pendente_aprovacao', NULL), (6, 'OBEN', 'split_em_filhos', NULL), (7, 'OBEN', 'disparado', 6);
    -- horas distintas por cabecalho (SP): 10:00 p1 | 11:00 filho do split p7 | 12:00 colacor | 13:00 pendente | 14:00 cancelado | 15:00 expirado
    INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, criado_em) VALUES
      (1, '1', ((h - 1)::timestamp + time '10:00') AT TIME ZONE 'America/Sao_Paulo'),
      (1, '1', ((h - 2)::timestamp + time '10:00') AT TIME ZONE 'America/Sao_Paulo'),
      (1, '1', now() - interval '20 days'),
      (7, '1', ((h - 1)::timestamp + time '11:00') AT TIME ZONE 'America/Sao_Paulo'),
      (4, '1', ((h - 1)::timestamp + time '12:00') AT TIME ZONE 'America/Sao_Paulo'),
      (5, '1', ((h - 1)::timestamp + time '13:00') AT TIME ZONE 'America/Sao_Paulo'),
      (2, '1', ((h - 1)::timestamp + time '14:00') AT TIME ZONE 'America/Sao_Paulo'),
      (3, '1', ((h - 1)::timestamp + time '15:00') AT TIME ZONE 'America/Sao_Paulo'),
      (1, 'ABC-NAO-NUMERICO', now() - interval '1 hour'),
      (1, '3', now() - interval '20 days');
    -- fuso: sku5 decidido 23:30 SP do dia h-4 (= h-3 02:30 UTC); NF no mesmo dia SP nao conta, no dia SP seguinte conta
    INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_em) VALUES
      ('oben', 5, 'liquidar', ((h - 4)::timestamp + time '23:30') AT TIME ZONE 'America/Sao_Paulo');
    INSERT INTO v_venda_items_history_efetivo VALUES
      ('OBEN', h - 4, 301, 'CLI TZ', 5, 'UN', 7, 70, 10),
      ('OBEN', h - 3, 302, 'CLI TZ', 5, 'UN', 2, 20, 10);
  END \$m\$"
  MED="public.raio_x_medicao('oben')"; MEC="public.raio_x_medicao('colacor')"; MSIG="public.raio_x_medicao(text)"

  # (a) fronteira ESTRITA: venda antes da decisao e a do proprio dia nao contam (sku1 decidido no dia h-3: NF h-9 e h-3 fora; h-2,h-1 = 5 un / 50)
  oks "$U_EST" "SELECT qtd_vendida || '|' || receita FROM $MED WHERE sku_codigo_omie = 1" "5|50" "m a venda antes da decisao nao conta e a do proprio dia tambem nao"
  oks "$U_EST" "SELECT preco_medio_12m FROM $MED WHERE sku_codigo_omie = 1" "10.0000" "m preco medio 12m na janela de fatos"
  oks "$U_EST" "SELECT foto_saldo || '|' || foto_cmc || '|' || foto_valor || '|' || foto_categoria || '|' || credito_troca || '|' || destino FROM $MED WHERE sku_codigo_omie = 1" "5|10|50|mercadoria|7|liquidar" "m foto e destino voltam"
  # (b) colacor: sem venda NF
  oks "$U_EST" "SELECT (qtd_vendida IS NULL AND receita IS NULL AND preco_medio_12m IS NULL AND compras_apos IS NULL) FROM $MEC WHERE sku_codigo_omie = 3" "t" "m b colacor sem venda e sem compras e NULL"
  oks "$U_EST" "SELECT saldo_atual FROM $MEC WHERE sku_codigo_omie = 3" "4" "m b colacor le colacor_vendas"
  # (c) compras: so disparado, depois da decisao, ordenadas; cancelado/expirado/colacor/nao numerico nao entram
  HORAS="(SELECT string_agg(to_char(t AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI'), ',' ORDER BY ord) FROM unnest(compras_apos) WITH ORDINALITY u(t, ord))"
  oks "$U_MASTER" "SELECT $HORAS FROM $MED WHERE sku_codigo_omie = 1" "10:00,10:00,11:00" "m c compras apos a decisao em ordem (disparado e filho de split entram)"
  oks "$U_MASTER" "SELECT ($HORAS LIKE '%12:00%') FROM $MED WHERE sku_codigo_omie = 1" "f" "m c cabecalho COLACOR fora de compras_apos"
  oks "$U_MASTER" "SELECT ($HORAS ~ '1[345]:00') FROM $MED WHERE sku_codigo_omie = 1" "f" "m c pendente cancelado expirado fora de compras_apos"
  oks "$U_MASTER" "SELECT ($HORAS LIKE '%11:00%') FROM $MED WHERE sku_codigo_omie = 1" "t" "m c item em filho de split disparado entra"
  oks "$U_EST" "SELECT qtd_vendida || '|' || receita FROM $MED WHERE sku_codigo_omie = 5" "2|20" "m fuso: decisao 23:30 SP conta NF do dia SP seguinte e nao a do mesmo dia"
  oks "$U_MASTER" "SELECT cardinality(compras_apos) FROM $MED WHERE sku_codigo_omie = 3" "0" "m c compra antes da decisao nao aparece"
  # R16: sem cap_compras_ler (estrategico le custo mas nao compras) -> NULL, nunca '{}' fabricado
  oks "$U_EST" "SELECT (compras_apos IS NULL) FROM $MED WHERE sku_codigo_omie = 1" "t" "m r16 sem cap_compras_ler compras_apos NULL"
  oks "$U_EST" "SELECT count(*) FILTER (WHERE compras_apos IS NOT NULL) FROM $MED" "0" "m r16 sem cap_compras_ler nenhuma linha com compras_apos"
  oks "$U_MASTER" "SELECT cardinality(compras_apos) FROM $MED WHERE sku_codigo_omie = 1" "3" "m r16 master le as compras"
  # (d) saldo atual: linha mais recente; 0 se a linha e 0; NULL sem linha
  oks "$U_EST" "SELECT saldo_atual FROM $MED WHERE sku_codigo_omie = 1" "9" "m d saldo atual mais recente"
  oks "$U_EST" "SELECT saldo_atual FROM $MED WHERE sku_codigo_omie = 7" "0" "m d saldo 0 existente volta 0"
  oks "$U_EST" "SELECT (saldo_atual IS NULL) FROM $MED WHERE sku_codigo_omie = 9999" "t" "m d sem linha de estoque volta NULL"
  # sem foto volta com foto NULL; destino NULL fora; ordem; contagem
  oks "$U_EST" "SELECT (foto_saldo IS NULL AND foto_cmc IS NULL AND foto_valor IS NULL AND foto_categoria IS NULL) FROM $MED WHERE sku_codigo_omie = 3" "t" "m linha sem foto volta com foto NULL"
  oks "$U_EST" "SELECT count(*) || '|' || count(*) FILTER (WHERE sku_codigo_omie = 6) FROM $MED" "5|0" "m so destino nao nulo"
  oks "$U_EST" "SELECT (array_agg(s) = array_agg(s ORDER BY s)) FROM (SELECT sku_codigo_omie AS s FROM $MED) t" "t" "m ordem crescente por sku"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_medicao(''colacor_sc'')', '22023')" "22023|RAIO_X_EMPRESA_INVALIDA: colacor_sc" "m empresa invalida 22023"
  oks "$U_CUST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_medicao(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "m customer barrado 42501"
  oks "$U_STAFF" "SELECT public.t_lanca('SELECT * FROM public.raio_x_medicao(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "m employee sem commercial_role barrado 42501"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.raio_x_medicao(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "m sem claims barrado 42501"
  okp "SELECT has_function_privilege('anon','$MSIG','EXECUTE')" "f" "m anon sem EXECUTE"
  okp "SELECT has_function_privilege('public','$MSIG','EXECUTE')" "f" "m public sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$MSIG','EXECUTE')" "t" "m authenticated com EXECUTE"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK (locale=$LOC)"

# 2) FALSIFICAÇÃO — uma sabotagem por vez, vermelha PELA asserção esperada. Controle verde acima, mesma invocação.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo esperado (FALHOU: <rotulo> |)
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -eq 99 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
sabotar "1 sem DISTINCT ON no estoque" \
  "s/SELECT DISTINCT ON (ip.omie_codigo_produto)/SELECT/" \
  "a sku1 uma linha com o saldo mais recente"
sabotar "2 estoque oben le a conta vendas" \
  "s/WHEN 'oben'    THEN v_est := 'oben';/WHEN 'oben'    THEN v_est := 'vendas';/" \
  "b sku so da conta vendas nunca aparece"
sabotar "3 coalesce(q12,0) na colacor" \
  "s/CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE coalesce(v.q12, 0) END AS q12/coalesce(v.q12, 0) AS q12/" \
  "c colacor q12 ncli ult_venda clientes IS NULL"
sabotar "4 cmc zero passa direto" \
  "s/CASE WHEN e.cmc > 0 THEN e.cmc END/e.cmc/" \
  "d cmc zero volta NULL (oben)"
sabotar "5 sem gate staff" \
  "s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF false THEN/" \
  "h customer barrado 42501"
sabotar "6 policy de raio_x_decisao aberta (USING true)" \
  "/CREATE POLICY raio_x_decisao_select_staff/,/;/{s/^  USING.*/  USING (true);/;}" \
  "i customer ve 0 linhas em raio_x_decisao"

sabotar "8 gate volta para has_role(employee)" \
  "s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN/" \
  "h employee sem commercial_role barrado 42501"
sabotar "9 sem filtro de armazem na NF de entrada" \
  "s/WHERE w.code = v_wh AND ri.produto_omie_id IS NOT NULL/WHERE ri.produto_omie_id IS NOT NULL/" \
  "c oben pega so a NF do armazem OB"
sabotar "10 clientes agrupados por razao social" \
  "s/GROUP BY vh.sku, vh.cliente_codigo_omie) t/GROUP BY vh.sku, vh.cliente_razao_social) t/" \
  "c clientes homonimos nao fundem e nome da NF mais recente"
sabotar "11 policy de decisao volta para staff comum" \
  "s/USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));/USING ((SELECT public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')));/" \
  "i employee sem commercial_role ve 0 linhas em raio_x_decisao (custo)"

# Task 3 - raio_x_medicao
sabotar "12 fronteira de venda estrita volta para >=" \
  "s/FILTER (WHERE vh.data_emissao > d.dia)/FILTER (WHERE vh.data_emissao >= d.dia)/g" \
  "m a venda antes da decisao nao conta e a do proprio dia tambem nao"
sabotar "12b dia da decisao sem AT TIME ZONE" \
  "s/(x.decidido_em AT TIME ZONE 'America\/Sao_Paulo')::date AS dia/x.decidido_em::date AS dia/" \
  "m fuso: decisao 23:30 SP conta NF do dia SP seguinte e nao a do mesmo dia"
sabotar "12c compras sem filtro de empresa do cabecalho" \
  "s/ AND pc.empresa = 'OBEN'//" \
  "m c cabecalho COLACOR fora de compras_apos"
sabotar "13 colacor com qtd_vendida 0" \
  "s/CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE coalesce(v.qtd, 0) END/coalesce(v.qtd, 0)/" \
  "m b colacor sem venda e sem compras e NULL"
sabotar "14 compras sem filtro de status" \
  "s/AND pc.status IN ('disparado','split_em_filhos')/AND true/" \
  "m c pendente cancelado expirado fora de compras_apos"
sabotar "14b pendente_aprovacao entra em compras_apos" \
  "s/AND pc.status IN ('disparado','split_em_filhos')/AND pc.status IN ('disparado','split_em_filhos','pendente_aprovacao')/" \
  "m c pendente cancelado expirado fora de compras_apos"
sabotar "15 compras antes da decisao entram" \
  "s/AND i.criado_em > d.decidido_em/AND true/" \
  "m c compra antes da decisao nao aparece"
sabotar "16 saldo atual sem linha vira 0" \
  "s/^\\( *\\)e\\.saldo,$/\\1coalesce(e.saldo, 0),/" \
  "m d sem linha de estoque volta NULL"
sabotar "17 medicao sem gate" \
  "/FUNCTION public.raio_x_medicao/,/^\$fn\$;/s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF false THEN/" \
  "m customer barrado 42501"
sabotar "19 r16 compras_apos sem guarda cap_compras_ler" \
  "s/ AND private.cap_compras_ler(auth.uid()) THEN coalesce/ THEN coalesce/" \
  "m r16 sem cap_compras_ler compras_apos NULL"
sabotar "20 r17 habilitado sem linha vira false" \
  "s/^         sp\.habilitado_reposicao_automatica\$/         coalesce(sp.habilitado_reposicao_automatica, false)/" \
  "r17 sem linha em sku_parametros volta NULL"
sabotar "18 medicao inclui destino nulo" \
  "s/WHERE x.empresa = p_empresa AND x.destino IS NOT NULL)/WHERE x.empresa = p_empresa)/" \
  "m so destino nao nulo"

# 7) tirar anon do REVOKE: a postcondicao embutida aborta o apply (rc=99) — vermelho pelo motivo certo.
sed "s/REVOKE ALL ON FUNCTION public.raio_x_estoque_fatos(text) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.raio_x_estoque_fatos(text) FROM PUBLIC;/" "$MIG" > "$TMPD/sab.sql"
if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: 7"; exit 1; fi
r=0; o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
if [ "$r" -ne 99 ] || ! grep -qF "postcondicao: anon executa" <<<"$o"; then
  echo "SABOTAGEM 7 NAO ABORTOU PELA POSTCONDICAO (rc=$r)"; echo "$o"; exit 1
fi
echo "sabotagem vermelha ok: 7 anon fora do REVOKE (postcondicao aborta o apply, rc=$r)"

# 7b) idem + postcondicao neutralizada: a asserção (h) é que precisa ficar vermelha.
sabotar "7b anon fora do REVOKE sem postcondicao" \
  "s/REVOKE ALL ON FUNCTION public.raio_x_estoque_fatos(text) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.raio_x_estoque_fatos(text) FROM PUBLIC;/;s/IF has_function_privilege('anon', 'public.raio_x_estoque_fatos(text)', 'EXECUTE') THEN/IF false THEN/" \
  "h anon sem EXECUTE"

echo "RAIOX-FATOS-OK"
