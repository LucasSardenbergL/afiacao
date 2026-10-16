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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_STAFF="22222222-2222-2222-2222-222222222222"
U_MASTER="11111111-1111-1111-1111-111111111111"
U_CUST="44444444-4444-4444-4444-444444444444"

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
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id AND r.role = _role) $$;

CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (
  omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc text, tipo_reposicao text,
  habilitado_reposicao_automatica boolean);
CREATE TABLE public.v_venda_items_history_efetivo (
  empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY, razao_social_emitente text, data_emissao date);
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
  ('44444444-4444-4444-4444-444444444444','customer');

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
    ('OBEN', 3, NULL, 'A', 'automatico', true);

  INSERT INTO v_venda_items_history_efetivo VALUES
    ('OBEN', h - 10, 101, 'CLI A', 3, 'UN', 6, 60, 10),
    ('OBEN', h - 5,  102, 'CLI B', 3, 'CX', 4, 60, 15),
    ('OBEN', h - 400, 103, 'CLI C', 3, 'UN', 100, 100, 1),
    ('COLACOR', h - 3, 999, 'CLI Z', 3, 'UN', 50, 500, 10);

  INSERT INTO nfe_recebimentos VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'FORN VELHO', h - 100),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'FORN NOVO', h - 20);
  INSERT INTO nfe_recebimento_itens (nfe_recebimento_id, produto_omie_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 3),
    ('aaaaaaaa-0000-0000-0000-000000000002', 3);
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
  P -c "INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, destino) VALUES ('oben', 1, 'liquidar')"

  # (a) dedup: sku 1 tem 2 linhas, volta 1 vez com a mais recente; sku 7 (mais recente saldo 0) some
  oks "$U_STAFF" "SELECT count(*) || '|' || max(saldo) || '|' || max(cmc) FROM $FOB WHERE sku_codigo_omie = 1" "1|9|12" "a sku1 uma linha com o saldo mais recente"
  oks "$U_STAFF" "SELECT count(*) FROM $FOB WHERE sku_codigo_omie = 7" "0" "a sku7 mais recente com saldo 0 nao aparece"

  # (b) conta vendas nunca aparece
  oks "$U_STAFF" "SELECT count(*) FROM $FOB WHERE sku_codigo_omie = 2" "0" "b sku so da conta vendas nunca aparece"
  oks "$U_STAFF" "SELECT saldo FROM $FOB WHERE sku_codigo_omie = 3" "20" "b sku3 oben usa o saldo da conta oben"

  # (c) colacor: estoque colacor_vendas; q12/ncli/ult_venda/clientes (e derivados) NULL
  oks "$U_STAFF" "SELECT saldo || '|' || tipo_produto || '|' || no_motor FROM $FCO WHERE sku_codigo_omie = 3" "4|08|false" "c colacor sku3 le colacor_vendas e cadastro colacor"
  oks "$U_STAFF" "SELECT (q12 IS NULL AND ncli IS NULL AND ult_venda IS NULL AND clientes IS NULL AND preco_medio_12m IS NULL AND unidades_venda IS NULL AND fornecedor IS NULL AND ult_entrada IS NULL) FROM $FCO WHERE sku_codigo_omie = 3" "t" "c colacor q12 ncli ult_venda clientes IS NULL"
  oks "$U_STAFF" "SELECT count(*) FROM $FCO" "11" "c colacor 11 skus"

  # oben com venda: sku 3 (janela de 12m ignora a NF de 400 dias e a de COLACOR)
  oks "$U_STAFF" "SELECT q12 || '|' || ncli || '|' || (ult_venda = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 5) || '|' || preco_medio_12m FROM $FOB WHERE sku_codigo_omie = 3" "10|2|true|12.0000" "c oben sku3 q12 ncli ult_venda preco"
  oks "$U_STAFF" "SELECT (clientes->0->>'nome') || '|' || (clientes->0->>'qtd') || '|' || jsonb_array_length(clientes) || '|' || array_to_string(unidades_venda, ',') FROM $FOB WHERE sku_codigo_omie = 3" "CLI A|6|2|CX,UN" "c oben sku3 clientes top e unidades"
  oks "$U_STAFF" "SELECT (q12 = 0 AND ncli = 0 AND ult_venda IS NULL AND clientes = '[]'::jsonb) FROM $FOB WHERE sku_codigo_omie = 1" "t" "c oben sem venda: q12 0, clientes vazio"
  oks "$U_STAFF" "SELECT no_motor || '|' || fornecedor || '|' || classe_abc FROM $FOB WHERE sku_codigo_omie = 1" "true|FORN SP|B" "c oben sku1 motor e fornecedor do motor"
  oks "$U_STAFF" "SELECT no_motor || '|' || fornecedor || '|' || (ult_entrada = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20) FROM $FOB WHERE sku_codigo_omie = 3" "true|FORN NOVO|true" "c oben sku3 fornecedor da ultima NF de entrada"

  # (d) cmc 0 / ausente => NULL
  oks "$U_STAFF" "SELECT (cmc IS NULL) FROM $FOB WHERE sku_codigo_omie = 4" "t" "d cmc zero volta NULL (oben)"
  oks "$U_STAFF" "SELECT (cmc IS NULL) FROM $FOB WHERE sku_codigo_omie = 5" "t" "d cmc ausente volta NULL (oben)"
  oks "$U_STAFF" "SELECT (cmc IS NULL) FROM $FCO WHERE sku_codigo_omie = 5002" "t" "d cmc zero volta NULL (colacor)"
  oks "$U_STAFF" "SELECT cmc FROM $FOB WHERE sku_codigo_omie = 3" "2.5" "d cmc positivo preservado"

  # (e) sem omie_products: nao some, tipo_produto NULL
  oks "$U_STAFF" "SELECT count(*) || '|' || bool_and(tipo_produto IS NULL AND codigo IS NULL) FROM $FOB WHERE sku_codigo_omie = 6" "1|true" "e sku sem omie_products volta com tipo_produto NULL"

  # (f) 1.205 SKUs, ordem estritamente crescente
  oks "$U_STAFF" "SELECT count(*) || '|' || count(DISTINCT sku_codigo_omie) FROM $FOB" "1205|1205" "f oben 1205 skus distintos"
  oks "$U_STAFF" "SELECT (array_agg(s) = array_agg(s ORDER BY s)) FROM (SELECT sku_codigo_omie AS s FROM $FOB) t" "t" "f ordem crescente por sku"
  oks "$U_MASTER" "SELECT count(*) FROM $FOB" "1205" "f master tambem le"

  # (g) empresa invalida / nula
  oks "$U_STAFF" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''colacor_sc'')', '22023')" "22023|RAIO_X_EMPRESA_INVALIDA: colacor_sc" "g empresa colacor_sc erro 22023"
  oks "$U_STAFF" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(NULL)', '22023')" "22023|RAIO_X_EMPRESA_INVALIDA: <null>" "g empresa nula erro 22023"

  # (h) gate staff + ACL
  oks "$U_CUST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "h customer barrado 42501"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.raio_x_estoque_fatos(''oben'')', '42501')" "42501|RAIO_X_SO_STAFF" "h sem claims barrado 42501"
  okp "SELECT has_function_privilege('anon','$FSIG','EXECUTE')" "f" "h anon sem EXECUTE"
  okp "SELECT has_function_privilege('public','$FSIG','EXECUTE')" "f" "h public sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$FSIG','EXECUTE')" "t" "h authenticated com EXECUTE"

  # (i) RLS das tabelas novas
  oks "$U_STAFF" "SELECT count(*) FROM public.raio_x_decisao" "1" "i controle: staff ve a linha de raio_x_decisao"
  oks "$U_CUST" "SELECT count(*) FROM public.raio_x_decisao" "0" "i customer ve 0 linhas em raio_x_decisao"
  oks "$U_CUST" "SELECT count(*) FROM public.raio_x_classificacao_manual" "0" "i customer ve 0 linhas em raio_x_classificacao_manual"
  oks "$U_CUST" "SELECT public.t_lanca('INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (''oben'', 9)', '42501')" "$RLSMSG" "i customer insert barrado por RLS"
  oks "$U_STAFF" "SELECT public.t_lanca('INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (''oben'', 9)', '42501')" "$RLSMSG" "i staff tambem nao escreve direto"
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
  "s/IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN/IF false THEN/" \
  "h customer barrado 42501"
sabotar "6 policy de raio_x_decisao aberta (USING true)" \
  "/CREATE POLICY raio_x_decisao_select_staff/,/;/{s/^  USING.*/  USING (true);/;}" \
  "i customer ve 0 linhas em raio_x_decisao"

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
