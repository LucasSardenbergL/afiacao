#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261018200000_fin_ciclo_giro_sku                                 ║
# ║  _fin_estoque_classe / fin_estoque_giro_valor / fin_ciclo_giro_sku              ║
# ║      bash db/test-fin-ciclo-giro-sku.sh > logs/t.log 2>&1; echo "exit=$?"       ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-giro-sku.sh  (2º ambiente)           ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + 1 sabotagem por camada, sobre CÓPIA da migration (o repo nunca é
# tocado). Asserções em ASCII, caixa fixa, sem -i. Valores esperados calculados à mão (comentados).
#
# Escolhas do preparo (espelham prod só no que a prova exige; tipos conferidos via psql-ro 2026-10-18):
#  - _fin_ciclo_gate_master: cópia do corpo de prod (a migration o CHAMA, não o cria).
#  - fin_user_can_access: stub do test-fin-ciclo-rpc.sh (master sem linha no stub = acesso total).
#  - private.cap_custo_ler: stub lendo fin_cap_stub. auth.role(): lê request.jwt.claims (o stub global
#    devolve NULL — sem isso o caminho service_role nunca seria exercido).
#  - v_sku_demanda_efetiva e v_pcp_malha_oben são TABELAS aqui (em prod são views; a RPC só as lê).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5476}"
SLUG="fin-ciclo-giro-sku"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261018200000_fin_ciclo_giro_sku.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_MASTER="11111111-1111-1111-1111-111111111111"
U_EMPLOYEE="22222222-2222-2222-2222-222222222222"
U_MASTER_SO_OBEN="33333333-3333-3333-3333-333333333333"
U_FINANCEIRO="44444444-4444-4444-4444-444444444444"

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.fin_permissoes_stub (user_id uuid, empresas text[]);
CREATE TABLE public.fin_cap_stub (user_id uuid);
CREATE TABLE public.inventory_position (account text, omie_codigo_produto bigint, product_id uuid, saldo numeric, cmc numeric);
CREATE TABLE public.omie_products (id uuid, omie_codigo_produto bigint, codigo text, descricao text, unidade text,
                                   familia text, tipo_produto text, account text);
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.v_pcp_malha_oben (pai_oben bigint, comp_oben bigint, quantidade numeric, unidade text);
CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, parametro_cold_start boolean);
CREATE TABLE public.sku_substituicao (empresa text, sku_codigo_antigo text, sku_codigo_novo text, status text, acao_parametros text);
CREATE TABLE public.cmc_ledger (account text, omie_codigo_produto bigint, observed_at timestamptz);

CREATE FUNCTION public._fin_ciclo_gate_master() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'CICLO_SO_MASTER' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._fin_ciclo_gate_master() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fin_user_can_access(check_company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p
                  WHERE p.user_id = auth.uid() AND check_company = ANY (p.empresas))
      OR (EXISTS (SELECT 1 FROM public.user_roles r
                   WHERE r.user_id = auth.uid() AND r.role IN ('master','employee'))
          AND NOT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid()))
$$;
CREATE FUNCTION private.cap_custo_ler(u uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.fin_cap_stub WHERE user_id = u)
$$;

-- Captura SO a SQLSTATE esperada (o resto propaga e derruba a prova). Roda como o chamador.
CREATE FUNCTION public.t_lanca(q text, estado text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = estado THEN RETURN SQLSTATE || '|' || SQLERRM; END IF;
  RAISE;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','employee');
INSERT INTO public.fin_permissoes_stub VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['oben']);
INSERT INTO public.fin_cap_stub VALUES ('44444444-4444-4444-4444-444444444444');

DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- Fonte OBEN: 362 dias de historico, ultima NF-e ha 2 dias.
  INSERT INTO venda_items_history VALUES ('OBEN', h-362), ('OBEN', h-2);
  -- Produtos (account EMPRESA em omie_products; account CONTA em inventory_position).
  INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, unidade, familia, tipo_produto, account) VALUES
    (md5('1001')::uuid,1001,'P1001','TINTA A','L','TINTAS','00','oben'),
    (md5('1002')::uuid,1002,'P1002','INSUMO MALHA','L','BASES','01','oben'),
    (md5('1003')::uuid,1003,'P1003','NUNCA SAIU','UN','LIXAS','00','oben'),
    (md5('1004')::uuid,1004,'P1004','COLD START','UN','LIXAS','00','oben'),
    (md5('1005')::uuid,1005,'P1005','COBERTURA 400','UN','LIXAS','00','oben'),
    (md5('1006')::uuid,1006,'P1006','SEM CUSTO','UN','LIXAS','00','oben'),
    (md5('1007')::uuid,1007,'P1007','MAQUINA','UN','Imobilizado','08','oben'),
    (md5('1008')::uuid,1008,'P1008','LUVA','UN','Uso e Consumo','00','oben'),
    (md5('1009')::uuid,1009,'P1009','PNEU','UN','PNEUS','99','oben'),
    (md5('1011')::uuid,1011,'P1011','SUBSTITUIDO','UN','LIXAS','00','oben'),
    (md5('1012')::uuid,1012,'P1012','COMPRA RECENTE','UN','LIXAS','00','oben'),
    (md5('1013')::uuid,1013,'P1013','UNIDADE DIVERGE','KG','BASES','01','oben'),
    (md5('1014')::uuid,1014,'P1014','SALDO ZERO','UN','LIXAS','00','oben'),
    (md5('1015')::uuid,1015,'P1015','SAIDA HA 300D','UN','LIXAS','00','oben'),
    (md5('2001')::uuid,2001,'P2001','COLACOR GIRO','UN','LIXAS','00','colacor');
  INSERT INTO inventory_position VALUES
    ('vendas',1001,md5('1001')::uuid,100,10),     -- 1000; consumo 365 -> 100.0 d; excedente (100-90)*10
    ('vendas',1002,md5('1002')::uuid,50,2),       -- 100; consumo 10 (malha) -> 1825.0 d; exc (50-10/365*90)*2=95.07
    ('vendas',1003,md5('1003')::uuid,5,100),      -- 500; nunca saiu -> liquidar
    ('vendas',1004,md5('1004')::uuid,1,7),        -- 7; cold start
    ('vendas',1005,md5('1005')::uuid,400,1),      -- 400; consumo 365 -> 400.0 d; exc 310.00
    ('vendas',1006,md5('1006')::uuid,3,0),        -- cmc 0 -> valor NULL
    ('vendas',1007,md5('1007')::uuid,1,1000),     -- fora 1000
    ('vendas',1008,md5('1008')::uuid,2,50),       -- fora 100 (familia), divergente
    ('vendas',1009,md5('1009')::uuid,4,25),       -- fora 100 (tipo 99), divergente
    ('vendas',1010,NULL,2,5),                     -- sem classificacao 10
    ('vendas',1011,md5('1011')::uuid,1,11),       -- substituido
    ('vendas',1012,md5('1012')::uuid,1,13),       -- compra recente
    ('vendas',1013,md5('1013')::uuid,10,1),       -- unidade divergente
    ('vendas',1014,md5('1014')::uuid,0,99),       -- fora do universo
    ('vendas',1015,md5('1015')::uuid,20,2),       -- 40; consumo 1 ha 300d -> 7300.0 d; liquidar; exc 39.51
    ('colacor_vendas',2001,md5('2001')::uuid,10,3),
    ('servicos',3001,NULL,1,9);
  INSERT INTO v_sku_demanda_efetiva VALUES
    ('OBEN',1001,200,h-10), ('OBEN',1001,165,h-100), ('OBEN',1001,999,h-400),
    ('OBEN',1002,10,h-5),
    ('OBEN',1005,365,h-30),
    ('OBEN',1013,4,h-5),
    ('OBEN',1015,1,h-300);
  INSERT INTO v_pcp_malha_oben VALUES (9001,1002,0.5,'L'), (9001,1013,0.1,'L');
  INSERT INTO sku_parametros VALUES ('OBEN',1004,true), ('OBEN',1003,false);
  INSERT INTO sku_substituicao VALUES ('OBEN','1011','1001','aplicada','consolidar_demanda');
  INSERT INTO cmc_ledger VALUES ('vendas',1012,now() - interval '30 days'), ('vendas',1003,now() - interval '200 days');
END $f$;
SQL
}

# Sessão simulada: $1 = claims JSON ('' = sem claims), $2 = SQL (uma consulta). Roda como authenticated.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then
      echo "SELECT set_config('request.jwt.claims', '$1', true) AS c \\gset"
    fi
    echo "$2;"
    echo "COMMIT;"
  } | Pq
}
cl() { echo "{\"sub\":\"$1\",\"role\":\"authenticated\"}"; }
CL_SERVICE='{"role":"service_role"}'

falhas=0
oks() { # $1 claims, $2 SQL, $3 esperado, $4 rótulo. Erro de psql vira valor distinto (nunca mascara).
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

LINHA="concat_ws('|', classe, coalesce(acao,'-'), coalesce(motivo_acao,'-'), coalesce(motivo_consumo,'-'), coalesce(valor_parado::text,'-'), coalesce(consumo_qtd_365d::text,'-'), coalesce(dias_cobertura::text,'-'), coalesce(valor_excedente::text,'-'), divergencia_cadastro::text)"
sku() { # $1 company, $2 código, $3 esperado
  oks "$(cl "$U_MASTER")" "SELECT $LINHA FROM public.fin_ciclo_giro_sku('$1') WHERE omie_codigo_produto = $2" "$3" "sku $2"
}
VAL="concat_ws('|', coalesce(valor_giro::text,'-'), coalesce(valor_fora_giro::text,'-'), coalesce(valor_sem_classificacao::text,'-'), skus_giro, skus_giro_com_custo, coalesce(cobertura_pct::text,'-'))"

suite() {
  falhas=0
  preparar_banco
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }

  # (a) linhas por SKU (oben, master)
  sku oben 1001 "giro|-|-|-|1000|365|100.0|100.00|false"
  sku oben 1002 "giro|segurar_compra|-|-|100|10|1825.0|95.07|false"
  sku oben 1003 "giro|liquidar|-|-|500|0|-|-|false"
  sku oben 1004 "giro|-|cold_start|-|7|0|-|-|false"
  sku oben 1005 "giro|segurar_compra|-|-|400|365|400.0|310.00|false"
  sku oben 1006 "giro|liquidar|-|-|-|0|-|-|false"
  sku oben 1007 "fora_giro|-|-|fora_do_giro|1000|-|-|-|false"
  sku oben 1008 "fora_giro|-|-|fora_do_giro|100|-|-|-|true"
  sku oben 1009 "fora_giro|-|-|fora_do_giro|100|-|-|-|true"
  sku oben 1010 "sem_classificacao|-|-|fora_do_giro|10|-|-|-|false"
  sku oben 1011 "giro|-|substituido|-|11|0|-|-|false"
  sku oben 1012 "giro|-|compra_recente|-|13|0|-|-|false"
  sku oben 1013 "giro|-|-|unidade_divergente|10|-|-|-|false"
  sku oben 1015 "giro|liquidar|-|-|40|1|7300.0|39.51|false"
  oks "$(cl "$U_MASTER")" "SELECT count(*) FROM public.fin_ciclo_giro_sku('oben')" "14" "oben 14 linhas (saldo 0 fora)"
  oks "$(cl "$U_MASTER")" "SELECT string_agg(omie_codigo_produto::text, ',') FROM (SELECT omie_codigo_produto FROM public.fin_ciclo_giro_sku('oben') LIMIT 2) t" "1001,1007" "ordem valor desc, codigo"
  oks "$(cl "$U_MASTER")" "SELECT (SELECT omie_codigo_produto FROM public.fin_ciclo_giro_sku('oben') OFFSET 13 LIMIT 1)::text" "1006" "sem custo por ultimo"
  oks "$(cl "$U_MASTER")" "SELECT ultima_saida = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 5 FROM public.fin_ciclo_giro_sku('oben') WHERE omie_codigo_produto = 1002" "t" "ultima saida inclui explosao pcp"
  sku colacor 2001 "giro|-|-|sem_consumo_por_sku|30|-|-|-|false"
  sku colacor_sc 3001 "sem_classificacao|-|-|fora_do_giro|9|-|-|-|false"

  # (b) gate 1: employee e sem claims
  oks "$(cl "$U_EMPLOYEE")" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_giro_sku(''oben'')', '42501')" "42501|CICLO_SO_MASTER" "b employee barrado"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_giro_sku(''oben'')', '42501')" "42501|CICLO_SO_MASTER" "b sem claims barrado"
  # (e) gate 2: master so-oben
  oks "$(cl "$U_MASTER_SO_OBEN")" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_giro_sku(''colacor'')', '42501')" "42501|CICLO_SEM_ACESSO_EMPRESA" "e gate2 colacor barrado"
  oks "$(cl "$U_MASTER_SO_OBEN")" "SELECT count(*) FROM public.fin_ciclo_giro_sku('oben')" "14" "e gate2 controle oben"
  oks "$(cl "$U_MASTER")" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_giro_sku(''xyz'')', 'P0001')" "P0001|empresa invalida: xyz" "empresa invalida"

  # (d) ACL
  okp "SELECT has_function_privilege('anon','public.fin_ciclo_giro_sku(text)','EXECUTE')" "f" "d anon sem EXECUTE giro_sku"
  okp "SELECT has_function_privilege('anon','public.fin_estoque_giro_valor(text)','EXECUTE')" "f" "d anon sem EXECUTE giro_valor"
  okp "SELECT has_function_privilege('authenticated','public._fin_estoque_classe(text,text)','EXECUTE')" "f" "d helper fechado"

  # (v) fin_estoque_giro_valor
  # giro oben = 1000+100+500+7+400+11+13+10+40 = 2081 (1006 sem custo fora da soma); 10 skus, 9 com custo.
  oks "$CL_SERVICE" "SELECT $VAL FROM public.fin_estoque_giro_valor('oben')" "2081|1200|10|10|9|90.00" "valor oben service_role"
  oks "$(cl "$U_FINANCEIRO")" "SELECT $VAL FROM public.fin_estoque_giro_valor('colacor')" "30|-|-|1|1|100.00" "valor colacor perfil financeiro"
  oks "$CL_SERVICE" "SELECT $VAL FROM public.fin_estoque_giro_valor('colacor_sc')" "-|-|9|0|0|-" "valor colacor_sc null"
  oks "$(cl "$U_EMPLOYEE")" "SELECT public.t_lanca('SELECT * FROM public.fin_estoque_giro_valor(''oben'')', '42501')" "42501|ESTOQUE_SEM_PERFIL_FINANCEIRO" "valor employee barrado"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.fin_estoque_giro_valor(''oben'')', '42501')" "42501|ESTOQUE_SEM_PERFIL_FINANCEIRO" "valor sem claims barrado"

  # (f) frescor da fonte: historico curto e fonte velha derrubam consumo/acao.
  Pq -c "DELETE FROM venda_items_history WHERE data_emissao < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 100" >/dev/null
  oks "$(cl "$U_MASTER")" "SELECT $LINHA FROM public.fin_ciclo_giro_sku('oben') WHERE omie_codigo_produto = 1003" "giro|-|-|consumo_incompleto|500|-|-|-|false" "fonte incompleta"
  Pq -c "INSERT INTO venda_items_history VALUES ('OBEN', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 362); DELETE FROM venda_items_history WHERE data_emissao > (now() AT TIME ZONE 'America/Sao_Paulo')::date - 20" >/dev/null
  oks "$(cl "$U_MASTER")" "SELECT $LINHA FROM public.fin_ciclo_giro_sku('oben') WHERE omie_codigo_produto = 1003" "giro|-|-|consumo_desatualizado|500|-|-|-|false" "fonte desatualizada"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — uma sabotagem por vez, vermelha PELA asserção esperada.
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
  echo "sabotagem vermelha ok: $1"
}
sabotar "1 sem gate master" \
  "/PERFORM public._fin_ciclo_gate_master();/d" \
  "b employee barrado"
sabotar "2 sem fin_user_can_access" \
  "s/IF NOT public.fin_user_can_access(lower(trim(p_company))) THEN/IF false THEN/" \
  "e gate2 colacor barrado"
sabotar "3 valor_parado com coalesce 0" \
  "s/           CASE WHEN m.cmc > 0 THEN m.saldo \* m.cmc END,/           coalesce(CASE WHEN m.cmc > 0 THEN m.saldo * m.cmc END, 0),/" \
  "sku 1006"
sabotar_post() { # $1 nome, $2 sed, $3 mensagem da postcondição — o apply TEM de abortar (rc=99) por ela.
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -ne 99 ] || ! grep -qF "$3" <<<"$o"; then
    echo "SABOTAGEM $1 NAO ABORTOU PELA POSTCONDICAO (rc=$r)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (postcondicao aborta o apply)"
}
sabotar_post "4 tipo 99 fora da lista" \
  "s/IN ('07', '08', '09', '99')/IN ('07', '08', '09')/" \
  "postcondicao: regra de classe divergente"
sabotar "4b tipo 99 fora da lista sem postcondicao" \
  "s/IN ('07', '08', '09', '99')/IN ('07', '08', '09')/;/OR public._fin_estoque_classe('99', NULL) <> 'fora_giro'/d" \
  "sku 1009"
sabotar "5 sem excecao de cold start" \
  "s/CASE WHEN m.cold_start OR m.compra_recente THEN NULL ELSE 'liquidar' END/CASE WHEN m.compra_recente THEN NULL ELSE 'liquidar' END/" \
  "sku 1004"
sabotar "6 sem excecao de compra recente" \
  "s/CASE WHEN m.cold_start OR m.compra_recente THEN NULL ELSE 'liquidar' END/CASE WHEN m.cold_start THEN NULL ELSE 'liquidar' END/" \
  "sku 1012"
sabotar "7 gate de historico vira so existencia" \
  "s/ELSIF v_min > v_hoje - c_fonte_min_historico_dias THEN/ELSIF false THEN/" \
  "fonte incompleta"
sabotar "8 sem gate de frescor" \
  "s/ELSIF v_max < v_hoje - c_fonte_max_atraso_dias THEN/ELSIF false THEN/" \
  "fonte desatualizada"
sabotar "9 sem unidade divergente" \
  "s/WHERE m.un IS DISTINCT FROM upper(trim(b.unidade))/WHERE false/" \
  "sku 1013"
sabotar "10 valor_giro com coalesce 0" \
  "s/      sum(saldo \* cmc) FILTER (WHERE classe = 'giro' AND cmc > 0),/      coalesce(sum(saldo * cmc) FILTER (WHERE classe = 'giro' AND cmc > 0), 0),/" \
  "valor colacor_sc null"
sabotar "11 giro_valor sem gate de perfil" \
  "s/IF NOT (coalesce(auth.role() = 'service_role', false)/IF false AND NOT (coalesce(auth.role() = 'service_role', false)/" \
  "valor employee barrado"
sabotar "12 substituido vira liquidar" \
  "s/WHEN m.mot_consumo IS NOT NULL OR m.substituido THEN NULL/WHEN m.mot_consumo IS NOT NULL THEN NULL/" \
  "sku 1011"

# 13) anon fora do REVOKE: a postcondição embutida aborta o apply (rc=99) — vermelho pelo motivo certo.
sabotar_post "13 anon fora do REVOKE" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_giro_sku(text) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_giro_sku(text) FROM PUBLIC;/" \
  "postcondicao: anon executa"
# 13b) idem + postcondição neutralizada: a asserção (d) é que precisa ficar vermelha.
sabotar "13b anon fora do REVOKE sem postcondicao" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_giro_sku(text) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_giro_sku(text) FROM PUBLIC;/;s/IF has_function_privilege('anon', f, 'EXECUTE') THEN/IF false THEN/" \
  "d anon sem EXECUTE giro_sku"

echo "PROVA-CICLO-GIRO-SKU-OK"
