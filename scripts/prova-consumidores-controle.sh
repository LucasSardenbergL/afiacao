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
read -ra TEST_CMD <<< "${MUTCHECK_TEST_CMD:-bunx vitest run}"

rodar() {  # $1 = filtro -t; ecoa nada, devolve o rc do vitest
  "${TEST_CMD[@]}" "$TESTE" -t "$1" > /tmp/prova-consumidores.$$.log 2>&1
}

# Guard: `-t` que nao casa teste nenhum faz o vitest sair 0 por VAZIO -- verde por ausencia, que e'
# exatamente a falha que este script existe para nao cometer. Exigimos "N passed" com N>=1.
casou_algum() { grep -qE 'Tests +[1-9][0-9]* passed' /tmp/prova-consumidores.$$.log; }

falhas=0

# ── CONTROLE: sem mutacao, os dois filtros tem de ficar VERDES e casar >=1 teste ──
for par in "SONDA:$FILTRO_SONDA" "CANARIA:$FILTRO_CANARIA"; do
  modo="${par%%:*}"; filtro="${par#*:}"
  if rodar "$filtro" && casou_algum; then
    printf 'CONTROLE  %-8s verde e casou teste ✓\n' "$modo"
  else
    printf 'CONTROLE  %-8s NAO ficou verde ou o filtro nao casou teste algum ✗\n' "$modo"
    printf '          (filtro: %s)\n' "$filtro"
    # DESPEJA O LOG. Sem isto a mensagem acima e' um veredito sem CAUSA: ela nao distingue
    # "o filtro nao casou teste" de "o vitest morreu na carga" -- desfechos com conserto oposto.
    # Medido em 2026-09-09 (PR #2413): o passo reprovou no CI em ~1,45s por execucao, tempo de
    # falha de INICIALIZACAO e nao de rodar 164 testes, e o log ficava em /tmp, que o runner
    # descarta. Reproduzir localmente a sequencia exata do CI (mutcheck -> prova) dava VERDE, e
    # sem a saida do vitest nao havia por onde continuar. Ausencia de evidencia parava a
    # investigacao; agora a causa viaja junto do veredito.
    printf '          ── saida do vitest (ultimas 40 linhas) ──\n'
    tail -40 "/tmp/prova-consumidores.$$.log" | sed 's/^/          | /'
    falhas=$((falhas+1))
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

rm -f /tmp/prova-consumidores.$$.log
echo "PROVA_CONSUMIDORES_FIM mortos=$mortos de 2"
[ "$mortos" -eq 2 ]
