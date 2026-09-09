#!/usr/bin/env bash
# Prova que o mutante do CTE COMPARTILHADO `controle_credencial` e' morto por CADA consumidor
# ISOLADAMENTE -- a sonda e a canaria -- e nao so pela suite agregada.
#
# POR QUE ELE EXISTE. O `mutcheck.sh` roda a suite INTEIRA e reporta PEGA/SOBREVIVE. Depois que a
# mecanica do controle virou UMA funcao (`cteControleCredencial`), "PEGA" passou a significar
# apenas "algum teste morreu" -- uma metade bem testada pode esconder a outra descoberta. Essa e a
# ressalva do parecer Codex de 2026-09-08 sobre consolidar duas mutacoes gemeas numa so, e este
# script e' a resposta a ela: roda a MESMA mutacao contra cada modo separado e exige vermelho nos
# DOIS. Sem isto, a consolidacao no `.mut` seria uma afirmacao sem evidencia.
#
# Exit: 0 = os dois modos mataram o mutante · 1 = algum sobreviveu, ou o controle nao ficou verde.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SRC=scripts/sonda-versao-sql.ts
TESTE=scripts/sonda-versao-sql.test.ts
# A mutacao consolidada, LITERALMENTE a mesma linha do .mut (se divergirem, a prova nao prova nada).
MUTACAO='s/AND NOT EXISTS \(SELECT 1 FROM ids id_leva WHERE id_leva\.request_id = r\.id\)/AND true/'
# Um filtro por modo. Sao os testes que exercitam o CTE em cada gerador, e so eles.
FILTRO_SONDA='sonda: conta 2xx e 401 na janela de 6h'
FILTRO_CANARIA='canária: conta 2xx e 401 na janela de 6h'

restaurar() { git checkout -- "$SRC"; }
# DOIS traps, pela licao do #2410: `trap ... INT TERM` roda o handler e a execucao SEGUE da
# instrucao seguinte -- um SIGTERM antes da mutacao deixaria o fonte mutado no disco. Aqui INT/TERM
# so pedem `exit`; quem restaura e' o trap EXIT, uma vez so, em qualquer caminho de saida.
trap 'exit 1' INT TERM
trap restaurar EXIT

# Runner configuravel, mesmo contrato do `mutcheck.sh`: default SEM `heavy`, porque o semaforo de
# RAM e' da M2 local e nao existe no runner do CI (exit 127). Localmente, prefixe a chamada:
#   MUTCHECK_TEST_CMD='heavy bunx vitest run' bash scripts/prova-consumidores-controle.sh
# O runner tem de ser vitest-compativel: alem do `-t`, recebe as flags de reporter abaixo.
read -ra TEST_CMD <<< "${MUTCHECK_TEST_CMD:-bunx vitest run}"

LOG=/tmp/prova-consumidores.$$.log
# O veredito de MAQUINA do vitest, e a razao de ele existir. Ate 2026-09-09 o guard abaixo lia a
# saida HUMANA (`grep -qE 'Tests +[1-9][0-9]* passed'`) e ficava CEGO no CI: no GitHub Actions o
# vitest COLORE, e a linha que chega ao log e'
#   ESC[2m      Tests ESC[22m ESC[1mESC[32m8653 passedESC[39m...
# -- entre `Tests` e o numero ha escapes ANSI, que o `+` (so espacos) nunca casa. O vitest ficava
# VERDE e quem mentia era o guard: verde na M2, vermelho em todo run do runner, deterministico dos
# dois lados. Ler o reporter JSON tira a APRESENTACAO da decisao -- cor, locale e o layout do
# reporter humano deixam de ter voto.
VEREDITO=/tmp/prova-consumidores.$$.json

rodar() {  # $1 = filtro -t; ecoa nada, devolve o rc do vitest
  rm -f "$VEREDITO"
  "${TEST_CMD[@]}" "$TESTE" -t "$1" \
    --reporter=default --reporter=json --outputFile.json="$VEREDITO" > "$LOG" 2>&1
}

# Guard: `-t` que nao casa teste nenhum faz o vitest sair 0 por VAZIO -- verde por ausencia, que e'
# exatamente a falha que este script existe para nao cometer. Exigimos >=1 teste PASSADO, contado
# pelo proprio vitest. Sem JSON legivel NAO ha veredito: devolve 1 (fail-CLOSED, ausente != zero).
casou_algum() {
  local j="${1:-$VEREDITO}"
  [ -s "$j" ] || return 1
  PROVA_VEREDITO="$j" bun -e 'const o=JSON.parse(require("fs").readFileSync(process.env.PROVA_VEREDITO,"utf8"));process.exit(Number(o.numPassedTests)>=1?0:1)' 2>/dev/null
}

# ── selftest (~0,1s, sem vitest): o guard decide pelo DADO, nunca pela APRESENTACAO ──
# Trava a regressao de 2026-09-09, em que este guard lia a saida COLORIDA do vitest e reprovava
# TODO run do CI com o vitest verde. A assercao e' a que teria pegado aquilo: com o MESMO veredito
# de maquina, um log limpo e um log cheio de ANSI tem de dar o MESMO resultado -- se alguem voltar
# a ler o log para decidir, os dois divergem e isto fica vermelho. Os dois casos negativos
# (contagem zero e veredito ausente) sao o controle de discriminacao: provam que ele sabe reprovar.
# `trap - EXIT` porque o selftest nao muta fonte nenhum e `restaurar` apagaria trabalho local.
if [ "${1:-}" = "--selftest" ]; then
  trap - EXIT
  tmp=$(mktemp -d) || exit 1
  esc=$(printf '\033')
  printf '      Tests  2 passed | 162 skipped (164)\n' > "$tmp/limpo.log"
  printf '%s[2m      Tests %s[22m %s[1m%s[32m2 passed%s[39m (164)\n' "$esc" "$esc" "$esc" "$esc" "$esc" \
    > "$tmp/colorido.log"
  printf '{"success":true,"numTotalTests":164,"numPassedTests":2,"numFailedTests":0}\n' > "$tmp/casou.json"
  printf '{"success":true,"numTotalTests":164,"numPassedTests":0,"numFailedTests":0}\n' > "$tmp/vazio.json"
  st_falhas=0
  checar() {  # $1 rotulo · $2 rc esperado (0=casou, 1=nao) · $3 veredito json · $4 log do vitest
    LOG="$4"
    casou_algum "$3"; rc=$?
    if [ "$rc" -eq "$2" ]; then
      printf 'SELFTEST  %-48s ✓\n' "$1"
    else
      printf 'SELFTEST  %-48s ✗ (esperava rc=%s, veio %s)\n' "$1" "$2" "$rc"
      st_falhas=$((st_falhas+1))
    fi
  }
  checar 'contagem >=1 · log LIMPO -> casou'            0 "$tmp/casou.json"     "$tmp/limpo.log"
  checar 'contagem >=1 · log COLORIDO -> casou IGUAL'   0 "$tmp/casou.json"     "$tmp/colorido.log"
  checar 'contagem 0 -> NAO casou'                      1 "$tmp/vazio.json"     "$tmp/limpo.log"
  checar 'veredito AUSENTE -> NAO casou (fail-closed)'  1 "$tmp/nao-existe.json" "$tmp/limpo.log"
  rm -rf "$tmp"
  if [ "$st_falhas" -ne 0 ]; then
    echo "PROVA_CONSUMIDORES_SELFTEST_FIM $st_falhas falha(s) — o guard voltou a depender da apresentacao"
    exit 1
  fi
  echo "PROVA_CONSUMIDORES_SELFTEST_FIM ok (4/4)"
  exit 0
fi

# A arvore tem de estar LIMPA nos dois arquivos que este script mede. Nao e' preciosismo: em
# 2026-09-09 este step rodava logo depois do `bun run mutcheck` (que muta e restaura o fonte) e o
# CONTROLE saiu vermelho nos DOIS modos, com a mensagem dizendo apenas "nao ficou verde OU o filtro
# nao casou" -- duas causas opostas no mesmo ramo, e nenhuma saida do vitest para separa-las.
# Aqui a sujeira e' NOMEADA antes de qualquer medicao; restaurar em silencio apagaria trabalho
# local de quem roda isto na maquina.
sujos=$(git status --porcelain -- "$SRC" "$TESTE" 2>/dev/null)
if [ -n "$sujos" ]; then
  echo "PROVA_CONSUMIDORES_FIM abortada: arvore SUJA — o controle mediria outro codigo, nao o do repo"
  printf '%s\n' "$sujos" | sed 's/^/  /'
  exit 1
fi

falhas=0

# ── CONTROLE: sem mutacao, os dois filtros tem de ficar VERDES e casar >=1 teste ──
for par in "SONDA:$FILTRO_SONDA" "CANARIA:$FILTRO_CANARIA"; do
  modo="${par%%:*}"; filtro="${par#*:}"
  # As duas causas de reprovacao sao SEPARADAS: suite vermelha e filtro que nao casa exigem
  # consertos opostos, e junta-las num ramo so foi o que cegou o diagnostico no CI.
  if ! rodar "$filtro"; then
    printf 'CONTROLE  %-8s a suite ficou VERMELHA com este filtro ✗\n' "$modo"
    printf '          (filtro: %s) — ultimas linhas do vitest:\n' "$filtro"
    tail -25 "$LOG" | sed 's/^/          /'
    falhas=$((falhas+1))
  elif [ ! -s "$VEREDITO" ]; then
    # Terceira causa, e a mais perigosa de calar: o runner saiu 0 mas NAO deixou veredito. Sem dado
    # nao ha aprovacao -- este ramo existe para nunca virar "casou" por omissao.
    printf 'CONTROLE  %-8s NAO CONSEGUI MEDIR: o runner saiu 0 sem emitir o JSON ✗\n' "$modo"
    printf '          (filtro: %s) — ultimas linhas do vitest:\n' "$filtro"
    tail -25 "$LOG" | sed 's/^/          /'
    falhas=$((falhas+1))
  elif ! casou_algum; then
    printf 'CONTROLE  %-8s o filtro NAO CASOU teste algum (vitest saiu 0 por VAZIO) ✗\n' "$modo"
    printf '          (filtro: %s) — ultimas linhas do vitest:\n' "$filtro"
    tail -25 "$LOG" | sed 's/^/          /'
    falhas=$((falhas+1))
  else
    printf 'CONTROLE  %-8s verde e casou teste ✓\n' "$modo"
  fi
done
if [ "$falhas" -ne 0 ]; then
  echo "PROVA_CONSUMIDORES_FIM abortada: controle nao verde (mutar suite ja vermelha nao prova nada)"
  exit 1
fi

# ── MUTANTE: cada modo, isolado, tem de ficar VERMELHO ──
perl -i -pe "$MUTACAO" "$SRC"
if git diff --quiet "$SRC"; then
  echo "PROVA_CONSUMIDORES_FIM abortada: a mutacao NAO CASOU o fonte (padrao stale ante o .mut)"
  exit 1
fi

mortos=0
for par in "SONDA:$FILTRO_SONDA" "CANARIA:$FILTRO_CANARIA"; do
  modo="${par%%:*}"; filtro="${par#*:}"
  if rodar "$filtro"; then
    printf 'MUTANTE   %-8s SOBREVIVEU ✗ (este modo nao cobre a exclusao da propria leva)\n' "$modo"
  else
    printf 'MUTANTE   %-8s morto ✓\n' "$modo"; mortos=$((mortos+1))
  fi
done

rm -f "$LOG" "$VEREDITO"
echo "PROVA_CONSUMIDORES_FIM mortos=$mortos de 2"
[ "$mortos" -eq 2 ]
