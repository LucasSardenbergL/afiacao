#!/usr/bin/env bash
# Prova PG17 do funil do canal WhatsApp (get_whatsapp_funil, SECURITY INVOKER: lê sob a RLS de quem chama)
# contra o schema que PRODUÇÃO executa (db/lib/corpo-vivo.sh: snapshot + ACL medido em prod + cadeia viva
# das migrations que tocam a RPC e as tabelas do canal).
#
# O que ela assevera, cada um com sabotagem própria:
#  • o funil RODA para o staff (F0) — com o ACL de prod. Em 2026-09-30 NÃO roda: a RPC filtra por
#    sales_orders.whatsapp_conversation_id, e authenticated não lê essa coluna (o GRANT por coluna da
#    20260709163500 é anterior a ela). A releitura do orçamento por whatsapp_proposta_dedupe
#    (enviarProposta.ts, o caminho do 23505) bate no mesmo GRANT ausente (F10). Esta prova fica
#    VERMELHA nesses dois até prod ganhar o GRANT — e fora do núcleo até lá
#    (docs/historico/provas-canal-revividas.md);
#  • os estágios (enviado = sent/delivered/read; queued é reserva), "respondeu" só com inbound DEPOIS do
#    envio e em até 24h (a mensagem que sai não conta), proposta/pedido SÓ com o elo explícito (pedido de
#    telefone não conta), receita só do que virou pedido Omie, o período com piso de 1 dia e teto de 365;
#  • a RLS: o cliente lê tudo 0; o anon não executa (nega o EXECUTE da RPC, não o SELECT da tabela);
#  • o hardening por coluna segue: o staff não lê omie_payload.
#
# Até 2026-09-30 esta prova re-aplicava as migrations de 07-13 sobre o snapshot; o re-dump 9c9aae173
# (#1509) a matou no setup (`CREATE POLICY` não-idempotente). E dava `GRANT ALL ON ALL TABLES` a
# anon/authenticated — foi esse ACL de mentira que escondeu o funil quebrado para o staff em prod.
#
# MODOS
#   bash db/test-whatsapp-funil.sh               # cenário no schema vivo → PASS=<n>  FAIL=<m>
#   bash db/test-whatsapp-funil.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + ACL + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5474}"
TMPD="$(mktemp -d /tmp/pgtest-wa-funil.XXXXXX)"
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

# Os objetos que esta prova assevera: a migration nova que fizer DDL sobre eles entra na cadeia sozinha.
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(get_whatsapp_funil)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(whatsapp_template_sends whatsapp_messages whatsapp_conversations)
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + cadeia viva…"
cv_montar

STAFF='00000000-0000-0000-0000-0000000aaaa1'      # employee: lê tudo pela RLS de staff
CLIENTE='00000000-0000-0000-0000-0000000bbbb2'    # customer sem pedido: o funil dele é 0
COMPRADOR='00000000-0000-0000-0000-0000000dddd4'  # customer dos pedidos
O2='00000000-0000-0000-0000-0000000000e2'         # o orçamento da proposta (tem a dedupe_key)
DEDUPE='proposta:dddd4:2026-07-14'
c() { printf '00000000-0000-0000-0000-00000000c00%s' "$1"; }
# Linha do tempo relativa ao now() do seed, com folga de horas em toda borda (a rodada consulta segundos
# ou minutos depois): s1/s2/s4 a 2d2h, s3 a 3d, s5/s6/s7 a 20h; pedidos a 1d, 60d e 400d.
echo "→ seed-base: staff, clientes, 5 conversas, 7 envios, mensagens e 5 pedidos…"
P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (id) VALUES ('$STAFF'), ('$CLIENTE'), ('$COMPRADOR');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$STAFF', 'employee'), ('$CLIENTE', 'customer'), ('$COMPRADOR', 'customer');
INSERT INTO public.whatsapp_templates (nome, categoria, corpo_referencia) VALUES ('teste_funil', 'utility', 'Ola, {{1}}!');
INSERT INTO public.whatsapp_conversations (id, phone_key, status) VALUES
  ('$(c 1)', 'c1', 'aberta'), ('$(c 2)', 'c2', 'aberta'), ('$(c 3)', 'c3', 'aberta'),
  ('$(c 4)', 'c4', 'aberta'), ('$(c 5)', 'c5', 'aberta');
-- s1 sent (sem resposta) · s2 delivered (in +1h → respondeu) · s3 read (in +30h → fora da janela)
-- s4 failed · s5 delivered (in ANTES do envio → não conta) · s6 queued (reserva, não é envio)
-- s7 sent (só mensagem que SAI depois → não conta)
INSERT INTO public.whatsapp_template_sends (template_nome, conversation_id, phone_e164, dedupe_key, status, created_at) VALUES
  ('teste_funil', '$(c 1)', '5537000000001', 's1', 'sent',      now() - interval '2 days 2 hours'),
  ('teste_funil', '$(c 2)', '5537000000002', 's2', 'delivered', now() - interval '2 days 2 hours'),
  ('teste_funil', '$(c 3)', '5537000000003', 's3', 'read',      now() - interval '3 days'),
  ('teste_funil', '$(c 1)', '5537000000001', 's4', 'failed',    now() - interval '2 days 2 hours'),
  ('teste_funil', '$(c 4)', '5537000000004', 's5', 'delivered', now() - interval '20 hours'),
  ('teste_funil', '$(c 2)', '5537000000002', 's6', 'queued',    now() - interval '20 hours'),
  ('teste_funil', '$(c 5)', '5537000000005', 's7', 'sent',      now() - interval '20 hours');
INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at) VALUES
  ('$(c 2)', 'in',  'quero sim',      now() - interval '2 days 1 hour'),
  ('$(c 3)', 'in',  'tarde demais',   now() - interval '3 days' + interval '30 hours'),
  ('$(c 4)', 'in',  'antes do envio', now() - interval '21 hours'),
  ('$(c 5)', 'out', 'so a gente fala', now() - interval '19 hours');
-- o1 elo+Omie (1000) · o2 elo, orçamento da proposta (dedupe) · o3 Omie SEM elo (telefone)
-- o4 elo+Omie a 60d (fora de 30d) · o6 elo+Omie a 400d (fora do teto de 365)
INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, total, status, omie_pedido_id,
                                 whatsapp_conversation_id, whatsapp_proposta_dedupe, created_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '$COMPRADOR', '$STAFF', 'oben', 1000, 'confirmado', 111, '$(c 2)', NULL, now() - interval '1 day'),
  ('$O2',                                  '$COMPRADOR', '$STAFF', 'oben',  500, 'orcamento',  NULL, '$(c 3)', '$DEDUPE', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000e3', '$COMPRADOR', '$STAFF', 'oben',  900, 'confirmado', 222, NULL,     NULL, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000e4', '$COMPRADOR', '$STAFF', 'oben',  700, 'confirmado', 333, '$(c 1)', NULL, now() - interval '60 days'),
  ('00000000-0000-0000-0000-0000000000e6', '$COMPRADOR', '$STAFF', 'oben',  300, 'confirmado', 444, '$(c 1)', NULL, now() - interval '400 days');
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
# funil <uid> <dias> <colunas> — lê o funil COMO o app. Quando ele não roda, o valor diz por quê (a
# SQLSTATE e a camada) em vez de um erro cru: quem impede o funil de rodar cai por VALOR no F0, e as
# medições que dependem dele caem junto, nomeando a causa.
funil() {
  local st
  st="$(st_como authenticated "$1" "SELECT * FROM public.get_whatsapp_funil($2)")"
  if [ "$st" = OK ]; then q_como authenticated "$1" "SELECT $3 FROM public.get_whatsapp_funil($2);"
  else printf 'funil nao roda: %s' "$st"; fi
}

cenario() {
  local st
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ o funil roda para o staff (a RPC é INVOKER: lê sales_orders com o GRANT por coluna de quem chama)"
  chk F0 "o staff executa get_whatsapp_funil(30)" \
    "$(st_como authenticated "$STAFF" "SELECT * FROM public.get_whatsapp_funil(30)")" "OK"
  st="$(st_como authenticated "$STAFF" "SELECT id FROM public.sales_orders WHERE whatsapp_proposta_dedupe = '$DEDUPE'")"
  if [ "$st" = OK ]; then
    st="$(q_como authenticated "$STAFF" "SELECT id FROM public.sales_orders WHERE whatsapp_proposta_dedupe = '$DEDUPE';")"
  else st="nao le: $st"; fi
  chk F10 "a proposta relê o orçamento pela dedupe_key (enviarProposta.ts, o caminho do 23505)" "$st" "$O2"

  echo "→ os estágios e a atribuição conservadora (30 dias)"
  chk F1 "enviados|entregues|lidos|falhas (queued é reserva, não envio)" \
    "$(funil "$STAFF" 30 "enviados || '|' || entregues || '|' || lidos || '|' || falhas")" "5|3|1|1"
  chk F2 "respondeu = inbound DEPOIS do envio e em até 24h (anterior, 30h e a que sai não contam)" \
    "$(funil "$STAFF" 30 "respondidos")" "1"
  chk F3 "propostas|pedidos|receita só com o elo explícito (o de telefone não conta) e no período" \
    "$(funil "$STAFF" 30 "propostas || '|' || pedidos_omie || '|' || receita_omie")" "2|1|1000"

  echo "→ o período: piso de 1 dia e teto de 365"
  chk F4 "2 dias → só os envios de 20h" "$(funil "$STAFF" 2 "enviados")" "2"
  chk F5 "0 dia vira 1 (não 'nada')" "$(funil "$STAFF" 0 "enviados")" "2"
  chk F6 "1000 dias vira 365 (o pedido de 400d fica fora)" "$(funil "$STAFF" 1000 "pedidos_omie")" "2"

  echo "→ a RLS e o ACL como o app os vê"
  chk F7 "cliente lê o funil zerado (envios e mensagens são de staff; ele não tem pedido)" \
    "$(funil "$CLIENTE" 30 "enviados || '|' || respondidos || '|' || propostas")" "0|0|0"
  chk F8 "anon não executa — nega o EXECUTE da RPC (42501/acl-funcao), não o SELECT da tabela" \
    "$(st_como anon '' "SELECT * FROM public.get_whatsapp_funil(30)")" "42501/acl-funcao"
  chk F9 "o hardening por coluna segue: staff não lê omie_payload (42501/acl-tabela)" \
    "$(st_como authenticated "$STAFF" "SELECT omie_payload FROM public.sales_orders")" "42501/acl-tabela"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. As do corpo trocam UM trecho da RPC viva (âncora
# única, cv_sabotar) e exigem o F0 verde — o funil que deixa de rodar não prova a regra que a sabotagem
# mirava. `sem_o_grant_da_coluna` é o defeito de prod de 2026-09-30 de volta. As `migracao_nova_*` são
# a regressão chegando pela PRÓXIMA migration: a drop_create é a armadilha do CLAUDE.md (DROP+CREATE
# devolve o EXECUTE a PUBLIC) e só o F8 a distingue, porque nomeia a camada.
SABOTAGENS="elo_some:F3:F0,F1,F2 janela_frouxa:F2:F0,F1,F3 resposta_anterior_conta:F2:F0,F1,F3
            direcao_ignorada:F2:F0,F1,F3 queued_conta:F1:F0,F2,F3 receita_sem_filtro:F3:F0,F1,F2
            periodo_pedidos_some:F3:F0,F1,F2 sem_piso_de_dia:F5:F0,F4 sem_teto_de_ano:F6:F0,F3
            definer_fura_rls:F7:F0,F1 anon_executa:F8:F0,F7 sem_o_grant_da_coluna:F0,F10:F8,F9
            select_de_tabela:F9:F0,F1 migracao_nova_elo_some:F3:F0,F1 migracao_nova_drop_create:F8:F0,F1"

# sabotagem <nome> — troca UMA camada do schema vivo no banco da rodada. Status ≠0 = não aplicou.
sabotagem() {
  local fn='public.get_whatsapp_funil(integer)' clamp='least(greatest(p_dias, 1), 365)'
  local elo='o.whatsapp_conversation_id IS NOT NULL'
  case "$1" in
    elo_some)                cv_sabotar "$fn" "$elo" "true" ;;
    janela_frouxa)           cv_sabotar "$fn" "interval '24 hours'" "interval '48 hours'" ;;
    resposta_anterior_conta) cv_sabotar "$fn" "m.created_at > s.created_at" "m.created_at > s.created_at - interval '2 hours'" ;;
    direcao_ignorada)        cv_sabotar "$fn" "AND m.direction = 'in'" "" ;;
    queued_conta)            cv_sabotar "$fn" "WHERE status IN ('sent','delivered','read')) AS enviados" \
                                              "WHERE status IN ('queued','sent','delivered','read')) AS enviados" ;;
    receita_sem_filtro)      cv_sabotar "$fn" "sum(o.total) FILTER (WHERE o.omie_pedido_id IS NOT NULL)" "sum(o.total)" ;;
    periodo_pedidos_some)    cv_sabotar "$fn" "AND o.created_at >= periodo.inicio" "" ;;
    sem_piso_de_dia)         cv_sabotar "$fn" "$clamp" "least(p_dias, 365)" ;;
    sem_teto_de_ano)         cv_sabotar "$fn" "$clamp" "greatest(p_dias, 1)" ;;
    definer_fura_rls)        P -v ON_ERROR_STOP=1 -q -c "ALTER FUNCTION $fn SECURITY DEFINER;" ;;
    anon_executa)            P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION $fn TO anon;" ;;
    sem_o_grant_da_coluna)   P -v ON_ERROR_STOP=1 -q -c "REVOKE SELECT (whatsapp_conversation_id, whatsapp_proposta_dedupe) ON public.sales_orders FROM authenticated;" ;;
    select_de_tabela)        P -v ON_ERROR_STOP=1 -q -c "GRANT SELECT ON public.sales_orders TO authenticated;" ;;
    migracao_nova_elo_some)  cv_migracao_nova "$fn" "$elo" "true" ;;
    # A armadilha do CLAUDE.md: DROP FUNCTION + CREATE devolve o ACL ao default (EXECUTE a PUBLIC); o
    # CREATE OR REPLACE preservaria. O anon passa a executar e só a tabela o barra — o F8 vê a troca.
    migracao_nova_drop_create)
                             cv_migracao_nova "$fn" "CREATE OR REPLACE FUNCTION public.get_whatsapp_funil(" \
                               $'DROP FUNCTION public.get_whatsapp_funil(integer);\nCREATE FUNCTION public.get_whatsapp_funil(' ;;
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
