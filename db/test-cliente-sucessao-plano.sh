#!/usr/bin/env bash
# test-cliente-sucessao-plano.sh — prova EXECUTADA (PG17) da 20261107210000_cliente_sucessao_plano_rateio.sql: o
# plano de rateio do histórico numa sucessão/cisão declarada (entrega 3 do "sucessor declarado", PR B — dados).
#
# O que ela prende: a trilha efetiva (private.historico_consumo_efetivo) com PARIDADE com private.venda_linhas_pedido
# sem plano e CONSERVAÇÃO por linha física com plano (cada order_item uma vez, mesmas quantidades); o corte (a linha
# do dia do corte e as posteriores ficam com a antiga; a visão anterior ao corte não herda); o destino pendente
# (novo sem cadastro) e o revogado devolvem o item à antiga; a revisão vigente é a maior; o grafo que vira
# `declarada` (alias muda depois) derruba a herança; a antiga ENCERRADA (sucessão) sai da recompra e da situação; a
# nova não herda preço (o líquido físico, NULL preservado, marcado referência da origem); a família expandida só nos
# itens anteriores ao corte; o gerador marca a origem; o reprocesso troca só a sugestão que mudou, nunca mostrada e
# sem desfecho, arquiva a linha inteira e preserva contato e ids intactos; o FACTUAL (linhas, recompra, situação,
# lista, preço, repasse, a TABELA venda_recompra) antes = depois; a versão otimista; a imutabilidade e a porta; a
# ACL de duas pontas e o gate de gestor.
#
# Monta o schema de produção como a db/test-cliente-sucessoes.sh (snapshot + ACL medido + retrato de 29/10 + a
# cadeia viva, que pega ESTA migration e as do gerador de venda pelo nome dos objetos guardados).
#
# Uso:
#   bash db/test-cliente-sucessao-plano.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-cliente-sucessao-plano.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5497}"
TMPD="$(mktemp -d /tmp/pgtest-cliente-sucessao-plano.XXXXXX)"
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
MIG="$REPO_ROOT/supabase/migrations/20261107210000_cliente_sucessao_plano_rateio.sql"
[ -f "$FIXTURE" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }

# Os objetos que a prova assevera, e os que o gerador de venda e a entrega 2 precisam (a cadeia dinâmica pega as
# migrations deles pelo nome).
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar cliente_resolver_documento cliente_sucessoes_chaves cliente_sucessoes_vigentes
            cliente_declarar_sucessao cliente_revogar_sucessao _mixgap_gaps_compradores venda_complemento_comprador
            venda_fechar_desfechos venda_gerar_lista venda_lista_calc venda_recompra_em venda_situacao_em
            venda_linhas_pedido venda_lista_preco venda_lista_complemento _venda_repasse_base venda_repasse_candidatos
            venda_recompra_atualizar historico_consumo_efetivo cliente_sucessao_plano_publicar)
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
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + retrato de 29/10 + cadeia (gerador, entrega 2, esta)…"
cv_montar

[ "$(P -tA -q -c "SELECT to_regprocedure('private.historico_consumo_efetivo(date)') IS NOT NULL")" = t ] \
  || { echo "❌ a cadeia não aplicou 20261107210000 (historico_consumo_efetivo ausente)"; exit 1; }

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
ANT='03166577000166'; NOV1='69491768000101'; NOV2='22222222000122'
DB_='33333333000133'; DBN='44444444000144'; DQ='55555555000155'; DX2='66666666000166'; DN4='77777777000177'

echo "→ seed: papéis, clientes, carteira, produtos, pedidos…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$UA'),('$UAL'),('$UN1'),('$UN2'),('$UB'),('$UBN'),
  ('$UQ'),('$UX2'),('$UN4');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER','master'),('$GER','employee'),('$FARM','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer');
INSERT INTO public.profiles (user_id, name) VALUES ('$MASTER','Lucas'),('$GER','Gestor'),('$FARM','Farmer Um');
INSERT INTO public.profiles (user_id, name, document) VALUES
  ('$UA','DIVIMOVEIS','$ANT'), ('$UN2','NOVA DOIS','$NOV2'), ('$UB','ANTIGA B','$DB_'), ('$UBN','SUCESSORA B','$DBN'),
  ('$UQ','ALHEIO','$DQ'), ('$UX2','ANTIGA X','$DX2'), ('$UN4','NOVA QUATRO','$DN4');
INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, documento, status) VALUES
  ('$UAL', '$UA', '$ANT', 'active');
UPDATE public.venda_config SET valor = 'true'::jsonb WHERE chave = 'onda_recompra';
UPDATE public.venda_config SET valor = 'false'::jsonb WHERE chave IN ('onda_complemento', 'onda_preco');
ALTER TABLE public.carteira_assignments DISABLE TRIGGER ALL;
INSERT INTO public.carteira_assignments (owner_user_id, customer_user_id, eligible, source) VALUES
  ('$FARM','$UA',true,'omie'), ('$FARM','$UN1',true,'omie'), ('$FARM','$UN2',true,'omie'), ('$FARM','$UB',true,'omie'),
  ('$FARM','$UBN',true,'omie'), ('$FARM','$UQ',true,'omie'), ('$FARM','$UX2',true,'omie'), ('$FARM','$UN4',true,'omie');
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
porta() { Q "SELECT prova.sqlstate(\$c\$SELECT set_config('cliente_sucessao_plano.porta','rpc',true); $1\$c\$)"; }
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
EF="private.historico_consumo_efetivo($H)"
# codigos <comprador> — os SKUs da recompra de HOJE na lista do farmer, em ordem
codigos() { Q "SELECT COALESCE(string_agg(omie_codigo_produto::text, ',' ORDER BY omie_codigo_produto), '')
                 FROM public.venda_sugestao WHERE dia_referencia = $H AND tipo = 'recompra' AND comprador_id = '$1'"; }
rec_ef() { Q "SELECT COALESCE(string_agg(omie_codigo_produto::text, ',' ORDER BY omie_codigo_produto), '')
                FROM private.venda_recompra_efetiva_em($H) WHERE comprador_id = '$1'"; }
# assinatura <sql de um conjunto> — md5 do conjunto ordenado (antes = depois)
assinatura() { Q "SELECT count(*) || ':' || md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) FROM ($1) x"; }
FACTUAIS=(
  "SELECT * FROM private.venda_linhas_pedido($H)"
  "SELECT * FROM public.venda_recompra_em($H)"
  "SELECT * FROM public.venda_situacao_em($H)"
  "SELECT * FROM private.venda_lista_calc($H)"
  "SELECT * FROM private.venda_lista_preco($H)"
  "SELECT * FROM private._venda_repasse_base(NULL)"
  "SELECT comprador_id, empresa, omie_codigo_produto, product_id, n_pedidos, cadencia_dias, qtd_sugerida, ultima_compra,
          ultimo_preco, due_ratio, atrasado, valor_esperado, data_referencia FROM public.venda_recompra"
  "SELECT comprador_id, situacao, dias_sem_compra, valor_atrasado, data_referencia FROM public.venda_situacao"
)
factuais() {
  local i out=""
  Q "SELECT public.venda_recompra_atualizar()" > /dev/null
  for i in "${!FACTUAIS[@]}"; do out="$out $i=$(assinatura "${FACTUAIS[$i]}")"; done
  out="$out cand=$(q_como authenticated "$MASTER" "SELECT md5(public.venda_repasse_candidatos()::text)")"
  printf '%s' "$out"
}
PROJ="comprador_id, empresa, omie_codigo_produto, product_id, quantidade, preco_unit_liquido, data_pedido, sales_order_id"
conserva() {  # física: mesmas linhas, cada order_item uma vez, mesma quantidade por SKU
  Q "SELECT (SELECT count(*) FROM $EF) || '/' || (SELECT count(DISTINCT order_item_id) FROM $EF) || '/' ||
            (SELECT count(*) FROM private.venda_linhas_pedido($H)) || '/' ||
            (SELECT count(*) FROM (SELECT comprador_fisico_id, empresa, omie_codigo_produto, product_id, quantidade,
                                          preco_unit_liquido, data_pedido, sales_order_id FROM $EF
                                   EXCEPT ALL SELECT * FROM private.venda_linhas_pedido($H)) d) || '/' ||
            (SELECT count(*) FROM (SELECT empresa, omie_codigo_produto, sum(quantidade) FROM $EF GROUP BY 1, 2
                                   EXCEPT SELECT empresa, omie_codigo_produto, sum(quantidade)
                                     FROM private.venda_linhas_pedido($H) GROUP BY 1, 2) q)"
}
lin() {  # <filtro> → count das linhas da trilha
  Q "SELECT count(*) FROM $EF WHERE $1"
}

cenario() {
  local BASE E1 E2 E4 ID_UA1001 ID_UA1007 ID_UQ ID_UA1003 ID_UA1004 CONTATO R J REG1 REG2 SUC_NOV2 FATO1 FATO2

  echo "── 0. a migration toca só o que diz ──"
  chk M1 "funções criadas/recriadas = as do desenho (gerar_lista é a ÚNICA viva recriada)" \
    "$(grep -oE 'CREATE OR REPLACE FUNCTION [a-z_.]+' "$MIG" | awk '{print $5}' | sort | tr '\n' ' ' | sed 's/ $//')" \
    "private.cliente_sucessao_plano_imutavel private.historico_compradores_encerrados private.historico_consumo_efetivo private.venda_lista_calc_efetiva private.venda_recompra_efetiva_em private.venda_situacao_efetiva_em private.venda_sugestao_substituida_imutavel private.venda_sugestoes_reprocessar_sucessao public.cliente_sucessao_plano_do_evento public.cliente_sucessao_plano_publicar public.cliente_sucessao_plano_revogar public.venda_gerar_lista"
  chk M2 "ALTER TABLE só em venda_sugestao (marcação) e nas tabelas novas" \
    "$(grep -oE '^ALTER TABLE public\.[a-z_]+' "$MIG" | awk '{print $3}' | sort -u | tr '\n' ' ' | sed 's/ $//')" \
    "public.cliente_sucessao_plano_regras public.cliente_sucessao_plano_revisoes public.venda_sugestao public.venda_sugestao_substituida"
  chk M3 "os factuais seguem com os corpos de prod" \
    "$(Q "SELECT string_agg(md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
           WHERE p.proname IN ('venda_linhas_pedido','venda_recompra_em','venda_situacao_em','venda_lista_calc')")" \
    "a7ff6d1c894aea2e16483b5084a097a1,cd7a7184e4b07d3665b1c39f70a3ac59,2b43b81254a7c13c019c65fae41ea90a,e96cf9c931a13b209bb3017b8c4743ac"

  BASE="$(factuais)"
  echo "── 1. sem plano: a trilha efetiva = a factual ──"
  chk P1 "trilha efetiva × venda_linhas_pedido: 0 a mais / 0 a menos / 39 linhas" \
    "$(Q "SELECT (SELECT count(*) FROM (SELECT $PROJ FROM $EF EXCEPT ALL SELECT * FROM private.venda_linhas_pedido($H)) a)
              || '/' || (SELECT count(*) FROM (SELECT * FROM private.venda_linhas_pedido($H) EXCEPT ALL SELECT $PROJ FROM $EF) b)
              || '/' || (SELECT count(*) FROM private.venda_linhas_pedido($H))")" "0/0/39"

  E1="$(declarar "$ANT" "$NOV1" cisao -60)"
  chk S0a "E1 (cisão) declarada com o novo SEM cadastro" "$(Q "SELECT count(*) FROM public.cliente_sucessoes WHERE evento_id = '$E1'")" "1"
  declarar "$ANT" "$NOV2" cisao -60 > /dev/null
  E2="$(declarar "$DB_" "$DBN" sucessao -60)"
  E4="$(declarar "$DX2" "$DN4" cisao -60)"
  chk S0b "estados: E1 novo1 declarada, novo2 ativa; E2 ativa; E4 ativa" \
    "$(Q "SELECT string_agg(novo_documento || '=' || estado, ',' ORDER BY novo_documento)
            FROM private.cliente_sucessoes_vigentes($H)")" \
    "$NOV2=ativa,$DBN=ativa,$NOV1=declarada,$DN4=ativa"

  echo "── 2. gerador sem plano: a antiga ENCERRADA (sucessão) sai; o resto = factual ──"
  Q "SELECT public.venda_gerar_lista($H, 'ativa')" > /dev/null
  chk G1 "a antiga da sucessão (E2) não tem sugestão" "$(codigos "$UB")" ""
  chk G2 "pré-condição: o cálculo factual teria sugerido a ela" \
    "$(Q "SELECT string_agg(omie_codigo_produto::text, ',' ORDER BY 1) FROM private.venda_lista_calc($H) WHERE comprador_id = '$UB'")" "2001,2002"
  chk G3 "a antiga da cisão tem as dela (1006 não está atrasado)" "$(codigos "$UA")" "1001,1002,1003,1004,1005,1007"
  chk G4 "o cliente alheio tem a dele" "$(codigos "$UQ")" "3001"
  chk G5 "lista efetiva = factual menos a encerrada (0 a mais / 0 a menos)" \
    "$(Q "SELECT (SELECT count(*) FROM (SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada
                                          FROM private.venda_lista_calc_efetiva($H)
                                        EXCEPT ALL SELECT * FROM private.venda_lista_calc($H) WHERE comprador_id <> '$UB') a) || '/' ||
                 (SELECT count(*) FROM (SELECT * FROM private.venda_lista_calc($H) WHERE comprador_id <> '$UB'
                                        EXCEPT ALL SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada
                                          FROM private.venda_lista_calc_efetiva($H)) b)")" "0/0"
  chk G6 "recompra efetiva = factual menos a encerrada" \
    "$(Q "SELECT (SELECT count(*) FROM (SELECT comprador_id, empresa, omie_codigo_produto, product_id, n_pedidos, cadencia_dias, qtd_sugerida,
                                               ultima_compra, ultimo_preco, due_ratio, atrasado, valor_esperado
                                          FROM private.venda_recompra_efetiva_em($H)
                                        EXCEPT ALL SELECT * FROM public.venda_recompra_em($H) WHERE comprador_id <> '$UB') a) || '/' ||
                 (SELECT count(*) FROM (SELECT * FROM public.venda_recompra_em($H) WHERE comprador_id <> '$UB'
                                        EXCEPT ALL SELECT comprador_id, empresa, omie_codigo_produto, product_id, n_pedidos, cadencia_dias,
                                               qtd_sugerida, ultima_compra, ultimo_preco, due_ratio, atrasado, valor_esperado
                                          FROM private.venda_recompra_efetiva_em($H)) b)")" "0/0"
  chk G7 "situação efetiva (\"parou de comprar\") = factual menos a encerrada" \
    "$(Q "SELECT (SELECT count(*) FROM (SELECT * FROM private.venda_situacao_efetiva_em($H)
                                        EXCEPT ALL SELECT * FROM public.venda_situacao_em($H) WHERE comprador_id <> '$UB') a) || '/' ||
                 (SELECT count(*) FROM (SELECT * FROM public.venda_situacao_em($H) WHERE comprador_id <> '$UB'
                                        EXCEPT ALL SELECT * FROM private.venda_situacao_efetiva_em($H)) b)")" "0/0"
  chk G8 "pré-condição: a factual tem a encerrada na situação" \
    "$(Q "SELECT count(*) FROM public.venda_situacao_em($H) WHERE comprador_id = '$UB'")" "1"
  chk G9 "sem plano, nenhuma sugestão marcada com origem" \
    "$(Q "SELECT count(*) FILTER (WHERE sucessao_origem IS NOT NULL OR valor_ref_referencia_origem) FROM public.venda_sugestao")" "0"

  echo "── 3. validação da publicação (nada é gravado) ──"
  J_V1="$(printf '[{"empresa":"oben","omie_codigo_produto":1001,"familia":"X","novo_documento":"%s"}]' "$NOV2")"
  J_V2="$(printf '[{"empresa":"xpto","omie_codigo_produto":1001,"novo_documento":"%s"}]' "$NOV2")"
  J_V3="$(printf '[{"empresa":"oben","omie_codigo_produto":"1001","novo_documento":"%s"}]' "$NOV2")"
  chk V1 "regra com item E família → 22023 no ramo da forma" \
    "$(msg_como "$GER" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '$J_V1')")" "22023:cliente_sucessao_plano_publicar: regra 1 malformada"
  chk V2 "empresa fora das 3 → 22023 no ramo da forma" \
    "$(msg_como "$GER" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '$J_V2')")" "22023:cliente_sucessao_plano_publicar: regra 1 malformada"
  chk V3 "código como texto → 22023 no ramo da forma" \
    "$(msg_como "$GER" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '$J_V3')")" "22023:cliente_sucessao_plano_publicar: regra 1 malformada"
  chk V4 "regras vazias → 22023 no ramo do array" \
    "$(msg_como "$GER" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '[]')")" \
    "22023:cliente_sucessao_plano_publicar: evento, revisão esperada e regras (array não vazio)"
  chk V5 "destino fora do evento" "$(publicar "$E1" 0 "[$(item oben 1001 "$DQ")]" motivo)" "destino_fora_do_evento"
  chk V6 "família sem item da antiga antes do corte" "$(publicar "$E1" 0 "[$(fam oben NAOEXISTE "$NOV2")]" motivo)" "familia_sem_itens"
  chk V7 "item e família com destinos diferentes" \
    "$(publicar "$E1" 0 "[$(item oben 1004 "$NOV1"),$(fam oben VERNIZ "$NOV2")]" motivo)" "regra_conflitante"
  chk V9 "evento inexistente" "$(publicar "00000000-0000-0000-0000-00000000dead" 0 "[$(item oben 1001 "$NOV2")]" motivo)" "evento_sem_declaracao_ativa"
  chk V10 "nada gravado pelas recusas" "$(Q "SELECT count(*) FROM public.cliente_sucessao_plano_revisoes")" "0"

  echo "── 4. ACL e gate ──"
  chk K1 "anon não executa publicar (ACL de função)" \
    "$(estado_como anon '' "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '[]')")" "42501/acl-funcao:cliente_sucessao_plano_publicar"
  chk K2 "farmer (sem gestor) não publica" \
    "$(estado_como authenticated "$FARM" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, '[$(item oben 1001 "$NOV2")]')")" "42501/?"
  chk K3 "farmer não revoga" \
    "$(estado_como authenticated "$FARM" "SELECT public.cliente_sucessao_plano_revogar('$E1', 0, 'x')")" "42501/?"
  chk K4 "farmer não lê o plano" \
    "$(estado_como authenticated "$FARM" "SELECT public.cliente_sucessao_plano_do_evento('$E1')")" "42501/?"
  chk K5 "gestor não lê a tabela de regras direto" \
    "$(estado_como authenticated "$GER" "SELECT count(*) FROM public.cliente_sucessao_plano_regras")" "42501/acl-tabela:cliente_sucessao_plano_regras"
  chk K6 "nem a de revisões" \
    "$(estado_como authenticated "$GER" "SELECT count(*) FROM public.cliente_sucessao_plano_revisoes")" "42501/acl-tabela:cliente_sucessao_plano_revisoes"
  chk K7 "nem o arquivo das substituídas" \
    "$(estado_como authenticated "$GER" "SELECT count(*) FROM public.venda_sugestao_substituida")" "42501/acl-tabela:venda_sugestao_substituida"
  chk K8 "a trilha efetiva é fechada ao JWT" \
    "$(estado_como authenticated "$GER" "SELECT count(*) FROM private.historico_consumo_efetivo(current_date)")" "42501/acl-funcao:historico_consumo_efetivo"
  chk K9 "service_role não escreve no plano direto" \
    "$(estado_como service_role '' "INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, publicado_por) VALUES ('$E1', 1, false, '$GER')")" \
    "42501/acl-tabela:cliente_sucessao_plano_revisoes"
  chk K10 "anon não lê o plano" \
    "$(estado_como anon '' "SELECT public.cliente_sucessao_plano_do_evento('$E1')")" "42501/acl-funcao:cliente_sucessao_plano_do_evento"
  chk K11 "catálogo: RPCs fechadas a anon/PUBLIC e privadas fechadas a authenticated" \
    "$(Q "SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('public', p.oid, 'EXECUTE')
                         OR (n.nspname = 'private' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')))
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.proname IN ('cliente_sucessao_plano_publicar','cliente_sucessao_plano_revogar','cliente_sucessao_plano_do_evento',
                               'historico_consumo_efetivo','historico_compradores_encerrados','venda_recompra_efetiva_em',
                               'venda_situacao_efetiva_em','venda_lista_calc_efetiva','venda_sugestoes_reprocessar_sucessao')")" "f"

  # O que precisa sobreviver ao reprocesso: ids de sugestão que não mudam, a mostrada, a com desfecho, o contato.
  ID_UA1001="$(Q "SELECT id FROM public.venda_sugestao WHERE comprador_id = '$UA' AND omie_codigo_produto = 1001")"
  ID_UA1007="$(Q "SELECT id FROM public.venda_sugestao WHERE comprador_id = '$UA' AND omie_codigo_produto = 1007")"
  ID_UQ="$(Q "SELECT id FROM public.venda_sugestao WHERE comprador_id = '$UQ'")"
  ID_UA1003="$(Q "UPDATE public.venda_sugestao SET mostrada_em = now() WHERE comprador_id = '$UA' AND omie_codigo_produto = 1003 RETURNING id")"
  ID_UA1004="$(Q "UPDATE public.venda_sugestao SET desfecho = 'nao_medivel', desfecho_motivo = 'prova', avaliado_em = now()
                   WHERE comprador_id = '$UA' AND omie_codigo_produto = 1004 RETURNING id")"
  Q "INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado) VALUES ('$FARM', '$UA', $H, 'vai_pedir')" > /dev/null
  CONTATO="$(Q "SELECT md5(c::text) FROM public.venda_contato c")"

  echo "── 5. revisão 1 de E1: item inteiro → destino; família expandida; destino pendente não recebe ──"
  REG1="[{\"empresa\":\"oben\",\"omie_codigo_produto\":1001,\"novo_documento\":\"$NOV1\"},
         {\"empresa\":\"oben\",\"omie_codigo_produto\":1002,\"novo_documento\":\"$NOV2\"},
         {\"empresa\":\"colacor\",\"omie_codigo_produto\":1003,\"novo_documento\":\"$NOV2\"},
         {\"empresa\":\"oben\",\"familia\":\"VERNIZ\",\"novo_documento\":\"$NOV2\"},
         {\"empresa\":\"oben\",\"omie_codigo_produto\":1004,\"novo_documento\":\"$NOV2\"},
         {\"empresa\":\"oben\",\"omie_codigo_produto\":1006,\"novo_documento\":\"$NOV2\"}]"
  R="$(q_como authenticated "$GER" "SELECT public.cliente_sucessao_plano_publicar('$E1', 0, \$j\$$REG1\$j\$::jsonb, 'prova')")"
  chk R1a "publicou: ok / revisão 1 / 6 regras" \
    "$(Q "SELECT (\$j\$$R\$j\$::jsonb ->> 'ok') || '/' || (\$j\$$R\$j\$::jsonb ->> 'revisao') || '/' || (\$j\$$R\$j\$::jsonb ->> 'regras')")" "true/1/6"
  chk R1b "regras por item (a família expandida só nos itens de ANTES do corte; o explícito prevalece)" \
    "$(Q "SELECT string_agg(omie_codigo_produto || ':' || origem, ',' ORDER BY omie_codigo_produto) FROM public.cliente_sucessao_plano_regras WHERE evento_id = '$E1'")" \
    "1001:item,1002:item,1003:item,1004:item,1005:familia,1006:item"
  chk R1c "reprocesso: substituídas / novas / preservadas" \
    "$(Q "SELECT (\$j\$$R\$j\$::jsonb #>> '{sugestoes,substituidas}') || '/' || (\$j\$$R\$j\$::jsonb #>> '{sugestoes,novas}') || '/' ||
                 (\$j\$$R\$j\$::jsonb #>> '{sugestoes,preservadas}')")" "2/4/2"
  chk C1 "conservação (rev 1): linhas / itens distintos / factual / físicas a mais / SKUs com qtd diferente" "$(conserva)" "39/39/39/0/0"
  chk R1d "destino PENDENTE (novo sem cadastro) não recebe: 1001 segue na antiga" \
    "$(lin "omie_codigo_produto = 1001 AND (herdada OR comprador_id <> '$UA')")" "0"
  chk R1e "a linha do DIA do corte fica com a antiga" \
    "$(lin "omie_codigo_produto = 1002 AND data_pedido = $H - 60 AND comprador_id = '$UA' AND NOT herdada")" "1"
  chk R1f "item com regra, comprado DEPOIS do corte, fica com a antiga" \
    "$(lin "omie_codigo_produto = 1006 AND comprador_id = '$UA' AND NOT herdada")" "3"
  chk R1g "antes do corte, com destino ativo: herdada pela 2ª nova (evento E1, revisão 1)" \
    "$(lin "omie_codigo_produto IN (1002, 1003, 1004, 1005) AND herdada AND comprador_id = '$UN2' AND comprador_fisico_id = '$UA'
           AND sucessao_evento_id = '$E1' AND plano_revisao = 1")" "13"
  chk R1h "a nova NÃO ganha preço: o líquido herdado é o físico, NULL preservado" \
    "$(lin "herdada AND omie_codigo_produto = 1002 AND preco_unit_liquido IS NULL")" "1"
  chk R1i "vista de antes do corte, nada é herdado" \
    "$(Q "SELECT count(*) FILTER (WHERE herdada) FROM private.historico_consumo_efetivo($H - 61)")" "0"
  chk R1j "a antiga perde o que saiu (recompra efetiva)" "$(rec_ef "$UA")" "1001,1006,1007"
  chk R1k "a 2ª nova ganha o que entrou" "$(rec_ef "$UN2")" "1002,1003,1004,1005"
  chk R1l "1004 herdado: valor = referência da origem, marcado, com a origem" \
    "$(Q "SELECT valor_esperado::int || '/' || ultimo_preco_referencia_origem || '/' || (sucessao_origem = jsonb_build_array(jsonb_build_object('evento_id', '$E1'::uuid, 'revisao', 1)))
            FROM private.venda_recompra_efetiva_em($H) WHERE comprador_id = '$UN2' AND omie_codigo_produto = 1004")" "100/true/true"
  chk R1m "1003 mistura próprio + herdado: 5 dias, último preço próprio (não é referência)" \
    "$(Q "SELECT n_pedidos || '/' || ultimo_preco_referencia_origem || '/' || (sucessao_origem IS NOT NULL)
            FROM private.venda_recompra_efetiva_em($H) WHERE comprador_id = '$UN2' AND omie_codigo_produto = 1003")" "5/false/true"
  chk R1n "1002 herdado com o último líquido ausente: valor NULL (nunca 0)" \
    "$(Q "SELECT (valor_esperado IS NULL)::text || '/' || ultimo_preco_referencia_origem
            FROM private.venda_recompra_efetiva_em($H) WHERE comprador_id = '$UN2' AND omie_codigo_produto = 1002")" "true/false"
  chk R1o "a lista da antiga: 1002/1005 saíram; a mostrada (1003) e a com desfecho (1004) ficaram" "$(codigos "$UA")" "1001,1003,1004,1007"
  chk R1p "a mostrada é a MESMA linha, com mostrada_em" \
    "$(Q "SELECT count(*) FROM public.venda_sugestao WHERE id = '$ID_UA1003' AND mostrada_em IS NOT NULL")" "1"
  chk R1p2 "a com desfecho é a MESMA linha, com o desfecho" \
    "$(Q "SELECT count(*) FROM public.venda_sugestao WHERE id = '$ID_UA1004' AND desfecho = 'nao_medivel'")" "1"
  chk R1q "a lista da 2ª nova: as 4 herdadas, marcadas" \
    "$(Q "SELECT string_agg(omie_codigo_produto || ':' || (sucessao_origem IS NOT NULL), ',' ORDER BY omie_codigo_produto)
            FROM public.venda_sugestao WHERE comprador_id = '$UN2' AND dia_referencia = $H")" "1002:true,1003:true,1004:true,1005:true"
  chk R1q2 "valor_ref da nova: 1004 = referência da origem; 1002 NULL sem rótulo" \
    "$(Q "SELECT string_agg(omie_codigo_produto || ':' || COALESCE(valor_ref::int::text, 'null') || ':' || valor_ref_referencia_origem, ',' ORDER BY omie_codigo_produto)
            FROM public.venda_sugestao WHERE comprador_id = '$UN2' AND omie_codigo_produto IN (1002, 1004)")" "1002:null:false,1004:100:true"
  chk R1r "o que não mudou não foi trocado (mesmos ids)" \
    "$(Q "SELECT count(*) FROM public.venda_sugestao WHERE id IN ('$ID_UA1001', '$ID_UA1007', '$ID_UQ')")" "3"
  chk R1s "arquivo: as 2 que saíram, linha inteira, motivo/evento/revisão" \
    "$(Q "SELECT string_agg(omie_codigo_produto || ':' || motivo || ':' || (evento_id = '$E1') || ':' || plano_revisao || ':' ||
                             (sugestao ->> 'id' = id::text) || ':' || (sugestao ->> 'mostrada_em' IS NULL), ',' ORDER BY omie_codigo_produto)
            FROM public.venda_sugestao_substituida")" \
    "1002:plano_publicado:true:1:true:true,1005:plano_publicado:true:1:true:true"
  chk R1t "o contato do dia ficou intacto" "$(Q "SELECT count(*) || ':' || md5(string_agg(c::text, '')) FROM public.venda_contato c")" "1:$CONTATO"
  chk R1u "o cron de novo não duplica nem ressuscita" "$(Q "SELECT public.venda_gerar_lista($H, 'ativa')")" "0"
  chk R1v "leitura do plano (gestor): revisão 1, 6 regras, destino de 1001 pendente" \
    "$(q_como authenticated "$GER" "SELECT (r ->> 'revisao') || '/' || jsonb_array_length(r -> 'regras') || '/' ||
         (SELECT x ->> 'destino_estado' FROM jsonb_array_elements(r -> 'regras') x WHERE x ->> 'omie_codigo_produto' = '1001')
         FROM (SELECT public.cliente_sucessao_plano_do_evento('$E1') AS r) s")" "1/6/declarada"

  echo "── 6. sucessão (E2): a sucessora herda; a antiga segue fora ──"
  chk E2a "publicou o plano de E2" "$(publicar "$E2" 0 "[$(item oben 2001 "$DBN")]" ok)" "true"
  chk E2b "a sucessora ganha 2001; a antiga nada" "$(rec_ef "$UBN")|$(rec_ef "$UB")" "2001|"
  chk E2c "2002 (sem regra) segue na antiga na trilha (conservação), sem sugestão" \
    "$(lin "comprador_id = '$UB' AND omie_codigo_produto = 2002")|$(codigos "$UB")" "3|"
  chk E2d "a lista da sucessora" "$(codigos "$UBN")" "2001"
  chk E2e "a antiga encerrada fora da situação efetiva" \
    "$(Q "SELECT count(*) FROM private.venda_situacao_efetiva_em($H) WHERE comprador_id = '$UB'")" "0"

  echo "── 7. o FACTUAL não mudou (linhas, recompra, situação, lista, preço, repasse, tabela venda_recompra) ──"
  FATO1="$(factuais)"
  chk I1 "antes = depois (com os dois planos vigentes)" "$FATO1" "$BASE"
  chk I2 "não-vácuo: linhas, recompra, lista e a TABELA venda_recompra têm conteúdo" \
    "$(printf '%s' "$BASE" | tr ' ' '\n' | grep -E '^(0|1|3|6)=' | cut -d= -f2 | cut -d: -f1 | tr '\n' ',')" "39,11,10,11,"
  chk I3 "candidatos do repasse leram (não é erro dos dois lados)" "$(printf '%s' "$BASE" | grep -c 'cand=ERRO' || true)" "0"

  echo "── 8. revisão 2 de E1: a 1ª nova cadastra; versão otimista; o que saiu volta ──"
  Q "INSERT INTO public.profiles (user_id, name, document) VALUES ('$UN1', 'MARQUES', '$NOV1')" > /dev/null
  REG2="[{\"empresa\":\"oben\",\"omie_codigo_produto\":1001,\"novo_documento\":\"$NOV1\"},{\"empresa\":\"oben\",\"omie_codigo_produto\":1002,\"novo_documento\":\"$NOV2\"}]"
  chk V8 "versão velha recusada" "$(publicar "$E1" 0 "$REG2" motivo)" "revisao_mudou"
  chk R2a "publicou a revisão 2" "$(publicar "$E1" 1 "$REG2" revisao)" "2"
  chk C5 "conservação (rev 2, dois destinos ativos)" "$(conserva)" "39/39/39/0/0"
  chk R2b "1001 → 1ª nova; 1003/1004/1005 voltaram à antiga" \
    "$(lin "omie_codigo_produto = 1001 AND comprador_id = '$UN1' AND plano_revisao = 2")/$(lin "omie_codigo_produto IN (1003, 1004, 1005) AND comprador_id = '$UA' AND NOT herdada")" "3/10"
  chk R2c "recompra efetiva: antiga / 1ª nova / 2ª nova" "$(rec_ef "$UA")|$(rec_ef "$UN1")|$(rec_ef "$UN2")" "1003,1004,1005,1006,1007|1001|1002"
  chk R2d "listas: antiga / 1ª nova / 2ª nova" "$(codigos "$UA")|$(codigos "$UN1")|$(codigos "$UN2")" "1003,1004,1005,1007|1001|1002"
  chk R2e "a sugestão da 2ª nova agora vem da revisão 2" \
    "$(Q "SELECT sucessao_origem -> 0 ->> 'revisao' FROM public.venda_sugestao WHERE comprador_id = '$UN2' AND omie_codigo_produto = 1002")" "2"
  chk R2f "arquivo: 5 trocas da revisão 2" "$(Q "SELECT count(*) FROM public.venda_sugestao_substituida WHERE plano_revisao = 2")" "5"
  chk R2g "a mostrada segue a MESMA linha" "$(Q "SELECT count(*) FROM public.venda_sugestao WHERE id = '$ID_UA1003'")" "1"

  echo "── 9. destino REVOGADO volta à origem ──"
  SUC_NOV2="$(Q "SELECT id FROM public.cliente_sucessoes WHERE novo_documento = '$NOV2'")"
  q_como authenticated "$GER" "SELECT public.cliente_revogar_sucessao('$SUC_NOV2', 'prova', $(versao))" > /dev/null
  chk D1 "1002 todo na antiga, nada herdado" "$(lin "omie_codigo_produto = 1002 AND (herdada OR comprador_id <> '$UA')")" "0"
  chk D2 "a 1ª nova segue com 1001" "$(lin "omie_codigo_produto = 1001 AND comprador_id = '$UN1'")" "3"
  chk D3 "destino revogado não entra em plano novo" \
    "$(publicar "$E1" 2 "[$(item oben 1002 "$NOV2")]" motivo)" "destino_fora_do_evento"

  echo "── 10. revogar o plano: tudo volta à antiga ──"
  chk Z1 "revogou: revisão 3" "$(revogar_plano "$E1" 2 revisao)" "3"
  chk Z2 "nada herdado de E1" "$(lin "sucessao_evento_id = '$E1'")" "0"
  chk Z3 "a lista: a antiga recupera; a 1ª nova perde (arquivada como plano_revogado)" \
    "$(codigos "$UA")|$(codigos "$UN1")|$(Q "SELECT count(*) FROM public.venda_sugestao_substituida WHERE motivo = 'plano_revogado' AND comprador_id = '$UN1'")" \
    "1001,1002,1003,1004,1005,1007||1"
  chk Z4 "revogar de novo: sem plano" "$(revogar_plano "$E1" 3 motivo)" "sem_plano"
  chk Z5 "leitura: revisão 3, revogado, sem regras, 3 revisões no histórico" \
    "$(q_como authenticated "$GER" "SELECT (r ->> 'revisao') || '/' || (r ->> 'revogado') || '/' || jsonb_array_length(r -> 'regras') || '/' || jsonb_array_length(r -> 'revisoes')
         FROM (SELECT public.cliente_sucessao_plano_do_evento('$E1') AS r) s")" "3/true/0/3"

  echo "── 11. o grafo que vira DECLARADA (alias muda depois) derruba a herança ──"
  chk X0 "E4 publicado: a nova herda 5001" \
    "$(publicar "$E4" 0 "[$(item oben 5001 "$DN4")]" ok)/$(lin "sucessao_evento_id = '$E4'")" "true/3"
  Q "INSERT INTO public.customer_canonical_alias (alias_user_id, canonical_user_id, documento, status) VALUES ('$UX2', '$UA', '$DX2', 'active')" > /dev/null
  chk X1 "a antiga de E4 vira a mesma identidade da de E1: evento divergente, nada herdado" \
    "$(Q "SELECT string_agg(DISTINCT impedimento, ',') FROM private.cliente_sucessoes_vigentes($H) WHERE evento_id IN ('$E1', '$E4')")/$(lin "sucessao_evento_id = '$E4'")" \
    "evento_divergente/0"

  echo "── 12. imutabilidade e porta ──"
  chk H1 "UPDATE de revisão → 23001" "$(Q "SELECT prova.sqlstate(\$c\$UPDATE public.cliente_sucessao_plano_revisoes SET motivo = 'x'\$c\$)")" "23001"
  chk H2 "DELETE de regra → 23001" "$(Q "SELECT prova.sqlstate(\$c\$DELETE FROM public.cliente_sucessao_plano_regras\$c\$)")" "23001"
  chk H3 "TRUNCATE de regras / do arquivo → 23001" \
    "$(Q "SELECT prova.sqlstate(\$c\$TRUNCATE public.cliente_sucessao_plano_regras\$c\$) || '/' || prova.sqlstate(\$c\$TRUNCATE public.venda_sugestao_substituida\$c\$)")" "23001/23001"
  chk H4 "INSERT sem a porta → 23001" \
    "$(Q "SELECT prova.sqlstate(\$c\$INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, publicado_por) VALUES ('$E2', 2, false, '$GER')\$c\$)")" "23001"
  chk H5 "com a porta, revisão fora de sequência → 23001" \
    "$(porta "INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, publicado_por) VALUES ('$E2', 9, false, '$GER')")" "23001"
  chk H6 "com a porta, regra em revisão que revoga → 23001" \
    "$(porta "INSERT INTO public.cliente_sucessao_plano_regras (evento_id, revisao, empresa, omie_codigo_produto, destino_sucessao_id, novo_documento, origem)
              SELECT '$E1', 3, 'oben', 1001, id, novo_documento, 'item' FROM public.cliente_sucessoes WHERE novo_documento = '$NOV1'")" "23001"
  chk H7 "arquivo: UPDATE / INSERT sem porta → 23001" \
    "$(Q "SELECT prova.sqlstate(\$c\$UPDATE public.venda_sugestao_substituida SET motivo = 'plano_revogado'\$c\$) || '/' ||
                 prova.sqlstate(\$c\$INSERT INTO public.venda_sugestao_substituida SELECT gen_random_uuid(), reprocesso_id, substituida_em, motivo, evento_id, plano_revisao, dia_referencia, fase, farmer_user_id, comprador_id, empresa, omie_codigo_produto, sugestao FROM public.venda_sugestao_substituida LIMIT 1\$c\$)")" "23001/23001"
  chk H8 "controle da porta: com ela, a revisão SEGUINTE entra (a recusa do H5 é a sequência)" \
    "$(porta "INSERT INTO public.cliente_sucessao_plano_revisoes (evento_id, revisao, revoga, publicado_por) VALUES ('$E2', 2, false, '$GER')")" "OK"

  echo "── 13. re-aplicar a migration (idempotente; a PRE aceita este corpo) ──"
  chk M4 "re-aplicar passa" "$(P --single-transaction -v ON_ERROR_STOP=1 -q -f "$MIG" > /dev/null 2>&1 && echo ok || echo falhou)" "ok"
}

GERAR='public.venda_gerar_lista(date,text)'
PUB='public.cliente_sucessao_plano_publicar(uuid,integer,jsonb,text)'
TRILHA='private.historico_consumo_efetivo(date)'
REPRO='private.venda_sugestoes_reprocessar_sucessao(uuid,integer,text)'
IMUT='private.cliente_sucessao_plano_imutavel()'
GATE_GESTOR='IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'
sabotagem() {
  case "$1" in
    sem_gate_publicar) cv_sabotar "$PUB" "$GATE_GESTOR" "IF false THEN" ;;
    sem_gate_revogar) cv_sabotar 'public.cliente_sucessao_plano_revogar(uuid,integer,text)' "$GATE_GESTOR" "IF false THEN" ;;
    sem_gate_ler) cv_sabotar 'public.cliente_sucessao_plano_do_evento(uuid)' "$GATE_GESTOR" "IF false THEN" ;;
    anon_executa) P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $PUB TO anon" ;;
    tabela_aberta) P -v ON_ERROR_STOP=1 -q -c "GRANT SELECT ON public.cliente_sucessao_plano_regras TO authenticated" ;;
    trilha_sem_corte) cv_sabotar "$TRILHA" "AND l.data_pedido < rg.data_corte" "" ;;
    trilha_destino_qualquer) cv_sabotar "$TRILHA" "JOIN v ON v.id = g.destino_sucessao_id AND v.evento_id = g.evento_id" "JOIN v ON v.evento_id = g.evento_id" ;;
    trilha_sem_ativa) cv_sabotar "$TRILHA" "WHERE s.estado = 'ativa' AND s.data_corte <= p_ate" "WHERE s.data_corte <= p_ate" ;;
    trilha_revisao_antiga) cv_sabotar "$TRILHA" "ORDER BY r.evento_id, r.revisao DESC" "ORDER BY r.evento_id, r.revisao" ;;
    trilha_visao_sem_corte) cv_sabotar "$TRILHA" "WHERE s.estado = 'ativa' AND s.data_corte <= p_ate" "WHERE s.estado = 'ativa'" ;;
    trilha_sem_alias) cv_sabotar "$TRILHA" "ON a.alias_user_id = so.customer_user_id AND a.status = 'active'" "ON false" ;;
    trilha_universo) cv_sabotar "$TRILHA" "AND oi.quantity > 0" "" ;;
    encerrados_qualquer_tipo) cv_sabotar 'private.historico_compradores_encerrados(date)' "AND v.tipo = 'sucessao'" "" ;;
    recompra_sem_encerrados) cv_sabotar 'private.venda_recompra_efetiva_em(date)' \
      "AND NOT EXISTS (SELECT 1 FROM enc WHERE enc.comprador_id = l.comprador_id)" "" ;;
    situacao_sem_encerrados) cv_sabotar 'private.venda_situacao_efetiva_em(date)' \
      "WHERE NOT EXISTS (SELECT 1 FROM enc WHERE enc.comprador_id = l.comprador_id)" "" ;;
    recompra_sem_rotulo) cv_sabotar 'private.venda_recompra_efetiva_em(date)' "a.ultimo_herdado AND a.ultimo_preco IS NOT NULL" "false" ;;
    reprocesso_apaga_mostrada) cv_sabotar "$REPRO" "AND s.mostrada_em IS NULL AND s.desfecho IS NULL" "AND s.desfecho IS NULL" ;;
    reprocesso_apaga_desfecho) cv_sabotar "$REPRO" "AND s.mostrada_em IS NULL AND s.desfecho IS NULL" "AND s.mostrada_em IS NULL" ;;
    reprocesso_substituta_fora) cv_sabotar "$REPRO" "SELECT 'recompra', v_fase, v_dia, n.farmer_user_id" "SELECT 'recompra', v_fase, v_dia + 1, n.farmer_user_id" ;;
    gerador_factual) cv_sabotar "$GERAR" "FROM private.venda_lista_calc_efetiva(p_dia) l" \
      "FROM (SELECT c.*, NULL::jsonb AS sucessao_origem, false AS valor_ref_referencia_origem FROM private.venda_lista_calc(p_dia) c) l" ;;
    publicar_sem_versao) cv_sabotar "$PUB" "IF v_atual IS DISTINCT FROM p_revisao_esperada THEN" "IF false THEN" ;;
    familia_sem_filtro) cv_sabotar "$PUB" "AND btrim(op.familia) = d.familia)" "AND true)" ;;
    familia_apos_corte) cv_sabotar "$PUB" "FROM private.venda_linhas_pedido(v_corte) l" "FROM private.venda_linhas_pedido(v_corte + 1000) l" ;;
    porta_aberta) cv_sabotar "$IMUT" "IF current_setting('cliente_sucessao_plano.porta', true) IS DISTINCT FROM 'rpc' THEN" "IF false THEN" ;;
    revisao_qualquer) cv_sabotar "$IMUT" "IF NEW.revisao IS DISTINCT FROM 1 + COALESCE(" "IF false AND NEW.revisao IS DISTINCT FROM 1 + COALESCE(" ;;
    regra_em_revoga) cv_sabotar "$IMUT" "AND NOT r.revoga) THEN" ") THEN" ;;
    sem_trigger_revisoes) P -v ON_ERROR_STOP=1 -q -c "DROP TRIGGER cliente_sucessao_plano_revisoes_imutavel_trg ON public.cliente_sucessao_plano_revisoes" ;;
    *) echo "SABOTAGEM desconhecida: $1"; return 1 ;;
  esac
}
# <sabotagem>:<asserts que TÊM de virar vermelhos>:<asserts que têm de seguir verdes (a sabotagem não quebrou outra camada)>
SABOTAGENS="sem_gate_publicar:K2:K1
sem_gate_revogar:K3:K2
sem_gate_ler:K4:K2
anon_executa:K1:K2
tabela_aberta:K5:K6
trilha_sem_corte:R1e,R1f:R1g
trilha_destino_qualquer:C5:C1
trilha_sem_ativa:X1:X0
trilha_revisao_antiga:R2b:R1g
trilha_visao_sem_corte:R1i:R1g
trilha_sem_alias:P1:K1
trilha_universo:P1:K1
encerrados_qualquer_tipo:G3:G4
recompra_sem_encerrados:G6:G7
situacao_sem_encerrados:G7:G6
recompra_sem_rotulo:R1l,R1q2:R1m
reprocesso_apaga_mostrada:R1p:R1p2
reprocesso_apaga_desfecho:R1p2:R1p
reprocesso_substituta_fora:R1q:R1s
gerador_factual:G1:G4
publicar_sem_versao:V8:R1a
familia_sem_filtro:R1a:V1
familia_apos_corte:R1a:V1
porta_aberta:H4:H1
revisao_qualquer:H5:H4
regra_em_revoga:H6:H4
sem_trigger_revisoes:H1:H2"

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
