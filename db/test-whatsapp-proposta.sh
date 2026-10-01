#!/usr/bin/env bash
# Prova PG17 da recotação da proposta 1-toque do canal WhatsApp (get_whatsapp_proposta_cotacao, SECURITY
# INVOKER) e da identidade imutável do orçamento (whatsapp_proposta_dedupe UNIQUE), contra o schema que
# PRODUÇÃO executa (db/lib/corpo-vivo.sh: snapshot + ACL medido em prod + cadeia viva da RPC).
#
# O que ela assevera, cada um com sabotagem própria:
#  • o praticado VÁLIDO mais recente do próprio cliente NA CONTA consultada vence a tabela — nem o de
#    outro cliente nem o da outra conta (Codex P0-1) o contaminam; "mais recente" é cronologia COMERCIAL:
#    o item sem data herda a do pedido pai (Codex P1-10);
#  • ausente ≠ zero: praticado 0 é ignorado, tabela 0 vira preço NULL (nunca fabrica); NaN e Infinity não
#    vazam como preço, nem do praticado nem da tabela; estoque NULL volta NULL; o inativo volta com
#    ativo=false (a trava é do consumidor); SKU de outra conta ou inexistente não volta;
#  • a identidade do orçamento é do BANCO: a mesma chave de proposta de novo → 23505 (Codex P0-3), e a
#    chave NULL dos pedidos comuns não colide — escrito COMO o staff, que é quem cria o orçamento;
#  • o cliente não recebe nada (o catálogo é de staff) e o anon não executa (nega o EXECUTE da RPC, não o
#    SELECT da tabela).
# A releitura do orçamento existente por whatsapp_proposta_dedupe (o caminho do 23505 no app) depende de
# um GRANT por coluna que prod não tem: mora em db/test-whatsapp-funil.sh, com o funil, que tem a mesma
# causa (docs/historico/provas-canal-revividas.md).
#
# A guarda `<> 'NaN'` da RPC é REDUNDANTE com a `< 'Infinity'` (em numeric, NaN não é < Infinity —
# medido): sabotar só ela fica verde por desenho, então a sabotagem do NaN tira as duas.
#
# Até 2026-09-30 esta prova re-aplicava as 5 migrations de 07-13 sobre o snapshot e NASCEU morta (no
# próprio merge, 250754cdf, o `CREATE POLICY` já re-existia no snapshot). Ela supunha o catálogo visível a
# authenticated, e a RLS viva o fechou para o staff. Histórico: docs/historico/provas-canal-revividas.md.
#
# MODOS
#   bash db/test-whatsapp-proposta.sh               # cenário no schema vivo → PASS=<n>  FAIL=<m>
#   bash db/test-whatsapp-proposta.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + ACL + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5475}"
TMPD="$(mktemp -d /tmp/pgtest-wa-prop.XXXXXX)"
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

# O objeto que esta prova assevera: a migration nova que o redefinir entra na cadeia sozinha.
CV_FUNCOES=(get_whatsapp_proposta_cotacao)
CV_TABELAS=()
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + cadeia viva…"
cv_montar

STAFF='00000000-0000-0000-0000-0000000aaaa1'     # employee: cria o orçamento e consulta a recotação
OUTRO='00000000-0000-0000-0000-0000000bbbb2'     # outro cliente (não-staff)
CLIENTE='00000000-0000-0000-0000-0000000cccc3'   # o cliente da proposta
pe() { printf '00000000-0000-0000-0000-00000000e00%s' "$1"; }
echo "→ seed-base: staff, 2 clientes, o catálogo de bordas e o histórico de praticados…"
P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (id) VALUES ('$STAFF'), ('$OUTRO'), ('$CLIENTE');
INSERT INTO public.user_roles (user_id, role) VALUES ('$STAFF', 'employee'), ('$OUTRO', 'customer'), ('$CLIENTE', 'customer');
-- cada SKU uma borda; o 101 existe nas DUAS contas (Codex P0-1)
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, unidade, valor_unitario, estoque, ativo, account) VALUES
  (101, 'C101', 'LIXA A275',          'UN', 99,         100,  true,  'oben'),
  (101, 'K101', 'LIXA COLACOR',       'UN', 80,         100,  true,  'colacor'),
  (102, 'C102', 'THINNER 4403',       'UN', 45,         100,  true,  'oben'),
  (103, 'C103', 'SEM TABELA',         'UN', 0,          100,  true,  'oben'),
  (104, 'C104', 'TABELA NAN',         'UN', 'NaN',      100,  true,  'oben'),
  (105, 'C105', 'ESTOQUE NULL',       'UN', 20,         NULL, true,  'oben'),
  (106, 'C106', 'INATIVO',            'UN', 30,         100,  false, 'oben'),
  (107, 'C107', 'OUTRA CONTA',        'UN', 10,         100,  true,  'colacor'),
  (109, 'C109', 'CRONOLOGIA',         'UN', 70,         100,  true,  'oben'),
  (111, 'C111', 'TABELA INFINITA',    'UN', 'Infinity', 100,  true,  'oben'),
  (112, 'C112', 'PRATICADO INFINITO', 'UN', 50,         100,  true,  'oben');
-- pedidos-pai com a CONTA explícita (e004 = colacor; e005/e006 para a cronologia comercial)
INSERT INTO public.sales_orders (id, customer_user_id, created_by, total, status, account, created_at) VALUES
  ('$(pe 1)', '$CLIENTE', '$STAFF', 100, 'confirmado', 'oben',    now() - interval '30 days'),
  ('$(pe 2)', '$CLIENTE', '$STAFF', 100, 'confirmado', 'oben',    now() - interval '1 day'),
  ('$(pe 3)', '$OUTRO',   '$STAFF', 100, 'confirmado', 'oben',    now() - interval '1 day'),
  ('$(pe 4)', '$CLIENTE', '$STAFF', 100, 'confirmado', 'colacor', now() - interval '2 hours'),
  ('$(pe 5)', '$CLIENTE', '$STAFF', 100, 'confirmado', 'oben',    now() - interval '3 hours'),
  ('$(pe 6)', '$CLIENTE', '$STAFF', 100, 'confirmado', 'oben',    now() - interval '10 days');
-- 101: oben 8.00 (30d) e 10.50 (1d) — o recente vence; colacor 5.00 (2h, o mais recente de todos) não
-- contamina a oben; o 7.77 de OUTRO cliente (1h) não contamina o do cliente.
-- 102 praticado 0 · 104 praticado NaN · 112 praticado Infinity — os três inválidos.
-- 109: 33.00 sem data num pai de 3h × 22.00 datado de 10d — a cronologia comercial escolhe 33.00.
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, created_at) VALUES
  ('$(pe 1)', '$CLIENTE', 101, 1, 8.00,       now() - interval '30 days'),
  ('$(pe 2)', '$CLIENTE', 101, 1, 10.50,      now() - interval '1 day'),
  ('$(pe 2)', '$CLIENTE', 102, 1, 0,          now() - interval '1 day'),
  ('$(pe 2)', '$CLIENTE', 104, 1, 'NaN',      now() - interval '1 day'),
  ('$(pe 2)', '$CLIENTE', 112, 1, 'Infinity', now() - interval '1 day'),
  ('$(pe 4)', '$CLIENTE', 101, 1, 5.00,       now() - interval '2 hours'),
  ('$(pe 3)', '$OUTRO',   101, 1, 7.77,       now() - interval '1 hour'),
  ('$(pe 5)', '$CLIENTE', 109, 1, 33.00,      NULL),
  ('$(pe 6)', '$CLIENTE', 109, 1, 22.00,      now() - interval '10 days');
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — a leitura COMO o app: o papel e o JWT fixados na MESMA sessão que
# lê (vários -c, um psql só), como o PostgREST faz. Na falha, o valor é o erro — assert vermelho com o
# porquê.
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"; fi
}
# st_como <papel> <uid ou ''> <sql> — o veredito do comando COMO o app: 'OK' ou a SQLSTATE, com a camada
# que negou quando é 42501 (prova.sqlstate, em db/lib/corpo-vivo.sh).
st_como() { q_como "$1" "$2" "SELECT prova.sqlstate(\$cmd\$$3\$cmd\$);"; }
# cot <conta> <sku> <colunas> — a recotação de UM SKU do cliente, COMO o staff; NULL vira 'NULL' (o
# ausente não pode sumir na concatenação).
cot() {
  q_como authenticated "$STAFF" "SELECT $3 FROM public.get_whatsapp_proposta_cotacao('$CLIENTE', '$1', ARRAY[$2]::bigint[]);"
}
PRECO="coalesce(preco::text, 'NULL') || '|' || coalesce(fonte_preco, 'NULL')"
orcamento() {  # <chave ou NULL> <total> — o INSERT do orçamento da proposta, como o app o faz
  local k="NULL"; [ "$1" = NULL ] || k="'$1'"
  printf "INSERT INTO public.sales_orders (customer_user_id, created_by, total, status, account, whatsapp_proposta_dedupe) VALUES ('%s', '%s', %s, 'orcamento', 'oben', %s)" \
    "$CLIENTE" "$STAFF" "$2" "$k"
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ o praticado vence a tabela: o do próprio cliente, na conta, o mais recente VÁLIDO"
  chk P1 "101 oben: 10.50 (não o antigo, nem a tabela, nem o de outro cliente, nem o da colacor)" "$(cot oben 101 "$PRECO")" "10.50|praticado"
  chk P2 "101 colacor: 5.00 (a partição por conta vale dos dois lados)" "$(cot colacor 101 "$PRECO")" "5.00|praticado"
  chk P3 "cronologia comercial: o item sem data herda a do pedido pai (109 → 33.00)" "$(cot oben 109 "$PRECO")" "33.00|praticado"

  echo "→ ausente ≠ zero: nada inválido vira preço"
  chk P4 "praticado 0 é ignorado → tabela (102 → 45)" "$(cot oben 102 "$PRECO")" "45|tabela"
  chk P5 "tabela 0 sem praticado → NULL, nunca 0 (103)" "$(cot oben 103 "$PRECO")" "NULL|NULL"
  chk P6 "NaN no praticado e na tabela → NULL (104)" "$(cot oben 104 "$PRECO")" "NULL|NULL"
  chk P7 "Infinity na tabela → NULL (111)" "$(cot oben 111 "$PRECO")" "NULL|NULL"
  chk P8 "Infinity no praticado é ignorado → tabela (112 → 50)" "$(cot oben 112 "$PRECO")" "50|tabela"
  chk P9 "estoque NULL volta NULL — desconhecido ≠ 0 (105)" "$(cot oben 105 "coalesce(estoque::text, 'NULL') || '|' || preco")" "NULL|20"
  chk P10 "o inativo volta com ativo=false — a trava é do consumidor (106)" "$(cot oben 106 "ativo")" "f"
  chk P11 "só SKUs da conta consultada (107 é colacor, 108 não existe)" \
    "$(q_como authenticated "$STAFF" "SELECT string_agg(omie_codigo_produto::text, ',' ORDER BY omie_codigo_produto) FROM public.get_whatsapp_proposta_cotacao('$CLIENTE', 'oben', ARRAY[101,102,103,104,105,106,107,108,109,111,112]::bigint[]);")" \
    "101,102,103,104,105,106,109,111,112"

  echo "→ a RLS e o ACL como o app os vê"
  chk P12 "o cliente não recebe nada — o catálogo é de staff (OUTRO consultando o cliente)" \
    "$(q_como authenticated "$OUTRO" "SELECT count(*) FROM public.get_whatsapp_proposta_cotacao('$CLIENTE', 'oben', ARRAY[101,102,109]::bigint[]);")" "0"
  chk P13 "anon não executa — nega o EXECUTE da RPC (42501/acl-funcao), não o SELECT da tabela" \
    "$(st_como anon '' "SELECT * FROM public.get_whatsapp_proposta_cotacao('$CLIENTE', 'oben', ARRAY[101]::bigint[])")" "42501/acl-funcao"

  echo "→ a identidade do orçamento é do banco (escrita COMO o staff, que é quem o cria)"
  chk P14 "o 1º orçamento da proposta entra" "$(st_como authenticated "$STAFF" "$(orcamento 'proposta:cccc3:2026-07-14' 21)")" "OK"
  chk P15 "a mesma chave de proposta de novo → 23505" "$(st_como authenticated "$STAFF" "$(orcamento 'proposta:cccc3:2026-07-14' 21)")" "23505"
  chk P16 "a chave NULL dos pedidos comuns não colide (2 orçamentos sem chave)" \
    "$(st_como authenticated "$STAFF" "$(orcamento NULL 10)")|$(st_como authenticated "$STAFF" "$(orcamento NULL 11)")" "OK|OK"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. As do corpo trocam UM trecho da RPC viva (âncora
# única, cv_sabotar); a do NaN tira as DUAS guardas que o filtram (a `<> 'NaN'` sozinha é redundante).
# As `migracao_nova_*` são a regressão chegando pela PRÓXIMA migration; a drop_create é a armadilha do
# CLAUDE.md (DROP+CREATE devolve o EXECUTE a PUBLIC), que só o P13 distingue, porque nomeia a camada.
SABOTAGENS="conta_atravessa:P1:P3,P4 cliente_atravessa:P1:P2,P3 cronologia_por_item:P3:P1
            praticado_zero_conta:P4:P1,P5 zero_fabricado:P5:P1,P4 praticado_nan:P6:P1,P8
            tabela_infinita:P7:P1,P5 praticado_infinito:P8:P1,P6 definer_fura_rls:P12:P1
            catalogo_aberto_ao_cliente:P12:P1,P13 anon_executa:P13:P1,P12 dedupe_some:P15:P14,P16
            migracao_nova_conta_atravessa:P1:P3,P4 migracao_nova_drop_create:P13:P1,P12"

# sabotagem <nome> — troca UMA camada do schema vivo no banco da rodada. Status ≠0 = não aplicou.
sabotagem() {
  local fn='public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])' conta='AND so.account = p_account'
  case "$1" in
    conta_atravessa)     cv_sabotar "$fn" "$conta" "" ;;
    cliente_atravessa)   cv_sabotar "$fn" "WHERE oi.customer_user_id = p_customer_user_id" "WHERE true" ;;
    cronologia_por_item) cv_sabotar "$fn" "COALESCE(oi.created_at, so.created_at) DESC NULLS LAST" "oi.created_at DESC NULLS LAST" ;;
    praticado_zero_conta) cv_sabotar "$fn" "AND oi.unit_price > 0" "AND oi.unit_price >= 0" ;;
    zero_fabricado)      cv_sabotar "$fn" ") AS preco," ", 0) AS preco," ;;
    praticado_nan)       cv_sabotar "$fn" "AND oi.unit_price <> 'NaN'::numeric" "" \
                           && cv_sabotar "$fn" "AND oi.unit_price < 'Infinity'::numeric" "" ;;
    tabela_infinita)     cv_sabotar "$fn" "THEN p.valor_unitario END" "OR p.valor_unitario = 'Infinity'::numeric THEN p.valor_unitario END" ;;
    praticado_infinito)  cv_sabotar "$fn" "AND oi.unit_price < 'Infinity'::numeric" "" ;;
    definer_fura_rls)    P -v ON_ERROR_STOP=1 -q -c "ALTER FUNCTION $fn SECURITY DEFINER;" ;;
    catalogo_aberto_ao_cliente)
                         P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY omie_products_select_staff ON public.omie_products USING (true);" ;;
    anon_executa)        P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $fn TO anon;" ;;
    dedupe_some)         P -v ON_ERROR_STOP=1 -q -c "DROP INDEX public.uq_so_whatsapp_proposta_dedupe;" ;;
    migracao_nova_conta_atravessa)
                         cv_migracao_nova "$fn" "$conta" "" ;;
    # A armadilha do CLAUDE.md: DROP FUNCTION + CREATE devolve o ACL ao default (EXECUTE a PUBLIC); o
    # CREATE OR REPLACE preservaria. O anon passa a executar e só a tabela o barra — o P13 vê a troca.
    migracao_nova_drop_create)
                         cv_migracao_nova "$fn" "CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(" \
                           $'DROP FUNCTION public.get_whatsapp_proposta_cotacao(uuid, text, bigint[]);\nCREATE FUNCTION public.get_whatsapp_proposta_cotacao(' ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}

# rodada <sabotagem|""> — clona o banco-base e roda o cenário no clone. Exit 3 = a sabotagem não
# aplicou (âncora sumiu do schema vivo): isso é FALHA da falsificação, nunca dente.
rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;"
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
