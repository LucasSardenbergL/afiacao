#!/usr/bin/env bash
# Prova PG17 do núcleo HSM do canal WhatsApp — o catálogo de templates Meta e o log de envio idempotente —
# contra o schema que PRODUÇÃO executa (db/lib/corpo-vivo.sh: snapshot + ACL medido em prod + cadeia viva
# das migrations que tocam whatsapp_templates / whatsapp_template_sends).
#
# O que ela assevera (cada regra com sabotagem própria; os positivos — a edge escreve, staff e master
# leem, o master escreve — são as pré-condições que as sabotagens exigem verdes):
#  • o seed do catálogo da 20260713010000 é DADO (o dump é schema-only) e continua entrando: os 2
#    templates, inativos até a Meta aprovar;
#  • a idempotência do envio é do BANCO (dedupe_key UNIQUE → 23505) e os CHECKs/FK barram lixo (23514,
#    23503) — inclusive origem e o teto de parâmetros, que a versão de julho não provava;
#  • a RLS como o app a vê (SET ROLE + JWT na mesma sessão): staff lê catálogo e log, master lê o log,
#    cliente e anon não leem nada;
#  • a escrita: o log só a edge (service_role) escreve — authenticated leva 42501 do GRANT, não da policy
#    (a camada que morde é declarada: '/acl-tabela' × '/rls'); o catálogo só o master escreve (a policy morde
#    o employee, o GRANT morde o anon).
#
# Até 2026-09-30 esta prova re-aplicava a 20260713010000 sobre o snapshot; o re-dump 9c9aae173 (#1509)
# absorveu a migration e o `CREATE POLICY` não-idempotente a matou no setup — 69 dias morta fora do
# núcleo. E ela dava `GRANT ALL ON ALL TABLES` a anon/authenticated: um ACL que prod não tem. Histórico:
# docs/historico/provas-db-mortas-fora-do-nucleo.md e docs/historico/provas-canal-revividas.md.
#
# MODOS
#   bash db/test-whatsapp-hsm.sh               # cenário no schema vivo → PASS=<n>  FAIL=<m>
#   bash db/test-whatsapp-hsm.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + ACL + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5473}"
TMPD="$(mktemp -d /tmp/pgtest-wa-hsm.XXXXXX)"
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
CV_FUNCOES=()
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(whatsapp_templates whatsapp_template_sends)
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + cadeia viva…"
cv_montar

# O seed do catálogo é DADO da migration (o snapshot é schema-only): extraído do próprio arquivo, não
# copiado — e fail-CLOSED se a extração não trouxer o INSERT inteiro.
MIG_HSM="$REPO_ROOT/supabase/migrations/20260713010000_whatsapp_templates_hsm.sql"
SEED_CATALOGO="$(sed -n '/^INSERT INTO public\.whatsapp_templates /,/ON CONFLICT (nome) DO NOTHING;/p' "$MIG_HSM")"
case "$SEED_CATALOGO" in
  *colacor_proposta_recompra*colacor_status_pedido*'ON CONFLICT (nome) DO NOTHING;') ;;
  *) echo "ERRO: o seed do catálogo não foi extraído de $MIG_HSM" >&2; exit 1 ;;
esac

STAFF='00000000-0000-0000-0000-0000000aaaa1'
MASTER='00000000-0000-0000-0000-0000000aaaa2'
CLIENTE='00000000-0000-0000-0000-0000000cccc3'
CONVERSA='00000000-0000-0000-0000-00000000c0f1'
echo "→ seed-base: o catálogo da migration + staff, master, cliente e uma conversa…"
P -v ON_ERROR_STOP=1 -q -c "$SEED_CATALOGO"
P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (id) VALUES ('$STAFF'), ('$MASTER'), ('$CLIENTE');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$STAFF', 'employee'), ('$MASTER', 'master'), ('$CLIENTE', 'customer');
INSERT INTO public.whatsapp_conversations (id, phone_key, phone_e164, status)
VALUES ('$CONVERSA', '37999990000', '5537999990000', 'aberta');
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
envio() {  # <dedupe_key> [status] [origem] [template] — INSERT de envio com a conversa do seed
  printf "INSERT INTO public.whatsapp_template_sends (template_nome, conversation_id, phone_e164, body_params, dedupe_key, status, origem) VALUES ('%s', '%s', '5537999990000', '[\"Ana\",\"42\",\"sai amanha\"]'::jsonb, '%s', '%s', '%s')" \
    "${4:-colacor_status_pedido}" "$CONVERSA" "$1" "${2:-queued}" "${3:-status_pedido}"
}
template() {  # <nome> [categoria] [num_body_params]
  printf "INSERT INTO public.whatsapp_templates (nome, categoria, corpo_referencia, num_body_params) VALUES ('%s', '%s', 'Ola, {{1}}!', %s)" \
    "$1" "${2:-utility}" "${3:-1}"
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ o catálogo: o seed da migration é DADO e entra"
  chk H1 "os 2 templates do seed, inativos até a Meta aprovar (nome:categoria:params:ativo)" \
    "$(q_como service_role '' "SELECT string_agg(nome || ':' || categoria || ':' || num_body_params || ':' || ativo, ',' ORDER BY nome) FROM public.whatsapp_templates;")" \
    "colacor_proposta_recompra:marketing:3:false,colacor_status_pedido:utility:3:false"
  echo "→ o log: quem escreve é a edge (service_role)"
  chk H2 "a edge registra o envio (FK real na conversa e no template)" "$(st_como service_role '' "$(envio k1)")" "OK"

  echo "→ RLS como o app (SET ROLE + JWT na mesma sessão)"
  chk H9 "staff lê o catálogo e o log (templates|envios)" \
    "$(q_como authenticated "$STAFF" "SELECT (SELECT count(*) FROM public.whatsapp_templates) || '|' || (SELECT count(*) FROM public.whatsapp_template_sends);")" "2|1"
  chk H10 "master lê o log" "$(q_como authenticated "$MASTER" "SELECT count(*) FROM public.whatsapp_template_sends;")" "1"
  chk H11 "cliente não lê o catálogo" "$(q_como authenticated "$CLIENTE" "SELECT count(*) FROM public.whatsapp_templates;")" "0"
  chk H12 "cliente não lê o log" "$(q_como authenticated "$CLIENTE" "SELECT count(*) FROM public.whatsapp_template_sends;")" "0"
  chk H13 "anon não lê nada (templates|envios)" \
    "$(q_como anon '' "SELECT (SELECT count(*) FROM public.whatsapp_templates) || '|' || (SELECT count(*) FROM public.whatsapp_template_sends);")" "0|0"

  echo "→ a idempotência e os CHECKs são do banco (a edge reserva a dedupe_key ANTES do POST)"
  chk H3 "a mesma dedupe_key de novo → 23505" "$(st_como service_role '' "$(envio k1)")" "23505"
  chk H4 "categoria fora de utility/marketing → 23514" "$(st_como service_role '' "$(template x_categoria promo)")" "23514"
  chk H5 "status fora do ciclo queued→read/failed → 23514" "$(st_como service_role '' "$(envio k5 zumbi)")" "23514"
  chk H6 "origem fora de manual/proposta/status_pedido/rota → 23514" "$(st_como service_role '' "$(envio k6 queued campanha)")" "23514"
  chk H7 "template inexistente → 23503" "$(st_como service_role '' "$(envio k7 queued status_pedido nao_existe)")" "23503"
  chk H8 "mais de 10 parâmetros → 23514" "$(st_como service_role '' "$(template x_params utility 11)")" "23514"

  echo "→ a escrita: o log é da edge, o catálogo é do master"
  chk H14 "staff não escreve no log — nega o GRANT da tabela (42501/acl-tabela)" "$(st_como authenticated "$STAFF" "$(envio k14)")" "42501/acl-tabela:whatsapp_template_sends"
  chk H15 "staff não muda status no log — nega o GRANT (sem ele a policy calaria: 0 linhas, sem erro)" \
    "$(st_como authenticated "$STAFF" "UPDATE public.whatsapp_template_sends SET status = 'read' WHERE dedupe_key = 'k1'")" "42501/acl-tabela:whatsapp_template_sends"
  chk H16 "employee não escreve no catálogo — nega a POLICY do master (42501/rls)" "$(st_como authenticated "$STAFF" "$(template x_employee)")" "42501/rls:whatsapp_templates"
  chk H17 "master escreve no catálogo" "$(st_como authenticated "$MASTER" "$(template x_master)")" "OK"
  chk H18 "anon não escreve no catálogo — nega o GRANT da tabela (42501/acl-tabela)" "$(st_como anon '' "$(template x_anon)")" "42501/acl-tabela:whatsapp_templates"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. Cada uma troca UMA camada do schema vivo no banco
# da rodada; as de GRANT provam que a camada declarada ('/acl-tabela') é a que morde — aberta, a outra
# responde ('/rls') ou cala. A `migracao_nova_*` é a regressão chegando pela PRÓXIMA migration: só
# fica vermelha porque a cadeia dinâmica a pega (DDL sobre tabela guardada).
SABOTAGENS="seed_incompleto:H1:H2 dedupe_some:H3:H2,H9 categoria_aberta:H4:H5 status_aberto:H5:H4
            origem_aberta:H6:H5 fk_template_some:H7:H2 params_sem_teto:H8:H4
            catalogo_aberto:H11:H9,H12 log_aberto:H12:H9,H11 log_sem_master:H10:H9 anon_le:H13:H11,H12 anon_le_log:H13:H11,H12
            log_insert_grant:H14:H16 log_update_grant:H15:H14 catalogo_employee_escreve:H16:H17,H14
            anon_insert_grant:H18:H16 migracao_nova_log_aberto:H12:H9"

# sabotagem <nome> — troca UMA camada do schema vivo no banco da rodada. Status ≠0 = não aplicou.
sabotagem() {
  local wt='public.whatsapp_templates' wts='public.whatsapp_template_sends' so_employee staff
  so_employee="EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (SELECT auth.uid()) AND ur.role = 'employee')"
  staff="EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('employee','master'))"
  case "$1" in
    seed_incompleto)   P -v ON_ERROR_STOP=1 -q -c "DELETE FROM $wt WHERE nome = 'colacor_proposta_recompra';" ;;
    dedupe_some)       P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wts DROP CONSTRAINT whatsapp_template_sends_dedupe_key_key;" ;;
    categoria_aberta)  P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wt DROP CONSTRAINT whatsapp_templates_categoria_check;" ;;
    status_aberto)     P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wts DROP CONSTRAINT whatsapp_template_sends_status_check;" ;;
    origem_aberta)     P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wts DROP CONSTRAINT whatsapp_template_sends_origem_check;" ;;
    fk_template_some)  P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wts DROP CONSTRAINT whatsapp_template_sends_template_nome_fkey;" ;;
    params_sem_teto)   P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE $wt DROP CONSTRAINT whatsapp_templates_num_body_params_check;" ;;
    catalogo_aberto)   P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY wt_staff_read ON $wt USING (true);" ;;
    log_aberto)        P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY wts_staff_read ON $wts USING (true);" ;;
    log_sem_master)    P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY wts_staff_read ON $wts USING ($so_employee);" ;;
    anon_le)           P -v ON_ERROR_STOP=1 -q -c "CREATE POLICY sabotagem_anon_le ON $wt FOR SELECT TO anon USING (true);" ;;
    anon_le_log)       P -v ON_ERROR_STOP=1 -q -c "CREATE POLICY sabotagem_anon_le_log ON $wts FOR SELECT TO anon USING (true);" ;;
    log_insert_grant)  P -v ON_ERROR_STOP=1 -q -c "GRANT INSERT ON $wts TO authenticated;" ;;
    log_update_grant)  P -v ON_ERROR_STOP=1 -q -c "GRANT UPDATE ON $wts TO authenticated;" ;;
    catalogo_employee_escreve)
                       P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY wt_master_write ON $wt USING ($staff) WITH CHECK ($staff);" ;;
    anon_insert_grant) P -v ON_ERROR_STOP=1 -q -c "GRANT INSERT ON $wt TO anon;" ;;
    migracao_nova_log_aberto)
                       cv_migracao_nova_sql "DROP POLICY wts_staff_read ON $wts;
CREATE POLICY wts_staff_read ON $wts FOR SELECT TO authenticated USING (true);" ;;
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
