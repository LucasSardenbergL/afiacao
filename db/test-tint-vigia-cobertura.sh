#!/usr/bin/env bash
# Teste PG17 do VIGIA da cobertura tint no Sentinela (_data_health_compute + watchdog + heartbeat),
# contra a VERSÃO QUE PRODUÇÃO EXECUTA (db/lib/data-health-vivo.sh: snapshot + cadeia viva do trio).
# Semeia cenários de cobertura (família × conta × ativo × tint_type × created_at) e de vínculo
# (tint_skus → Omie inativo / produto em >1 SKU) e asserta:
#  • Check A (tint_cobertura_bases): NASCE ok; stale/warning com drift >30h; conta só oben × ativo ×
#    família MixMachine × classificação divergente, com TOLERÂNCIA de 30h (anti-falso-positivo);
#  • Check B (tint_vinculo_omie): conta SKU ativa→Omie inativo e produto Omie em >1 SKU ativa;
#  • PUSH SELETIVO: o watchdog promove SÓ o A (fin_alertas + e-mail); o B é DASHBOARD-ONLY;
#  • o alerta do A fecha quando ele volta a ok; o heartbeat traz o A no resumo e NÃO traz o B;
#  • a rodada do watchdog é COMPLETA (todas as fontes do v_sources avaliadas, sem falha) — sem esta
#    pré-condição os asserts negativos ("B não entra") passariam por vacuidade, porque o watchdog vivo
#    ENGOLE a falha do compute e só deixa de avaliar.
#
# Até 2026-09-27 esta prova aplicava a base 20260611210000 + a 20260615130000 por cima do snapshot de
# setembro e asseverava "20 checks": media a versão de JUNHO do trio, que as migrations seguintes
# reescreveram ~10 vezes (VERSÃO COBERTA ≠ VERSÃO ENTREGUE, money-path.md). Morreu no stub de
# _vendas_familia_ausente_lista_email, que colidia com a função real já no snapshot. Histórico:
# docs/historico/provas-tint-apodrecidas.md.
#
# MODOS
#   bash db/test-tint-vigia-cobertura.sh               # cenário na versão viva → PASS=<n>  FAIL=<m>
#   bash db/test-tint-vigia-cobertura.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + cadeia) sobe UMA vez; cada rodada roda num clone dele (CREATE DATABASE …
# TEMPLATE), então controle e sabotagens partem do mesmo estado e nenhuma herda o histórico da outra.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5443}"
TMPD="$(mktemp -d /tmp/pgtest-tintvigia.XXXXXX)"
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

# Pais p/ as FKs de tint_skus (produto_id/base_id/embalagem_id NOT NULL + FK) e o estado LIMPO.
echo "→ seed-base: pais tint + estado LIMPO (cobertura ok)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.tint_produtos (id, account, cod_produto, descricao) VALUES
  ('11111111-1111-1111-1111-111111111111','oben','P1','Produto teste');
INSERT INTO public.tint_bases (id, account, id_base_sayersystem, descricao) VALUES
  ('22222222-2222-2222-2222-222222222222','oben','B1','Base teste');
-- 5 embalagens distintas: tint_skus tem UNIQUE (account, produto_id, base_id, embalagem_id),
-- então cada SKU precisa de combinação única (o caso ambíguo = 2 SKUs distintas → mesmo omie).
INSERT INTO public.tint_embalagens (id, account, id_embalagem_sayersystem, volume_ml, descricao) VALUES
  ('33333333-3333-3333-3333-333333333331','oben','E1',3600,'GL'),
  ('33333333-3333-3333-3333-333333333332','oben','E2',405,'405ML'),
  ('33333333-3333-3333-3333-333333333333','oben','E3',810,'810ML'),
  ('33333333-3333-3333-3333-333333333334','oben','E4',900,'QT'),
  ('33333333-3333-3333-3333-333333333335','oben','E5',100,'BH');
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5004,'5004','Base correta',       'oben','Bases MixMachine',       true,  true, 'base',        now()-interval '60 hours'),
  (5005,'5005','Concentrado correto','oben','Concentrados MixMachine',true,  true, 'concentrado', now()-interval '60 hours');
SQL

SQL_DRIFT="$(cat <<'SQL'
-- Check A — drift de cobertura:
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (5001,'5001','Base nao marcada velha','oben','Bases MixMachine',       true,  false, NULL,         now()-interval '40 hours'), -- CONTA (não-marcada, >30h)
  (5002,'5002','Base nao marcada NOVA', 'oben','Bases MixMachine',       true,  false, NULL,         now()-interval '10 hours'), -- NÃO conta (tolerância <30h)
  (5003,'5003','Base tipo errado',      'oben','Bases MixMachine',       true,  true,  'concentrado',now()-interval '50 hours'), -- CONTA (tint_type errado, >30h)
  (5006,'5006','Base inativa',          'oben','Bases MixMachine',       false, false, NULL,         now()-interval '60 hours'), -- NÃO conta (inativo)
  (5007,'5007','Abrasivo',              'oben','ABRASIVOS',              true,  false, NULL,         now()-interval '60 hours'), -- NÃO conta (outra família)
  (5008,'5008','Base colacor',          'colacor','Bases MixMachine',   true,  false, NULL,         now()-interval '60 hours'); -- NÃO conta (account != oben)
-- Check B — vínculo quebrado:
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo, is_tintometric, tint_type, created_at) VALUES
  (6001,'6001','Omie inativo p/ vinculo','oben','X',false,false,NULL, now()-interval '60 hours'), -- alvo morto
  (6002,'6002','Omie em 2 skus',         'oben','X',true, false,NULL, now()-interval '60 hours'), -- alvo ambíguo
  (6003,'6003','Omie ok 1 sku',          'oben','X',true, false,NULL, now()-interval '60 hours'); -- alvo ok
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333331', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6001;                       -- morto: SKU ativa → omie inativo
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333332', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6002;                       -- ambíguo (1ª)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6002;                       -- ambíguo (2ª)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333334', op.id, true
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6003;                       -- ok (1 sku → omie ativo)
-- SKU INATIVA → omie inativo: NÃO conta (ts.ativo=false)
INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id, omie_product_id, ativo)
SELECT 'oben','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333335', op.id, false
  FROM public.omie_products op WHERE op.omie_codigo_produto = 6001;
SQL
)"

# A rodada que ACABOU de rodar foi completa e sem falha: o marcador de sucesso só avança assim, e ele
# é gravado DEPOIS do last_run_at da mesma rodada. `ultimo_erro` vai no valor para o log dizer o porquê.
SQL_RODADA="SELECT CASE WHEN last_success_at >= last_run_at AND checks_falhos = 0 AND ultimo_erro IS NULL
                        THEN 'completa'
                        ELSE 'incompleta: avaliados=' || COALESCE(checks_avaliados::text, '?') || ' falhos='
                             || COALESCE(checks_falhos::text, '?') || ' erro=' || COALESCE(ultimo_erro, '') END
              FROM public.data_health_watchdog_estado WHERE id;"

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
qa() { q "SELECT $1 FROM public._data_health_compute() WHERE source='tint_cobertura_bases';"; }
qb() { q "SELECT $1 FROM public._data_health_compute() WHERE source='tint_vinculo_omie';"; }

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ FASE 1 — estado limpo: o vigia nasce verde"
  chk V1  "compute: 1 linha por source (source duplicado faz o watchdog abortar o laço)" \
    "$(q "SELECT (count(*) = count(DISTINCT source))::text FROM public._data_health_compute();")" "true"
  chk V2a "tint_cobertura_bases aparece 1x" "$(qa "count(*)")" "1"
  chk V2b "tint_vinculo_omie aparece 1x"    "$(qb "count(*)")" "1"
  chk V3a "Check A NASCE ok"                "$(qa "status")"   "ok"
  chk V3b "Check A severity info quando ok" "$(qa "severity")" "info"
  chk V3c "Check B NASCE ok"                "$(qb "status")"   "ok"
  roda E1 "watchdog (estado limpo) executou" "SELECT public.data_health_watchdog();"
  chk V4  "rodada COMPLETA e sem falha (pré-condição dos negativos)" "$(q "$SQL_RODADA")" "completa"
  chk V5  "nenhum alerta tint aberto com tudo ok" \
    "$(q "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_tint_cobertura_bases','data_health_tint_vinculo_omie') AND dismissed_at IS NULL;")" "0"

  echo "→ mutação: drift de cobertura + vínculo quebrado"
  roda M1 "semeia o drift" "$SQL_DRIFT"
  echo "→ FASE 2 — drift"
  chk V6a "Check A vira stale"       "$(qa "status")"   "stale"
  chk V6b "Check A severity warning" "$(qa "severity")" "warning"
  chk V7  "Check A conta 2 (5001+5003); 5002 <30h, 5006 inativo, 5007 outra família, 5008 outra conta NÃO" \
    "$(qa "substring(message from '^Cobertura tint: ([0-9]+) ')")" "2"
  chk V8  "Check A age_seconds > 30h (o drift mais velho é a 5003, 50h)" "$(qa "(age_seconds > 30*3600)::text")" "true"
  chk V9a "Check B vira stale" "$(qb "status")" "stale"
  chk V9b "Check B: 1 SKU ativa → Omie inativo (a SKU inativa NÃO conta)" \
    "$(qb "substring(message from ': ([0-9]+) SKU')")" "1"
  chk V9c "Check B: 1 produto Omie em >1 SKU ativa" "$(qb "substring(message from ', ([0-9]+) produto')")" "1"
  roda E2 "watchdog (drift) executou" "SELECT public.data_health_watchdog();"
  chk V10  "rodada COMPLETA e sem falha (pré-condição dos negativos V12)" "$(q "$SQL_RODADA")" "completa"
  chk V11a "PUSH do A: alerta ativo em fin_alertas" \
    "$(q "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='data_health_tint_cobertura_bases' AND dismissed_at IS NULL;")" "1"
  chk V11b "PUSH do A: e-mail enfileirado" \
    "$(q "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] tint_cobertura_bases' AND status='pendente_notificacao';")" "1"
  chk V12a "B é DASHBOARD-ONLY: nada em fin_alertas" \
    "$(q "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_tint_vinculo_omie';")" "0"
  chk V12b "B é DASHBOARD-ONLY: nenhum e-mail" \
    "$(q "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '%tint_vinculo_omie%';")" "0"
  roda E3 "heartbeat executou" "SELECT public.fin_sync_heartbeat();"
  chk V13a "heartbeat: o resumo traz o A com o status" \
    "$(q "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%tint_cobertura_bases: stale%';")" "1"
  chk V13b "heartbeat: o resumo NÃO traz o B (dashboard-only)" \
    "$(q "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%tint_vinculo_omie%';")" "0"

  echo "→ mutação: corrige a cobertura (marca 5001/5003)"
  roda M2 "marca 5001/5003" "UPDATE public.omie_products SET is_tintometric=true, tint_type='base' WHERE omie_codigo_produto IN (5001,5003);"
  echo "→ FASE 3 — o A volta a ok e o alerta fecha"
  chk V14 "Check A volta a ok" "$(qa "status")" "ok"
  roda E4 "watchdog (corrigido) executou" "SELECT public.data_health_watchdog();"
  chk V15 "watchdog dispensou o alerta do A (0 ativos)" \
    "$(q "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_tint_cobertura_bases' AND dismissed_at IS NULL;")" "0"
  return 0
}

# Cada sabotagem troca UM trecho do corpo VIVO e declara o assert que TEM de ficar vermelho e as
# pré-condições que TÊM de seguir verdes — vermelho em outra camada (setup quebrado, rodada
# incompleta) é quebra, não dente. As âncoras ocorrem uma vez só no corpo (dhv_sabotar confere).
EXIGE_VERMELHO=""; EXIGE_VERDE=""
sabotagem() {
  local wd='public.data_health_watchdog()' hb='public.fin_sync_heartbeat()' cp='public._data_health_compute()'
  local conta="WHERE op.account = 'oben' AND op.ativo = true"
  case "$1" in
    push_sem_A)            EXIGE_VERMELHO="V11a V11b"; EXIGE_VERDE="V4 V10"
                           dhv_sabotar "$wd" "'tint_cobertura_bases'," "" ;;
    push_com_B)            EXIGE_VERMELHO="V12a V12b"; EXIGE_VERDE="V4 V10 V11a"
                           dhv_sabotar "$wd" "'tint_cobertura_bases'," "'tint_cobertura_bases','tint_vinculo_omie'," ;;
    resumo_sem_A)          EXIGE_VERMELHO="V13a"; EXIGE_VERDE="E3 V11a"
                           dhv_sabotar "$hb" "'tint_cobertura_bases'," "" ;;
    resumo_com_B)          EXIGE_VERMELHO="V13b"; EXIGE_VERDE="E3 V13a"
                           dhv_sabotar "$hb" "'tint_cobertura_bases'," "'tint_cobertura_bases','tint_vinculo_omie'," ;;
    A_sem_tolerancia)      EXIGE_VERMELHO="V7"; EXIGE_VERDE="V1 V4 V6a"
                           dhv_sabotar "$cp" "AND op.created_at < now() - interval '30 hours'" "AND op.created_at < now() - interval '0 hours'" ;;
    A_ignora_tint_type)    EXIGE_VERMELHO="V7"; EXIGE_VERDE="V1 V4 V6a"
                           dhv_sabotar "$cp" "OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))" "OR false AND op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))" ;;
    A_outra_conta)         EXIGE_VERMELHO="V7"; EXIGE_VERDE="V1 V4 V6a"
                           dhv_sabotar "$cp" "$conta" "WHERE op.ativo = true" ;;
    A_inativo)             EXIGE_VERMELHO="V7"; EXIGE_VERDE="V1 V4 V6a"
                           dhv_sabotar "$cp" "$conta" "WHERE op.account = 'oben'" ;;
    A_outra_familia)       EXIGE_VERMELHO="V7"; EXIGE_VERDE="V1 V4 V6a"
                           dhv_sabotar "$cp" "AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')" "AND true" ;;
    B_ignora_omie_inativo) EXIGE_VERMELHO="V9b"; EXIGE_VERDE="V1 V9a V9c"
                           dhv_sabotar "$cp" "(op.ativo IS NOT TRUE OR op.account IS DISTINCT FROM ts.account)" "(op.account IS DISTINCT FROM ts.account)" ;;
    B_ignora_ambiguo)      EXIGE_VERMELHO="V9c"; EXIGE_VERDE="V1 V9a V9b"
                           dhv_sabotar "$cp" "GROUP BY ts.omie_product_id HAVING count(*) > 1" "GROUP BY ts.omie_product_id HAVING count(*) > 2" ;;
    nao_dispensa)          EXIGE_VERMELHO="V15"; EXIGE_VERDE="V4 V11a"
                           dhv_sabotar "$wd" "WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;" "WHERE false;" ;;
    migracao_nova_sem_A)   EXIGE_VERMELHO="V11a V11b"; EXIGE_VERDE="V4 V10"
                           dhv_migracao_nova "$wd" "'tint_cobertura_bases'," "" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
SABOTAGENS="push_sem_A push_com_B resumo_sem_A resumo_com_B A_sem_tolerancia A_ignora_tint_type
            A_outra_conta A_inativo A_outra_familia B_ignora_omie_inativo B_ignora_ambiguo nao_dispensa
            migracao_nova_sem_A"

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
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha (ambiente
# quebrado, snapshot que não sobe) aprovaria todas as sabotagens. O controle roda primeiro, aqui, e
# um controle vermelho aborta ANTES da primeira sabotagem.
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
