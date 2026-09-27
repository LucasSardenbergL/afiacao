#!/usr/bin/env bash
# Teste PG17 da frente "e-mail lista as bases MixMachine divergentes" (nasceu na 20260708210000), contra
# a VERSÃO QUE PRODUÇÃO EXECUTA (db/lib/data-health-vivo.sh: snapshot + cadeia viva do trio). Semeia
# divergência tint e asserta:
#  • _tint_cobertura_bases_lista_email() lista cada produto que CONTA (oben × MixMachine × >30h ×
#    (sem is_tintometric | tint_type errado)) com '• <desc> (cód. X) — <motivo>', e EXCLUI os que NÃO
#    contam (<30h tolerância, inativo, outra família, outro account, já classificado) — mesmo predicado
#    do Check A (regressão se o helper divergir do compute);
#  • motivo correto: 'sem is_tintometric' × 'tint_type "X" deveria ser "base"';
#  • cap honesto: p_limit pequeno mostra os primeiros + "… e mais N"; n=0 → NULL;
#  • E2E: o watchdog vivo, numa rodada COMPLETA, enfileira o e-mail do tint_cobertura_bases COM a lista
#    no corpo, SEM perder a mensagem original; anti-cascata: o append do vendas_familia_ausente e os
#    sources do v_sources seguem no corpo (lido SEM comentários, money-path.md).
#
# Até 2026-09-27 esta prova re-aplicava a 20260708210000 por cima do snapshot de setembro: o watchdog
# sob teste era o de JULHO (INSERT direto, 17 sources), não o que roda (episódio com anti-flap, dead-man,
# 22 sources). Morreu no compute vivo lendo a MV não populada, e a falsificação antiga (dispensa →
# sabota → roda) passaria POR VACUIDADE no corpo vivo: o anti-flap do _data_health_episodio não
# re-enfileira e-mail de episódio dispensado há <2h. Histórico: docs/historico/provas-tint-apodrecidas.md.
#
# MODOS
#   bash db/test-tint-cobertura-lista-email.sh               # cenário na versão viva → PASS=<n>  FAIL=<m>
#   bash db/test-tint-cobertura-lista-email.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado e nenhuma herda histórico.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5449}"
TMPD="$(mktemp -d /tmp/pgtest-tint-lista.XXXXXX)"
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

# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/data-health-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + MV + ACL de prod + cadeia viva do trio…"
dhv_montar

echo "→ seed-base (divergência tint: 2 contam; 6 NÃO contam por motivos distintos)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5001,'5001','Base nao marcada velha','oben',   'Bases MixMachine',        true,  false, NULL,          now()-interval '40 hours'), -- CONTA: sem is_tintometric, >30h
  (5002,'5002','Base nao marcada NOVA', 'oben',   'Bases MixMachine',        true,  false, NULL,          now()-interval '10 hours'), -- NÃO: <30h (tolerância)
  (5003,'5003','Base tipo errado',      'oben',   'Bases MixMachine',        true,  true,  'concentrado', now()-interval '50 hours'), -- CONTA: tint_type errado, >30h
  (5004,'5004','Base correta',          'oben',   'Bases MixMachine',        true,  true,  'base',        now()-interval '60 hours'), -- NÃO: classificado
  (5005,'5005','Concentrado correto',   'oben',   'Concentrados MixMachine', true,  true,  'concentrado', now()-interval '60 hours'), -- NÃO: classificado
  (5006,'5006','Base inativa',          'oben',   'Bases MixMachine',        false, false, NULL,          now()-interval '60 hours'), -- NÃO: inativo
  (5007,'5007','Abrasivo comum',        'oben',   'ABRASIVOS',               true,  false, NULL,          now()-interval '60 hours'), -- NÃO: outra família
  (5008,'5008','Base colacor',          'colacor','Bases MixMachine',        true,  false, NULL,          now()-interval '60 hours'); -- NÃO: outro account
SQL

# A rodada que ACABOU de rodar foi completa e sem falha (o marcador de sucesso só avança assim, e é
# gravado DEPOIS do last_run_at da mesma rodada). `ultimo_erro` vai no valor para o log dizer o porquê.
SQL_RODADA="SELECT CASE WHEN last_success_at >= last_run_at AND checks_falhos = 0 AND ultimo_erro IS NULL
                        THEN 'completa'
                        ELSE 'incompleta: avaliados=' || COALESCE(checks_avaliados::text, '?') || ' falhos='
                             || COALESCE(checks_falhos::text, '?') || ' erro=' || COALESCE(ultimo_erro, '') END
              FROM public.data_health_watchdog_estado WHERE id;"
# Corpo do watchdog SEM comentários: a substring num comentário não prova código (money-path.md).
WD_CODIGO="regexp_replace(pg_get_functiondef('public.data_health_watchdog()'::regprocedure), '--[^\n]*', '', 'g')"
EMAIL_TINT="FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases'"

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
q() { P -tA -c "$1" 2>&1 | tr '\n' ' ' | sed 's/ *$//'; }
# O PASSO também é assert: SQL que erra fica vermelho (com o erro no log) em vez de derrubar a rodada.
roda() {  # <id> <descrição> <sql>
  local saida
  if saida="$(P -v ON_ERROR_STOP=1 -q -c "$3" 2>&1 >/dev/null)"; then chk "$1" "$2" "ok" "ok"
  else chk "$1" "$2" "$(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-300)" "ok"; fi
}
lista() { q "SELECT ($1)::text FROM (SELECT public._tint_cobertura_bases_lista_email($2) AS l) s;"; }
bullets() { lista "length(l) - length(replace(l, '•', ''))" "$1"; }

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ helper — conteúdo e motivo"
  chk T1a "lista contém a base não-marcada (desc+cód. 5001)" "$(lista "l LIKE '%Base nao marcada velha (cód. 5001)%'" 50)" "true"
  chk T1b "motivo 'sem is_tintometric' p/ a 5001"            "$(lista "l LIKE '%5001) — sem is_tintometric%'" 50)" "true"
  chk T2a "lista contém a base tipo-errado (desc+cód. 5003)"  "$(lista "l LIKE '%Base tipo errado (cód. 5003)%'" 50)" "true"
  chk T2b "motivo 'tint_type \"concentrado\" deveria ser \"base\"' p/ a 5003" \
    "$(lista "l LIKE '%tint_type \"concentrado\" deveria ser \"base\"%'" 50)" "true"
  echo "→ helper — o WHERE morde (exclusões)"
  chk T3 "NÃO lista a base <30h (tolerância: 5002)"  "$(lista "l LIKE '%5002%'" 50)" "false"
  chk T4 "NÃO lista classificados (5004/5005)"       "$(lista "l LIKE '%5004%' OR l LIKE '%5005%'" 50)" "false"
  chk T5 "NÃO lista inativo (5006)"                  "$(lista "l LIKE '%5006%'" 50)" "false"
  chk T6 "NÃO lista outra família (5007 Abrasivo)"   "$(lista "l LIKE '%Abrasivo%'" 50)" "false"
  chk T7 "NÃO lista outro account (5008 colacor)"    "$(lista "l LIKE '%5008%'" 50)" "false"
  chk T8 "exatamente 2 bullets (só 5001+5003)"       "$(bullets 50)" "2"
  echo "→ helper — cap honesto (p_limit=1 com n=2)"
  chk T9a "cap mostra 1 bullet" "$(bullets 1)" "1"
  chk T9b "cap anuncia '… e mais 1 item(ns)'" "$(lista "l LIKE '%… e mais 1 item(ns)%'" 1)" "true"

  echo "→ E2E pelo watchdog vivo — e-mail enriquecido, anti-cascata"
  roda E1 "watchdog executou" "SELECT public.data_health_watchdog();"
  chk T10a "rodada COMPLETA e sem falha (pré-condição do E2E)" "$(q "$SQL_RODADA")" "completa"
  chk T10 "e-mail do tint_cobertura_bases TEM a lista (cód. 5001) no corpo" \
    "$(q "SELECT count(*) $EMAIL_TINT AND mensagem LIKE '%(cód. 5001)%';")" "1"
  chk T11 "e-mail mantém a mensagem original (Cobertura tint: 2 …)" \
    "$(q "SELECT count(*) $EMAIL_TINT AND mensagem LIKE 'Cobertura tint: 2 %';")" "1"
  chk T12 "anti-cascata: o watchdog chama o append do vendas_familia_ausente (no código)" \
    "$(q "SELECT (strpos($WD_CODIGO, 'public._vendas_familia_ausente_lista_email(50)') > 0)::text;")" "true"
  chk T13a "anti-cascata: pedidos_compra_sync segue no v_sources (no código)" \
    "$(q "SELECT (strpos($WD_CODIGO, '''pedidos_compra_sync''') > 0)::text;")" "true"
  chk T13b "anti-cascata: custos_proxy_conf_alta segue no v_sources (no código)" \
    "$(q "SELECT (strpos($WD_CODIGO, '''custos_proxy_conf_alta''') > 0)::text;")" "true"
  chk T14 "compute: tint_cobertura_bases segue 1x" \
    "$(q "SELECT count(*) FROM public._data_health_compute() WHERE source='tint_cobertura_bases';")" "1"

  echo "→ n=0 → NULL depois de corrigir"
  roda M1 "marca 5001/5003" "UPDATE public.omie_products SET is_tintometric=true, tint_type='base' WHERE omie_codigo_produto IN (5001,5003);"
  chk T15 "helper retorna NULL quando não há divergentes" "$(lista "l IS NULL" 50)" "true"
  return 0
}

# Cada sabotagem troca UM trecho do corpo VIVO e declara o assert que TEM de ficar vermelho e as
# pré-condições que TÊM de seguir verdes — vermelho em outra camada é quebra, não dente. A sabotagem é
# o ÚLTIMO comando do ramo: o status dela é o status de `sabotagem` (o `|| return 3` do chamador).
EXIGE_VERMELHO=""; EXIGE_VERDE=""
sabotagem() {
  local wd='public.data_health_watchdog()' hl='public._tint_cobertura_bases_lista_email(integer)'
  case "$1" in
    email_sem_lista)         EXIGE_VERMELHO="T10"; EXIGE_VERDE="T10a T11"
                             dhv_sabotar "$wd" "public._tint_cobertura_bases_lista_email(50)" "NULL::text" ;;
    lista_sem_tolerancia)    EXIGE_VERMELHO="T3 T8"; EXIGE_VERDE="T1a T2a"
                             dhv_sabotar "$hl" "AND op.created_at < now() - interval '30 hours'" "AND op.created_at < now() - interval '0 hours'" ;;
    lista_outra_conta)       EXIGE_VERMELHO="T7 T8"; EXIGE_VERDE="T1a T2a"
                             dhv_sabotar "$hl" "WHERE op.account = 'oben' AND op.ativo = true" "WHERE op.ativo = true" ;;
    lista_ignora_tint_type)  EXIGE_VERMELHO="T2a T8"; EXIGE_VERDE="T1a"
                             dhv_sabotar "$hl" "OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))" "OR false AND op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))" ;;
    lista_sem_cap)           EXIGE_VERMELHO="T9b"; EXIGE_VERDE="T9a"
                             dhv_sabotar "$hl" "count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados" "count(*)::int AS n_mostrados" ;;
    migracao_nova_sem_lista) EXIGE_VERMELHO="T10"; EXIGE_VERDE="T10a T11"
                             dhv_migracao_nova "$wd" "public._tint_cobertura_bases_lista_email(50)" "NULL::text" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
SABOTAGENS="email_sem_lista lista_sem_tolerancia lista_outra_conta lista_ignora_tint_type lista_sem_cap
            migracao_nova_sem_lista"

# rodada <sabotagem|""> — clona o banco-base e roda o cenário no clone. Exit 3 = a sabotagem não
# aplicou (âncora sumiu do corpo vivo): isso é FALHA da falsificação, nunca dente.
rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;"
  DB=rodada
  EXIGE_VERMELHO=""; EXIGE_VERDE=""
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
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha aprovaria todas
# as sabotagens. O controle roda primeiro, aqui, e um controle vermelho aborta ANTES da 1ª sabotagem.
echo "══ CONTROLE (versão viva, sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

vermelhas=0; falhas=0
for s in $SABOTAGENS; do
  rc=0; rodada "$s" > "$TMPD/sab-$s.log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $(grep -m1 -E 'ERRO|ERROR|dhv_' "$TMPD/sab-$s.log" | cut -c1-200 || true)"
  else
    for id in $EXIGE_VERMELHO; do
      case "$FALHOS" in *" $id "*) ;; *) motivo="$motivo $id ficou VERDE (o assert não tem dente);" ;; esac
    done
    for id in $EXIGE_VERDE; do
      case "$FALHOS" in *" $id "*) motivo="$motivo $id ficou VERMELHO (a sabotagem quebrou outra camada);" ;; esac
    done
  fi
  if [ -z "$motivo" ]; then
    vermelhas=$((vermelhas+1)); echo "  ✅ $s — vermelho no alvo ($EXIGE_VERMELHO)"
  else
    falhas=$((falhas+1)); echo "  ❌ $s —$motivo"
    grep -E '✗' "$TMPD/sab-$s.log" | head -8 | sed 's/^/       /' || true
  fi
done

# Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag não foi
# ignorada.
echo "SABOTAGENS: $vermelhas vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
