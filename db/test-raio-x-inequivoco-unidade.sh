#!/usr/bin/env bash
# Prova PG17 — Raio-X inequivoco: unidade DESCONHECIDA (venda ou estoque sem unidade) com consumo a comparar bloqueia o
# veredito e, com ele, o liquidar (RX004). Migration: supabase/migrations/20261110100000_raio_x_inequivoco_unidade_desconhecida.sql
# sobre 20261016120000 + 20261031130000 + 20261031180000 + 20261101120000 + 20261101190000 (= PROD em 2026-11-08).
# Esqueleto de roles/stubs/fixtures = db/test-raio-x-inequivoco.sh (101 = inequivoco que vende em UN; 102 = sem venda).
# Rodar: bash db/test-raio-x-inequivoco-unidade.sh > log 2>&1; echo "exit=$?"   (LOCALE=C | pt_BR.UTF-8)
# Lei de Ferro: UM impedimento por fixture, controle verde na MESMA invocacao, sabotagens sobre COPIA da migration
# exigindo o FALHOU ESPECIFICO; a PRE (anti-deriva) e a PÓS (md5/DEFINER/ACL) sao provadas no controle e a parte.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5481}"
SLUG="raio-x-inequivoco-unidade"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
ANCORA1="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"
ANCORA2="$REPO_ROOT/supabase/migrations/20261031130000_raio_x_correcoes_pos_revisao.sql"
ANCORA3="$REPO_ROOT/supabase/migrations/20261031180000_raio_x_plano_execucao.sql"
MIG="$REPO_ROOT/supabase/migrations/20261101120000_raio_x_inequivoco.sql"
# correcao do 403 em prod: inequivoco vira SECURITY DEFINER (corpo identico). A suite aplica as DUAS, nesta ordem.
MIG2="$REPO_ROOT/supabase/migrations/20261101190000_raio_x_inequivoco_definer.sql"
# a desta prova: unidade desconhecida com consumo a comparar bloqueia o inequivoco
MIG3="$REPO_ROOT/supabase/migrations/20261110100000_raio_x_inequivoco_unidade_desconhecida.sql"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# master entra pelos user_roles (cap_custo_ler); a prova chama como U_EST (estrategico) e U_STAFF (sem custo)
U_STAFF="22222222-2222-2222-2222-222222222222"  # employee SEM commercial_role: nao le custo
U_EST="55555555-5555-5555-5555-555555555555"    # employee estrategico (chamador)

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id AND r.role = _role) $$;
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(_uid IS NOT NULL AND (public.has_role(_uid, 'master')
    OR (public.has_role(_uid, 'employee') AND EXISTS (SELECT 1 FROM public.commercial_roles cr
         WHERE cr.user_id = _uid AND cr.commercial_role IN ('estrategico','super_admin')))), false) $$;
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'), false) $$;
-- regra de classe da 20261018200000 (provada la); stub com a mesma semantica
CREATE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(trim(p_familia)) IN ('uso e consumo','imobilizado') THEN 'fora_giro'
              WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
              WHEN trim(p_tipo) IN ('07','08','09','99') THEN 'fora_giro' ELSE 'giro' END $$;
-- ACL de PROD (20261018200000:230): helper interno, SEM EXECUTE para authenticated. Sem isto o default privileges do
-- harness o abria, e uma RPC INVOKER que o chama passava aqui e dava 42501 (403) em prod — o bug de 2026-11-01.
REVOKE ALL ON FUNCTION public._fin_estoque_classe(text, text) FROM PUBLIC, anon, authenticated;
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc character(1), tipo_reposicao text,
  habilitado_reposicao_automatica boolean, parametro_cold_start boolean);
CREATE TABLE public.v_venda_items_history_efetivo (empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date, sku_unidade text);
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN', 'COLACOR');   -- tipo REAL da coluna (Codex codigo P1-1)
CREATE TABLE public.sku_leadtime_history (empresa public.empresa_reposicao, sku_codigo_omie text, quantidade_recebida numeric, t4_data_recebimento timestamptz);
CREATE TABLE public.v_pcp_malha_oben_quarentena (pai_oben bigint, comp_oben bigint, motivo text);
CREATE TABLE public.cmc_ledger (account text, omie_codigo_produto bigint, observed_at timestamptz);
CREATE TABLE public.sku_substituicao (empresa text, sku_codigo_antigo text, sku_codigo_novo text, status text, acao_parametros text);
CREATE TABLE public.warehouses (id uuid PRIMARY KEY, code text);
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY, razao_social_emitente text, data_emissao date, warehouse_id uuid);
CREATE TABLE public.nfe_recebimento_itens (id uuid DEFAULT gen_random_uuid(), nfe_recebimento_id uuid, produto_omie_id bigint);
CREATE TABLE public.pedido_compra_sugerido (id bigint PRIMARY KEY, empresa text, status text, split_parent_id bigint);
CREATE TABLE public.pedido_compra_item (id bigserial, pedido_id bigint, sku_codigo_omie text, criado_em timestamptz);
CREATE FUNCTION public.t_lanca(q text, st text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = st THEN RETURN SQLSTATE; END IF;
  RAISE;
END $$;
INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('55555555-5555-5555-5555-555555555555','employee');
INSERT INTO public.commercial_roles VALUES ('55555555-5555-5555-5555-555555555555','estrategico');
INSERT INTO public.warehouses VALUES ('aaaaaaaa-0000-0000-0000-000000000001','OB'), ('aaaaaaaa-0000-0000-0000-000000000002','CC');

-- fonte de consumo FRESCA (min <= hoje-330, max >= hoje-7)
INSERT INTO public.venda_items_history VALUES ('OBEN', current_date - 400), ('OBEN', current_date - 1);

-- Fixtures: UM impedimento por SKU (101/102 = controles positivos). Tudo mercadoria tipo 00 salvo onde dito.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, ativo, familia, account, tipo_produto, created_at) VALUES
 (101,'C101','VERNIZ PARADO','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (102,'C102','VERNIZ SEM VENDA','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (103,'C103','VERNIZ 365 EXATO','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (104,'C104','CORANTE LC','UN',true,'Concentrados LC','oben','00', now() - interval '400 days'),
 (105,'C105','ENTRADA LEADTIME','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (106,'C106','ENTRADA NFE','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (107,'C107','COLD START','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (108,'C108','SUBSTITUIDO','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (109,'C109','USO E CONSUMO 07','UN',true,'Vernizes','oben','07', now() - interval '400 days'),
 (110,'C110','SALDO ZERO','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (112,'C112','CADASTRO NOVO','UN',true,'Vernizes','oben','00', now() - interval '10 days'),
 (113,'C113','MANUAL MERCADORIA (tipo 07)','UN',true,'Vernizes','oben','07', now() - interval '400 days'),
 (114,'C114','CORANTE LC COLD','UN',true,'Concentrados LC','oben','00', now() - interval '400 days'),
 (115,'C115','ENTRADA LEDGER','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (116,'C116','MAQUINA DE TESTE','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (117,'C117','VENDA EM CAIXA','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (118,'C118','INSUMO QUARENTENA','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (201,'C201','COLACOR PARADO','UN',true,'Vernizes','colacor','00', now() - interval '400 days');
-- 111 = sem cadastro (so estoque)
INSERT INTO public.inventory_position VALUES
 (101,100,10,10,'oben',now()), (102,100,10,10,'oben',now()), (103,100,10,10,'oben',now()), (104,100,10,10,'oben',now()),
 (105,100,10,10,'oben',now()), (106,100,10,10,'oben',now()), (107,100,10,10,'oben',now()), (108,100,10,10,'oben',now()),
 (109,100,10,10,'oben',now()), (110,0,10,10,'oben',now()), (111,100,10,10,'oben',now()), (112,100,10,10,'oben',now()),
 (113,100,10,10,'oben',now()), (114,100,10,10,'oben',now()), (115,100,10,10,'oben',now()), (116,100,10,10,'oben',now()),
 (117,100,10,10,'oben',now()), (118,100,10,10,'oben',now()),
 (201,100,10,10,'colacor_vendas',now());
-- consumo 365d: 90 un (cobertura 405d) em todos menos 102 (0) e 103 (100 un = exatamente 365d)
INSERT INTO public.v_sku_demanda_efetiva
  SELECT 'OBEN', s, 1, current_date - g FROM unnest(ARRAY[101,104,105,106,107,108,109,111,112,113,114,115,116]) s, generate_series(1, 360, 4) g;
INSERT INTO public.v_sku_demanda_efetiva SELECT 'OBEN', 103, 1, current_date - g FROM generate_series(1, 300, 3) g;
-- 117: venda em CX (estoque em UN) — 20 CX/ano "parecem" 1.825 dias de cobertura; 118: componente em quarentena, consumo invisivel
INSERT INTO public.v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao, sku_unidade) SELECT 'OBEN', 117, 1, current_date - g, 'CX' FROM generate_series(1, 360, 18) g;
INSERT INTO public.v_pcp_malha_oben_quarentena VALUES (900, 118, 'perc_perda > 0');
-- venda direta (para preco medio 12m do planejar): 101 vendeu 10 un por R$20
INSERT INTO public.v_venda_items_history_efetivo (empresa, data_emissao, cliente_codigo_omie, sku_codigo_omie, sku_unidade, quantidade, valor_total)
  VALUES ('OBEN', current_date - 30, 1, 101, 'UN', 10, 200);
-- 105: recebimento REAL ha 10 dias (CMC inalterado — o ledger nao veria); 106: NF de entrada ha 30 dias no armazem OB; 115: so observacao do ledger ha 5 dias
INSERT INTO public.sku_leadtime_history VALUES ('OBEN','105',12, now() - interval '10 days');
INSERT INTO public.nfe_recebimentos VALUES ('bbbbbbbb-0000-0000-0000-000000000001','FORN', current_date - 30, 'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.nfe_recebimento_itens (nfe_recebimento_id, produto_omie_id) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 106);
INSERT INTO public.cmc_ledger VALUES ('vendas', 115, now() - interval '5 days'), ('vendas', 101, now() - interval '200 days');
-- 107 e 114: cold start; 101: parametro normal
INSERT INTO public.sku_parametros VALUES ('OBEN',107,'Forn','C','automatica',true,true), ('OBEN',114,'Forn','C','automatica',true,true),
                                         ('OBEN',101,'Forn','C','automatica',true,false);
INSERT INTO public.sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, status, acao_parametros) VALUES ('OBEN','108','109','aplicada','consolidar_demanda');
SQL
}

sess() { # $1 = uuid ('' = sem claims), $2 = SQL. Roda como authenticated.
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
passes=0  # asserts que PASSARAM nesta suite — o runner do nucleo exige o total (PASS=n FAIL=m)
oks() { # $1 uuid, $2 SQL, $3 esperado, $4 rotulo
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); else passes=$((passes+1)); fi
}
okp() { local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); else passes=$((passes+1)); fi; }
run() { local got; if got="$(sess "$U_EST" "$1" 2>&1)"; then passes=$((passes+1)); else echo "FALHOU: $2 | ERRO-PSQL: $got"; falhas=$((falhas+1)); fi; }
# linha do inequivoco: inequivoco|motivos|cobertura|qtd_liquidavel
INEQ() { echo "SELECT coalesce(inequivoco::text,'N') || '|' || CASE WHEN cardinality(motivos_espera) = 0 THEN '-' ELSE array_to_string(motivos_espera, ',') END || '|' || coalesce(cobertura_dias::text,'N') || '|' || coalesce(round(qtd_liquidavel,1)::text,'N') FROM public.raio_x_inequivoco('$1') WHERE sku_codigo_omie = $2"; }
dec() { echo "SELECT destino FROM public.raio_x_decidir($1)"; }
lanca() { echo "SELECT public.t_lanca('$1', '$2')"; }

fixtures_unidade() {
  P <<'SQL'
-- as vendas do esqueleto nascem sem sku_unidade: aqui TODA venda tem unidade conhecida (como em prod: 0 nulas em 382),
-- salvo as fixtures desta prova. 117 segue em CX (divergente).
UPDATE public.v_sku_demanda_efetiva SET sku_unidade = 'UN' WHERE sku_unidade IS NULL;
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, ativo, familia, account, tipo_produto, created_at) VALUES
 (119,'C119','VENDA SEM UNIDADE','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (120,'C120','ESTOQUE SEM UNIDADE',NULL,true,'Vernizes','oben','00', now() - interval '400 days'),
 (121,'C121','ESTOQUE UNIDADE EM BRANCO','  ',true,'Vernizes','oben','00', now() - interval '400 days'),
 (122,'C122','ESTOQUE SEM UNIDADE E SEM VENDA',NULL,true,'Vernizes','oben','00', now() - interval '400 days'),
 (123,'C123','VENDA EM un MINUSCULA','UN',true,'Vernizes','oben','00', now() - interval '400 days'),
 (124,'C124','SO LINHAS DE QUANTIDADE ZERO','UN',true,'Vernizes','oben','00', now() - interval '400 days');
INSERT INTO public.inventory_position VALUES
 (119,100,10,10,'oben',now()), (120,100,10,10,'oben',now()), (121,100,10,10,'oben',now()),
 (122,100,10,10,'oben',now()), (123,100,10,10,'oben',now()), (124,100,10,10,'oben',now());
-- 90 un/ano (cobertura 405d, a do 101) em todas com consumo
INSERT INTO public.v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao, sku_unidade)
  SELECT 'OBEN', 119, 1, current_date - g, NULL FROM generate_series(1, 360, 4) g;
INSERT INTO public.v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao, sku_unidade)
  SELECT 'OBEN', s, 1, current_date - g, 'UN' FROM unnest(ARRAY[120,121]) s, generate_series(1, 360, 4) g;
INSERT INTO public.v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao, sku_unidade)
  SELECT 'OBEN', 123, 1, current_date - g, ' un ' FROM generate_series(1, 360, 4) g;
INSERT INTO public.v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao, sku_unidade)
  SELECT 'OBEN', 124, 0, current_date - g, NULL FROM generate_series(1, 360, 30) g;
SQL
}

suite() {  # $1 = arquivo da migration desta prova (real ou sabotada)
  falhas=0
  passes=0
  preparar_banco
  fixtures_unidade >/dev/null || { echo "FIXTURES FALHARAM"; return 98; }
  P -f "$ANCORA1" >/dev/null || { echo "ANCORA1 FALHOU"; return 98; }
  P -f "$ANCORA2" >/dev/null || { echo "ANCORA2 FALHOU"; return 98; }
  P -f "$ANCORA3" >/dev/null || { echo "ANCORA3 FALHOU"; return 98; }
  P -f "$MIG" >/dev/null || { echo "MIG FALHOU"; return 98; }
  P -f "$MIG2" >/dev/null || { echo "MIG2 FALHOU"; return 98; }
  # ANTES da correcao (= PROD): 119 vendido sem unidade passa como inequivoco — o bug, provado executando
  oks "$U_EST" "$(INEQ oben 119)" "true|-|405.6|77.8" "z ANTES: 119 venda sem unidade era inequivoco (o bug)"
  P -f "$1" >/dev/null || { echo "APLICACAO FALHOU: $1"; return 99; }

  # ---------- (a) gate e cabecalho intactos ----------
  oks "$U_STAFF" "$(lanca "SELECT count(*) FROM public.raio_x_inequivoco(''oben'')" 42501)" "42501" "a staff sem custo 42501"
  okp "SELECT prosecdef FROM pg_proc WHERE oid = 'public.raio_x_inequivoco(text,bigint)'::regprocedure" "t" "a segue SECURITY DEFINER"
  okp "SELECT has_function_privilege('anon', 'public.raio_x_inequivoco(text,bigint)', 'EXECUTE') OR has_function_privilege('public', 'public.raio_x_inequivoco(text,bigint)', 'EXECUTE')" "f" "a anon/PUBLIC sem EXECUTE"
  # ---------- (b) controles positivos ----------
  oks "$U_EST" "$(INEQ oben 101)" "true|-|405.6|77.8" "b 101 parado, venda e estoque em UN: inequivoco"
  oks "$U_EST" "$(INEQ oben 102)" "true|-|N|100.0" "b 102 sem consumo: inequivoco"
  oks "$U_EST" "$(INEQ oben 122)" "true|-|N|100.0" "b 122 estoque sem unidade mas SEM consumo: nada a comparar, inequivoco"
  oks "$U_EST" "$(INEQ oben 124)" "true|-|N|100.0" "b 124 so linhas de quantidade zero sem unidade: sem consumo a comparar"
  oks "$U_EST" "$(INEQ oben 123)" "true|-|405.6|77.8" "b 123 ' un ' = 'UN' (trim/caixa): nao e divergente"
  # ---------- (c) um impedimento por fixture ----------
  oks "$U_EST" "$(INEQ oben 119)" "false|unidade_desconhecida|405.6|N" "c 119 venda sem unidade aguarda"
  oks "$U_EST" "$(INEQ oben 120)" "false|unidade_desconhecida|405.6|N" "c 120 estoque sem unidade com consumo aguarda"
  oks "$U_EST" "$(INEQ oben 121)" "false|unidade_desconhecida|405.6|N" "c 121 estoque com unidade em branco aguarda"
  oks "$U_EST" "$(INEQ oben 117)" "false|unidade_divergente|1825.0|N" "c 117 CX x UN segue divergente (so ele)"
  oks "$U_EST" "$(INEQ oben 111)" "false|cadastro_incompleto,unidade_desconhecida|405.6|N" "c 111 sem cadastro: incompleto E unidade desconhecida"
  # ---------- (d) RX004: liquidar o desconhecido e recusado ----------
  oks "$U_EST" "$(lanca "SELECT * FROM public.raio_x_decidir(''oben'', 119, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false)" RX004)" "RX004" "d liquidar 119 (unidade desconhecida) RX004"
  oks "$U_EST" "$(lanca "SELECT * FROM public.raio_x_decidir(''oben'', 120, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false)" RX004)" "RX004" "d liquidar 120 (estoque sem unidade) RX004"
  okp "SELECT count(*) FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie IN (119,120)" "0" "d RX004 nao deixa linha"
  oks "$U_EST" "$(dec "'oben', 101, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "liquidar" "d liquidar 101 inequivoco passa"
  oks "$U_EST" "$(dec "'oben', 119, 'trocar', 'mercadoria', NULL, 'Forn', 50, false, false")" "trocar" "d trocar 119 passa (a regra e so do liquidar)"

  echo "PASS=$passes  FAIL=$falhas"
  [ "$falhas" -eq 0 ] || { echo "falhas=$falhas"; return 1; }
  return 0
}

echo "== controle (migration real, com PRE e PÓS) =="
if ! out="$(suite "$MIG3" 2>&1)"; then echo "$out"; echo "CONTROLE VERMELHO"; exit 1; fi
echo "controle verde"
grep -E '^PASS=[0-9]+  FAIL=0$' <<<"$out" || { echo "FALHOU: controle sem linha PASS=n FAIL=0"; exit 1; }
echo "== re-aplicar e idempotente (PRE aceita o proprio corpo) =="
P -f "$MIG3" >/dev/null || { echo "FALHOU: re-aplicacao da migration abortou"; exit 1; }
echo "re-aplicacao ok"
echo "== PRE anti-deriva: corpo vivo desconhecido aborta =="
preparar_banco
P -f "$ANCORA1" >/dev/null; P -f "$ANCORA2" >/dev/null; P -f "$ANCORA3" >/dev/null
if o="$(P -f "$MIG3" 2>&1)"; then echo "FALHOU: PRE aceitou aplicar sem a 20261101190000 (inequivoco ausente)"; exit 1; fi
grep -qF "PRE FALHOU" <<<"$o" || { echo "FALHOU: PRE vermelha pelo motivo errado"; echo "$o" | head -3; exit 1; }
echo "PRE ok: sem o corpo de partida, aborta"

# Sabotagens mexem no CORPO: a PÓS (md5 do corpo) recusaria qualquer uma e a sabotagem "nao aplicaria". Nelas a PÓS
# sai (sed de "-- ── PÓS" ao fim); o controle acima roda a migration real com a PÓS.
sabotar() { # $1 nome, $2 expressao sed, $3 rotulo esperado (FALHOU: <rotulo> |)
  sed -e "$2" "$MIG3" | sed '/^-- ── PÓS/,$d' > "$TMPD/sab.sql"
  sed '/^-- ── PÓS/,$d' "$MIG3" > "$TMPD/sem-pos.sql"
  if cmp -s "$TMPD/sem-pos.sql" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -ge 98 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1; fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
echo "== controle do laco: a copia SEM a PÓS e sem sabotagem fica verde =="
sed '/^-- ── PÓS/,$d' "$MIG3" > "$TMPD/sem-pos.sql"
if ! o="$(suite "$TMPD/sem-pos.sql" 2>&1)"; then echo "$o"; echo "FALHOU: controle do laco vermelho (sabotagens nao provariam nada)"; exit 1; fi
echo "controle do laco verde"
echo "== falsificacoes =="
sabotar "1 motivo unidade_desconhecida removido" "s/CASE WHEN b.un_desconhecida THEN 'unidade_desconhecida' END,/NULL,/" "c 119 venda sem unidade aguarda"
sabotar "2 so a unidade da venda e checada" "s/OR nullif(trim(p.unidade), '') IS NULL)) AS un_desconhecida/)) AS un_desconhecida/" "c 120 estoque sem unidade com consumo aguarda"
sabotar "3 unidade em branco tratada como conhecida" "s/OR nullif(trim(p.unidade), '') IS NULL)) AS un_desconhecida/OR p.unidade IS NULL)) AS un_desconhecida/" "c 121 estoque com unidade em branco aguarda"
sabotar "4 bloqueia sem consumo a comparar" "s/bool_or(d.quantidade <> 0/bool_or(true/" "b 124 so linhas de quantidade zero sem unidade: sem consumo a comparar"
sabotar "5 divergencia CX x UN desligada" "s/AND upper(trim(d.sku_unidade)) IS DISTINCT FROM upper(trim(p.unidade))) AS un_divergente/AND false) AS un_divergente/" "c 117 CX x UN segue divergente (so ele)"
sabotar "6 comparacao sensivel a caixa" "s/AND upper(trim(d.sku_unidade)) IS DISTINCT FROM upper(trim(p.unidade))) AS un_divergente/AND trim(d.sku_unidade) IS DISTINCT FROM trim(p.unidade)) AS un_divergente/" "b 123 ' un ' = 'UN' (trim/caixa): nao e divergente"
sabotar "7 desconhecida volta a valer como igual (o bug)" "s/AND (nullif(trim(d.sku_unidade), '') IS NULL OR nullif(trim(p.unidade), '') IS NULL)) AS un_desconhecida/AND false) AS un_desconhecida/" "c 119 venda sem unidade aguarda"
echo "RAIO-X-INEQUIVOCO-UNIDADE-PROVA-OK"
