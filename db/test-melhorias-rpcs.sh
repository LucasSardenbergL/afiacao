#!/usr/bin/env bash
# Prova PG17 do canal Melhorias — as 2 RPCs de dados (melhoria_clientes_por_produto e
# melhoria_produtos_relacionados, SECURITY DEFINER) e a RLS de melhoria_itens / melhoria_mensagens —
# contra o schema que PRODUÇÃO executa (db/lib/corpo-vivo.sh: snapshot + ACL medido em prod + a cadeia
# viva das RPCs, dos helpers que elas e as policies chamam e das tabelas que elas leem — hoje 5
# migrations: a 20260929000234, que reescreve as 2 RPCs com o escape de curinga, e as 4 de
# order_items/sales_orders que o snapshot não tem). md5 das 2 RPCs = o de prod (619fdf35…, 7be92ff8…;
# medido em 2026-10-01).
#
# O que ela assevera (o que SÓ a versão morta provava — as irmãs cobrem o resto, sem duplicar):
#  • os guards das 2 RPCs: o termo curto (< 3 depois do trim) é recusado nas duas, o não-staff é
#    barrado na produtos_relacionados e o anon não executa nenhuma (nega o EXECUTE, camada nomeada);
#  • quem vê quais clientes na clientes_por_produto: o master vê todos ('todos'), a vendedora só a
#    carteira dela ('minha_carteira') — e só pedido válido conta: janela de 12 meses, cancelado,
#    rascunho, pendente e apagado (deleted_at) fora, produto inativo fora;
#  • a produtos_relacionados: mesma família (ativo, mesma conta, sem o alvo) e comprados juntos (regra
#    cujo antecedente é o alvo, máximo de confiança/lift por consequente, sem inativo nem o alvo); o
#    produto inativo não é alvo;
#  • a RLS de melhoria_itens e melhoria_mensagens como o app a vê (SET ROLE + JWT na mesma sessão): a
#    autoria e o gate de staff no INSERT, os campos do founder e o status nascendo fechados, a leitura
#    (autor ou master), o UPDATE só do master (calado — 0 linhas — para os outros), a mensagem só no
#    item próprio aberto, o papel founder só do master, `dados` só da edge; o anon não lê nem escreve.
# Fora daqui, de propósito: o gate de staff da clientes_por_produto e o escape do termo
# (db/test-padrao-like-contem.sh, F18–F22, núcleo), o ranking com receita NULL
# (db/test-preco-ausente-nao-e-zero.sh, núcleo) e os helpers no schema privado
# (db/test-fu7-helpers-schema-privado.sh). A cobertura por carteira (carteira_coverage) e o papel
# comercial gerencial são semântica dos helpers, não da RPC.
#
# Os 2 guards das RPCs dão a MESMA SQLSTATE (P0001: RAISE EXCEPTION sem ERRCODE). Cada assert de guard
# usa uma entrada que só UM deles pode barrar (o não-staff com termo longo; o master com termo curto),
# e cada guard tem a sua sabotagem.
#
# Camada redundante, medida: a conjunção `i.autor_user_id = auth.uid()` da policy de INSERT de
# mensagens não tem dente sobre o NÃO-master — a subconsulta dela lê melhoria_itens sob a RLS de quem
# insere, e a vendedora já não vê o item do master (M2 segue verde na sabotagem dela). O dente dela é
# o MASTER, que vê todo item: sem ela, ele posta como 'funcionario' no item alheio (M9).
#
# Até 2026-10-01 esta prova re-aplicava a 20260610130000 sobre o snapshot e morreu duas vezes fora do
# núcleo: em 07-21 no 1º assert (o corpo de junho chamava carteira_visivel_para, que o fu7 moveu para o
# schema privado) e, desde 39ec9e31e (08-28), já no seed (o CHECK de cluster_segment em
# farmer_association_rules). E dois dos asserts eram teatro: o do termo curto aceitava qualquer erro
# cuja mensagem tivesse "curto" — inclusive a do próprio teste, "A4 FALHOU: termo curto…" — e o do anon
# na RPC imprimia OK sem conferir nada. Histórico: docs/historico/provas-carteira-revividas.md.
#
# MODOS
#   bash db/test-melhorias-rpcs.sh               # cenário no schema vivo → PASS=<n>  FAIL=<m>
#   bash db/test-melhorias-rpcs.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + ACL + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5485}"
TMPD="$(mktemp -d /tmp/pgtest-melhorias.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# Socket num diretório exclusivo e sem TCP: a porta deixa de ser recurso disputado entre provas.
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

# Os objetos que esta prova assevera — as 2 RPCs, os helpers que elas e as policies chamam e as
# tabelas que elas leem e escrevem: a migration nova que fizer DDL sobre eles entra na cadeia sozinha.
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(melhoria_clientes_por_produto melhoria_produtos_relacionados padrao_like_contem
            carteira_visivel_para pode_ver_carteira_completa has_role)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(melhoria_itens melhoria_mensagens omie_products order_items sales_orders profiles
            farmer_association_rules carteira_assignments user_roles)
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + cadeia viva…"
cv_montar

MASTER='00000000-0000-0000-0000-0000000aaaa1'    # master: vê toda a base e todo item
VEND='00000000-0000-0000-0000-0000000aaaa2'      # employee sem papel comercial gerencial: só a carteira dela
CLI='00000000-0000-0000-0000-0000000cccc3'       # customer: não é staff
C1='00000000-0000-0000-0000-0000000c0001'        # comprador na carteira da VEND
C2='00000000-0000-0000-0000-0000000c0002'        # comprador sem dono
ITEM_V='00000000-0000-0000-0000-00000000e0a1'    # item aberto da VEND
ITEM_R='00000000-0000-0000-0000-00000000e0a2'    # item resolvido da VEND
ITEM_M='00000000-0000-0000-0000-00000000e0a3'    # item aberto do MASTER
so() { printf '00000000-0000-0000-0000-00000000d00%s' "$1"; }
pr() { printf '00000000-0000-0000-0000-00000000f00%s' "$1"; }
# A data comercial é o dia de São Paulo (a RPC compara no fuso escrito, não no da sessão) e fica longe
# das bordas: 10–90 dias dentro da janela de 12 meses, 430 fora.
dia() { printf "((now() AT TIME ZONE 'America/Sao_Paulo')::date - %s)" "$1"; }
# Numa transação SÓ: o trigger de coerência (cadeia viva) é DEFERIDO e confere, no COMMIT, que o `items`
# do cabeçalho descreve as mesmas linhas de order_items. Os papéis entram ANTES dos profiles: sem papel,
# o trigger de profiles daria 'customer' a quem não tem.
echo "→ seed-base: papéis, carteira, catálogo, pedidos coerentes, regras de associação, itens e mensagens…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'), ('$VEND'), ('$CLI'), ('$C1'), ('$C2');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER', 'master'), ('$VEND', 'employee'), ('$CLI', 'customer'), ('$C1', 'customer'), ('$C2', 'customer');
INSERT INTO public.profiles (user_id, name) VALUES ('$C1', 'Cliente Um'), ('$C2', 'Cliente Dois');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, eligible)
VALUES ('$C1', '$VEND', 'omie', true);
-- P1 é o alvo de 'LIXA GR80'. P2 é a mesma família ativa; P4 a mesma família INATIVA; P5 a mesma família
-- na OUTRA conta; P3 e P6 são de outra família (consequentes de regras).
INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, familia) VALUES
  ('$(pr 1)', 1001, 'P001', 'LIXA GR80 TESTE',    'oben',    true,  'ABRASIVOS TESTE'),
  ('$(pr 2)', 1002, 'P002', 'LIXA GR120 TESTE',   'oben',    true,  'ABRASIVOS TESTE'),
  ('$(pr 3)', 1003, 'P003', 'COLA TESTE',         'oben',    true,  'QUIMICOS TESTE'),
  ('$(pr 4)', 1004, 'P004', 'LIXA GR240 TESTE',   'oben',    false, 'ABRASIVOS TESTE'),
  ('$(pr 5)', 1005, 'K005', 'LIXA COLACOR TESTE', 'colacor', true,  'ABRASIVOS TESTE'),
  ('$(pr 6)', 1006, 'P006', 'MASSA TESTE',        'oben',    true,  'QUIMICOS TESTE');
-- Só SO1 (C1, 50.00) e SO2 (C2, 10.00) contam para 'LIXA GR80'. Cada pedido que NÃO conta tem uma
-- quantidade própria, então qualquer um que vaze muda o valor de um jeito reconhecível: fora da janela
-- (+500), cancelado (+500), rascunho (+5000), pendente (+15000), apagado (+35). SO8 é de produto
-- inativo (só a busca 'GR240' o alcança).
INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi, deleted_at) VALUES
  ('$(so 1)', '$C1', '$VEND', 'oben', 'faturado',  $(dia 60),  NULL),
  ('$(so 2)', '$C2', '$VEND', 'oben', 'enviado',   $(dia 90),  NULL),
  ('$(so 3)', '$C1', '$VEND', 'oben', 'faturado',  $(dia 430), NULL),
  ('$(so 4)', '$C2', '$VEND', 'oben', 'cancelado', $(dia 30),  NULL),
  ('$(so 5)', '$C1', '$VEND', 'oben', 'rascunho',  $(dia 20),  NULL),
  ('$(so 6)', '$C2', '$VEND', 'oben', 'pendente',  $(dia 25),  NULL),
  ('$(so 7)', '$C1', '$VEND', 'oben', 'faturado',  $(dia 10),  now()),
  ('$(so 8)', '$C2', '$VEND', 'oben', 'faturado',  $(dia 15),  NULL);
INSERT INTO public.order_items (sales_order_id, customer_user_id, product_id, omie_codigo_produto, quantity, unit_price) VALUES
  ('$(so 1)', '$C1', '$(pr 1)', 1001, 10,   5.00),
  ('$(so 2)', '$C2', '$(pr 1)', 1001, 2,    5.00),
  ('$(so 3)', '$C1', '$(pr 1)', 1001, 100,  5.00),
  ('$(so 4)', '$C2', '$(pr 1)', 1001, 100,  5.00),
  ('$(so 5)', '$C1', '$(pr 1)', 1001, 1000, 5.00),
  ('$(so 6)', '$C2', '$(pr 1)', 1001, 3000, 5.00),
  ('$(so 7)', '$C1', '$(pr 1)', 1001, 7,    5.00),
  ('$(so 8)', '$C2', '$(pr 4)', 1004, 1,    99.00);
UPDATE public.sales_orders so
   SET items = (SELECT jsonb_agg(jsonb_build_object('omie_codigo_produto', oi.omie_codigo_produto,
                                                    'quantidade', oi.quantity,
                                                    'valor_unitario', oi.unit_price::text,
                                                    'desconto', oi.discount) ORDER BY oi.id)
                  FROM public.order_items oi WHERE oi.sales_order_id = so.id)
 WHERE EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.sales_order_id = so.id);
-- P1 → {P3, P4, P1} em duas regras (o máximo por consequente: 0.4 / 2.1); P2 → {P6} é de OUTRO
-- antecedente (lift 5, o maior de todos) e não pode aparecer para o alvo P1.
INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids, confidence, lift, support, rule_type, cluster_segment) VALUES
  (ARRAY['$(pr 1)'], ARRAY['$(pr 3)', '$(pr 4)', '$(pr 1)'], 0.4, 2.1, 0.1, 'association', 'geral'),
  (ARRAY['$(pr 1)'], ARRAY['$(pr 3)'],                       0.3, 1.5, 0.1, 'association', 'geral'),
  (ARRAY['$(pr 2)'], ARRAY['$(pr 6)'],                       0.9, 5.0, 0.1, 'association', 'geral');
-- Itens e mensagens-base (escritos pelo dono do banco: a RLS de escrita é medida no cenário).
INSERT INTO public.melhoria_itens (id, autor_user_id, empresa, tipo, urgencia, titulo, status, resolvido_em) VALUES
  ('$ITEM_V', '$VEND',   'oben', 'problema', 'alta',  'Bug no picking',   'aberto',    NULL),
  ('$ITEM_R', '$VEND',   'oben', 'pergunta', 'baixa', 'Duvida resolvida', 'resolvido', now()),
  ('$ITEM_M', '$MASTER', 'oben', 'sugestao', 'media', 'Ideia do master',  'aberto',    NULL);
INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo) VALUES
  ('$ITEM_V', '$VEND',   'funcionario', 'Detalhe do bug'),
  ('$ITEM_R', '$VEND',   'funcionario', 'Pergunta original'),
  ('$ITEM_M', '$MASTER', 'founder',     'Nota do master');
COMMIT;
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — a leitura COMO o app: o papel e o JWT fixados na MESMA sessão que
# lê (vários -c, um psql só), como o PostgREST faz. ON_ERROR_STOP: um SET ROLE que falhe aborta, em vez
# de deixar a leitura rodar como superusuário. Na falha, o valor é o erro — assert vermelho com o porquê.
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"; fi
}
# st_como <papel> <uid ou ''> <sql> — o veredito do comando COMO o app: 'OK' ou a SQLSTATE, com a camada
# e o objeto que negaram quando é 42501 (prova.sqlstate, em db/lib/corpo-vivo.sh).
st_como() { q_como "$1" "$2" "SELECT prova.sqlstate(\$cmd\$$3\$cmd\$);"; }
# rpc <uid> <função> <termo> <expressão sobre r> — chama a RPC como authenticated e projeta o jsonb.
rpc() { q_como authenticated "$1" "SELECT $4 FROM (SELECT public.$2('$3') AS r) s;"; }
# codigos <chave> — os códigos de uma lista do jsonb, ordenados; vazio vira '-' (ausente não some).
codigos() { printf "coalesce((SELECT string_agg(e->>'codigo', ',' ORDER BY e->>'codigo') FROM jsonb_array_elements(r->'%s') e), '-')" "$1"; }
CLIENTES="coalesce((SELECT string_agg((c->>'cliente') || ':' || (c->>'n_pedidos') || ':' || (c->>'valor_12m'), ',' ORDER BY c->>'cliente') FROM jsonb_array_elements(r->'clientes') c), '-')"
NOMES="coalesce((SELECT string_agg(c->>'cliente', ',' ORDER BY c->>'cliente') FROM jsonb_array_elements(r->'clientes') c), '-')"
JUNTOS="coalesce((SELECT string_agg((e->>'codigo') || ':' || (e->>'confidence') || ':' || (e->>'lift'), ',' ORDER BY e->>'codigo') FROM jsonb_array_elements(r->'comprados_juntos') e), '-')"
item() {  # <autor> [colunas extras] [valores extras] — o INSERT de item como o app o faz
  printf "INSERT INTO public.melhoria_itens (autor_user_id, empresa, tipo, titulo%s) VALUES ('%s', 'oben', 'problema', 'Item de teste'%s)" "${2:-}" "$1" "${3:-}"
}
msg() {  # <item> <autor> <papel> [dados] — o INSERT de mensagem como o app o faz
  printf "INSERT INTO public.melhoria_mensagens (item_id, autor_user_id, papel, conteudo, dados) VALUES ('%s', '%s', '%s', 'Mensagem de teste', %s)" "$1" "$2" "$3" "${4:-NULL}"
}
CONTA_ITENS="SELECT (SELECT count(*) FROM public.melhoria_itens) || '|' || (SELECT count(*) FROM public.melhoria_mensagens);"
NEGA_ITEM='42501/rls:melhoria_itens'
NEGA_MSG='42501/rls:melhoria_mensagens'

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ os guards das RPCs (P0001 é dos dois: cada entrada só pode tropeçar em UM) e o ACL"
  chk G1 "não-staff é barrado na produtos_relacionados (termo longo: só o gate de staff morde)" \
    "$(st_como authenticated "$CLI" "SELECT public.melhoria_produtos_relacionados('LIXA GR80')")" "P0001"
  chk G2 "termo curto é recusado na produtos_relacionados (o master passa o gate de staff)" \
    "$(st_como authenticated "$MASTER" "SELECT public.melhoria_produtos_relacionados('ab')")" "P0001"
  chk G3 "termo curto DEPOIS do trim é recusado na clientes_por_produto ('  ab  ')" \
    "$(st_como authenticated "$MASTER" "SELECT public.melhoria_clientes_por_produto('  ab  ')")" "P0001"
  chk G5 "anon não executa a clientes_por_produto — nega o EXECUTE da RPC" \
    "$(st_como anon '' "SELECT public.melhoria_clientes_por_produto('LIXA GR80')")" "42501/acl-funcao:melhoria_clientes_por_produto"
  chk G6 "anon não executa a produtos_relacionados — nega o EXECUTE da RPC" \
    "$(st_como anon '' "SELECT public.melhoria_produtos_relacionados('LIXA GR80')")" "42501/acl-funcao:melhoria_produtos_relacionados"

  echo "→ clientes_por_produto: quem vê quem, e só o pedido válido conta"
  chk D1 "o master vê a base toda (escopo|total)" \
    "$(rpc "$MASTER" melhoria_clientes_por_produto 'LIXA GR80' "(r->>'escopo') || '|' || (r->>'total_clientes_visiveis')")" "todos|2"
  chk D2 "só pedido válido na janela de 12 meses conta (cliente:n_pedidos:valor_12m)" \
    "$(rpc "$MASTER" melhoria_clientes_por_produto 'LIXA GR80' "$CLIENTES")" "Cliente Dois:1:10.00,Cliente Um:1:50.00"
  chk D3 "a vendedora vê só a carteira dela (escopo|total|clientes — QUEM, os valores são o D2)" \
    "$(rpc "$VEND" melhoria_clientes_por_produto 'LIXA GR80' "(r->>'escopo') || '|' || (r->>'total_clientes_visiveis') || '|' || $NOMES")" \
    "minha_carteira|1|Cliente Um"
  chk D4 "venda de produto inativo não conta ('GR240': o único que casa é inativo)" \
    "$(rpc "$MASTER" melhoria_clientes_por_produto 'GR240' "(r->>'total_clientes_visiveis')")" "0"

  echo "→ produtos_relacionados: família e comprados juntos"
  chk R1 "mesma família: ativo, mesma conta, sem o alvo" \
    "$(rpc "$MASTER" melhoria_produtos_relacionados 'LIXA GR80' "$(codigos mesma_familia)")" "P002"
  chk R2 "comprados juntos: só regras do alvo, máximo por consequente, sem inativo nem o alvo (codigo:conf:lift)" \
    "$(rpc "$MASTER" melhoria_produtos_relacionados 'LIXA GR80' "$JUNTOS")" "P003:0.400:2.10"
  chk R3 "o produto inativo não é alvo ('GR240')" \
    "$(rpc "$MASTER" melhoria_produtos_relacionados 'GR240' "$(codigos produtos_casados)")" "-"

  echo "→ RLS de leitura (itens|mensagens) como o app a vê"
  chk S1 "a vendedora lê os itens dela (2), não o do master" "$(q_como authenticated "$VEND" "SELECT count(*) FROM public.melhoria_itens;")" "2"
  chk S2 "o master lê todos os itens" "$(q_como authenticated "$MASTER" "SELECT count(*) FROM public.melhoria_itens;")" "3"
  chk S3 "o cliente não lê item nem mensagem" "$(q_como authenticated "$CLI" "$CONTA_ITENS")" "0|0"
  chk S4 "o anon não lê item nem mensagem" "$(q_como anon '' "$CONTA_ITENS")" "0|0"
  chk S5 "a vendedora lê só as mensagens dos itens dela" "$(q_como authenticated "$VEND" "SELECT count(*) FROM public.melhoria_mensagens;")" "2"
  chk S6 "o master lê todas as mensagens" "$(q_como authenticated "$MASTER" "SELECT count(*) FROM public.melhoria_mensagens;")" "3"

  echo "→ UPDATE de item: só o master; para os outros a policy CALA (0 linhas, sem erro)"
  chk U1 "a vendedora não muda o status do próprio item (linhas afetadas)" \
    "$(q_como authenticated "$VEND" "WITH u AS (UPDATE public.melhoria_itens SET status = 'resolvido' WHERE id = '$ITEM_V' RETURNING 1) SELECT count(*) FROM u;")" "0"
  chk U2 "o master muda o status (linhas afetadas)" \
    "$(q_como authenticated "$MASTER" "WITH u AS (UPDATE public.melhoria_itens SET status = 'em_andamento' WHERE id = '$ITEM_M' RETURNING 1) SELECT count(*) FROM u;")" "1"

  echo "→ INSERT de item: autor = quem insere, só staff, e nasce aberto, pendente e sem campo do founder"
  chk I1 "a vendedora abre item próprio" "$(st_como authenticated "$VEND" "$(item "$VEND")")" "OK"
  chk I2 "item com autor alheio é barrado" "$(st_como authenticated "$VEND" "$(item "$MASTER")")" "$NEGA_ITEM"
  chk I3 "item nascendo com triagem 'ok' é barrado" "$(st_como authenticated "$VEND" "$(item "$VEND" ", triagem_status" ", 'ok'")")" "$NEGA_ITEM"
  chk I4 "o cliente (não-staff) não abre item nem com autoria própria" "$(st_como authenticated "$CLI" "$(item "$CLI")")" "$NEGA_ITEM"
  chk I5 "item nascendo resolvido é barrado" "$(st_como authenticated "$VEND" "$(item "$VEND" ", status" ", 'resolvido'")")" "$NEGA_ITEM"
  chk I6 "item nascendo com avaliação|resposta do founder|resolvido_em é barrado" \
    "$(st_como authenticated "$VEND" "$(item "$VEND" ", avaliacao_founder" ", 'otimo'")")|$(st_como authenticated "$VEND" "$(item "$VEND" ", resposta_founder" ", 'feito'")")|$(st_como authenticated "$VEND" "$(item "$VEND" ", resolvido_em" ", now()")")" \
    "$NEGA_ITEM|$NEGA_ITEM|$NEGA_ITEM"
  chk I7 "o master abre item próprio" "$(st_como authenticated "$MASTER" "$(item "$MASTER")")" "OK"
  chk W1 "o anon não abre item" "$(st_como anon '' "$(item "$VEND")")" "$NEGA_ITEM"

  echo "→ INSERT de mensagem: no item próprio aberto, papel founder só do master, dados só da edge"
  chk M1 "a vendedora escreve no próprio item aberto" "$(st_como authenticated "$VEND" "$(msg "$ITEM_V" "$VEND" funcionario)")" "OK"
  chk M2 "a vendedora não escreve no item do master" "$(st_como authenticated "$VEND" "$(msg "$ITEM_M" "$VEND" funcionario)")" "$NEGA_MSG"
  chk M3 "papel founder por quem não é master é barrado" "$(st_como authenticated "$VEND" "$(msg "$ITEM_V" "$VEND" founder)")" "$NEGA_MSG"
  chk M4 "dados preenchidos (exclusivo da edge) são barrados" "$(st_como authenticated "$VEND" "$(msg "$ITEM_V" "$VEND" funcionario "'{\"x\":1}'::jsonb")")" "$NEGA_MSG"
  chk M5 "o master responde como founder no item da vendedora" "$(st_como authenticated "$MASTER" "$(msg "$ITEM_V" "$MASTER" founder)")" "OK"
  chk M6 "a vendedora não escreve no próprio item já resolvido" "$(st_como authenticated "$VEND" "$(msg "$ITEM_R" "$VEND" funcionario)")" "$NEGA_MSG"
  chk M7 "mensagem com autor alheio é barrada" "$(st_como authenticated "$VEND" "$(msg "$ITEM_V" "$MASTER" funcionario)")" "$NEGA_MSG"
  chk M8 "papel 'ia' (o da edge) é barrado para quem está logado" "$(st_como authenticated "$VEND" "$(msg "$ITEM_V" "$VEND" ia)")" "$NEGA_MSG"
  chk M9 "o master não posta como 'funcionario' no item alheio" "$(st_como authenticated "$MASTER" "$(msg "$ITEM_V" "$MASTER" funcionario)")" "$NEGA_MSG"
  return 0
}

# sabotar_policy <tabela> <policy> <qual|with_check> <âncora> <troca> — o cv_sabotar das POLICIES: troca
# a âncora no texto VIVO da expressão (pg_policies) e re-emite com ALTER POLICY. A âncora tem de ocorrer
# EXATAMENTE uma vez e a expressão tem de mudar: sabotagem que não pegou é erro (status ≠ 0), nunca "a
# suíte ficou verde, então o assert não tem dente".
sabotar_policy() {
  P -v ON_ERROR_STOP=1 -q -v tab="$1" -v pol="$2" -v campo="$3" -v ancora="$4" -v troca="$5" > /dev/null <<'SQL'
SELECT set_config('sp.tab', :'tab', false), set_config('sp.pol', :'pol', false),
       set_config('sp.campo', :'campo', false), set_config('sp.ancora', :'ancora', false),
       set_config('sp.troca', :'troca', false);
DO $sab$
DECLARE
  v_tab    text := current_setting('sp.tab');
  v_pol    text := current_setting('sp.pol');
  v_campo  text := current_setting('sp.campo');
  v_anc    text := current_setting('sp.ancora');
  v_expr   text;
  v_depois text;
  v_n      int;
BEGIN
  SELECT CASE v_campo WHEN 'qual' THEN qual WHEN 'with_check' THEN with_check END INTO v_expr
    FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tab AND policyname = v_pol;
  IF v_expr IS NULL THEN
    RAISE EXCEPTION 'SABOTAGEM SEM EXPRESSAO: %.% (%)', v_tab, v_pol, v_campo;
  END IF;
  v_n := (length(v_expr) - length(replace(v_expr, v_anc, ''))) / length(v_anc);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SABOTAGEM SEM ANCORA UNICA: % ocorrencia(s) em %.%', v_n, v_tab, v_pol;
  END IF;
  EXECUTE format('ALTER POLICY %I ON public.%I %s (%s)', v_pol, v_tab,
                 CASE v_campo WHEN 'qual' THEN 'USING' ELSE 'WITH CHECK' END,
                 replace(v_expr, v_anc, current_setting('sp.troca')));
  SELECT CASE v_campo WHEN 'qual' THEN qual ELSE with_check END INTO v_depois
    FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tab AND policyname = v_pol;
  IF v_depois IS NOT DISTINCT FROM v_expr THEN
    RAISE EXCEPTION 'SABOTAGEM NAO MUDOU A POLICY %.%', v_tab, v_pol;
  END IF;
END $sab$;
SQL
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. As das RPCs trocam UM trecho do corpo vivo (âncora
# única, cv_sabotar — as de produtos_relacionados com contexto de linha, porque os filtros de
# mesma_familia e comprados_juntos são textualmente iguais); as de RLS tiram UMA conjunção da policy
# viva (sabotar_policy). A msg_insert_item_alheio declara M2 VERDE: a camada é redundante para o
# não-master (cabeçalho). As `migracao_nova_*` são a regressão chegando pela PRÓXIMA migration; as
# drop_create são a armadilha do CLAUDE.md — DROP+CREATE devolve o EXECUTE ao default de prod, que o dá
# ao anon EXPLÍCITO, e o `REVOKE … FROM PUBLIC` não o tira: só G5/G6 distinguem, porque nomeiam a
# camada e o objeto.
SABOTAGENS="produtos_sem_gate_staff:G1:G2,R1 produtos_sem_teto_termo:G2:G1,R1
            clientes_sem_teto_termo:G3:D1 clientes_termo_sem_trim:G3:D1
            anon_executa_clientes:G5:G6,D1 anon_executa_produtos:G6:G5,R1
            migracao_nova_drop_create_clientes:G5:D1,G6 migracao_nova_drop_create_sem_anon_produtos:G6:R1,G5
            janela_aberta:D2:D1,D3 cancelado_conta:D2:D1,D3 rascunho_conta:D2:D1,D3 pendente_conta:D2:D1,D3
            apagado_conta:D2:D1,D3 vendedora_ve_tudo:D3:D1,D2 inativo_conta:D4:D2
            migracao_nova_vendedora_ve_tudo:D3:D1,D2
            familia_inclui_inativo:R1:R2 familia_atravessa_conta:R1:R2 familia_inclui_alvo:R1:R2
            juntos_inclui_inativo:R2:R1 juntos_inclui_alvo:R2:R1 juntos_outro_antecedente:R2:R1
            juntos_min_confianca:R2:R1 alvo_inclui_inativo:R3:R1
            item_insert_sem_autor:I2:I1,I4 item_insert_sem_staff:I4:I1,I2 item_insert_triagem_livre:I3:I1
            item_insert_status_livre:I5:I1 item_insert_avaliacao_livre:I6:I1 item_insert_resposta_livre:I6:I1
            item_insert_resolvido_livre:I6:I1 item_select_aberto:S1,S3:S2,S5 item_select_sem_master:S2,S6:S1
            item_update_aberto:U1:U2 msg_insert_sem_autor:M7:M1 msg_insert_dados_livre:M4:M1
            msg_insert_item_alheio:M9:M1,M2,M5 msg_insert_item_resolvido:M6:M1 msg_insert_founder_livre:M3:M5
            msg_insert_papel_ia:M8:M1 msg_select_aberto:S5,S3:S6 msg_select_sem_master:S6:S5
            anon_le_itens:S4:S3 anon_escreve_itens:W1:I1 migracao_nova_item_select_aberto:S1:S2"

# sabotagem <nome> — troca UMA camada do schema vivo no banco da rodada. Status ≠0 = não aplicou.
sabotagem() {
  local cli='public.melhoria_clientes_por_produto(text)' rel='public.melhoria_produtos_relacionados(text)'
  local gate="if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then"
  local teto="if length(trim(coalesce(p_termo,''))) < 3 then" status="where so.status not in ('cancelado','rascunho','pendente')"
  local visivel='where v_full or carteira_visivel_para(c.customer_user_id, v_uid)'
  local uid='( SELECT auth.uid() AS uid)'
  case "$1" in
    produtos_sem_gate_staff)  cv_sabotar "$rel" "$gate" "if false then" ;;
    produtos_sem_teto_termo)  cv_sabotar "$rel" "$teto" "if false then" ;;
    clientes_sem_teto_termo)  cv_sabotar "$cli" "$teto" "if false then" ;;
    clientes_termo_sem_trim)  cv_sabotar "$cli" "length(trim(coalesce(p_termo,'')))" "length(coalesce(p_termo,''))" ;;
    anon_executa_clientes)    P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $cli TO anon;" ;;
    anon_executa_produtos)    P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $rel TO anon;" ;;
    migracao_nova_drop_create_clientes)
                              cv_migracao_nova "$cli" "CREATE OR REPLACE FUNCTION public.melhoria_clientes_por_produto(" \
                                $'DROP FUNCTION public.melhoria_clientes_por_produto(text);\nCREATE FUNCTION public.melhoria_clientes_por_produto(' ;;
    migracao_nova_drop_create_sem_anon_produtos)
                              cv_migracao_nova "$rel" "CREATE OR REPLACE FUNCTION public.melhoria_produtos_relacionados(" \
                                $'DROP FUNCTION public.melhoria_produtos_relacionados(text);\nCREATE FUNCTION public.melhoria_produtos_relacionados(' \
                                "REVOKE ALL ON FUNCTION $rel FROM PUBLIC; GRANT EXECUTE ON FUNCTION $rel TO authenticated, service_role;" ;;
    janela_aberta)            cv_sabotar "$cli" "- interval '12 months'" "- interval '1200 months'" ;;
    cancelado_conta)          cv_sabotar "$cli" "$status" "where so.status not in ('rascunho','pendente')" ;;
    rascunho_conta)           cv_sabotar "$cli" "$status" "where so.status not in ('cancelado','pendente')" ;;
    pendente_conta)           cv_sabotar "$cli" "$status" "where so.status not in ('cancelado','rascunho')" ;;
    apagado_conta)            cv_sabotar "$cli" "and so.deleted_at is null" "" ;;
    vendedora_ve_tudo)        cv_sabotar "$cli" "$visivel" "where true" ;;
    inativo_conta)            cv_sabotar "$cli" "coalesce(ativo, true) = true" "true" ;;
    migracao_nova_vendedora_ve_tudo)
                              cv_migracao_nova "$cli" "$visivel" "where true" ;;
    familia_inclui_inativo)   cv_sabotar "$rel" $'op.account = a.account\n    where coalesce(op.ativo, true) = true' $'op.account = a.account\n    where true' ;;
    familia_atravessa_conta)  cv_sabotar "$rel" "op.familia = a.familia and op.account = a.account" "op.familia = a.familia" ;;
    familia_inclui_alvo)      cv_sabotar "$rel" $'and op.id not in (select id from alvo)\n    limit 10' $'\n    limit 10' ;;
    juntos_inclui_inativo)    cv_sabotar "$rel" $'r.cons_id\n    where coalesce(op.ativo, true) = true' $'r.cons_id\n    where true' ;;
    juntos_inclui_alvo)       cv_sabotar "$rel" $'and op.id not in (select id from alvo)\n  )\n  select' $'\n  )\n  select' ;;
    juntos_outro_antecedente) cv_sabotar "$rel" "where exists (select 1 from alvo a where a.id::text = any(r.antecedent_product_ids::text[]))" "where true" ;;
    juntos_min_confianca)     cv_sabotar "$rel" "max(r.confidence) as confidence" "min(r.confidence) as confidence" ;;
    alvo_inclui_inativo)      cv_sabotar "$rel" "where coalesce(ativo, true) = true" "where true" ;;
    item_insert_sem_autor)    sabotar_policy melhoria_itens melhoria_itens_insert with_check "(autor_user_id = $uid) AND " "" ;;
    item_insert_sem_staff)    sabotar_policy melhoria_itens melhoria_itens_insert with_check \
                                " AND (has_role($uid, 'employee'::app_role) OR has_role($uid, 'master'::app_role))" "" ;;
    item_insert_triagem_livre)   sabotar_policy melhoria_itens melhoria_itens_insert with_check " AND (triagem_status = 'pendente'::text)" "" ;;
    item_insert_status_livre)    sabotar_policy melhoria_itens melhoria_itens_insert with_check " AND (status = 'aberto'::text)" "" ;;
    item_insert_avaliacao_livre) sabotar_policy melhoria_itens melhoria_itens_insert with_check " AND (avaliacao_founder IS NULL)" "" ;;
    item_insert_resposta_livre)  sabotar_policy melhoria_itens melhoria_itens_insert with_check " AND (resposta_founder IS NULL)" "" ;;
    item_insert_resolvido_livre) sabotar_policy melhoria_itens melhoria_itens_insert with_check " AND (resolvido_em IS NULL)" "" ;;
    item_select_aberto)       P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY melhoria_itens_select ON public.melhoria_itens USING (true);" ;;
    item_select_sem_master)   sabotar_policy melhoria_itens melhoria_itens_select qual " OR has_role($uid, 'master'::app_role)" "" ;;
    item_update_aberto)       P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY melhoria_itens_update ON public.melhoria_itens USING (true) WITH CHECK (true);" ;;
    msg_insert_sem_autor)     sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check "(autor_user_id = $uid) AND (dados IS NULL)" "(dados IS NULL)" ;;
    msg_insert_dados_livre)   sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check " AND (dados IS NULL)" "" ;;
    msg_insert_item_alheio)   sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check " AND (i.autor_user_id = $uid)" "" ;;
    msg_insert_item_resolvido) sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check \
                                " AND (i.status = ANY (ARRAY['aberto'::text, 'em_andamento'::text]))" "" ;;
    msg_insert_founder_livre) sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check \
                                "((papel = 'founder'::text) AND has_role($uid, 'master'::app_role))" "(papel = 'founder'::text)" ;;
    msg_insert_papel_ia)      sabotar_policy melhoria_mensagens melhoria_mensagens_insert with_check \
                                "(papel = 'funcionario'::text)" "(papel = ANY (ARRAY['funcionario'::text, 'ia'::text]))" ;;
    msg_select_aberto)        P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY melhoria_mensagens_select ON public.melhoria_mensagens USING (true);" ;;
    msg_select_sem_master)    sabotar_policy melhoria_mensagens melhoria_mensagens_select qual " OR has_role($uid, 'master'::app_role)" "" ;;
    anon_le_itens)            P -v ON_ERROR_STOP=1 -q -c "CREATE POLICY sabotagem_anon_le ON public.melhoria_itens FOR SELECT TO anon USING (true);" ;;
    anon_escreve_itens)       P -v ON_ERROR_STOP=1 -q -c "CREATE POLICY sabotagem_anon_escreve ON public.melhoria_itens FOR INSERT TO anon WITH CHECK (true);" ;;
    migracao_nova_item_select_aberto)
                              cv_migracao_nova_sql "DROP POLICY melhoria_itens_select ON public.melhoria_itens;
CREATE POLICY melhoria_itens_select ON public.melhoria_itens FOR SELECT TO authenticated USING (true);" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}

# rodada <sabotagem|""> — clona o banco-base e roda o cenário no clone. Exit 3 = a sabotagem não
# aplicou (âncora sumiu do schema vivo); exit 4 = o clone falhou (a rodada não pode seguir no banco da
# sabotagem anterior). Os dois são FALHA da falsificação, nunca dente.
rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
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

# ── --falsificar ───────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha (ambiente
# quebrado, snapshot que não sobe) aprovaria todas as sabotagens. O controle roda primeiro, aqui, e
# um controle vermelho aborta ANTES da primeira sabotagem.
echo "══ CONTROLE (versão viva, sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

# O vermelho que conta é o do assert DECLARADO, verde no controle e vermelho na rodada; os verdes
# declarados seguem verdes; a rodada executa tantos asserts quanto o controle; e vermelho com ERRO
# de execução não é dente (docs/historico/falsificacao-exit-nao-e-dente.md).
falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  elif grep -Eq '^  ✗ .*got\[ERRO: ' "$log"; then
    motivo=" vermelho com ERRO de execução: a medição que erra cai pelo erro, não pelo valor"
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
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

# Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag não foi
# ignorada.
total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
