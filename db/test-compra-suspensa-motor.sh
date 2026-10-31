#!/usr/bin/env bash
# Prova PG17 — "SEGURAR COMPRA" escreve no motor: reposicao_compra_suspensa + RPCs + gerar_pedidos_sugeridos_ciclo.
# Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md (§6)
# Rodar: bash db/test-compra-suspensa-motor.sh > log 2>&1; echo "exit=$?"   (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica a MIGRATION REAL (20261101090000 — RPCs + motor + cauda); asserts por valor; FALSIFICA
# (sabota a fixture -> exige o SKU SUSPENSO DENTRO DO PEDIDO, nao "erro SQL" -> restaura -> re-verde).
# Papeis REAIS: RPCs rodam sob SET LOCAL ROLE authenticated + request.jwt.claims (sub); gate sem JWT via login
# 'authenticator' (session_user real do PostgREST). Sentinelas ASCII, caixa fixa; rode em LC_ALL=C e pt_BR.UTF-8.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="compra-suspensa"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
: "${LC_ALL:=C}"; export LC_ALL LANG="$LC_ALL"
MIG="$REPO_ROOT/supabase/migrations/20261101090000_reposicao_compra_suspensa.sql"
FIXTURE="$REPO_ROOT/db/embalagem-motor-rpc.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose "$@"; }
Pq() { P -qtA "$@"; }
# conexao REAL como authenticator (session_user do PostgREST) — para provar o gate sem JWT
PA() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U authenticator -d prove -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

U_MASTER='11111111-0000-0000-0000-000000000001'   # cap ler + escrever
U_LEITOR='11111111-0000-0000-0000-000000000002'   # so cap ler
U_NADA='11111111-0000-0000-0000-000000000003'     # sem cap

echo "=== setup PG17 :$PORT ==="

# ── ZONA 1: roles/schemas que a MIGRATION exige + stubs (espelham a prod no que as funcoes leem) ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT; GRANT authenticated TO authenticator; GRANT anon TO authenticator;
CREATE SCHEMA auth;
-- auth.uid() como o Supabase: le o sub dos claims da sessao (NULL sem JWT)
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE SCHEMA private;
CREATE TABLE public.cap_stub (user_id uuid PRIMARY KEY, ler boolean NOT NULL, escrever boolean NOT NULL);
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT ler FROM public.cap_stub WHERE user_id = p), false) $$;
CREATE FUNCTION private.cap_compras_escrever(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce((SELECT escrever FROM public.cap_stub WHERE user_id = p), false) $$;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid), private.cap_compras_escrever(uuid) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- helpers da 20261018200000 (fin_ciclo_giro_sku) que a foto reutiliza — mesma regra, provada la
CREATE FUNCTION public._fin_estoque_account(p_company text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; BEGIN
  v := CASE lower(trim(p_company)) WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v IS NULL THEN RAISE EXCEPTION 'empresa invalida: %', p_company USING ERRCODE = 'P0001'; END IF;
  RETURN v; END $$;
CREATE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(trim(p_familia)) IN ('uso e consumo','imobilizado') THEN 'fora_giro'
              WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
              WHEN trim(p_tipo) IN ('07','08','09','99') THEN 'fora_giro' ELSE 'giro' END $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text, valor_vendido_90d numeric);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric, fonte_sync text);
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean,
  unidades_omie_por_embalagem numeric);  -- [UNIDADES #2849] o motor le a coluna
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean,
  fator_conversao numeric NOT NULL DEFAULT 1);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'rascunho', account text NOT NULL DEFAULT 'oben', hash_payload text, omie_numero_pedido text,
  omie_reconciliado_em timestamptz, deleted_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, capados_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric, lt_logistica_dias int);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric NOT NULL DEFAULT 0, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric, fator_embalagem_portal numeric, qtde_sem_teto numeric,
  teto_cobertura_aplicado boolean, estoque_comprometido numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
CREATE TABLE public.reposicao_teto_cobertura_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, classe_abc text, teto_dias numeric, demanda_diaria numeric,
  estoque_efetivo numeric, ponto_pedido numeric, estoque_maximo numeric, cap_teto_ancora numeric, qtde_sem_teto numeric, qtde_final numeric, motivo text);
-- fontes da FOTO (consumo efetivo e substituicao) — tabela no lugar da view: mesma assinatura lida
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.sku_substituicao (id bigserial, empresa text, sku_codigo_antigo text, sku_codigo_novo text, acao_parametros text, status text);
-- o motor e INVOKER: o staff (authenticated) le/escreve estas tabelas no "Recalcular" — GRANT como na prod
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pedido_compra_sugerido, public.pedido_compra_item, public.reposicao_motor_run,
  public.reposicao_estoque_nao_confirmado_log, public.reposicao_teto_cobertura_log TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
SQL
echo "stubs criados"

# ── ZONA 2: aplicar a MIGRATION REAL ──
P -q -f "$MIG"
echo "migration aplicada"

eq "decisao criada com RLS" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE relname='reposicao_compra_suspensa'")" "t"
eq "log criado com RLS" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE relname='reposicao_compra_suspensa_log'")" "t"
eq "policies (1 decisao + 2 log)" "$(Pq -c "SELECT (SELECT count(*) FROM pg_policy WHERE polrelid='public.reposicao_compra_suspensa'::regclass) || '+' || (SELECT count(*) FROM pg_policy WHERE polrelid='public.reposicao_compra_suspensa_log'::regclass)")" "1+2"
eq "authenticated NAO insere na decisao" "$(Pq -c "SELECT has_table_privilege('authenticated','public.reposicao_compra_suspensa','INSERT')")" "f"
eq "anon NAO executa suspender" "$(Pq -c "SELECT has_function_privilege('anon','public.reposicao_compra_suspender(text,bigint[],text,date,text,uuid)','EXECUTE')")" "f"
eq "authenticated NAO executa a foto interna" "$(Pq -c "SELECT has_function_privilege('authenticated','public._reposicao_compra_foto(text,bigint[])','EXECUTE')")" "f"
eq "marker ganhou suspensas_compra_n" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='reposicao_motor_run' AND column_name='suspensas_compra_n'")" "1"

# ── ZONA 3: seeds (molde do teto: 9003 B compra 18; 9004 A compra 7 sem preco; grupo 9101/9102 compra 3) ──
P -q <<'SQL'
INSERT INTO cap_stub VALUES ('11111111-0000-0000-0000-000000000001', true, true),
                            ('11111111-0000-0000-0000-000000000002', true, false),
                            ('11111111-0000-0000-0000-000000000003', false, false);
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (9003,'oben','B PARCIAL QT','Abrasivos',true,'00'),
 (9004,'oben','A LIVRE QT','Abrasivos',true,'00'),
 (9101,'oben','GRUPO WP QT','Concentrados',true,'00'),
 (9102,'oben','GRUPO WP GL','Concentrados',true,'00'),
 (9401,'oben','CAND COBERTURA 365','Vernizes',true,'00'),
 (9402,'oben','CAND ACELEROU','Vernizes',true,'00'),
 (9201,'oben','CORANTE LC','Concentrados LC',true,'00'),
 (9301,'oben','SUBSTITUIDO','Vernizes',true,'00'),
 (9501,'oben','FORA GIRO 08','Maquinas',true,'08'),
 (9601,'oben','TROCA QT','Concentrados',true,'00'),
 (9602,'oben','TROCA GL','Concentrados',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada, valor_vendido_90d) VALUES
 ('OBEN',9003,'B PARCIAL QT','Sayerlack',3,20,NULL,true,'automatica',0.1,'B',NULL,500),
 ('OBEN',9004,'A LIVRE QT','Sayerlack',1,8,NULL,true,'automatica',0.01,'A',NULL,50),
 ('OBEN',9101,'GRUPO WP QT','Sayerlack',1,4,NULL,true,'automatica',0.005,'C',NULL,NULL),
 ('OBEN',9401,'CAND COBERTURA 365','Sayerlack',1,2,NULL,false,'sob_encomenda',0.1,'C',NULL,10),
 ('OBEN',9601,'TROCA QT','Sayerlack',1,8,NULL,true,'automatica',0.02,'C',NULL,80);
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
 ('OBEN','9003',2,0,'ListarPosEstoque'),
 ('OBEN','9004',1,0,'ListarPosEstoque'),
 ('OBEN','9101',1,0,'ListarPosEstoque'),
 ('OBEN','9102',0,0,'ListarPosEstoque'),
 ('OBEN','9601',1,0,'ListarPosEstoque'),
 ('OBEN','9602',0,0,'ListarPosEstoque');
-- preco de compra so do 9003 (10/un): o evitado do 9004 tem de sair NULL (ausente != zero)
INSERT INTO sku_leadtime_history VALUES ('OBEN','9003',10,100);
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, fator_para_base, ativo) VALUES
 ('oben','11111111-1111-1111-1111-111111111111','9101',1,true),
 ('oben','11111111-1111-1111-1111-111111111111','9102',4,true),
 ('oben','66666666-6666-6666-6666-666666666666','9601',1,true),
 ('oben','66666666-6666-6666-6666-666666666666','9602',4,true);
-- troca QT->GL: preco-app fresco nos 2 membros, GL 30 (7,5/base) < QT 10 (10/base); portal-map nos 2
INSERT INTO sku_preco_fornecedor_capturado (empresa, sku_codigo_omie, preco, status, capturado_em) VALUES
 ('oben','9601',10,'ok', now()-interval '2 days'), ('oben','9602',30,'ok', now()-interval '2 days');
INSERT INTO sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, ativo) VALUES
 ('OBEN','Sayerlack','9601','TQT',true), ('OBEN','Sayerlack','9602','TGL',true);
-- FOTO/candidatos: saldo e consumo (365d e 90d). 9401 cobertura 365d e 450d (ambas >=180) = candidato;
-- 9402 365d mas 90d=150 (acelerou) = fora; 9201 corante = fora por padrao; 9301 substituido = fora; 9501 fora do giro.
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at) VALUES
 (9003,'vendas',2,10,now()), (9004,'vendas',1,NULL,now()), (9101,'vendas',1,5,now()),
 (9601,'vendas',1,8,now()), (9602,'vendas',0,25,now()),
 (9401,'vendas',100,2,now()), (9402,'vendas',100,3,now()), (9201,'vendas',100,4,now()), (9301,'vendas',100,1,now()), (9501,'vendas',10,1000,now());
INSERT INTO venda_items_history VALUES ('OBEN', current_date - 400), ('OBEN', current_date - 1);
INSERT INTO v_sku_demanda_efetiva (empresa, sku_codigo_omie, quantidade, data_emissao)
 SELECT 'OBEN', 9401, 1, current_date - g FROM generate_series(1, 365, 5) g     -- 73 un/365d (~500d), 18 un/90d (=500d)
 UNION ALL SELECT 'OBEN', 9402, 1, current_date - g FROM generate_series(1, 90, 1) g       -- 90 un, todas em 90d: 365d=405d; 90d=100d
 UNION ALL SELECT 'OBEN', 9402, 1, current_date - g FROM generate_series(100, 365, 100) g
 UNION ALL SELECT 'OBEN', 9201, 1, current_date - g FROM generate_series(1, 365, 5) g
 UNION ALL SELECT 'OBEN', 9301, 1, current_date - g FROM generate_series(1, 365, 5) g;
INSERT INTO sku_substituicao (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status) VALUES ('OBEN','9301','9302','consolidar_demanda','aplicada');
SQL
echo "seeds ok"

# sessao simulada do PostgREST: $1 = claims JSON ('' = sem claims), $2 = SQL. Roda como authenticated, DENTRO de transacao.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then echo "SELECT set_config('request.jwt.claims', '$1', true) AS c \\gset"; fi
    echo "$2;"
    echo "COMMIT;"
  } | Pq 2>&1
}
cl() { echo "{\"sub\":\"$1\",\"role\":\"authenticated\"}"; }
# erro vira valor distinto (nunca mascara): devolve o SQLSTATE-marcador em ASCII
sqlstate() { if echo "$1" | grep -q "42501"; then echo "42501"; elif echo "$1" | grep -q "P0001"; then echo "P0001"; else echo "$1"; fi; }

run_ciclo() { sess "$(cl "$U_MASTER")" "SELECT (gerar_pedidos_sugeridos_ciclo('$1','$2')).skus_incluidos" | grep -i "error" | head -3; }
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='$1' AND pcs.data_ciclo='$2' AND pci.sku_codigo_omie='$3' AND pcs.status='pendente_aprovacao' LIMIT 1),'AUSENTE')"; }
ultimo_marker() { Pq -c "SELECT suspensas_compra_n FROM reposicao_motor_run WHERE empresa='OBEN' ORDER BY criado_em DESC LIMIT 1"; }
log_sku() { Pq -c "SELECT coalesce(string_agg(concat_ws('|', qtde_final::text, coalesce(valor_evitado::text,'NULO'), coalesce(ancora_sku,'-'), coalesce(grupo_id::text,'-')), ';' ORDER BY criado_em), 'VAZIO') FROM reposicao_compra_suspensa_log l WHERE l.sku_codigo_omie='$1' AND l.run_id=(SELECT run_id FROM reposicao_motor_run WHERE empresa='OBEN' AND data_ciclo='$2' ORDER BY criado_em DESC LIMIT 1)"; }
SUSP="SELECT string_agg(concat_ws('|', sku_codigo_omie, inserido, coalesce(recusa,'-'), pendentes_n), ';' ORDER BY sku_codigo_omie) FROM reposicao_compra_suspender"
REAT="SELECT string_agg(concat_ws('|', sku_codigo_omie, reativado, coalesce(impedimento,'-')), ';' ORDER BY sku_codigo_omie) FROM reposicao_compra_reativar"

echo "=== R1: CONTROLE — sem suspensao o motor compra (9003=18, 9004=7, grupo 9101=3), log vazio, marker 0 ==="
run_ciclo OBEN 2026-11-01
eq "R1 9003 compra 18" "$(qf OBEN 2026-11-01 9003)" "18"
eq "R1 9004 compra 7" "$(qf OBEN 2026-11-01 9004)" "7"
eq "R1 grupo 9101 compra 3" "$(qf OBEN 2026-11-01 9101)" "3"
eq "R1 grupo com TROCA: a linha e o GL 9602 (2 galoes = 7 un/4), a ancora 9601 nao aparece" "$(qf OBEN 2026-11-01 9602)|$(qf OBEN 2026-11-01 9601)" "2|AUSENTE"
eq "R1 log vazio" "$(Pq -c "SELECT count(*) FROM reposicao_compra_suspensa_log")" "0"
eq "R1 marker suspensas_compra_n=0" "$(ultimo_marker)" "0"

echo "=== R2: GATE das RPCs (papeis reais) ==="
eq "R2 sem cap -> 42501 em suspender" "$(sqlstate "$(sess "$(cl "$U_NADA")" "$SUSP('OBEN', ARRAY[9003]::bigint[], 'x')")")" "42501"
eq "R2 so-leitor -> 42501 em suspender" "$(sqlstate "$(sess "$(cl "$U_LEITOR")" "$SUSP('OBEN', ARRAY[9003]::bigint[], 'x')")")" "42501"
eq "R2 so-leitor LE candidatos (9401 unico)" "$(sess "$(cl "$U_LEITOR")" "SELECT string_agg(sku_codigo_omie::text, ',' ORDER BY 1) FROM reposicao_compra_suspensa_candidatos('OBEN', 180)")" "9401"
eq "R2 sem cap -> 42501 em listar" "$(sqlstate "$(sess "$(cl "$U_NADA")" "SELECT count(*) FROM reposicao_compra_suspensa_listar('OBEN')")")" "42501"
eq "R2 PostgREST SEM JWT (authenticator) -> 42501" "$(sqlstate "$(PA -c "SET ROLE authenticated; SELECT count(*) FROM reposicao_compra_suspensa_candidatos('OBEN', 180)" 2>&1)")" "42501"
eq "R2 sessao direta (postgres, sem JWT) passa — caminho do envelope" "$(Pq -c "SELECT string_agg(sku_codigo_omie::text, ',') FROM reposicao_compra_suspensa_candidatos('OBEN', 180)")" "9401"
eq "R2 motivo vazio -> P0001" "$(sqlstate "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9003]::bigint[], '  ')")")" "P0001"
eq "R2 skus vazio -> P0001" "$(sqlstate "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[]::bigint[], 'x')")")" "P0001"
eq "R2 revisar_em no passado -> P0001" "$(sqlstate "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9003]::bigint[], 'x', current_date - 1)")")" "P0001"
eq "R2 empresa invalida -> P0001" "$(sqlstate "$(sess "$(cl "$U_MASTER")" "$SUSP('ACME', ARRAY[9003]::bigint[], 'x')")")" "P0001"

echo "=== R3: candidatos (dupla janela, corante, substituido, fora do giro) ==="
eq "R3 corante entra so com p_incluir_corante" "$(Pq -c "SELECT string_agg(sku_codigo_omie::text, ',' ORDER BY 1) FROM reposicao_compra_suspensa_candidatos('OBEN', 180, true)")" "9201,9401"
eq "R3 9402 acelerou (365d=405 mas 90d=100) fica fora com min 150 — dupla janela" "$(Pq -c "SELECT string_agg(sku_codigo_omie::text, ',' ORDER BY 1) FROM reposicao_compra_suspensa_candidatos('OBEN', 150)")" "9401"
eq "R3 com min 100 as duas janelas passam e 9402 entra (ordem = valor desc)" "$(Pq -c "SELECT string_agg(sku_codigo_omie::text, ',') FROM reposicao_compra_suspensa_candidatos('OBEN', 100)")" "9402,9401"
eq "R3 foto do candidato (saldo|cmc|valor|dias365|dias90|no_motor|corante)" "$(Pq -c "SELECT concat_ws('|', saldo, cmc, valor, dias_365, dias_90, no_motor, corante) FROM reposicao_compra_suspensa_candidatos('OBEN', 180) WHERE sku_codigo_omie=9401")" "100|2|200.00|500.0|500.0|f|f"
P -q -c "UPDATE venda_items_history SET data_emissao = current_date - 30 WHERE data_emissao = current_date - 1;"
eq "R3 fonte desatualizada (>7d) -> P0001 fail-closed" "$(sqlstate "$(Pq -c "SELECT count(*) FROM reposicao_compra_suspensa_candidatos('OBEN', 180)" 2>&1)")" "P0001"
P -q -c "UPDATE venda_items_history SET data_emissao = current_date - 1 WHERE data_emissao = current_date - 30;"

echo "=== R4: suspender 9003 (com preco) e 9004 (sem preco) -> fora do pedido + log com valor e NULO ==="
eq "R4 suspender insere os 2 (pendentes_n=1 cada: o pedido de R1 ainda esta la)" \
   "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9003,9004]::bigint[], 'cobertura alta')")" "9003|t|-|1;9004|t|-|1"
eq "R4 foto gravada no 9003 (saldo|cmc|valor|no_motor|venda90)" "$(Pq -c "SELECT concat_ws('|', foto_saldo, foto_cmc, foto_valor, foto_no_motor, foto_valor_vendido_90d) FROM reposicao_compra_suspensa WHERE sku_codigo_omie=9003 AND reativado_em IS NULL")" "2|10|20.00|t|500"
eq "R4 autor = uid do master" "$(Pq -c "SELECT suspenso_por::text FROM reposicao_compra_suspensa WHERE sku_codigo_omie=9003 AND reativado_em IS NULL")" "$U_MASTER"
eq "R4 revisar_em default hoje+90" "$(Pq -c "SELECT (revisar_em = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 90) FROM reposicao_compra_suspensa WHERE sku_codigo_omie=9003 AND reativado_em IS NULL")" "t"
run_ciclo OBEN 2026-11-02
eq "R4 9003 SOME do pedido" "$(qf OBEN 2026-11-02 9003)" "AUSENTE"
eq "R4 9004 SOME do pedido" "$(qf OBEN 2026-11-02 9004)" "AUSENTE"
eq "R4 grupo 9101 segue comprando 3" "$(qf OBEN 2026-11-02 9101)" "3"
eq "R4 log 9003: qtde 18, evitado 180 (18x10), ancora 9003, sem grupo" "$(log_sku 9003 2026-11-02)" "18|180|9003|-"
eq "R4 log 9004: qtde 7, evitado NULO (preco ausente != zero)" "$(log_sku 9004 2026-11-02)" "7|NULO|9004|-"
eq "R4 marker suspensas_compra_n=2" "$(ultimo_marker)" "2"
eq "R4 idempotente: 2a chamada inserido=false, recusa ja_suspensa, pendentes 0" \
   "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9003]::bigint[], 'de novo')")" "9003|f|ja_suspensa|0"
eq "R4 substituido e RECUSADO" "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9301]::bigint[], 'x')")" "9301|f|substituido|0"
eq "R4 candidatos exclui quem ja esta suspenso (9003 nao e candidato de qualquer jeito; 9401 segue)" "$(Pq -c "SELECT string_agg(sku_codigo_omie::text, ',') FROM reposicao_compra_suspensa_candidatos('OBEN', 180)")" "9401"

echo "=== R5: listar + runs (sensor com denominador) ==="
eq "R5 listar: 2 ativas ordenadas por venda90 desc, evitado do ultimo run" \
   "$(sess "$(cl "$U_MASTER")" "SELECT string_agg(concat_ws('|', sku_codigo_omie, coalesce(evitado_ultimo_run::text,'NULO'), qtde_ultimo_run, no_motor_atual), ';' ORDER BY foto_valor_vendido_90d DESC) FROM reposicao_compra_suspensa_listar('OBEN')")" "9003|180|18|t;9004|NULO|7|t"
eq "R5 runs: 2 runs, o ultimo com 2 seguradas, 180 evitado e 1 linha sem preco" \
   "$(sess "$(cl "$U_MASTER")" "SELECT string_agg(concat_ws('|', data_ciclo, suspensas_compra_n, coalesce(valor_evitado::text,'NULO'), linhas_sem_preco), ';' ORDER BY criado_em) FROM reposicao_compra_suspensa_runs('OBEN', 30)")" "2026-11-01|0|NULO|0;2026-11-02|2|180|1"

echo "=== R6: reativar 9003 -> volta ao pedido; 9004 segue fora ==="
eq "R6 reativar 9003 (impedimento nenhum) e 9999 (nao ativa, fora do motor)" \
   "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9003,9999]::bigint[], 'volta')")" "9003|t|-;9999|f|fora_do_motor"
eq "R6 reativado_por/motivo gravados" "$(Pq -c "SELECT concat_ws('|', reativado_por::text, motivo_reativacao) FROM reposicao_compra_suspensa WHERE sku_codigo_omie=9003 AND reativado_em IS NOT NULL")" "$U_MASTER|volta"
run_ciclo OBEN 2026-11-03
eq "R6 9003 volta a comprar 18" "$(qf OBEN 2026-11-03 9003)" "18"
eq "R6 9004 segue fora" "$(qf OBEN 2026-11-03 9004)" "AUSENTE"
eq "R6 log do run so 9004" "$(log_sku 9003 2026-11-03)" "VAZIO"
eq "R6 marker=1" "$(ultimo_marker)" "1"
eq "R6 re-suspender 9003 apos reativar -> inserido=true (episodio novo)" \
   "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9003]::bigint[], 'de novo', NULL, 'lote_cobertura', '22222222-2222-2222-2222-222222222222')")" "9003|t|-|1"
eq "R6 2 episodios do 9003 na tabela" "$(Pq -c "SELECT count(*) FROM reposicao_compra_suspensa WHERE sku_codigo_omie=9003")" "2"

echo "=== R7: grupo de embalagem — ancora suspensa segura o grupo; galao suspenso sozinho NAO ==="
eq "R7 suspender ancora 9101" "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9101]::bigint[], 'grupo')")" "9101|t|-|1"
run_ciclo OBEN 2026-11-04
eq "R7 grupo SOME do pedido" "$(qf OBEN 2026-11-04 9101)" "AUSENTE"
eq "R7 log do grupo: qtde 3, 15 (3 x cmc 5), ancora 9101, grupo_id" "$(log_sku 9101 2026-11-04)" "3|15|9101|11111111-1111-1111-1111-111111111111"
eq "R7 reativar o galao 9102 (nao suspenso): impedimento ancora_suspensa" \
   "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9102]::bigint[], NULL)")" "9102|f|ancora_suspensa"
eq "R7 reativar a ancora" "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9101]::bigint[], NULL)")" "9101|t|-"
eq "R7 suspender SO o galao 9102" "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9102]::bigint[], 'galao')")" "9102|t|-|0"
run_ciclo OBEN 2026-11-05
eq "R7 galao suspenso com ancora livre: a linha (ancora) COMPRA 3 — semantica documentada" "$(qf OBEN 2026-11-05 9101)" "3"
eq "R7 sem log para o grupo nesse run" "$(log_sku 9101 2026-11-05)" "VAZIO"

echo "=== R8: grupo com TROCA (final = GL 9602, ancora = QT 9601) ==="
eq "R8 suspender a ancora 9601 (pendentes_n=1: o pedido de hoje tem o GL 9602 do grupo)" "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9601]::bigint[], 'grupo troca')")" "9601|t|-|1"
run_ciclo OBEN 2026-11-09
eq "R8 GL escolhido SOME (ancora suspensa segura o grupo)" "$(qf OBEN 2026-11-09 9602)" "AUSENTE"
eq "R8 log no SKU final 9602 com ancora 9601 e grupo (2 GL x 30 = 60)" "$(log_sku 9602 2026-11-09)" "2|60|9601|66666666-6666-6666-6666-666666666666"
eq "R8 reativar ancora" "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9601]::bigint[], NULL)")" "9601|t|-"
eq "R8 suspender SO o GL 9602" "$(sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9602]::bigint[], 'so galao')")" "9602|t|-|0"
run_ciclo OBEN 2026-11-10
eq "R8 GL suspenso E escolhido: a linha SOME (casa pelo SKU final)" "$(qf OBEN 2026-11-10 9602)" "AUSENTE"
eq "R8 log do final 9602 (ancora 9601 registrada)" "$(log_sku 9602 2026-11-10)" "2|60|9601|66666666-6666-6666-6666-666666666666"
eq "R8 reativar o GL" "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9602]::bigint[], NULL)")" "9602|t|-"
sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9601,9602]::bigint[], 'ambos')" >/dev/null
eq "R8 reativar ancora+galao JUNTOS: galao sem impedimento (ancora desta chamada nao conta)" "$(sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9601,9602]::bigint[], NULL)")" "9601|t|-;9602|t|-"
echo "=== R9: SKU suspenso que ZEROU segue na lista com saldo 0 / cobertura 0 (risco visivel), nao NULL ==="
P -q -c "UPDATE inventory_position SET saldo = 0 WHERE omie_codigo_produto = 9401; INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao, valor_vendido_90d) VALUES ('OBEN', 9402, 'CAND ACELEROU', 'Sayerlack', 1, 2, true, 'automatica', 7);"
sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9401]::bigint[], 'zerou')" >/dev/null
eq "R9 listar 9401: saldo_atual 0, cobertura_90d 0.0, valor 0.00" "$(sess "$(cl "$U_MASTER")" "SELECT concat_ws('|', saldo_atual, cobertura_90d_atual, valor_atual) FROM reposicao_compra_suspensa_listar('OBEN') WHERE sku_codigo_omie=9401")" "0|0.0|0.00"
eq "R9 foto do SKU 9402 com estoque e parametro: saldo 100, no_motor t" "$(Pq -c "SELECT concat_ws('|', coalesce(f.saldo::text,'NULO'), f.no_motor) FROM public._reposicao_compra_foto('OBEN', ARRAY[9402]::bigint[]) f")" "100|t"
P -q -c "DELETE FROM inventory_position WHERE omie_codigo_produto = 9402;"
eq "R9 reativar SKU zerado com parametro: sem impedimento falso (fora_do_motor so sem flag)" "$(Pq -c "SELECT concat_ws('|', coalesce(f.saldo::text,'NULO'), f.no_motor) FROM public._reposicao_compra_foto('OBEN', ARRAY[9402]::bigint[]) f")" "NULO|t"
sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9401]::bigint[], 'volta')" >/dev/null
run_ciclo OBEN 2026-11-11
eq "R8 tudo livre: GL volta a comprar 2" "$(qf OBEN 2026-11-11 9602)" "2"

echo "=== FALSIFICACOES (baseline verde: 9003/9004 suspensos; ancoras 9101 e 9601 suspensas) ==="
# estado de base para as sabotagens: 9003 e 9004 suspensos, ancora 9101 suspensa, galao livre
sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9102]::bigint[], NULL)" >/dev/null
sess "$(cl "$U_MASTER")" "$SUSP('OBEN', ARRAY[9101,9601]::bigint[], 'grupo')" >/dev/null
run_ciclo OBEN 2026-11-06
eq "BASE 9003 fora" "$(qf OBEN 2026-11-06 9003)" "AUSENTE"
eq "BASE 9101 fora" "$(qf OBEN 2026-11-06 9101)" "AUSENTE"
eq "BASE 9602 fora (ancora 9601 suspensa)" "$(qf OBEN 2026-11-06 9602)" "AUSENTE"
eq "BASE 9004 fora" "$(qf OBEN 2026-11-06 9004)" "AUSENTE"
SAB_DIR="$(mktemp -d "/tmp/sab-${SLUG}.XXXXXX")"
falsifica() {  # $1=nome  $2=sed-expr  $3=descricao  $4=query  $5=valor sob sabotagem (o SKU SUSPENSO DENTRO do pedido)
  local nome="$1" sedexpr="$2" query="$4" esperado_sab="$5"
  sed "$sedexpr" "$FIXTURE" > "$SAB_DIR/$nome.sql"
  if cmp -s "$FIXTURE" "$SAB_DIR/$nome.sql"; then bad "FALSIF $nome: sed NAO aplicou (padrao nao casou)"; return; fi
  P -q -f "$SAB_DIR/$nome.sql" >/dev/null 2>&1 || { bad "FALSIF $nome: sabotagem nao compilou"; return; }
  P -q -c "DELETE FROM reposicao_compra_suspensa_log; DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-11-07
  local veio; veio="$(eval "$query")"
  if [ "$veio" = "$esperado_sab" ]; then ok "FALSIF $nome pegou a sabotagem ($3)"; else bad "FALSIF $nome NAO detectou — esperado sob sabotagem [$esperado_sab], veio [$veio]"; fi
  P -q -f "$FIXTURE" >/dev/null   # restaura a funcao REAL
  P -q -c "DELETE FROM reposicao_compra_suspensa_log; DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido; DELETE FROM reposicao_motor_run;" >/dev/null
  run_ciclo OBEN 2026-11-08
  eq "RESTAURA apos $nome: 9003 fora de novo" "$(qf OBEN 2026-11-08 9003)" "AUSENTE"
}
# F1: tira o filtro de skus_inseriveis -> o SKU suspenso ENTRA no pedido (18)
falsifica "F1-sem-filtro" \
  "s/AND NOT sn.suprimido AND sn.compra_suspensa_id IS NULL/AND NOT sn.suprimido/" \
  "sem o filtro o suspenso volta ao pedido" \
  "qf OBEN 2026-11-07 9003" "18"
# F2: inverte a leitura de ATIVA (IS NOT NULL) -> suspensao viva ignorada -> 9003 no pedido
falsifica "F2-ativa-invertida" \
  "s/WHERE cs.empresa = p_empresa AND cs.reativado_em IS NULL/WHERE cs.empresa = p_empresa AND cs.reativado_em IS NOT NULL/" \
  "ativa lida ao contrario deixa comprar (9004: so episodio ativo)" \
  "qf OBEN 2026-11-07 9004" "7"
# F3: ignora a ancora (COALESCE so do final) -> grupo com ancora suspensa volta a comprar 3
falsifica "F3-sem-ancora" \
  "s/COALESCE(sa_anc.id, sa_fin.id) AS compra_suspensa_id/sa_fin.id AS compra_suspensa_id/" \
  "sem a ancora o GL escolhido do grupo com ancora suspensa compra" \
  "qf OBEN 2026-11-07 9602" "2"
rm -rf "$SAB_DIR"

# F4 (gate): sabota o gate para no-op -> usuario SEM cap consegue suspender (vermelho = inserido=true); restaura pela MIGRATION
P -q -c "CREATE OR REPLACE FUNCTION public._reposicao_compra_gate(p_escrever boolean) RETURNS void LANGUAGE sql AS \$\$ SELECT NULL::void \$\$;"
eq "FALSIF F4 gate morto: sem cap suspende (esperado sob sabotagem t)" \
   "$(sess "$(cl "$U_NADA")" "SELECT inserido FROM reposicao_compra_suspender('OBEN', ARRAY[9402]::bigint[], 'furo')")" "t"
P -q -f "$MIG" >/dev/null
sess "$(cl "$U_MASTER")" "$REAT('OBEN', ARRAY[9402]::bigint[], 'limpa sabotagem')" >/dev/null
eq "RESTAURA F4: sem cap -> 42501" "$(sqlstate "$(sess "$(cl "$U_NADA")" "$SUSP('OBEN', ARRAY[9402]::bigint[], 'x')")")" "42501"

echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "COMPRA-SUSPENSA-PROVA-OK"
exit 0
