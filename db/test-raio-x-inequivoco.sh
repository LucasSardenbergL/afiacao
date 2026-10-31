#!/usr/bin/env bash
# Prova PG17 — Raio-X "liquidar so o inequivoco": raio_x_inequivoco (regra inteira no servidor), RX004 em raio_x_decidir,
# raio_x_planejar v2 (frete/contrapartida/bases congeladas) e raio_x_medicao com troca_contrapartida.
# Migration: supabase/migrations/20261101120000_raio_x_inequivoco.sql (sobre as ancoras 20261016120000 + 20261031130000
# + 20261031180000). Rodar: bash db/test-raio-x-inequivoco.sh > log 2>&1; echo "exit=$?"
# Lei de Ferro: fixtures com UM impedimento cada (Codex desenho P1-10: fixture com varios impedimentos nao prova nenhum),
# controle verde na MESMA invocacao, sabotagens sobre COPIA da migration exigindo o FALHOU ESPECIFICO. LOCALE=C|pt_BR.UTF-8.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5478}"
SLUG="raio-x-inequivoco"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
ANCORA1="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"
ANCORA2="$REPO_ROOT/supabase/migrations/20261031130000_raio_x_correcoes_pos_revisao.sql"
ANCORA3="$REPO_ROOT/supabase/migrations/20261031180000_raio_x_plano_execucao.sql"
MIG="$REPO_ROOT/supabase/migrations/20261101120000_raio_x_inequivoco.sql"
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
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc character(1), tipo_reposicao text,
  habilitado_reposicao_automatica boolean, parametro_cold_start boolean);
CREATE TABLE public.v_venda_items_history_efetivo (empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, t4_data_recebimento timestamptz);
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
 (201,'C201','COLACOR PARADO','UN',true,'Vernizes','colacor','00', now() - interval '400 days');
-- 111 = sem cadastro (so estoque)
INSERT INTO public.inventory_position VALUES
 (101,100,10,10,'oben',now()), (102,100,10,10,'oben',now()), (103,100,10,10,'oben',now()), (104,100,10,10,'oben',now()),
 (105,100,10,10,'oben',now()), (106,100,10,10,'oben',now()), (107,100,10,10,'oben',now()), (108,100,10,10,'oben',now()),
 (109,100,10,10,'oben',now()), (110,0,10,10,'oben',now()), (111,100,10,10,'oben',now()), (112,100,10,10,'oben',now()),
 (113,100,10,10,'oben',now()), (114,100,10,10,'oben',now()), (115,100,10,10,'oben',now()), (116,100,10,10,'oben',now()),
 (201,100,10,10,'colacor_vendas',now());
-- consumo 365d: 90 un (cobertura 405d) em todos menos 102 (0) e 103 (100 un = exatamente 365d)
INSERT INTO public.v_sku_demanda_efetiva
  SELECT 'OBEN', s, 1, current_date - g FROM unnest(ARRAY[101,104,105,106,107,108,109,111,112,113,114,115,116]) s, generate_series(1, 360, 4) g;
INSERT INTO public.v_sku_demanda_efetiva SELECT 'OBEN', 103, 1, current_date - g FROM generate_series(1, 300, 3) g;
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
oks() { # $1 uuid, $2 SQL, $3 esperado, $4 rotulo
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi; }
run() { local got; got="$(sess "$U_EST" "$1" 2>&1)" || { echo "FALHOU: $2 | ERRO-PSQL: $got"; falhas=$((falhas+1)); }; }
# linha do inequivoco: inequivoco|motivos|cobertura|qtd_liquidavel
INEQ() { echo "SELECT coalesce(inequivoco::text,'N') || '|' || CASE WHEN cardinality(motivos_espera) = 0 THEN '-' ELSE array_to_string(motivos_espera, ',') END || '|' || coalesce(cobertura_dias::text,'N') || '|' || coalesce(round(qtd_liquidavel,1)::text,'N') FROM public.raio_x_inequivoco('$1') WHERE sku_codigo_omie = $2"; }
dec() { echo "SELECT destino FROM public.raio_x_decidir($1)"; }
lanca() { echo "SELECT public.t_lanca('$1', '$2')"; }
helpers() {
  P <<'SQL'
CREATE FUNCTION public.t_v(e text, s bigint) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT atualizado_em FROM public.raio_x_decisao WHERE empresa = e AND sku_codigo_omie = s $$;
CREATE FUNCTION public.t_planejar(e text, s bigint, piso numeric, canal text, resp uuid, prazo date, concl boolean, frete numeric, contra text)
RETURNS SETOF public.raio_x_decisao LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.raio_x_planejar(e, s, piso, canal, resp, prazo, concl, public.t_v(e, s), frete, contra);
END $$;
-- cliente ANTIGO (8 argumentos): tem de resolver na funcao nova pelos DEFAULTs
CREATE FUNCTION public.t_planejar8(e text, s bigint, piso numeric, canal text, resp uuid, prazo date, concl boolean)
RETURNS SETOF public.raio_x_decisao LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.raio_x_planejar(e, s, piso, canal, resp, prazo, concl, public.t_v(e, s));
END $$;
SQL
}
PLANO() { echo "SELECT coalesce(preco_piso::text,'N') || '|' || coalesce(frete_estimado::text,'N') || '|' || coalesce(desconto_sobre_medio_pct::text,'N') || '|' || coalesce(margem_unit::text,'N') || '|' || coalesce(preco_medio_base::text,'N') || '|' || coalesce(cmc_base::text,'N') || '|' || coalesce(troca_contrapartida,'N') FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }

suite() {
  falhas=0
  preparar_banco
  P -f "$ANCORA1" >/dev/null || { echo "ANCORA1 FALHOU"; return 98; }
  P -f "$ANCORA2" >/dev/null || { echo "ANCORA2 FALHOU"; return 98; }
  P -f "$ANCORA3" >/dev/null || { echo "ANCORA3 FALHOU"; return 98; }
  # decisoes de partida ANTES da regra nova: 104 (corante) ja 'liquidar' — a regra nao pode tornar orfa a liquidacao antiga
  run "$(dec "'oben', 104, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "z 104 liquidar antes da regra"
  P -f "$1" >/dev/null || { echo "APLICACAO FALHOU: $1"; return 99; }
  helpers >/dev/null || { echo "HELPERS FALHARAM"; return 98; }

  # ---------- (a) gate ----------
  oks "$U_STAFF" "$(lanca "SELECT count(*) FROM public.raio_x_inequivoco(''oben'')" 42501)" "42501" "a staff sem custo 42501"
  oks "$U_EST" "$(lanca "SELECT count(*) FROM public.raio_x_inequivoco(''acme'')" 22023)" "22023" "a empresa invalida 22023"

  # ---------- (b) controles positivos ----------
  oks "$U_EST" "$(INEQ oben 101)" "true|-|405.6|77.8" "b 101 parado 405d inequivoco (liquidavel preserva 90d de consumo)"
  oks "$U_EST" "$(INEQ oben 102)" "true|-|N|100.0" "b 102 sem consumo inequivoco (sem divisao por zero; liquidavel = saldo)"
  # ---------- (c) um impedimento por fixture ----------
  oks "$U_EST" "$(INEQ oben 103)" "false|cobertura_abaixo_365|365.0|N" "c 103 cobertura exatamente 365 aguarda"
  oks "$U_EST" "$(INEQ oben 104)" "false|corante|405.6|N" "c 104 corante aguarda"
  oks "$U_EST" "$(INEQ oben 105)" "false|entrada_recente|405.6|N" "c 105 recebimento real ha 10d (CMC inalterado) aguarda"
  oks "$U_EST" "$(INEQ oben 106)" "false|entrada_recente|405.6|N" "c 106 NF de entrada ha 30d aguarda"
  oks "$U_EST" "$(INEQ oben 115)" "false|entrada_recente|405.6|N" "c 115 observacao do ledger ha 5d aguarda (precisao > recall)"
  oks "$U_EST" "SELECT revisar_em = current_date + 80 FROM public.raio_x_inequivoco('oben') WHERE sku_codigo_omie = 105" "t" "c 105 revisar_em = entrada + 90d"
  oks "$U_EST" "$(INEQ oben 107)" "false|cold_start|405.6|N" "c 107 cold start aguarda"
  oks "$U_EST" "$(INEQ oben 108)" "false|substituido|405.6|N" "c 108 substituido aguarda"
  oks "$U_EST" "$(INEQ oben 109)" "false|nao_mercadoria|405.6|N" "c 109 tipo 07 nao e mercadoria"
  oks "$U_EST" "$(INEQ oben 116)" "false|nao_mercadoria|405.6|N" "c 116 descricao MAQUINA nao e mercadoria"
  oks "$U_EST" "SELECT count(*) FROM public.raio_x_inequivoco('oben') WHERE sku_codigo_omie = 110" "0" "c 110 saldo zero fora dos candidatos"
  oks "$U_EST" "$(INEQ oben 111)" "false|cadastro_incompleto|405.6|N" "c 111 sem cadastro aguarda (desconhecido != elegivel)"
  oks "$U_EST" "$(INEQ oben 112)" "false|cadastro_recente|405.6|N" "c 112 cadastro ha 10d aguarda"
  oks "$U_EST" "$(INEQ oben 114)" "false|corante,cold_start|405.6|N" "c 114 TODOS os motivos (corante E cold)"
  # manual vence a regra: 113 e tipo 07 mas classificado mercadoria a mao
  run "SELECT sku_codigo_omie FROM public.raio_x_classificar('oben', 113, 'mercadoria', 'e produto de venda')" "c classificar 113"
  oks "$U_EST" "$(INEQ oben 113)" "true|-|405.6|77.8" "c 113 manual mercadoria vence o tipo 07"
  # colacor: sem NF nao ha prova de nada
  oks "$U_EST" "$(INEQ colacor 201)" "false|sem_nf|N|N" "c colacor aguarda sem_nf"
  # fonte desatualizada: tudo aguarda
  P -c "UPDATE public.venda_items_history SET data_emissao = current_date - 30 WHERE data_emissao = current_date - 1;" >/dev/null
  oks "$U_EST" "$(INEQ oben 101)" "false|fonte_consumo_desatualizada|N|N" "c fonte velha: 101 deixa de ser inequivoco"
  P -c "UPDATE public.venda_items_history SET data_emissao = current_date - 1 WHERE data_emissao = current_date - 30;" >/dev/null
  # p_sku filtra
  oks "$U_EST" "SELECT count(*) FROM public.raio_x_inequivoco('oben', 101)" "1" "c p_sku restringe o universo"

  # ---------- (d) RX004: liquidar NOVO so no inequivoco ----------
  oks "$U_EST" "$(lanca "SELECT * FROM public.raio_x_decidir(''oben'', 105, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false)" RX004)" "RX004" "d liquidar 105 (entrada recente) RX004"
  okp "SELECT count(*) FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=105" "0" "d RX004 nao deixa linha-base"
  oks "$U_EST" "$(dec "'oben', 101, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "liquidar" "d liquidar 101 inequivoco passa"
  oks "$U_EST" "$(dec "'oben', 105, 'trocar', 'mercadoria', NULL, 'Forn', 50, false, false")" "trocar" "d trocar 105 passa (regra e so do liquidar)"
  oks "$U_EST" "$(dec "'oben', 104, 'liquidar', 'mercadoria', 'obs nova', NULL, NULL, false, false")" "liquidar" "d re-salvar liquidacao antiga do 104 (destino nao mudou) passa"
  oks "$U_EST" "$(dec "'oben', 104, 'estrategico', 'mercadoria', NULL, NULL, NULL, false, false")" "estrategico" "d 104 muda para estrategico"
  oks "$U_EST" "$(lanca "SELECT * FROM public.raio_x_decidir(''oben'', 104, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false)" RX004)" "RX004" "d 104 voltar a liquidar agora e NOVO -> RX004"

  # ---------- (e) planejar v2: frete, bases congeladas, contrapartida ----------
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 101, 15, 'outlet_queima', '$U_STAFF', '2026-12-01', false, 120, NULL)" "e plano liquidar com frete"
  okp "$(PLANO oben 101)" "15|120|0.2500|5.0000|20.0000|10|N" "e desconto 1-15/20, margem 15-10, bases congeladas"
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 105, NULL, NULL, '$U_STAFF', NULL, false, NULL, 'encalhe')" "e contrapartida na troca"
  okp "$(PLANO oben 105)" "N|N|N|N|N|N|encalhe" "e contrapartida gravada"
  oks "$U_EST" "$(lanca "SELECT * FROM public.t_planejar(''oben'', 105, NULL, NULL, NULL, NULL, false, 10, NULL)" 22023)" "22023" "e frete fora do liquidar 22023"
  oks "$U_EST" "$(lanca "SELECT * FROM public.t_planejar(''oben'', 101, 15, NULL, NULL, NULL, false, NULL, ''giro'')" 22023)" "22023" "e contrapartida fora do trocar 22023"
  oks "$U_EST" "$(lanca "SELECT * FROM public.t_planejar(''oben'', 101, 15, NULL, NULL, NULL, false, -1, NULL)" 22023)" "22023" "e frete negativo 22023"
  oks "$U_EST" "$(lanca "SELECT * FROM public.t_planejar(''oben'', 105, NULL, NULL, NULL, NULL, false, NULL, ''x'')" 22023)" "22023" "e contrapartida invalida 22023"
  run "SELECT sku_codigo_omie FROM public.t_planejar8('oben', 101, 12, 'outro', NULL, NULL, false)" "e cliente antigo de 8 args resolve na funcao nova"
  okp "$(PLANO oben 101)" "12|N|0.4000|2.0000|20.0000|10|N" "e 8 args: frete limpo, desconto recalculado nas bases"
  # sem venda em 12m (102): desconto DESCONHECIDO, nao 0
  run "$(dec "'oben', 102, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "e 102 liquidar"
  run "SELECT sku_codigo_omie FROM public.t_planejar('oben', 102, 8, NULL, NULL, NULL, false, NULL, NULL)" "e plano 102"
  okp "$(PLANO oben 102)" "8|N|N|-2.0000|N|10|N" "e sem medio: desconto NULL (nunca 0); margem negativa visivel"

  # ---------- (f) medicao devolve a contrapartida ----------
  oks "$U_EST" "SELECT coalesce(troca_contrapartida,'N') FROM public.raio_x_medicao('oben') WHERE sku_codigo_omie = 105" "encalhe" "f medicao traz troca_contrapartida"
  oks "$U_EST" "SELECT count(*) FROM public.raio_x_medicao('oben') WHERE destino IS NOT NULL" "4" "f medicao lista as 4 decisoes"

  [ "$falhas" -eq 0 ] || { echo "falhas=$falhas"; return 1; }
  return 0
}

echo "== controle (migration real) =="
if ! out="$(suite "$MIG" 2>&1)"; then echo "$out"; echo "CONTROLE VERMELHO"; exit 1; fi
echo "controle verde"
MD5_NOVO="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)'::regprocedure")"
echo "md5 do raio_x_decidir desta migration: $MD5_NOVO"
if ! grep -qF "$MD5_NOVO" "$MIG"; then echo "FALHOU: a PRE da migration nao aceita o proprio corpo (md5 $MD5_NOVO ausente) — re-rodar a migration abortaria"; exit 1; fi
echo "== re-aplicar e idempotente (PRE aceita o proprio corpo) =="
P -f "$MIG" >/dev/null || { echo "RE-APLICACAO FALHOU"; exit 1; }

sabotar() { # $1 nome, $2 expressao sed, $3 rotulo esperado (FALHOU: <rotulo> |)
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -ge 98 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1; fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
echo "== falsificacoes =="
sabotar "1 corante nao segura" "s/CASE WHEN b.corante THEN 'corante' END,/NULL,/" "c 104 corante aguarda"
sabotar "2 entrada recente nao segura" "s/CASE WHEN b.ultima IS NOT NULL AND b.ultima >= v_hoje - c_entrada_dias THEN 'entrada_recente' END,/NULL,/" "c 105 recebimento real ha 10d (CMC inalterado) aguarda"
sabotar "3 cold start nao segura" "s/CASE WHEN b.cold THEN 'cold_start' END,/NULL,/" "c 107 cold start aguarda"
sabotar "4 substituido nao segura" "s/CASE WHEN b.subst THEN 'substituido' END,/NULL,/" "c 108 substituido aguarda"
sabotar "5 cobertura 365 exata passa (<= vira <)" "s/AND b.cob <= c_cobertura_dias THEN/AND b.cob < c_cobertura_dias THEN/" "c 103 cobertura exatamente 365 aguarda"
sabotar "6 manual nao vence" "s/SELECT b.\*, CASE WHEN b.manual IS NOT NULL THEN b.manual = 'mercadoria' ELSE b.merc_regra END AS merc/SELECT b.*, b.merc_regra AS merc/" "c 113 manual mercadoria vence o tipo 07"
sabotar "7 RX004 removido (liquidar fora do inequivoco passa)" "s/IF p_destino = 'liquidar' AND v_mudou/IF false AND v_mudou/" "d liquidar 105 (entrada recente) RX004"
sabotar "8 ledger ignorado como entrada" "s/WHERE cl.account = CASE p_empresa WHEN 'oben' THEN 'vendas' ELSE 'colacor_vendas' END/WHERE false/" "c 115 observacao do ledger ha 5d aguarda (precisao > recall)"
sabotar "9 desconto fabricado 0 sem medio" "s/AND v_pm12 > 0 THEN round(1 - p_preco_piso \/ v_pm12, 4) END,/THEN coalesce(round(1 - p_preco_piso \/ nullif(v_pm12,0), 4), 0) END,/" "e sem medio: desconto NULL (nunca 0); margem negativa visivel"
echo "RAIO-X-INEQUIVOCO-PROVA-OK"
