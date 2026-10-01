#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5471}"
SLUG="sync-reprocess-saude"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# A regra que este laço respeita (CLAUDE.md): sabotar sem CONTROLE VERDE na MESMA invocação é
# teatro — uma suíte sempre-vermelha (por ambiente quebrado, porta ocupada, migration inválida)
# aprovaria TODAS as sabotagens. Por isso o controle roda PRIMEIRO, aqui dentro, e um controle
# vermelho ABORTA antes da primeira sabotagem, em vez de deixar o laço "passar".
#
# E exit≠0 NÃO é dente (money-path.md: "o vermelho tem de ser do SEU assert"). Até 2026-09-27 este
# laço contava toda rodada vermelha como "vermelha como devia", inclusive o `exit 9` de uma sabotagem
# NÃO APLICÁVEL (o padrão derivou depois de editar a migration), cuja própria linha "❌ SABOTAGEM NÃO
# APLICÁVEL" ainda entrava na contagem de "asserts quebrados". Agora cada sabotagem DECLARA os asserts
# que têm de acusá-la, e a rodada só conta como vermelha se:
#   1. a sabotagem APLICOU (a linha "SABOTAGEM ATIVA em" está no log);
#   2. a suíte rodou INTEIRA (PASS+FAIL do recibo = o do controle: aborto no meio não é assert);
#   3. CADA assert declarado está VERDE no controle e VERMELHO aqui (o mesmo assert virou);
#   4. a rodada não tem ERRO de execução do SQL que o controle não tem — a medição que erra sai
#      vazia e o assert cai por ERRO, não por julgamento (achado do Codex, 2026-09-27).
# Qualquer outro vermelho é FALHA da falsificação. Diário: docs/historico/falsificacao-exit-nao-e-dente.md
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<IDs dos asserts que TÊM de acusá-la>. `,` = E (cada um tem de virar); `|` = OU
  # (basta um). O ID é o prefixo `A<n> ` que cada assert imprime. Os colaterais (asserts que também
  # caem, mas não existem para pegar ESTA sabotagem) ficam de fora de propósito: alguns oscilam
  # (o A25 sob `message_com_hora_de_parede` depende de a leitura cruzar a virada de um segundo).
  SABOTAGENS="erro_nao_e_broken:A7,A9 desconhecido_vira_ok:A13 nao_catalogada_vira_ok:A14
              orfa_nunca_dispara:A10 stale_nunca_dispara:A12 nunca_executou_vira_ok:A2
              retry_liquida_erro:A15 degradado_conta_dispensada:A18 message_com_idade:A23
              message_com_data_do_relogio:A23 message_com_hora_de_parede:A23 message_constante:A24
              fora_do_v_sources:A28,A30 migracao_nova_retry_liquida_erro:A15
              migracao_nova_drop_create:A32"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  # asserts EXECUTADOS numa rodada = PASS+FAIL do recibo final; vazio se ela abortou antes dele
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar. Uma suíte que já falha sozinha"
    echo "     aprovaria todas as sabotagens por vermelhidão constante, não por dente."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM um recibo PASS/FAIL legível [$asserts_controle] — sem ele não há como"
                   echo "     saber se uma rodada sabotada rodou a suíte inteira. Abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou? nome sem ramo?): nenhum assert acusou nada"
      { grep -m3 -E 'SABOTAGEM|reescrita_na_cadeia|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto, não de assert"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de execução do SQL ($erros_sql linha(s) ERROR, o controle tem $erros_controle): a medição que erra sai vazia e o assert cai por ERRO, não por julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou (verde no controle → vermelho aqui):$faltam"
      echo "       vermelhos desta rodada: ${vermelhos:-nenhum assert}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  # Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag
  # `--falsificar` não foi silenciosamente ignorada. Vermelhas = as que ficaram vermelhas NO ASSERT
  # DECLARADO; vermelho de outra causa entra em falhas.
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# PGBIN resolvido POR PLATAFORMA (macOS Homebrew / Linux PGDG) com conferência positiva da major.
# O boilerplate do template é macOS-only (`/opt/homebrew`) — esta prova roda no `provas-sql` do CI,
# que é Ubuntu, então tem de usar o helper. Fail-closed: PG ausente é ERRO, nunca skip.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# `P` fala com o banco $DB: `prove` na rodada. Só a pré-fase das sabotagens migracao_nova_* (abaixo)
# monta um 2º banco, `pre`, no mesmo cluster. As funções da lib (dhv_*) também falam por `P`.
DB=prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }   # -X: o ~/.psqlrc não entra (#2696)
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# A CADEIA VIVA do trio, não uma lista fixa (docs/historico/sync-reprocess-cadeia-viva.md). Até
# 2026-09-30 esta prova aplicava 0918 → 0920a → 0920b e parava — e o sabotar() dizia que a 0920b era
# "a última a recriar o compute, que é o que vale em prod". A 20260922225500 (portal humano) o recriou
# de novo, e a prova seguiu VERDE medindo o compute anterior (md5 f0eecc… no harness; prod 4cc51b…):
# VERSÃO COBERTA ≠ VERSÃO ENTREGUE, dentro do núcleo. Agora a seleção é a de db/lib/data-health-vivo.sh
# — toda migration ≥ DHV_INICIO que redefine função guardada, em ordem de versão —, e a próxima
# reescrita do trio entra sozinha. Quem prova isso são as sabotagens migracao_nova_*, que põem a
# próxima reescrita no diretório que o SETUP lê (pré-fase, abaixo).
#
# ESTREITADA às 3 funções que esta prova EXECUTA de verdade. Das outras guardadas da lib, o
# _data_health_episodio (o ESPIÃO do A28) e os 2 helpers de lista são stubs aqui
# (db/stubs-data-health-trio.sql), e o get_data_health esta prova nem monta. Uma migration que
# redefine uma das 3 E lê tabela fora do stub reprova: o compute (LANGUAGE sql) já no CREATE; o
# watchdog e o heartbeat (plpgsql) quando a prova os EXECUTA (A26–A29). É o sinal que o stub pede —
# a versão nova ficou sem cobertura; estenda o stub, nunca volte a fixar a lista.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/data-health-vivo.sh"
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_GUARDADAS=(_data_health_compute data_health_watchdog fin_sync_heartbeat)
# O início também é DESTA prova, não da lib: é a 0918 que monta watchdog e heartbeat inteiros sobre
# os stubs. A lib o move junto com o snapshot das irmãs; aqui, movê-lo tiraria a base da cadeia.
# shellcheck disable=SC2034  # lida por dhv_cadeia, na lib
DHV_INICIO=20260918200000

# ══════════════════════════════════════════════════════════════════════════════
# ZONAS 1+2 — o banco de UMA rodada, em $DB: base do Supabase + stubs do trio + o ACL de prod + a
# cadeia viva lida de $1 (Lei #1: as migrations REAIS, nunca um stub da lógica)
# ══════════════════════════════════════════════════════════════════════════════
# As funções que esta prova STUBA: se uma migration da cadeia também redefinir uma delas, o A27/A28
# cairia com o diagnóstico errado ("não roteou"). O setup confere que a cadeia não as tocou.
STUBADAS="'_data_health_episodio','_tint_cobertura_bases_lista_email','_vendas_familia_ausente_lista_email','refresh_customer_metrics','tint_marcar_bases_mixmachine'"
assinatura_stubadas() {
  Pq -c "SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ' ' ORDER BY p.proname, p.oid)
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ($STUBADAS);"
}
montar_banco() {
  local stubadas
  # base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS)
  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
  # ZONA 1 — pré-requisitos mínimos (formas MEDIDAS em prod, sem schema-snapshot)
  P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"
  # ZONA 2 — O PG17 limpo daria EXECUTE a PUBLIC por default; PROD tem o REVOKE (medido: o compute e
  # executavel so por postgres/service_role/sandbox_exec — nem `authenticated`). Reproduzimos esse
  # estado ANTES do apply com um stub de assinatura identica: assim a postcondicao de ACL nao mede o
  # default do harness, e sim o que a migration faz com ele — provando que `CREATE OR REPLACE`
  # PRESERVA o ACL (so DROP+CREATE o resetaria, CLAUDE.md/database.md §4). Só a 0918 o confere; o
  # A32 o confere no FIM da cadeia.
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
  stubadas="$(assinatura_stubadas)"
  echo "  → cadeia viva (≥ $DHV_INICIO que redefine ${DHV_GUARDADAS[*]}), de $1:"
  dhv_aplicar_cadeia "$1" || { echo "❌ a cadeia viva do trio NÃO aplicou sobre os stubs"; return 1; }
  [ "$(assinatura_stubadas)" = "$stubadas" ] \
    || { echo "❌ a cadeia redefiniu uma função que esta prova STUBA ($STUBADAS) — re-stube-a depois da cadeia"; return 1; }
}

# ══════════════════════════════════════════════════════════════════════════════
# PRÉ-FASE das sabotagens migracao_nova_*: a PRÓXIMA reescrita do compute, no diretório que o SETUP lê
# ══════════════════════════════════════════════════════════════════════════════
# O incidente desta prova (22–30/09) foi o SETUP não seguir a cadeia. Uma sabotagem que trouxesse a
# PRÓPRIA cadeia (o dhv_migracao_nova reaplica a dele) ficaria vermelha com o setup re-fixado à mão —
# medido na revisão de 2026-09-30: lista fixa de volta, normal 31/0 e falsificação 14/0. Aqui a
# reescrita vai para um ESPELHO de supabase/migrations, e a rodada monta o banco pela MESMA chamada de
# sempre, lendo $MIGDIR: setup que não segue a cadeia não a aplica, o case da SABOTAGEM sai 9 e o juiz
# conta FALHA. O corpo da reescrita vem de um 2º banco (`pre`) montado do jeito normal — é o corpo
# VIVO + uma troca, nunca o texto de um arquivo.
MIGDIR="$REPO_ROOT/supabase/migrations"
# reescrita_na_cadeia <prefixo> <âncora> <troca> — no banco $DB, escreve <prefixo> + o corpo vivo do
# compute com a âncora trocada, como migration nova (29991231235959) num espelho de
# supabase/migrations, e imprime o diretório. Fail-closed: âncora não única, troca que não muda o
# corpo e seleção que não pega a migration nova → return 1.
reescrita_na_cadeia() {
  local dir nova corpo lista
  dir="$(mktemp -d "${TMPDIR:-/tmp}/reescrita-${SLUG}.XXXXXX")"
  ln -s "$REPO_ROOT"/supabase/migrations/*.sql "$dir"/
  nova="$dir/29991231235959_reescrita_do_compute.sql"
  corpo="$(Pq -X -v ancora="$2" -v troca="$3" <<'SQL'
SELECT CASE WHEN (length(d) - length(replace(d, :'ancora', ''))) / length(:'ancora') = 1
             AND replace(d, :'ancora', :'troca') <> d
            THEN replace(d, :'ancora', :'troca') ELSE 'SEM ANCORA UNICA' END
  FROM (SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure) AS d) s;
SQL
)" || return 1
  case "$corpo" in
    ''|'SEM ANCORA UNICA') echo "reescrita_na_cadeia: a âncora não ocorre 1× no corpo vivo (ou a troca não o muda)" >&2; return 1 ;;
  esac
  printf '%s%s;\n' "$1" "$corpo" > "$nova"
  lista="$(dhv_cadeia "$dir")" || return 1
  case "$lista" in
    *"$nova"*) ;;
    *) echo "reescrita_na_cadeia: a seleção dinâmica NÃO pegou a migration nova" >&2; return 1 ;;
  esac
  printf '%s\n' "$dir"
}
case "${SABOTAGEM:-}" in
  migracao_nova_*)
    case "$SABOTAGEM" in
      migracao_nova_retry_liquida_erro)
        # o furo E.1 (A15) chegando pela próxima reescrita
        prefixo=""
        ancora="             AND l.status IS DISTINCT FROM 'running'
           -- desempate EXPLICITO por id"
        troca="           -- desempate EXPLICITO por id" ;;
      migracao_nova_drop_create)
        # a armadilha do CLAUDE.md: DROP+CREATE reseta o ACL, e o compute SECURITY DEFINER volta a
        # executar para PUBLIC/anon (A32) com o md5 do pg_get_functiondef intocado. A troca no
        # comentário só existe para o md5 provar que a reescrita chegou; a lógica segue a viva.
        prefixo="DROP FUNCTION public._data_health_compute();
"
        ancora="-- desempate EXPLICITO por id"
        troca="-- desempate EXPLICITO por id (reescrita por DROP+CREATE)" ;;
      *) echo "❌ SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 9 ;;
    esac
    echo "── pré-fase: o banco \`pre\`, montado do jeito normal, dá o corpo vivo para a reescrita ──"
    "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres pre
    DB=pre montar_banco "$MIGDIR"
    MIGDIR="$(DB=pre reescrita_na_cadeia "$prefixo" "$ancora" "$troca")" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a reescrita não foi escrita (âncora) ou a seleção dinâmica não a pegou."; exit 9; }
    MD5_REESCRITA="$(DB=pre Pq -X -v ancora="$ancora" -v troca="$troca" <<'SQL'
SELECT md5(replace(pg_get_functiondef('public._data_health_compute()'::regprocedure), :'ancora', :'troca'));
SQL
)" ;;
esac

echo "═══ setup PG17 :$PORT ═══"
montar_banco "$MIGDIR"   # ← O SETUP: a mesma chamada em toda rodada, sabotada ou não
# A versão COBERTA, legível no log do CI — para conferir contra a ENTREGUE (psql-ro):
#   SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));
echo "  compute exercitado: md5 $(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")"
echo "═══ cadeia real aplicada (cada postcondição passou) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# SABOTAGEM (dirigida por $SABOTAGEM; o laço --falsificar no topo do arquivo a usa)
# Sabota no BANCO, trocando UM trecho do corpo VIVO da função — o que a cadeia acabou de instalar,
# lido por pg_get_functiondef (dhv_sabotar, da lib) — e recriando-a. Até 2026-09-30 o corpo vinha do
# ARQUIVO de uma migration fixa: com a cadeia viva, isso recriaria a versão VELHA + a sabotagem, e a
# rodada sabotada mediria duas mudanças (a 0922 revertida em silêncio), não uma. O repo NUNCA é
# tocado, então não há `git checkout --` para restaurar (que é onde a falsificação costuma comer
# trabalho não commitado). A âncora tem de ocorrer exatamente 1× no corpo e o md5 tem de mudar: uma
# substituição que não pegou deixaria a suíte verde e faria a falsificação aprovar tudo — teatro. O
# `exit 9` abaixo NÃO é o vermelho que a falsificação procura: o laço exige a linha "SABOTAGEM ATIVA
# em" e o assert declarado, e conta este exit como FALHA (era contado como dente até 2026-09-27).
# ══════════════════════════════════════════════════════════════════════════════
sabotar() {
  local fn="$1" de="$2" para="$3"
  dhv_sabotar "public.${fn}()" "$de" "$para" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a âncora não ocorre exatamente 1× no corpo VIVO de $fn (ou não o mudou). Sem isto a suíte ficaria verde e a falsificação aprovaria tudo."; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em $fn — a suíte abaixo DEVE ficar vermelha"
}

case "${SABOTAGEM:-}" in
  "") ;;
  erro_nao_e_broken)
      sabotar _data_health_compute "WHEN u.status IN ('error','failed') THEN 'broken'" \
                                   "WHEN u.status IN ('error','failed') THEN 'ok'" ;;
  desconhecido_vira_ok)
      sabotar _data_health_compute "WHEN u.status IS NOT NULL AND u.status <> 'complete' THEN 'unknown'" \
                                   "WHEN u.status IS NOT NULL AND u.status <> 'complete' THEN 'ok'" ;;
  nao_catalogada_vira_ok)
      sabotar _data_health_compute "WHEN cat.nao_catalogada THEN 'unknown'" \
                                   "WHEN cat.nao_catalogada THEN 'ok'" ;;
  orfa_nunca_dispara)
      sabotar _data_health_compute "AND r.created_at < now() - interval '2 hours' THEN 'broken'" \
                                   "AND r.created_at < now() - interval '900 hours' THEN 'broken'" ;;
  stale_nunca_dispara)
      sabotar _data_health_compute "WHEN s.ultimo_sucesso_em < now() - make_interval(hours => cat.sla_h) THEN 'stale'" \
                                   "WHEN s.ultimo_sucesso_em < now() - make_interval(hours => cat.sla_h * 1000) THEN 'stale'" ;;
  nunca_executou_vira_ok)
      sabotar _data_health_compute "WHEN s.ultimo_sucesso_em IS NULL THEN 'broken'" \
                                   "WHEN s.ultimo_sucesso_em IS NULL THEN 'ok'" ;;
  degradado_conta_dispensada)
      # devolver a contagem a TODAS as chaves faz o fóssil de `manual` voltar a inflar a message
      sabotar _data_health_compute "(cat.sla_h IS NOT NULL AND NOT cat.nao_catalogada
                AND u.status = 'complete' AND u.error_message IS NOT NULL) AS degradado," \
                                   "(u.status = 'complete' AND u.error_message IS NOT NULL) AS degradado," ;;
  retry_liquida_erro)
      # o furo E.1 em si: devolver `u` a leitura de QUALQUER linha faz um `running` posterior
      # apagar o erro terminal. Tem de ficar vermelha no assert do E.1.
      sabotar _data_health_compute "             AND l.status IS DISTINCT FROM 'running'
           -- desempate EXPLICITO por id" \
                                   "           -- desempate EXPLICITO por id" ;;
  message_com_idade)
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') END" ;;
  message_com_data_do_relogio)
      # O defeito de SENSOR que o assert antigo não via: a data vir do RELÓGIO, e não do último sucesso.
      # Ela só muda à meia-noite ⇒ mesmo problema, message nova por dia ⇒ um e-mail por dia. Só pega
      # isso um relógio que CRUZA a meia-noite local com o dado parado; deslocar o dado, nunca.
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" ;;
  message_com_hora_de_parede)
      # clock_timestamp() não passa pelo relógio controlado (só now() passa): quem pega é o pg_sleep REAL
      # entre as leituras. Sem esta sabotagem aquele sleep seria camada sem prova de dente.
      sabotar _data_health_compute "ELSE ' desde ' || to_char(d.ultimo_sucesso_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') END" \
                                   "ELSE ' desde ' || to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') END" ;;
  message_constante)
      # O outro lado da moeda de `message_com_idade`: uma message que NUNCA muda passaria o teste de
      # estabilidade e não avisaria ninguém. Esta sabotagem tem de ficar vermelha no assert do PAR.
      sabotar _data_health_compute "WHEN sr.n_broken > 0 THEN 'Reprocesso Omie PARADO: ' || sr.resumo" \
                                   "WHEN sr.n_broken > 0 THEN 'Reprocesso Omie PARADO'" ;;
  fora_do_v_sources)
      # Âncora só entre ASPAS, sem a pontuação do array: até 2026-10-01 era "'sync_reprocess_saude'];"
      # (o fim do array), e a 20261001011500 acrescentou uma fonte depois dela. O nome entre aspas
      # ocorre 1× no watchdog vivo (o comentário o cita sem aspas) — o dhv_sabotar exige isso.
      sabotar data_health_watchdog "'sync_reprocess_saude'" "'nao_existe_este_source'" ;;
  migracao_nova_*)
      # O dente da CADEIA DINÂMICA (a reescrita foi posta no diretório da cadeia pela pré-fase). Se o
      # compute instalado não é ela, o SETUP não segue a cadeia — o incidente de 22–30/09 — e a rodada
      # sai 9 sem a linha ATIVA: o juiz conta FALHA, nunca dente.
      [ "$(Pq -c "SELECT md5(pg_get_functiondef('public._data_health_compute()'::regprocedure));")" = "$MD5_REESCRITA" ] \
        || { echo "❌ SABOTAGEM NÃO APLICÁVEL — a reescrita nova estava no diretório da cadeia e o SETUP não a aplicou: o setup não segue a cadeia viva."; exit 9; }
      echo "⚠️  SABOTAGEM ATIVA em _data_health_compute (pela PRÓXIMA reescrita, aplicada pelo setup) — a suíte abaixo DEVE ficar vermelha" ;;
  *)  echo "❌ SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 9 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — mesa de controle: cada cenário semeia sync_reprocess_log e lê o veredito
# ══════════════════════════════════════════════════════════════════════════════
# As 7 chaves VIGIADAS do catálogo. `semear_saudavel` deixa todas verdes; cada cenário
# depois altera UMA coisa, para que o assert prove aquela coisa e não o ambiente.
# $1 (opcional) = instante-âncora como expressão SQL; o padrão é now(). Só o cenário de message
# estável ancora num instante FIXO — o porquê está lá.
semear_saudavel() {
  P -q -v agora="${1:-now()}" <<'SQL'
TRUNCATE public.sync_reprocess_log;
INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('oben','operational','orders',            'complete', :agora - interval '30 minutes'),
  ('oben','operational','inventory',         'complete', :agora - interval '30 minutes'),
  ('oben','strategic','orders',              'complete', :agora - interval '3 hours'),
  ('oben','strategic','inventory',           'complete', :agora - interval '3 hours'),
  ('oben','strategic','products',            'complete', :agora - interval '3 hours'),
  ('oben','status_produtos','sku_status_omie','complete', :agora - interval '3 hours'),
  ('colacor','status_produtos','sku_status_omie','complete', :agora - interval '3 hours');
SQL
}
# status agregado do check
st()  { Pq -c "SELECT status  FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
# message/idade lidas com o relógio controlado em $1, cada leitura na SUA sessão (o SET morre com ela).
# Só valem com o relógio ligado (seção "message estável"), e o controle positivo de lá confere isso.
msg_em()   { Pq -q -c "SET test.agora = '$1'" -c "SELECT message FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
idade_em() { Pq -q -c "SET test.agora = '$1'" -c "SELECT age_seconds::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }
nlin(){ Pq -c "SELECT count(*)::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';"; }

echo "── contrato de forma (o que cega os outros checks se quebrar) ──"
P -q -c "TRUNCATE public.sync_reprocess_log;"
eq "A1 tabela VAZIA ainda devolve 1 linha (catálogo é o FROM, não a tabela)" "$(nlin)" "1"
eq "A2 tabela VAZIA ⇒ broken (chave vigiada que nunca executou é falha, não silêncio)" "$(st)" "broken"

semear_saudavel
eq "A3 1 linha por source no compute INTEIRO" \
   "$(Pq -c "SELECT (count(*) = count(DISTINCT source))::text FROM public._data_health_compute();")" "true"
# Contagem da VERSÃO VIVA (cadeia dinâmica): a 0918 levou o compute a 30 (29 + este) e a
# 20261001011500 (vendas_empurradas_sem_gemeo) a 31. Fonte nova no trio muda este número — no PR que
# a acrescenta, que é onde o vermelho tem de aparecer.
eq "A4 o compute tem 31 sources (a 0918 trouxe este; a 20261001011500, o 31º)" \
   "$(Pq -c "SELECT count(DISTINCT source)::text FROM public._data_health_compute();")" "31"
eq "A5 status dentro do vocabulário que o watchdog aceita" \
   "$(Pq -c "SELECT (status IN ('ok','stale','broken','unknown'))::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

echo "── vereditos por eixo ──"
eq "A6 catálogo todo com complete fresco ⇒ ok" "$(st)" "ok"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='error', error_message='pedido 7b6f incoerente'
          WHERE reprocess_type='operational' AND entity_type='orders';"
eq "A7 última linha em error ⇒ broken (o incidente real)" "$(st)" "broken"
eq "A8 o erro técnico chega ao last_error" \
   "$(Pq -c "SELECT (last_error LIKE '%7b6f%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='failed'
          WHERE reprocess_type='status_produtos' AND account='oben';"
eq "A9 dialeto 'failed' (omie-sync-status-produtos) também é broken" "$(st)" "broken"

# O cenário da órfã precisa de um SUCESSO DENTRO do SLA, senão o `broken` vem da cláusula "nunca
# completou" e o assert passa pelo motivo errado — foi o que a falsificação flagrou: sabotar o
# limiar da órfã deixava a suíte verde. Aqui: complete há 3h (dentro do SLA de 4h) e uma tentativa
# iniciada há 2h30 que nunca terminou. Só a cláusula da órfã pode dar broken.
semear_saudavel
P -q -c "DELETE FROM public.sync_reprocess_log WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('oben','operational','orders','complete', now() - interval '3 hours'),
  ('oben','operational','orders','running',  now() - interval '150 minutes');"
eq "A10 running iniciada há 2h30 sobre sucesso ainda no SLA ⇒ broken (órfã; máx real 2,6 min)" "$(st)" "broken"

semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('oben','operational','orders','running', now() - interval '10 minutes');"
eq "A11 running há 10min sobre sucesso fresco ⇒ ok (run em voo não é órfã)" "$(st)" "ok"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET created_at = now() - interval '9 hours'
          WHERE reprocess_type='operational' AND entity_type='inventory';"
eq "A12 sem complete há 9h num SLA de 4h ⇒ stale" "$(st)" "stale"

semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='enigma'
          WHERE reprocess_type='strategic' AND entity_type='products';"
eq "A13 status FORA dos 3 dialetos ⇒ unknown, NUNCA ok" "$(st)" "unknown"

semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('nova_conta','operational','orders','complete', now());"
eq "A14 chave ATIVA fora do catálogo ⇒ unknown (cobertura desconhecida não é saudável)" "$(st)" "unknown"

# ⚠️ REPRODUÇÃO do achado E.1 do Codex (challenge retroativo 2026-09-20): um `running` posterior
# NÃO pode liquidar um erro terminal. Sucesso 10h → erro 12h → retry grava `running` 12h29: a última
# linha deixa de ser erro, o running é recente e o sucesso das 10h ainda cabe no SLA de 4h ⇒ o check
# diria `ok` e o watchdog faria DISMISS AUTOMÁTICO, antes de o retry sequer completar.
semear_saudavel
P -q -c "DELETE FROM public.sync_reprocess_log WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at) VALUES
  ('oben','operational','orders','complete', NULL,             now() - interval '150 minutes'),
  ('oben','operational','orders','error',    'RPC falhou',     now() - interval '31 minutes'),
  ('oben','operational','orders','running',  NULL,             now() - interval '1 minute');"
eq "A15 erro terminal seguido de retry em voo NÃO pode virar ok (E.1)" "$(st)" "broken"

echo "── precisão: degradação ≠ quebra ──"
semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET error_message='2 pedidos falharam na reconciliação'
          WHERE reprocess_type='operational' AND entity_type='orders';"
eq "A16 complete COM error_message ⇒ continua ok (o estágio andou)" "$(st)" "ok"
eq "A17 …mas a degradação aparece na message" \
   "$(Pq -c "SELECT (message LIKE '%falha por pedido%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "true"

# O contador de degradação tem de contar só as chaves VIGIADAS. Medido em prod 2026-09-20:
# `oben/manual/orders` tem um `complete` COM error_message de 94 dias atrás — chave DISPENSADA — e
# ele inflava a message ("falha por pedido registrada em 1 estagio(s)") sobre um fóssil que ninguém
# vigia. Status seguia `ok`, então não havia alarme falso; o dano era na message, que é o que o
# founder lê — e é exatamente o ruído que o catálogo existe para não deixar entrar.
semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at)
         VALUES ('oben','manual','orders','complete','1 pedido com SKU repetido', now() - interval '94 days');"
eq "A18 fóssil DISPENSADO com error_message não conta como degradação" \
   "$(Pq -c "SELECT (message LIKE '%falha por pedido%')::text FROM public._data_health_compute() WHERE source='sync_reprocess_saude';")" "false"

echo "── o catálogo não deixa fóssil nem escritor alheio poluir ──"
semear_saudavel
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at)
         VALUES ('colacor','manual','products','error', now() - interval '200 days');"
eq "A19 manual em error desde fevereiro NÃO derruba o check (dispensado)" "$(st)" "ok"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, created_at) VALUES
  ('OBEN','ciclo_diario','pedidos_compra_sugeridos','ok', now()),
  ('OBEN','disparo_diario','pedidos_compra_disparo','partial', now());"
eq "A20 grupo OBEN (dialeto ok/partial, vigiado por efeito) não vira 'não catalogada'" "$(st)" "ok"

echo "── message estável (senão re-emaila a cada 30 min) ──"
# ⚠️ QUEM ANDA É O RELÓGIO, NÃO O DADO. Até 2026-09-26 este assert simulava "o mesmo problema ficou 3h
# mais velho" deslocando o DADO (UPDATE created_at - 3h). Isso só equivale a avançar o relógio para o
# que é função de (now() - t) — e a message é, por CONTRATO, função do INSTANTE do último sucesso (a
# data congelada DD/MM em America/Sao_Paulo). O UPDATE movia esse instante: com a semeadura entre 00:30
# e 03:30 BRT (03:30Z–06:30Z) o deslocamento cruzava a meia-noite local e a data mudava, com razão. A
# prova reprovava sozinha nessa janela e travava o auto-merge de todo PR (#2573, #2576) sem defeito
# nenhum no sensor. Diário: docs/historico/deslocar-o-dado-nao-e-avancar-o-relogio.md
#
# Agora o dado fica PARADO e o relógio anda. `public.now()` lê a GUC `test.agora`, e o compute — corpo
# REAL da migration, intocado — ganha `pg_catalog` DEPOIS de `public` no search_path: é a única forma
# de um nome de usuário vencer um embutido (sem pg_catalog explícito ele é buscado PRIMEIRO, e por isso
# nada mais no banco enxerga esta função). O cenário é ADVERSARIAL e FIXO, independente da hora do CI:
# semeado às 23:00 BRT e relido às 02:00 BRT do dia seguinte — o relógio cruza a meia-noite local com o
# mesmo problema aberto, que é exatamente onde uma data tirada do relógio se trairia.
cfg_compute="$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")"
# O search_path que a CADEIA deixou — não um literal: a próxima reescrita pode mudá-lo, e o literal
# faria o desligamento abaixo acusar "relógio não desligado" sem defeito nenhum. pg_catalog entra logo
# DEPOIS de public, o lugar em que public.now() vence o embutido.
sp_compute="$(Pq -c "SELECT substring(c FROM '^search_path=(.*)\$') FROM pg_proc p, unnest(p.proconfig) c WHERE p.oid = 'public._data_health_compute()'::regprocedure AND c LIKE 'search_path=%';")"
sp_relogio="$(printf '%s' "$sp_compute" | sed -E 's/(^|, )public(,|$)/\1public, pg_catalog\2/')"
[ -n "$sp_compute" ] && [ "$sp_relogio" != "$sp_compute" ] \
  || { echo "❌ relógio controlado: o compute não tem public no search_path [$sp_compute] — public.now() não teria onde vencer o embutido"; exit 1; }
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.agora', true), '')::timestamptz, pg_catalog.now())
$f$;
SQL
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_relogio;"
T0='2026-09-15 23:00:00-03'   # 23:00 BRT
T1='2026-09-16 02:00:00-03'   # +3h, do OUTRO lado da meia-noite local

# O par certo: um `complete` antigo (a data que congela) + um `error` por cima, e depois SÓ o relógio
# anda. Às 02:00 as outras chaves seguem dentro do SLA (a mais apertada, 4h, completou às 22:30): o
# conjunto de problemas não muda, então nada autoriza a message a mudar.
semear_saudavel "'$T0'::timestamptz"
P -q -c "INSERT INTO public.sync_reprocess_log (account, reprocess_type, entity_type, status, error_message, created_at)
         VALUES ('oben','operational','orders','error','pedido incoerente', '$T0'::timestamptz - interval '10 minutes');"
M1="$(msg_em "$T0")"; I1="$(idade_em "$T0")"
# O relógio REAL também anda >1s entre as leituras: o controlado só intercepta now(), e uma hora
# corrida tirada de clock_timestamp()/CURRENT_TIMESTAMP escaparia dele (sabotagem message_com_hora_de_parede).
P -q -c "SELECT pg_sleep(1.1);" >/dev/null
M2="$(msg_em "$T1")"; I2="$(idade_em "$T1")"
# Controle POSITIVO: um relógio que não interceptasse nada deixaria M1=M2 por construção, e o assert
# de estabilidade passaria por CEGUEIRA. A idade que o compute enxerga TEM de andar as 3h.
eq "A21 o compute lê o relógio controlado: idade de 30 min às 23:00" "$I1" "1800"
eq "A22 …e de 3h30 às 02:00 do dia seguinte (o relógio andou 3h, o dado ficou parado)" "$I2" "12600"
if [ "$M1" = "$M2" ] && [ -n "$M1" ]; then ok "A23 message idêntica com o relógio 3h adiante, cruzando a meia-noite local (data congelada)"; else
  bad "A23 message VARIOU só porque o tempo passou — o fingerprint source|status|severity|message re-emailaria
       antes: [$M1]
       depois: [$M2]"; fi

# O PAR do assert acima, e ele é obrigatório: "message estável" sozinho é satisfeito por uma
# message CONSTANTE, que não avisaria nada. A propriedade real tem dois lados — congela enquanto o
# problema é o mesmo, MUDA quando o conjunto de problemas muda (aí re-emitir é o certo, não spam).
P -q -c "UPDATE public.sync_reprocess_log SET status='error'
          WHERE reprocess_type='strategic' AND entity_type='products';"
M3="$(msg_em "$T1")"
if [ "$M3" != "$M2" ] && [ -n "$M3" ]; then ok "A24 message MUDA quando um 2º estágio quebra (re-emite, como deve)"; else
  bad "A24 message NÃO mudou com um 2º estágio quebrado — uma message constante passaria o teste de
       estabilidade sem avisar nada: [$M3]"; fi

# Dois problemas simultâneos: o resumo tem de ser DETERMINÍSTICO (o string_agg é ordenado por
# reprocess_type, entity_type, account). Sem ordem explícita a message oscilaria entre formas e o
# fingerprint re-emailaria sozinho — a lição do #1980, aqui no eixo do agregado.
M4="$(msg_em "$T1")"
eq "A25 resumo com 2 problemas é estável entre leituras (string_agg ordenado)" "$M4" "$M3"

# Desliga o relógio controlado: o resto da prova (watchdog/heartbeat) roda no compute EXATAMENTE como a
# migration o deixou — conferido, não suposto.
P -q -c "ALTER FUNCTION public._data_health_compute() SET search_path = $sp_compute;"
P -q -c "DROP FUNCTION public.now();"
[ "$(Pq -c "SELECT array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;")" = "$cfg_compute" ] \
  || { echo "❌ o relógio controlado NÃO foi desligado: o search_path do compute diverge do da migration [$cfg_compute]"; exit 1; }

echo "── as outras 2 pernas do trio EXECUTAM (late-bound: CREATE não prova nada) ──"
semear_saudavel
P -q -c "UPDATE public.sync_reprocess_log SET status='error' WHERE reprocess_type='operational' AND entity_type='orders';"
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
# 23 = tamanho do v_sources na versão viva (a 0918 levou a 22; a 20261001011500, a 23). O compute
# produz 31 sources; o watchdog avalia os do array e ignora o resto — por isso os dois números são
# diferentes DE PROPÓSITO.
eq "A26 watchdog avalia 23 checks (o v_sources, não os 31 do compute)" \
   "$(Pq -c "SELECT checks_avaliados::text FROM public.data_health_watchdog_estado WHERE id;")" "23"
# ⚠️ checks_falhos conta EXCECAO DE EXECUCAO do check, nunca status de negocio: o laco so o
# incrementa no EXCEPTION. Com o check novo em `broken`, o certo e ZERO — ele avaliou bem, o
# resultado e que e ruim. Foi por isso que o estado de 14/09 (checks_avaliados=21, checks_falhos=0)
# nao provava saude nenhuma durante os 10 dias do incidente: provava so que nada explodiu.
eq "A27 checks_falhos=0 mesmo com o check novo em broken (conta exceção, não negócio)" \
   "$(Pq -c "SELECT checks_falhos::text FROM public.data_health_watchdog_estado WHERE id;")" "0"
eq "A28 watchdog ROTEOU o source novo para o push (_data_health_episodio)" \
   "$(Pq -c "SELECT (count(*) > 0)::text FROM public._spy_episodio WHERE tipo='data_health_sync_reprocess_saude';")" "true"
P -q -c "SELECT public.fin_sync_heartbeat();" >/dev/null
ok "A29 fin_sync_heartbeat executa com o source novo na IN-list"

echo "── o source está nas DUAS pontas (senão o check existe e nunca é avaliado) ──"
eq "A30 sync_reprocess_saude no v_sources do watchdog" \
   "$(Pq -c "SELECT (pg_get_functiondef(p.oid) LIKE '%''sync_reprocess_saude''%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='data_health_watchdog';")" "true"
eq "A31 sync_reprocess_saude na IN-list do heartbeat" \
   "$(Pq -c "SELECT (pg_get_functiondef(p.oid) LIKE '%''sync_reprocess_saude''%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fin_sync_heartbeat';")" "true"

echo "── o compute SECURITY DEFINER segue FECHADO no fim da cadeia (o ACL não está no md5) ──"
# Medido em prod (psql-ro, 2026-09-30): anon/authenticated/PUBLIC sem EXECUTE, service_role com. O
# setup reproduz esse ACL ANTES da cadeia, e só a postcondição da 0918 o confere: uma reescrita
# posterior por DROP+CREATE o reseta (EXECUTE volta a PUBLIC) sem mudar uma letra do md5 que esta
# prova imprime — md5 igual não é função igual. Por isso o ACL é conferido aqui, na versão viva.
eq "A32 compute fechado a anon, authenticated e PUBLIC (só service_role executa)" \
   "$(Pq -c "SELECT 'anon=' || has_function_privilege('anon', 'public._data_health_compute()', 'EXECUTE')
              || ' authenticated=' || has_function_privilege('authenticated', 'public._data_health_compute()', 'EXECUTE')
              || ' public=' || has_function_privilege('public', 'public._data_health_compute()', 'EXECUTE')
              || ' service_role=' || has_function_privilege('service_role', 'public._data_health_compute()', 'EXECUTE');")" \
   "anon=false authenticated=false public=false service_role=true"

echo
# Recibo no formato do runner (db/roda-nucleo-ci.sh): sem uma linha de contagem que ele saiba ler,
# uma prova trocada por `exit 0` passaria — o fechamento `[ "$FAIL" -eq 0 ]` também aceita PASS=0.
echo "PASS=${PASS}  FAIL=${FAIL}"
echo "═══ ${PASS} passaram · ${FAIL} falharam ═══"
[ "$FAIL" -eq 0 ] || exit 1
