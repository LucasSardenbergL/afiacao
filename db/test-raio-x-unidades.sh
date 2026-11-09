#!/usr/bin/env bash
# Prova PG17 — Raio-X "unidade comprovada antes de qualquer numero" (bug 3 da 2a revisao, money-path):
# raio_x_planejar so grava desconto/margem com unidade comprovada; raio_x_medicao devolve unidade do estoque e unidades
# das NFs desde a foto. Migration: supabase/migrations/20261103120000_raio_x_unidades.sql, sobre a cadeia
# 20261016120000 + 20261031130000 + 20261031180000 + 20261101120000 + 20261101190000.
# Rodar: bash db/test-raio-x-unidades.sh > log 2>&1; echo "exit=$?"   (2o ambiente: LOCALE=pt_BR.UTF-8)
# Controle verde na MESMA invocacao; sabotagens sobre COPIA da migration exigindo o FALHOU especifico. Asserts ASCII.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5477}"
SLUG="raio-x-unidades"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
ANCORA1="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"
ANCORA2="$REPO_ROOT/supabase/migrations/20261031130000_raio_x_correcoes_pos_revisao.sql"
ANCORA3="$REPO_ROOT/supabase/migrations/20261031180000_raio_x_plano_execucao.sql"
ANCORA4="$REPO_ROOT/supabase/migrations/20261101120000_raio_x_inequivoco.sql"
ANCORA5="$REPO_ROOT/supabase/migrations/20261101190000_raio_x_inequivoco_definer.sql"
MIG="$REPO_ROOT/supabase/migrations/20261103120000_raio_x_unidades.sql"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
U_STAFF="22222222-2222-2222-2222-222222222222"  # employee SEM commercial_role: nao le custo
U_EST="55555555-5555-5555-5555-555555555555"    # employee estrategico (chamador)

# Esqueleto de roles/stubs/fixtures = db/test-raio-x-inequivoco.sh (101 = inequivoco que vende em UN; 102 = sem venda).
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
dec() { echo "SELECT destino FROM public.raio_x_decidir($1)"; }
lanca() { echo "SELECT public.t_lanca('$1', '$2')"; }
helpers() {
  P <<'SQL'
CREATE FUNCTION public.t_v(e text, s bigint) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT atualizado_em FROM public.raio_x_decisao WHERE empresa = e AND sku_codigo_omie = s $$;
CREATE FUNCTION public.t_planejar(e text, s bigint, piso numeric) RETURNS SETOF public.raio_x_decisao LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.raio_x_planejar(e, s, piso, NULL, NULL, NULL, false, public.t_v(e, s), NULL, NULL);
END $$;
SQL
}
# piso|desconto|margem|medio_base|cmc_base
PLANO() { echo "SELECT coalesce(preco_piso::text,'N') || '|' || coalesce(desconto_sobre_medio_pct::text,'N') || '|' || coalesce(margem_unit::text,'N') || '|' || coalesce(preco_medio_base::text,'N') || '|' || coalesce(cmc_base::text,'N') FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }
# unidade_estoque|unidades desde a foto (ordenadas; '' = unidade nula na NF)
UNID() { echo "SELECT coalesce(unidade_estoque,'N') || '|' || coalesce(array_to_string(unidades_venda_periodo, ','),'N') FROM public.raio_x_medicao('$1') WHERE sku_codigo_omie = $2"; }
venda() { P -c "INSERT INTO public.v_venda_items_history_efetivo (empresa, data_emissao, cliente_codigo_omie, sku_codigo_omie, sku_unidade, quantidade, valor_total) VALUES ('OBEN', current_date + ($2), 1, $1, $3, $4, $5);" >/dev/null; }

suite() {
  falhas=0
  passes=0
  preparar_banco
  for a in "$ANCORA1" "$ANCORA2" "$ANCORA3" "$ANCORA4" "$ANCORA5"; do
    P -f "$a" >/dev/null || { echo "ANCORA FALHOU: $a"; return 98; }
  done
  P -f "$1" >/dev/null || { echo "APLICACAO FALHOU: $1"; return 99; }
  helpers >/dev/null || { echo "HELPERS FALHARAM"; return 98; }

  # decisoes (passam no RX004: 101 e 102 sao inequivocos nas fixtures)
  oks "$U_EST" "$(dec "'oben', 101, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "liquidar" "z decidir 101 liquidar"
  oks "$U_EST" "$(dec "'oben', 102, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "liquidar" "z decidir 102 liquidar"

  # ---------- (a) controle positivo: vende em UN, estoca em UN ----------
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 101, 15)" "a plano 101"
  okp "$(PLANO oben 101)" "15|0.2500|5.0000|20.0000|10" "a UN=UN: desconto 1-15/20 e margem 15-10"

  # ---------- (d) sem venda nenhuma: nada prova a unidade ----------
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 102, 8)" "d plano 102"
  okp "$(PLANO oben 102)" "8|N|N|N|10" "d sem venda: margem e desconto NULL (nada prova a unidade), CMC segue como base"

  # ---------- (b) vende so em CX, estoca em UN ----------
  venda 102 -10 "'CX'" 4 400
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 102, 80)" "b plano 102 em CX"
  okp "$(PLANO oben 102)" "80|0.2000|N|100.0000|10" "b CX: desconto na propria unidade de venda, margem NULL (CX diferente de UN)"

  # ---------- (c) unidades misturadas em 12m ----------
  venda 101 -5 "'CX'" 1 50
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 101, 15)" "c2 plano 101 mesmo piso"
  okp "$(PLANO oben 101)" "15|N|N|20.0000|10" "c2 mesmo piso com unidades misturadas: base congelada, desconto e margem NULL"
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 101, 14)" "c plano 101 misturado"
  okp "$(PLANO oben 101)" "14|N|N|N|10" "c UN e CX em 12m: desconto, margem e medio NULL"

  # ---------- (e) unidade nula na NF nao prova nada ----------
  P -c "UPDATE public.v_venda_items_history_efetivo SET sku_unidade = NULL WHERE sku_codigo_omie = 102;" >/dev/null
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 102, 70)" "e plano 102 unidade nula"
  okp "$(PLANO oben 102)" "70|N|N|N|10" "e NF sem unidade: desconto e margem NULL"

  # ---------- (f) medicao: unidade do estoque e unidades desde a foto (foto = hoje; vendas de amanha) ----------
  venda 101 1 "'UN'" 2 40
  venda 101 1 "NULL" 1 20
  venda 102 1 "'CX'" 1 100
  oks "$U_EST" "$(UNID oben 101)" "UN|,UN" "f medicao 101: UN e NF sem unidade desde a foto (nula vira vazio)"
  oks "$U_EST" "$(UNID oben 102)" "UN|CX" "f medicao 102: CX desde a foto (antes da foto nao entra)"
  oks "$U_EST" "SELECT qtd_vendida FROM public.raio_x_medicao('oben') WHERE sku_codigo_omie = 101" "3" "f quantidade desde a foto intacta"
  # medio 12m: 101 vendeu UN e CX em 12m (e uma NF sem unidade) -> NULL; 102 so CX (estoque UN) -> NULL
  oks "$U_EST" "SELECT coalesce(preco_medio_12m::text,'N') FROM public.raio_x_medicao('oben') WHERE sku_codigo_omie = 101" "N" "f medio 12m com unidades misturadas e NULL"
  oks "$U_EST" "SELECT coalesce(preco_medio_12m::text,'N') FROM public.raio_x_medicao('oben') WHERE sku_codigo_omie = 102" "N" "f medio 12m em CX com estoque UN e NULL"
  P -c "DELETE FROM public.v_venda_items_history_efetivo WHERE sku_codigo_omie = 101 AND (sku_unidade IS DISTINCT FROM 'UN');" >/dev/null
  oks "$U_EST" "SELECT preco_medio_12m FROM public.raio_x_medicao('oben') WHERE sku_codigo_omie = 101" "20.0000" "f medio 12m so em UN = estoque vale (controle positivo)"
  oks "$U_EST" "$(dec "'colacor', 201, 'trocar', 'mercadoria', NULL, 'Forn', 10, false, false")" "trocar" "f decidir colacor 201"
  oks "$U_EST" "$(UNID colacor 201)" "UN|N" "f colacor: sem NF, unidades NULL (nunca lista vazia fingindo prova)"
  # ---------- (g) gate e ACL ----------
  oks "$U_STAFF" "$(lanca "SELECT count(*) FROM public.raio_x_medicao(''oben'')" 42501)" "42501" "g staff sem custo 42501 na medicao"
  okp "SELECT has_function_privilege('anon', 'public.raio_x_medicao(text)', 'EXECUTE')" "f" "g anon nao executa medicao"
  okp "SELECT has_function_privilege('authenticated', 'public.raio_x_medicao(text)', 'EXECUTE')" "t" "g authenticated executa medicao"

  echo "PASS=$passes  FAIL=$falhas"
  [ "$falhas" -eq 0 ] || { echo "falhas=$falhas"; return 1; }
  return 0
}

echo "== controle (migration real) =="
if ! out="$(suite "$MIG" 2>&1)"; then echo "$out"; echo "CONTROLE VERMELHO"; exit 1; fi
echo "controle verde"
grep -E '^PASS=[0-9]+  FAIL=0$' <<<"$out" || { echo "FALHOU: controle sem linha PASS=n FAIL=0"; exit 1; }
for f in 'public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz,numeric,text)' 'public.raio_x_medicao(text)'; do
  m="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$f'::regprocedure")"
  grep -qF "$m" "$MIG" || { echo "FALHOU: a PRE/POS da migration nao conhece o proprio corpo de $f (md5 $m)"; exit 1; }
done
echo "== re-aplicar e idempotente (PRE aceita o proprio corpo) =="
P -f "$MIG" >/dev/null || { echo "RE-APLICACAO FALHOU"; exit 1; }

sabotar() { # $1 nome, $2 expressao sed, $3 rotulo esperado (FALHOU: <rotulo> |)
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  # o md5 do corpo sabotado nao e o da PRE/POS: neutraliza so essas guardas (a prova e do comportamento)
  sed -i.bak -e "s/NOT IN ('1bf86bd2fa624d5497099cad81726fcc', '[0-9a-f]*')/IS NULL/" -e "s/NOT IN ('7b7f4b18ca51bbec7804e38c9c3e6d6d', '[0-9a-f]*')/IS NULL/" \
    -e "s/IS DISTINCT FROM '[0-9a-f]\{32\}' THEN/IS NULL THEN/" "$TMPD/sab.sql"
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -ge 98 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1; fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
echo "== falsificacoes =="
sabotar "1 margem sem prova de unidade" "s/AND v_cmc IS NOT NULL AND v_un_equiv THEN/AND v_cmc IS NOT NULL THEN/" "b CX: desconto na propria unidade de venda, margem NULL (CX diferente de UN)"
sabotar "2 desconto com unidades misturadas" "s/AND v_pm12 > 0 AND v_venda_unica THEN/AND v_pm12 > 0 THEN/" "c2 mesmo piso com unidades misturadas: base congelada, desconto e margem NULL"
sabotar "3 medio misturado vira base" "s/      v_pm12 := NULL;/      v_pm12 := v_pm12;/" "c UN e CX em 12m: desconto, margem e medio NULL"
sabotar "4 unidade nula some da lista da medicao" "s/array_agg(DISTINCT coalesce(vh.sku_unidade, ''))/array_agg(DISTINCT vh.sku_unidade)/" "f medicao 101: UN e NF sem unidade desde a foto (nula vira vazio)"
sabotar "5 sem venda conta como prova (margem fabricada)" "s/v_un_equiv := coalesce(v_un_hist = 1 AND v_uv_hist <> '' AND v_uv_hist = v_ue, false);/v_un_equiv := coalesce(v_uv_hist = v_ue, true);/" "d sem venda: margem e desconto NULL (nada prova a unidade), CMC segue como base"
sabotar "6 janela da unidade ignora a foto" "s/array_agg(DISTINCT coalesce(vh.sku_unidade, '')) FILTER (WHERE vh.data_emissao > d.dia)/array_agg(DISTINCT coalesce(vh.sku_unidade, ''))/" "f medicao 102: CX desde a foto (antes da foto nao entra)"
sabotar "7 medio 12m sem prova de unidade" "s/WHEN v.n_un12 = 1 AND v.un12 <> '' AND v.un12 = u.unidade THEN round(v.pm12::numeric, 4)/WHEN true THEN round(v.pm12::numeric, 4)/" "f medio 12m com unidades misturadas e NULL"
echo "RAIO-X-UNIDADES-PROVA-OK"
