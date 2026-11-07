#!/usr/bin/env bash
# test-cliente-sucessao-consumidores.sh — prova EXECUTADA (PG17) da 20261108000000_cliente_sucessao_consumidores.sql:
# os CONSUMIDORES do plano de rateio (sucessor declarado, entrega 3 PR C).
#
# O que ela prende: o helper da lista da farmer (private._venda_sugestoes_json) só ACRESCENTA chaves — tirando as
# novas, o JSON é byte a byte o do corpo anterior, com herança no ar; a sugestão herdada carrega a origem, o nome da
# antiga e a marca "preço de referência da antiga"; a própria, não. `venda_heranca_comprador`: só declaração `ativa`,
# só o plano VIGENTE (revogado = nada), só o destino da própria declaração, alias resolve para o canônico, gate de
# staff + carteira e ACL de duas pontas. `cliente_sucessao_plano_itens`: os destinos com o estado, os itens da antiga
# com PARIDADE com private.venda_linhas_pedido(corte) (o universo e o alias), o sensor do dia por evento, gate de
# gestor. Nenhuma das duas devolve chave de valor. A migration re-aplica (idempotente) e a PRE recusa corpo alheio.
#
# Monta o schema como a db/test-cliente-sucessao-plano.sh (snapshot + ACL medido + retrato de 29/10 + a cadeia viva,
# que pega o PR B e ESTA migration pelo nome dos objetos guardados).
#
# Uso:
#   bash db/test-cliente-sucessao-consumidores.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-cliente-sucessao-consumidores.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5517}"
TMPD="$(mktemp -d /tmp/pgtest-cliente-sucessao-consumidores.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
export PGTZ=UTC

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
MIG_B="$REPO_ROOT/supabase/migrations/20261107210000_cliente_sucessao_plano_rateio.sql"
MIG="$REPO_ROOT/supabase/migrations/20261108000000_cliente_sucessao_consumidores.sql"
ANTES="$REPO_ROOT/supabase/migrations/20261021070000_venda_lista_lente.sql"   # o corpo do helper ANTES (prod: md5 288ace38…)
[ -f "$FIXTURE" ] && [ -f "$MIG" ] && [ -f "$MIG_B" ] && [ -f "$ANTES" ] || { echo "fixture ou migration ausente"; exit 1; }

# Os objetos que a prova assevera, e os que o gerador de venda e a entrega 2 precisam (a cadeia dinâmica pega as
# migrations deles pelo nome).
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar cliente_resolver_documento cliente_sucessoes_chaves cliente_sucessoes_vigentes
            cliente_declarar_sucessao cliente_revogar_sucessao _mixgap_gaps_compradores venda_complemento_comprador
            venda_fechar_desfechos venda_gerar_lista venda_lista_calc venda_recompra_em venda_situacao_em
            venda_linhas_pedido venda_lista_preco venda_lista_complemento _venda_repasse_base venda_repasse_candidatos
            venda_recompra_atualizar historico_consumo_efetivo cliente_sucessao_plano_publicar
            _venda_sugestoes_json venda_minhas_sugestoes get_venda_sugestoes_for venda_heranca_comprador
            cliente_sucessao_plano_itens)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(cliente_sucessoes venda_sugestao venda_recompra cliente_sucessao_plano_regras)
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  # Mesmo artefato dos harness irmãos: o snapshot de 15/10 ainda tem a contagem de 8 parâmetros (prod só tem a de 10).
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
  # A espinha do gerador lê vendas_sync_cursor.falhou_em (20261015221700, fora da cadeia e não sob prova: só a
  # coluna, para a função da cobertura do sync compilar).
  P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS falhou_em timestamptz" > /dev/null || return 1
  # A pós-condição da 20261021070000 (lente da lista, na cadeia pelo helper) executa a RPC como um master de
  # user_roles: um master só da cadeia (o da prova é outro uid, semeado depois).
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-00000000a0ff');
    INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000a0ff', 'master')" > /dev/null || return 1
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + retrato de 29/10 + cadeia (gerador, entrega 2, esta)…"
cv_montar

[ "$(P -tA -q -c "SELECT to_regprocedure('private.historico_consumo_efetivo(date)') IS NOT NULL
                        AND to_regprocedure('public.venda_heranca_comprador(uuid)') IS NOT NULL")" = t ] \
  || { echo "❌ a cadeia não aplicou 20261107210000 + 20261108000000"; exit 1; }

MASTER='00000000-0000-0000-0000-00000000a001'
GER='00000000-0000-0000-0000-00000000a002'     # employee + gerencial (pode_ver_carteira_completa)
FARM='00000000-0000-0000-0000-00000000a003'    # employee + farmer: dono da carteira, não publica plano
UA='00000000-0000-0000-0000-0000000c0001'      # a antiga da CISÃO (E1)
UAL='00000000-0000-0000-0000-0000000c0002'     # alias fiscal dela (sem profile)
UN1='00000000-0000-0000-0000-0000000c0011'     # 1ª nova: cadastrada só no meio da prova (destino pendente)
UN2='00000000-0000-0000-0000-0000000c0012'     # 2ª nova, já cliente, com compra própria
UB='00000000-0000-0000-0000-0000000c0021'      # a antiga da SUCESSÃO (E2): encerrada no corte
UBN='00000000-0000-0000-0000-0000000c0022'     # a sucessora
UQ='00000000-0000-0000-0000-0000000c0031'      # cliente alheio, mesma carteira
UX2='00000000-0000-0000-0000-0000000c0041'     # a antiga de E4 (vira alias da UA no fim: grafo → declarada)
UN4='00000000-0000-0000-0000-0000000c0042'
UN5='00000000-0000-0000-0000-0000000c0051'     # nova de E5: cadastra DURANTE o cálculo da drenagem
U6A='00000000-0000-0000-0000-0000000c0061'     # antiga de E6: declarada DURANTE o cálculo
FARM2='00000000-0000-0000-0000-00000000a004'; FARM3='00000000-0000-0000-0000-00000000a005'   # outros farmers
U7A='00000000-0000-0000-0000-0000000c0071'; U7N='00000000-0000-0000-0000-0000000c0072'      # E7 (sucessão)
X7='00000000-0000-0000-0000-0000000c0073'      # alias da U7A, dono FÍSICO do histórico herdado (muda de dono)
U8A='00000000-0000-0000-0000-0000000c0081'; U8N='00000000-0000-0000-0000-0000000c0082'      # E8 (sucessão)
U8C='00000000-0000-0000-0000-0000000c0083'     # para onde o alias X8 passa: a antiga de E8 muda de identidade
X8='00000000-0000-0000-0000-0000000c0084'
ANT='03166577000166'; NOV1='69491768000101'; NOV2='22222222000122'
DB_='33333333000133'; DBN='44444444000144'; DQ='55555555000155'; DX2='66666666000166'; DN4='77777777000177'; D6A='99999999000199'
D7A='13131313000113'; D7N='14141414000114'; D7X='15151515000115'; D8A='16161616000116'; D8N='17171717000117'
D8C='18181818000118'; D8X='19191919000119'

echo "→ seed: papéis, clientes, carteira, produtos, pedidos…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$UA'),('$UAL'),('$UN1'),('$UN2'),('$UB'),('$UBN'),
  ('$UQ'),('$UX2'),('$UN4'),('$UN5'),('$U6A'),('$FARM2'),('$FARM3'),
  ('$U7A'),('$U7N'),('$X7'),('$U8A'),('$U8N'),('$U8C'),('$X8');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER','master'),('$GER','employee'),('$FARM','employee'),
  ('$FARM2','employee'),('$FARM3','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer'),
  ('$FARM2','farmer'),('$FARM3','farmer');
INSERT INTO public.profiles (user_id, name) VALUES ('$MASTER','Lucas'),('$GER','Gestor'),('$FARM','Farmer Um'),
  ('$FARM2','Farmer Dois'),('$FARM3','Farmer Tres');
INSERT INTO public.profiles (user_id, name, document) VALUES
  ('$UA','DIVIMOVEIS','$ANT'), ('$UN2','NOVA DOIS','$NOV2'), ('$UB','ANTIGA B','$DB_'), ('$UBN','SUCESSORA B','$DBN'),
  ('$UQ','ALHEIO','$DQ'), ('$UX2','ANTIGA X','$DX2'), ('$UN4','NOVA QUATRO','$DN4'), ('$U6A','ANTIGA SEIS','$D6A'),
  ('$U7A','ANTIGA SETE','$D7A'), ('$U7N','SUCESSORA SETE','$D7N'), ('$U8A','ANTIGA OITO','$D8A'), ('$U8N','SUCESSORA OITO','$D8N'),
  ('$U8C','OUTRA OITO','$D8C');
INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, documento, status) VALUES
  ('$UAL', '$UA', '$ANT', 'active'),
  ('$X7', '$U7A', '$D7X', 'active'),
  ('$X8', '$U8A', '$D8X', 'active');   -- E8 é declarada pelo documento do ALIAS: resolve para a U8A
UPDATE public.venda_config SET valor = 'true'::jsonb WHERE chave = 'onda_recompra';
UPDATE public.venda_config SET valor = 'false'::jsonb WHERE chave IN ('onda_complemento', 'onda_preco');
ALTER TABLE public.carteira_assignments DISABLE TRIGGER ALL;
INSERT INTO public.carteira_assignments (owner_user_id, customer_user_id, eligible, source) VALUES
  ('$FARM','$UA',true,'omie'), ('$FARM','$UN1',true,'omie'), ('$FARM','$UN2',true,'omie'), ('$FARM','$UB',true,'omie'),
  ('$FARM','$UBN',true,'omie'), ('$FARM','$UQ',true,'omie'), ('$FARM','$UX2',true,'omie'), ('$FARM','$UN4',true,'omie'), ('$FARM','$UN5',true,'omie'),
  ('$FARM','$U7A',true,'omie'), ('$FARM2','$U7N',true,'omie'), ('$FARM','$U8A',true,'omie'), ('$FARM2','$U8N',true,'omie'),
  ('$FARM3','$U8C',true,'omie');
ALTER TABLE public.omie_products DISABLE TRIGGER ALL;
INSERT INTO public.omie_products (account, codigo, descricao, omie_codigo_produto, familia) VALUES
  ('oben','1001','PROD 1001',1001,'OUTRA'), ('oben','1002','PROD 1002',1002,'OUTRA'), ('colacor','1003','PROD 1003',1003,'OUTRA'),
  ('oben','1004','VERNIZ A',1004,'VERNIZ'), ('oben','1005','VERNIZ B',1005,'VERNIZ'), ('oben','1006','PROD 1006',1006,'OUTRA'),
  ('oben','1007','PROD 1007',1007,'OUTRA'), ('oben','1008','VERNIZ C',1008,'VERNIZ');
-- Pedidos e itens são semente, não o objeto sob prova: sem os gatilhos de coerência items(jsonb) × order_items.
ALTER TABLE public.order_items DISABLE TRIGGER ALL;
ALTER TABLE public.sales_orders DISABLE TRIGGER ALL;
CREATE TABLE public.t_cfg AS SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje;
CREATE FUNCTION public.t_ped(p_cli uuid, p_off int, p_cod bigint, p_qtd numeric DEFAULT 10, p_preco numeric DEFAULT 10,
                             p_desc numeric DEFAULT 0, p_conta text DEFAULT 'oben', p_status text DEFAULT 'faturado')
RETURNS uuid LANGUAGE plpgsql AS \$f\$
DECLARE v uuid := gen_random_uuid(); d date := (SELECT t.hoje FROM public.t_cfg t) + p_off;
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, account, status, order_date_kpi, created_at, created_by)
  VALUES (v, p_cli, p_conta, p_status, d, (d + time '15:00') AT TIME ZONE 'UTC', '$MASTER');
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
  VALUES (v, p_cli, p_cod, p_qtd, p_preco, p_desc);
  RETURN v;
END \$f\$;
-- A antiga da cisão (E1, corte = hoje − 60): 1001..1005 e 1007 antes do corte, a cada 30 dias (atrasados hoje).
SELECT public.t_ped('$UA', o, 1001) FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$UA', -200, 1002); SELECT public.t_ped('$UA', -170, 1002);
SELECT public.t_ped('$UA', -140, 1002, 10, 10, NULL);   -- desconto NÃO apurado: líquido NULL (ausente ≠ zero)
SELECT public.t_ped('$UA', -60, 1002);                  -- no DIA do corte: fica com a antiga
SELECT public.t_ped('$UA', o, 1003, 10, 10, 0, 'colacor') FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$UA', o, 1004) FROM unnest(ARRAY[-200,-170,-140]) o;
-- 2º item do MESMO SKU no MESMO pedido: a conservação é por linha física (order_item), não por pedido.
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
  SELECT so.id, '$UA', 1004, 5, 10, 0 FROM public.sales_orders so JOIN public.order_items oi ON oi.sales_order_id = so.id
   WHERE so.customer_user_id = '$UA' AND oi.omie_codigo_produto = 1004 AND so.order_date_kpi = (SELECT hoje - 200 FROM public.t_cfg);
SELECT public.t_ped('$UA', -200, 1005); SELECT public.t_ped('$UAL', -170, 1005); SELECT public.t_ped('$UA', -140, 1005);
SELECT public.t_ped('$UA', o, 1006) FROM unnest(ARRAY[-45,-30,-15]) o;           -- depois do corte
SELECT public.t_ped('$UA', o, 1007) FROM unnest(ARRAY[-200,-170,-140]) o;        -- sem regra
SELECT public.t_ped('$UA', o, 1008) FROM unnest(ARRAY[-30,-20]) o;               -- VERNIZ só depois do corte
SELECT public.t_ped('$UA', -100, 1007, 10, 10, 0, 'oben', 'cancelado');          -- fora do universo
SELECT public.t_ped('$UA', -100, 1001, 0);                                       -- quantidade 0: fora do universo
-- A 2ª nova compra 1003 por conta própria (mistura com a herdada).
SELECT public.t_ped('$UN2', o, 1003, 10, 10, 0, 'colacor') FROM unnest(ARRAY[-110,-80]) o;
-- A antiga da sucessão (E2): 2001 vai para a sucessora; 2002 fica (e não gera sugestão: a antiga morreu).
SELECT public.t_ped('$UB', o, 2001) FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$UB', o, 2002) FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$UQ', o, 3001) FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$UX2', o, 5001) FROM unnest(ARRAY[-200,-170,-140]) o;
SELECT public.t_ped('$X7', o, 7001) FROM unnest(ARRAY[-200,-170,-140]) o;     -- pedido no ALIAS da U7A
SELECT public.t_ped('$U8A', o, 8001) FROM unnest(ARRAY[-200,-170,-140]) o;
-- prova.msg: como prova.sqlstate, mas com a mensagem (casa o RAMO que recusou, não só o código). Sem WHEN OTHERS
-- engolindo: o código e a mensagem voltam e o assert os compara EXATOS.
CREATE FUNCTION prova.msg(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ':' || SQLERRM;
END \$f\$;
GRANT EXECUTE ON FUNCTION prova.msg(text) TO authenticated, anon, service_role;
COMMIT;
SQL

PASS=0; FAIL=0
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); fi
}
# Q <sql> — uma linha, como postgres; erro vira 'ERRO: …' (o assert fica vermelho, o cenário segue).
Q() {
  local o
  if o="$(P -v ON_ERROR_STOP=1 -tA -q -c "$1" 2>&1)"; then printf '%s' "$o" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(printf '%s' "$o" | tr '\n' ' ' | cut -c1-200)"; fi
}
# q_como <papel> <uid ou ''> <sql> — como o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
estado_como() { q_como "$1" "$2" "SELECT prova.sqlstate(\$c\$$3\$c\$)"; }   # SQLSTATE (+ camada) como o papel
msg_como() { q_como authenticated "$1" "SELECT prova.msg(\$c\$$2\$c\$)"; }      # SQLSTATE:mensagem (prova o RAMO)
versao() { Q "SELECT versao FROM private.cliente_sucessoes_grafo"; }
declarar() {  # <antigo> <novo> <tipo> <offset do corte> → evento_id
  q_como authenticated "$GER" "SELECT public.cliente_declarar_sucessao('$1','$2','$3',
    (SELECT hoje + $4 FROM public.t_cfg), $(versao))->>'evento_id'"
}
publicar() {  # <evento> <revisão esperada> <regras json> <campo do retorno>
  q_como authenticated "$GER" "SELECT public.cliente_sucessao_plano_publicar('$1'::uuid, $2, \$j\$$3\$j\$::jsonb, 'prova') #>> '{$4}'"
}
revogar_plano() {  # <evento> <revisão esperada> <campo>
  q_como authenticated "$GER" "SELECT public.cliente_sucessao_plano_revogar('$1'::uuid, $2, 'prova') #>> '{$3}'"
}
# item/fam <empresa> <código|família> <documento> — uma regra em JSON. As chaves saem do printf (dado), nunca do
# texto do script: dentro de "$(…)" o bash faz brace expansion em {a,b} e quebra o JSON em palavras.
item() { printf '{"empresa":"%s","omie_codigo_produto":%s,"novo_documento":"%s"}' "$1" "$2" "$3"; }
fam() { printf '{"empresa":"%s","familia":"%s","novo_documento":"%s"}' "$1" "$2" "$3"; }
H="(SELECT hoje FROM public.t_cfg)"
drenar() { Q "SELECT private.venda_sugestoes_drenar_reprocesso()"; }   # o que o cron faz a cada minuto

HER='public.venda_heranca_comprador(uuid)'
ITENS='public.cliente_sucessao_plano_itens(uuid)'
HELPER='private._venda_sugestoes_json(uuid,date)'
# her <uid de quem lê> <comprador> — "papel:outro:itens | …" da herança, em ordem
her() {
  q_como authenticated "$1" "SELECT COALESCE(string_agg(h->>'papel' || ':' || COALESCE(h->>'outro_nome', '?') || ':' ||
      (SELECT string_agg(i->>'omie_codigo_produto', ',' ORDER BY (i->>'omie_codigo_produto')::bigint)
         FROM jsonb_array_elements(h->'itens') i), ' | ' ORDER BY h->>'papel', h->>'outro_nome'), '')
    FROM jsonb_array_elements(public.venda_heranca_comprador('$2')->'herancas') h"
}
# itens_de <evento> <expressão sobre o elemento i> — os itens da tela do plano, como o gestor lê
itens_de() {
  q_como authenticated "$GER" "SELECT COALESCE(string_agg($2, ',' ORDER BY i->>'empresa', (i->>'omie_codigo_produto')::bigint), '')
    FROM jsonb_array_elements(public.cliente_sucessao_plano_itens('$1')->'itens') i"
}
# chaves_de_valor <sql jsonb> — toda chave, em todo nível, que cheire a dinheiro (o contrato é: nenhuma)
chaves_de_valor() {
  q_como authenticated "$1" "SELECT COALESCE(string_agg(DISTINCT k, ','), '')
    FROM jsonb_path_query(($2), 'strict \$.**') v,
         jsonb_object_keys(CASE WHEN jsonb_typeof(v) = 'object' THEN v ELSE '{}'::jsonb END) k
   WHERE k ~ '(valor|preco|price|receita|total|margem|custo)'"
}
# a sugestão de HOJE do comprador/SKU (recompra), campo do JSON do helper da farmer
sug() {
  Q "SELECT s->>'$3' FROM jsonb_array_elements(private._venda_sugestoes_json('$FARM', $H)->'compradores') c,
            jsonb_array_elements(c->'sugestoes') s
      WHERE c->>'comprador_id' = '$1' AND s->>'tipo' = 'recompra' AND (s->>'omie_codigo_produto')::bigint = $2"
}

cenario() {
  local E1 E2 R ID_MOSTRA

  echo "── 0. a migration toca só o que diz ──"
  chk M1 "funções criadas/recriadas = as do desenho (o helper é a ÚNICA viva recriada)" \
    "$(grep -oE 'CREATE OR REPLACE FUNCTION [a-z_.]+' "$MIG" | awk '{print $5}' | sort | tr '\n' ' ' | sed 's/ $//')" \
    "private._venda_sugestoes_json public.cliente_sucessao_plano_itens public.venda_heranca_comprador"
  chk M2 "nenhum DDL de tabela, nenhum DROP" "$(grep -cE '^(ALTER TABLE|CREATE TABLE|DROP )' "$MIG" || true)" "0"
  chk M3 "as RPCs da lista seguem com os corpos de prod (chamam o helper)" \
    "$(Q "SELECT string_agg(md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
           WHERE p.proname IN ('get_venda_sugestoes_for','venda_minhas_sugestoes')")" \
    "2cd5333ed0750a7f0b4afae29a97e650,ca1ece0e8e887d2b3e66d9fc757f1b3f"

  # O helper ANTES desta migration (o corpo vivo de prod, md5 288ace38…), como prova.helper_antes.
  awk '/^CREATE OR REPLACE FUNCTION private\._venda_sugestoes_json/{on=1} on{print} on && /^\$fn\$;/{exit}' "$ANTES" \
    | sed 's/FUNCTION private\._venda_sugestoes_json/FUNCTION prova.helper_antes/' > "$TMPD/antes.sql"
  P -v ON_ERROR_STOP=1 -q -f "$TMPD/antes.sql" > /dev/null
  chk M3b "o corpo anterior copiado é o de prod" \
    "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'prova.helper_antes(uuid,date)'::regprocedure")" \
    "288ace38a44f0a70bffe5426a0ba44a3"

  echo "── 1. declarações e planos ──"
  E1="$(declarar "$ANT" "$NOV1" cisao -60)"
  declarar "$ANT" "$NOV2" cisao -60 > /dev/null
  E2="$(declarar "$DB_" "$DBN" sucessao -60)"
  chk S1 "E1: NOV1 declarada (sem cadastro), NOV2 ativa; E2 ativa" \
    "$(Q "SELECT string_agg(novo_documento || '=' || estado, ',' ORDER BY novo_documento)
            FROM private.cliente_sucessoes_vigentes($H) WHERE antigo_documento IN ('$ANT', '$DB_')")" \
    "$NOV2=ativa,$DBN=ativa,$NOV1=declarada"

  echo "── 2. a tela do plano ANTES de publicar ──"
  chk P0 "destinos do evento com o estado (o pendente aparece, com o impedimento)" \
    "$(q_como authenticated "$GER" "SELECT string_agg(d->>'novo_documento' || '=' || (d->>'estado') || '/' || COALESCE(d->>'impedimento', ''), ',' ORDER BY d->>'novo_documento')
         FROM jsonb_array_elements(public.cliente_sucessao_plano_itens('$E1')->'destinos') d")" \
    "$NOV2=ativa/,$NOV1=declarada/novo_sem_cadastro"
  chk P1 "itens = os da antiga ANTES do corte (paridade com venda_linhas_pedido, alias incluso)" \
    "$(itens_de "$E1" "(i->>'empresa') || ':' || (i->>'omie_codigo_produto')")/$(Q "SELECT string_agg(k, ',' ORDER BY k) FROM (
         SELECT DISTINCT empresa || ':' || omie_codigo_produto AS k FROM private.venda_linhas_pedido((SELECT hoje - 60 FROM public.t_cfg))
          WHERE comprador_id = '$UA') x")" \
    "colacor:1003,oben:1001,oben:1002,oben:1004,oben:1005,oben:1007/colacor:1003,oben:1001,oben:1002,oben:1004,oben:1005,oben:1007"
  chk P2 "contagem de pedidos: universo (qtd 0 e cancelado fora) e alias da antiga dentro" \
    "$(itens_de "$E1" "CASE WHEN (i->>'omie_codigo_produto') IN ('1001','1005','1007') THEN (i->>'omie_codigo_produto') || '=' || (i->>'pedidos') END")" \
    "1001=3,1005=3,1007=3"
  chk P2b "família e descrição do catálogo; última data antes do corte" \
    "$(itens_de "$E1" "CASE WHEN i->>'omie_codigo_produto' = '1004' THEN (i->>'familia') || '/' || (i->>'descricao') || '/' || ((i->>'ultimo_pedido')::date = (SELECT hoje - 140 FROM public.t_cfg))::text END")" \
    "VERNIZ/VERNIZ A/true"
  chk P5 "evento sem declaração ativa: ativo=false, listas vazias (não erro)" \
    "$(q_como authenticated "$GER" "SELECT (j->>'ativo') || '/' || jsonb_array_length(j->'destinos') || '/' || jsonb_array_length(j->'itens')
         FROM public.cliente_sucessao_plano_itens(gen_random_uuid()) j")" "false/0/0"
  chk P4 "farmer (não gestor) não lê a tela do plano" \
    "$(msg_como "$FARM" "SELECT public.cliente_sucessao_plano_itens('$E1')")" "42501:forbidden: gestor/master only"
  chk P4a "anon fechado na ACL" \
    "$(estado_como anon '' "SELECT public.cliente_sucessao_plano_itens('$E1')")" "42501/acl-funcao:cliente_sucessao_plano_itens"
  chk H0 "sem plano publicado: ninguém herdou" "$(her "$FARM" "$UN2")/$(her "$FARM" "$UA")" "/"

  R="[$(item oben 1001 "$NOV2"),$(fam oben VERNIZ "$NOV2"),$(item oben 1007 "$NOV1")]"
  chk S2 "publica E1 (1001 + VERNIZ → NOV2; 1007 → NOV1 pendente) e E2 (2001 → DBN)" \
    "$(publicar "$E1" 0 "$R" revisao)/$(publicar "$E2" 0 "[$(item oben 2001 "$DBN")]" revisao)" "1/1"
  Q "SELECT public.venda_gerar_lista($H, 'ativa')" > /dev/null
  drenar > /dev/null

  echo "── 3. a herança na ficha/complemento (venda_heranca_comprador) ──"
  chk H1 "a nova herda do plano vigente: 1001 + a família expandida (1004, 1005)" "$(her "$FARM" "$UN2")" "novo:DIVIMOVEIS:1001,1004,1005"
  chk H2 "a antiga vê o que repassou, só para o destino ATIVO (1007 → NOV1 pendente não conta)" \
    "$(her "$FARM" "$UA")" "antigo:NOVA DOIS:1001,1004,1005"
  chk H3 "pelo ALIAS fiscal da antiga, o mesmo comprador" "$(her "$FARM" "$UAL")" "antigo:NOVA DOIS:1001,1004,1005"
  chk H7 "a sucessora (E2) herda 2001" "$(her "$FARM" "$UBN")" "novo:ANTIGA B:2001"
  chk H8 "a herança traz o tipo, o corte e a família do catálogo" \
    "$(q_como authenticated "$FARM" "SELECT (h->>'tipo') || '/' || ((h->>'data_corte')::date = (SELECT hoje - 60 FROM public.t_cfg))::text || '/' || (h->>'revisao') || '/' ||
         (SELECT string_agg(COALESCE(i->>'familia', '-'), ',' ORDER BY (i->>'omie_codigo_produto')::bigint) FROM jsonb_array_elements(h->'itens') i)
         FROM jsonb_array_elements(public.venda_heranca_comprador('$UN2')->'herancas') h")" "cisao/true/1/OUTRA,VERNIZ,VERNIZ"
  chk H6a "anon fechado na ACL" "$(estado_como anon '' "SELECT public.venda_heranca_comprador('$UN2')")" "42501/acl-funcao:venda_heranca_comprador"
  chk H6b "cliente (sem papel de staff) recusado no 1º portão" \
    "$(msg_como "$UQ" "SELECT public.venda_heranca_comprador('$UN2')")" "42501:venda_heranca_comprador: requer perfil staff"
  chk H6c "staff de outra carteira recusado" \
    "$(msg_como "$FARM2" "SELECT public.venda_heranca_comprador('$UA')")" "42501:venda_heranca_comprador: comprador fora da sua carteira"
  chk H6d "gestor (carteira completa) lê de qualquer carteira" "$(her "$GER" "$UN2")" "novo:DIVIMOVEIS:1001,1004,1005"
  chk H9 "nenhuma chave de valor, em nível nenhum" \
    "$(chaves_de_valor "$FARM" "public.venda_heranca_comprador('$UN2')")" ""

  echo "── 4. a lista da farmer (helper) ──"
  chk C0 "pré-condição: há sugestão herdada e própria na lista de hoje" \
    "$(Q "SELECT count(*) FILTER (WHERE sucessao_origem IS NOT NULL) > 0 AND count(*) FILTER (WHERE sucessao_origem IS NULL) > 0
            FROM public.venda_sugestao WHERE dia_referencia = $H AND fase = 'ativa' AND farmer_user_id = '$FARM'")" "t"
  chk C1 "tirando as chaves novas, o JSON é IGUAL ao do corpo anterior (nada sai, nada muda de valor ou ordem)" \
    "$(Q "WITH n AS (SELECT private._venda_sugestoes_json('$FARM', $H) j)
          SELECT jsonb_set(n.j, '{compradores}', COALESCE((
                   SELECT jsonb_agg((c - 'valor_ref_total_referencia_origem') || jsonb_build_object('sugestoes',
                            (SELECT jsonb_agg(x - 'sucessao_origem' - 'herdada_de' - 'valor_ref_referencia_origem' ORDER BY i)
                               FROM jsonb_array_elements(c->'sugestoes') WITH ORDINALITY y(x, i)))
                          ORDER BY k)
                     FROM jsonb_array_elements(n.j->'compradores') WITH ORDINALITY z(c, k)), '[]'::jsonb))
                 = prova.helper_antes('$FARM', $H)
            FROM n")" "t"
  chk C2 "a herdada carrega a origem (evento E1) e o nome da antiga" \
    "$(sug "$UN2" 1004 sucessao_origem | grep -c "$E1")/$(sug "$UN2" 1004 herdada_de)" "1/[\"DIVIMOVEIS\"]"
  chk C2b "a própria não: origem e nome nulos" "$(sug "$UQ" 3001 sucessao_origem)/$(sug "$UQ" 3001 herdada_de)/$(sug "$UQ" 3001 valor_ref_referencia_origem)" "//false"
  chk C3 "a herdada marca o preço de referência DA ANTIGA (a nova não herda preço)" \
    "$(sug "$UN2" 1004 valor_ref_referencia_origem)" "true"
  chk C3b "o total do comprador avisa que soma preço da antiga; o do alheio, não" \
    "$(Q "SELECT string_agg(c->>'comprador_id' || '=' || (c->>'valor_ref_total_referencia_origem'), ',' ORDER BY c->>'comprador_id')
            FROM jsonb_array_elements(private._venda_sugestoes_json('$FARM', $H)->'compradores') c
           WHERE c->>'comprador_id' IN ('$UN2', '$UQ')")" "$UN2=true,$UQ=false"
  chk C4 "pela RPC da farmer (venda_minhas_sugestoes), as chaves chegam" \
    "$(q_como authenticated "$FARM" "SELECT count(*) > 0 FROM jsonb_array_elements(public.venda_minhas_sugestoes($H)->'compradores') c,
         jsonb_array_elements(c->'sugestoes') s WHERE jsonb_typeof(s->'sucessao_origem') = 'array' AND s ? 'herdada_de'
         AND s ? 'valor_ref_referencia_origem'")" "t"

  echo "── 5. o sensor do dia na tela do plano ──"
  chk P3 "herdadas de HOJE por evento = contagem independente (E2 também herda: não mistura)" \
    "$(q_como authenticated "$GER" "SELECT public.cliente_sucessao_plano_itens('$E1')->'sugestoes_hoje'->>'herdadas'")/$(Q "SELECT count(*) FROM public.venda_sugestao
         WHERE dia_referencia = $H AND fase = 'ativa' AND sucessao_origem::text LIKE '%$E1%'")/$(Q "SELECT count(*) > 0 FROM public.venda_sugestao
         WHERE dia_referencia = $H AND fase = 'ativa' AND sucessao_origem::text LIKE '%$E2%'")" \
    "$(Q "SELECT count(*) FROM public.venda_sugestao WHERE dia_referencia = $H AND fase = 'ativa' AND sucessao_origem::text LIKE '%$E1%'")/$(Q "SELECT count(*) FROM public.venda_sugestao WHERE dia_referencia = $H AND fase = 'ativa' AND sucessao_origem::text LIKE '%$E1%'")/t"
  ID_MOSTRA="$(Q "UPDATE public.venda_sugestao SET mostrada_em = now() WHERE id = (SELECT id FROM public.venda_sugestao
                   WHERE dia_referencia = $H AND comprador_id = '$UN2' AND sucessao_origem IS NOT NULL ORDER BY id LIMIT 1) RETURNING id")"
  chk P3b "a mostrada entra no denominador do sensor" \
    "$(q_como authenticated "$GER" "SELECT public.cliente_sucessao_plano_itens('$E1')->'sugestoes_hoje'->>'mostradas'")/$([ -n "$ID_MOSTRA" ] && echo id)" "1/id"
  chk P6 "nenhuma chave de valor na tela do plano" \
    "$(chaves_de_valor "$GER" "public.cliente_sucessao_plano_itens('$E1')")" ""

  echo "── 6. revogar o plano: a herança some na hora da leitura ──"
  chk H4 "plano revogado: nem a nova nem a antiga mostram herança; E2 segue" \
    "$(revogar_plano "$E1" 1 revisao)/$(her "$FARM" "$UN2")/$(her "$FARM" "$UA")/$(her "$FARM" "$UBN")" "2///novo:ANTIGA B:2001"

  echo "── 7. re-aplicar a migration; a PRE recusa corpo alheio ──"
  chk M4 "re-aplicar passa (idempotente; a PRE aceita este corpo)" \
    "$(P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG" > /dev/null 2>&1 && echo ok || echo falhou)" "ok"
  cv_sabotar "$HELPER" "'dia', p_dia," "'dia', p_dia, 'alheio', 1,"
  chk M5 "helper vivo diferente dos dois corpos revisados: a PRE aborta" \
    "$(P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG" 2>&1 | grep -c 'PRE FALHOU: private._venda_sugestoes_json vivo' || true)" "1"
}

GATE_GESTOR='IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'
sabotagem() {
  case "$1" in
    sem_gate_itens) cv_sabotar "$ITENS" "$GATE_GESTOR" "IF false THEN" ;;
    anon_itens) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $ITENS TO anon" ;;
    anon_heranca) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $HER TO anon" ;;
    sem_gate_staff) cv_sabotar "$HER" "RAISE EXCEPTION 'venda_heranca_comprador: requer perfil staff' USING ERRCODE = '42501';" "NULL;" ;;
    sem_gate_carteira) cv_sabotar "$HER" "IF NOT private.cap_carteira_ler(v_uid) AND NOT (v_uid = ANY (v_donos)) THEN" "IF false THEN" ;;
    heranca_revogado) cv_sabotar "$HER" "AND NOT rev.revoga" "" ;;
    heranca_destino_qualquer) cv_sabotar "$HER" "AND g.destino_sucessao_id = d.id" "" ;;
    heranca_declarada) cv_sabotar "$HER" "WHERE s.estado = 'ativa' AND (" "WHERE (" ;;
    heranca_sem_alias) cv_sabotar "$HER" "v_comprador := COALESCE(v_comprador, p_comprador);" "v_comprador := p_comprador;" ;;
    itens_sem_corte) cv_sabotar "$ITENS" "WHERE x.comprador_id = v_antigo AND x.data_pedido < v_corte" "WHERE x.comprador_id = v_antigo" ;;
    itens_sem_alias) cv_sabotar "$ITENS" "WHERE so.customer_user_id = ANY (v_cadastros)" "WHERE so.customer_user_id = v_antigo" ;;
    itens_universo) cv_sabotar "$ITENS" "AND oi.quantity > 0" "" ;;
    itens_vaza_valor) cv_sabotar "$ITENS" "'pedidos', it.pedidos," "'pedidos', it.pedidos, 'valor_ref', 1," ;;
    heranca_vaza_valor) cv_sabotar "$HER" "'descricao', op.descricao, 'familia', op.familia)" "'descricao', op.descricao, 'familia', op.familia, 'preco_unit', 1)" ;;
    sensor_mistura) cv_sabotar "$ITENS" "AND vs.sucessao_origem @> jsonb_build_array(jsonb_build_object('evento_id', p_evento_id))" "AND vs.sucessao_origem IS NOT NULL" ;;
    sensor_sem_mostrada) cv_sabotar "$ITENS" "count(*) FILTER (WHERE vs.mostrada_em IS NOT NULL)" "0" ;;
    helper_sem_origem) cv_sabotar "$HELPER" "'sucessao_origem', s.sucessao_origem," "'sucessao_origem', NULL::jsonb," ;;
    helper_sem_nome) cv_sabotar "$HELPER" "'herdada_de', s.herdada_de," "'herdada_de', NULL::jsonb," ;;
    helper_muda_total) cv_sabotar "$HELPER" "'valor_ref_total', c.valor_ref_total," "'valor_ref_total', c.valor_ref_total + 0.01," ;;
    helper_ref_falsa) cv_sabotar "$HELPER" "'valor_ref_referencia_origem', s.valor_ref_referencia_origem)" "'valor_ref_referencia_origem', false)" ;;
    helper_total_ref) cv_sabotar "$HELPER" "COALESCE(bool_or(s.valor_ref_referencia_origem AND s.valor_ref IS NOT NULL)" "COALESCE(bool_or(false)" ;;
    *) echo "SABOTAGEM desconhecida: $1"; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelhos>[:<ids que têm de ficar verdes — o controle da camada>]
SABOTAGENS="sem_gate_itens:P4:P1
anon_itens:P4a:P4
anon_heranca:H6a:H6b
sem_gate_staff:H6b:H6c
sem_gate_carteira:H6c:H6b
heranca_revogado:H4:H1
heranca_destino_qualquer:H2:H1
heranca_declarada:H2:H1
heranca_sem_alias:H3:H2
itens_sem_corte:P1:P0
itens_sem_alias:P2:P0
itens_universo:P2:P0
itens_vaza_valor:P6:P1
heranca_vaza_valor:H9:H1
sensor_mistura:P3:P3b
sensor_sem_mostrada:P3b:P3
helper_sem_origem:C2:C1
helper_sem_nome:C2:C1
helper_muda_total:C1:C2
helper_ref_falsa:C3:C1
helper_total_ref:C3b:C3"

rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
  PASS=0; FAIL=0
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ────────────────────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: o controle roda primeiro e, vermelho, aborta antes
# da primeira sabotagem.
echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_|SABOTAGEM' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
  fi
done
total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo ""
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
echo "PASS=$((total - falhas))  FAIL=$falhas"
[ "$falhas" -eq 0 ]
