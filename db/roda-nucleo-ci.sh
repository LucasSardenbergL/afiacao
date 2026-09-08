#!/usr/bin/env bash
# roda-nucleo-ci.sh — executa o núcleo de provas SQL de `db/nucleo-ci.txt`.
# =====================================================================================
#   bash db/roda-nucleo-ci.sh                 # roda o núcleo
#   bash db/roda-nucleo-ci.sh --lista         # só imprime o que rodaria
#   PGH_MIN_VERSION_NUM=170006 bash db/...    # piso da versão do servidor
#
# ## O que este runner existe para impedir
#
# Um gate que executa SQL falha de um jeito específico: fica VERDE sem ter provado
# nada. As formas medidas/apontadas (parecer Codex, 2026-09-07):
#
#   · lista vazia ou glob sem correspondência — `set -euo pipefail` NÃO reprova um
#     laço que rodou zero vezes;
#   · PostgreSQL ausente virando skip silencioso — a assinatura de `ausente ≠ zero`
#     aplicada ao CI: banco que não existe aprovaria TUDO;
#   · prova esvaziada. O fechamento das provas é `[ "$FAIL" -eq 0 ]`, que **também
#     aceita PASS=0** — um script truncado sai 0. Por isso cada linha do manifesto
#     carrega o mínimo de asserts que aquela prova precisa ter EXECUTADO;
#   · filho paralelo que falha com o pai aprovando. Medido pelo Codex no bash:
#     `(exit 7) & wait` devolve **0**. Aqui o padrão é SERIAL, e o status de cada
#     prova é conferido na hora — sem `&` e sem `wait` sem argumento.
#
# Toda conferência é POSITIVA: nada é aprovado por ausência de sinal.
#
# ## Isolamento
#
# Cada prova sobe o seu próprio cluster (`initdb` + `pg_ctl`) — este runner só lhe
# entrega uma porta distinta via `PGPORT_TEST` e a executa. Serial é uma decisão:
# 70 das 289 provas trazem porta fixa sem override, e o isolamento por porta é
# frágil por desenho. Paralelizar exige antes migrar as provas para socket em
# diretório exclusivo por execução com `listen_addresses=''` — aí a porta deixa de
# ser recurso disputado. Enquanto isso não existe, o núcleo custa ~15s: serial paga.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFESTO="${MANIFESTO:-$REPO_ROOT/db/nucleo-ci.txt}"
PORTA_BASE="${PORTA_BASE:-5810}"
# Piso da versão do servidor. 170006 = 17.6, que é o que PRODUÇÃO roda (medido via
# psql-ro em 2026-09-07). Testar contra um servidor MAIS VELHO que prod provaria
# algo sobre um Postgres que ninguém usa.
PGH_MIN_VERSION_NUM="${PGH_MIN_VERSION_NUM:-170006}"

so_lista=0
[ "${1:-}" = "--lista" ] && so_lista=1

# ── 1. Manifesto ────────────────────────────────────────────────────────────────
[ -f "$MANIFESTO" ] || { echo "::error::manifesto ausente: $MANIFESTO"; exit 1; }

scripts=(); minimos=()
linha_n=0
while IFS= read -r linha || [ -n "$linha" ]; do
  linha_n=$((linha_n + 1))
  linha="${linha%%#*}"                              # tira comentário de fim de linha
  linha="$(printf '%s' "$linha" | tr -d '\r')"
  # shellcheck disable=SC2001  # a substituição precisa de classe POSIX nas duas pontas
  linha="$(printf '%s' "$linha" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$linha" ] && continue

  caminho="$(printf '%s' "$linha" | awk '{print $1}')"
  minimo="$(printf '%s' "$linha" | awk '{print $2}')"

  if ! printf '%s' "$minimo" | grep -qE '^[0-9]+$'; then
    echo "::error::$MANIFESTO:$linha_n — falta o mínimo de asserts (formato: <caminho> <n>): $linha"; exit 1
  fi
  if [ "$minimo" -lt 1 ]; then
    echo "::error::$MANIFESTO:$linha_n — mínimo de asserts precisa ser ≥1 (0 aprovaria uma prova vazia)"; exit 1
  fi
  if [ ! -f "$REPO_ROOT/$caminho" ]; then
    echo "::error::$MANIFESTO:$linha_n — arquivo não existe: $caminho (arquivo ausente ABORTA, nunca é filtrado)"; exit 1
  fi
  for ja in ${scripts[@]+"${scripts[@]}"}; do
    [ "$ja" = "$caminho" ] && { echo "::error::$MANIFESTO:$linha_n — duplicata: $caminho"; exit 1; }
  done
  scripts+=("$caminho"); minimos+=("$minimo")
done < "$MANIFESTO"

esperados=${#scripts[@]}
# Guard do DENOMINADOR — sem ele um manifesto vazio (ou um parser quebrado) sairia
# 0 sem executar nada, e o gate aprovaria por AUSÊNCIA de dado.
if [ "$esperados" -lt 1 ]; then
  echo "::error::manifesto sem nenhuma prova — um gate que não executa nada não pode afirmar nada"; exit 1
fi

if [ "$so_lista" -eq 1 ]; then
  printf '%s\n' "manifesto=$MANIFESTO provas=$esperados"
  for i in "${!scripts[@]}"; do printf '  %s  (asserts≥%s)\n' "${scripts[$i]}" "${minimos[$i]}"; done
  exit 0
fi

# ── 2. Sonda POSITIVA do ambiente ───────────────────────────────────────────────
# Antes de rodar prova nenhuma: sobe um cluster de mentira e PERGUNTA a versão ao
# servidor. Sem isto, "PG ausente" e "todas as provas passaram" produzem o mesmo
# verde. `initdb --version` não bastaria: prova o binário, não que ele SOBE.
echo "=== sonda do ambiente ==="
# LC_ALL=C não é detalhe: sem locale válido o postmaster do macOS morre no start com
# "became multithreaded during startup". Toda prova do acervo já exporta isto; a sonda
# precisa do mesmo ambiente, ou reprova por motivo que não é o do teste.
export LC_ALL=C LANG=C
# Sobrescrevível para exercitar o fail-closed do helper com uma major que não existe
# (é assim que db/falsifica-nucleo-ci.sh prova que "Postgres ausente" REPROVA).
export PGVER="${PGVER:-17}"   # lido pelo pg-harness.sh abaixo (via source), não por um filho
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

SONDA_DIR="$(mktemp -d "/tmp/pgsonda-nucleo.XXXXXX")"
sonda_cleanup() {
  "$PGBIN/pg_ctl" -D "$SONDA_DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$SONDA_DIR"
}
trap sonda_cleanup EXIT

"$PGBIN/initdb" -D "$SONDA_DIR/data" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$SONDA_DIR/data" -o "-p $PORTA_BASE -k $SONDA_DIR" \
  -l "$SONDA_DIR/pg.log" -w start >/dev/null
versao_num="$("$PGBIN/psql" -X -p "$PORTA_BASE" -h "$SONDA_DIR" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -tA -c 'SHOW server_version_num')"
versao_txt="$("$PGBIN/psql" -X -p "$PORTA_BASE" -h "$SONDA_DIR" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -tA -c 'SHOW server_version')"
sonda_cleanup; trap - EXIT

if ! printf '%s' "$versao_num" | grep -qE '^[0-9]+$'; then
  echo "::error::sonda não obteve server_version_num do servidor (veio: '$versao_num')"; exit 1
fi
if [ "$versao_num" -lt "$PGH_MIN_VERSION_NUM" ]; then
  echo "::error::servidor $versao_txt ($versao_num) é mais VELHO que o piso $PGH_MIN_VERSION_NUM (produção)"; exit 1
fi
echo "  servidor SUBIU e respondeu: $versao_txt (server_version_num=$versao_num, piso=$PGH_MIN_VERSION_NUM)"
echo "  PGBIN=$PGBIN"

# ── 3. Execução ─────────────────────────────────────────────────────────────────
LOGS="$(mktemp -d "/tmp/pgnucleo-logs.XXXXXX")"
concluidas=(); falhas=()
porta=$((PORTA_BASE + 1))

echo
echo "=== núcleo: $esperados prova(s), serial ==="
for i in "${!scripts[@]}"; do
  caminho="${scripts[$i]}"; minimo="${minimos[$i]}"
  nome="$(basename "$caminho" .sh)"
  log="$LOGS/$nome.log"
  porta=$((porta + 1))

  inicio=$(date +%s)
  # rc capturado ANTES de qualquer recorte da saída: `| tail` devolveria o status
  # do tail e o veredito do trabalho se perderia.
  PGPORT_TEST="$porta" bash "$REPO_ROOT/$caminho" > "$log" 2>&1 && rc=0 || rc=$?
  dur=$(( $(date +%s) - inicio ))

  if [ "$rc" -ne 0 ]; then
    falhas+=("$nome: exit $rc")
    printf '  ❌ %-44s exit=%s (%ss)\n' "$nome" "$rc" "$dur"
    echo "     ── últimas linhas ──"
    tail -12 "$log" | sed 's/^/     /'
    continue
  fi

  # Contagem de asserts. Três formatos vivem no acervo, todos com <pass> antes de
  # <fail>:  `PASS=27  FAIL=0` · `RESULTADO: 25 ok / 0 fail` · `19 OK / 0 FAIL`.
  # Não extrair é ERRO, nunca "assume que passou": é justamente o caso da prova
  # substituída por um `exit 0`.
  contagem="$(grep -ohE 'PASS=[0-9]+[[:space:]]+FAIL=[0-9]+|RESULTADO:[[:space:]]*[0-9]+[[:space:]]*[oO][kK][[:space:]]*[/,][[:space:]]*[0-9]+[[:space:]]*[fF][aA][iI][lL]|[0-9]+[[:space:]]*[oO][kK][[:space:]]*[/,][[:space:]]*[0-9]+[[:space:]]*[fF][aA][iI][lL]' "$log" | tail -1 || true)"
  if [ -z "$contagem" ]; then
    falhas+=("$nome: exit 0 mas SEM linha de contagem de asserts no log")
    printf '  ❌ %-44s exit=0 sem contagem — não dá para afirmar que asseriu algo\n' "$nome"
    continue
  fi
  n_pass="$(printf '%s' "$contagem" | grep -oE '[0-9]+' | sed -n 1p)"
  n_fail="$(printf '%s' "$contagem" | grep -oE '[0-9]+' | sed -n 2p)"

  if [ "${n_fail:-1}" -ne 0 ]; then
    falhas+=("$nome: $n_fail assert(s) vermelhos com exit 0"); printf '  ❌ %-44s FAIL=%s\n' "$nome" "$n_fail"; continue
  fi
  if [ "${n_pass:-0}" -lt "$minimo" ]; then
    falhas+=("$nome: executou $n_pass asserts, o manifesto exige ≥$minimo")
    printf '  ❌ %-44s asserts=%s < mínimo %s (prova encolheu)\n' "$nome" "$n_pass" "$minimo"
    continue
  fi

  concluidas+=("$caminho")
  printf '  ✅ %-44s asserts=%-4s (≥%s) %ss\n' "$nome" "$n_pass" "$minimo" "$dur"
done

# ── 4. Recibo — CONJUNTO, não contagem ──────────────────────────────────────────
# "Cinco de cinco" não prova que foram ESTAS cinco: uma prova rodada duas vezes e
# outra pulada dariam o mesmo total. A conferência é sobre as identidades.
echo
faltando=()
for esperado in "${scripts[@]}"; do
  achou=0
  for feito in ${concluidas[@]+"${concluidas[@]}"}; do [ "$feito" = "$esperado" ] && achou=1 && break; done
  [ "$achou" -eq 0 ] && faltando+=("$esperado")
done

if [ ${#falhas[@]} -ne 0 ] || [ ${#faltando[@]} -ne 0 ]; then
  echo "=================================================="
  for f in ${falhas[@]+"${falhas[@]}"};     do echo "  ❌ $f"; done
  for f in ${faltando[@]+"${faltando[@]}"}; do echo "  ❌ sem recibo de conclusão: $f"; done
  echo "PROVAS-SQL REPROVADO — logs em $LOGS"
  exit 1
fi

echo "=================================================="
echo "SQL_PROOF_OK provas=${#concluidas[@]}/$esperados server_version_num=$versao_num pgbin=$PGBIN"
rm -rf "$LOGS"
