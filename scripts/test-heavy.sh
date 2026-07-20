#!/usr/bin/env bash
# test-heavy.sh — TDD do semáforo scripts/heavy.sh (concorrência de verdade).
#
# Por que com N processos: os três bugs que este teste cobre SÓ aparecem sob
# disputa. Um wrapper isolado passa em todos eles e não prova nada.
#
# Cobre (cada caso nasceu de um bug observado em 2026-07-18, ~24 sessões/40 worktrees):
#   1. matar o wrapper mata a ÁRVORE do filho (bun → node tsc ficava vivo comendo
#      a RAM cuja falta causou a espera — e o slot voltava pra fila, mentindo)
#   2. `--status` nunca mostra vaga negativa ("2 em uso, -1 livre(s)")
#   3. total menor que o em-uso não sobre-inscreve por índice esparso de slot
#   4. atendimento em ORDEM DE CHEGADA (era polling puro: 21min05 perdia p/ 2min00)
#   5. dono morto libera o slot (recuperação de órfão que já existia — não regrediu)
#   6. waiter morto não trava a fila atrás dele (risco NOVO que o FIFO introduz)
#   7. exit code do comando é preservado (mudou de `"$@"` para `"$@" & wait`)
#
# macOS/local, como o próprio heavy (usa sysctl/stat -f). Não roda no CI (ubuntu).
# Uso: bash scripts/test-heavy.sh   (exit 0 = tudo verde).  Leva ~50s.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HEAVY="${HEAVY:-$here/heavy.sh}"

# lockdir isolado: NUNCA tocar /tmp/afiacao-heavy-slots — há sessões reais nele.
LK="$(mktemp -d /tmp/heavy-test.XXXXXX)"
export AFIACAO_HEAVY_LOCKDIR="$LK"
# sufixo exclusivo desta execução: pkill jamais acerta processo de outra sessão.
TAG=".707$$"
ORD="$LK/ordem.txt"

# shellcheck disable=SC2329  # invocada indiretamente pelo trap EXIT
limpar() { pkill -9 -f "sleep [0-9.]*$TAG" 2>/dev/null; rm -rf "$LK"; }
trap limpar EXIT

fail=0
ok()   { echo "  ok    $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }
zerar(){ rm -rf "${LK:?}"/slot-* "${LK:?}"/fila 2>/dev/null; mkdir -p "$LK/fila"; }
n_slots(){ local s n=0; for s in "$LK"/slot-*; do [ -d "$s" ] && n=$((n+1)); done; echo "$n"; }

echo "test-heavy.sh — alvo: $HEAVY"
echo "lockdir isolado: $LK"

# ─────────────────────────────────────── 1. TERM no wrapper mata a árvore toda
zerar
AFIACAO_MAX_HEAVY=1 "$HEAVY" sleep "300$TAG" >/dev/null 2>&1 &
w=$!
sleep 2
kid=$(pgrep -P "$w" 2>/dev/null | head -1)
kill -TERM "$w" 2>/dev/null
sleep 3
if [ -n "${kid:-}" ] && kill -0 "$kid" 2>/dev/null; then
  bad "TERM no wrapper: filho $kid sobreviveu (órfão comendo RAM)"
  kill -9 "$kid" 2>/dev/null
else
  ok "TERM no wrapper mata a árvore do filho"
fi
if [ -n "$(ls -d "$LK"/slot-* 2>/dev/null)" ]; then
  bad "slot ficou pendurado após o wrapper morrer"
else
  ok "slot liberado no mesmo trap"
fi
wait "$w" 2>/dev/null

# ─────────────────────────────────── 2. --status nunca reporta vaga negativa
zerar
AFIACAO_MAX_HEAVY=2 "$HEAVY" sleep "30$TAG" >/dev/null 2>&1 & a=$!
sleep 1
AFIACAO_MAX_HEAVY=2 "$HEAVY" sleep "30$TAG" >/dev/null 2>&1 & b=$!
sleep 2
st=$(AFIACAO_MAX_HEAVY=1 "$HEAVY" --status 2>/dev/null | grep "em uso")
case "$st" in
  *-[0-9]*livre*) bad "--status negativo com o total encolhido: $st" ;;
  *) ok "--status satura em 0 livre(s) sob total encolhido" ;;
esac
case "$st" in
  *"acima do teto"*) ok "--status explica a sobrecarga em palavras" ;;
  *) bad "--status não sinaliza a sobrecarga: $st" ;;
esac
{ kill -9 "$a" "$b"; wait "$a" "$b"; } 2>/dev/null   # wait consome a notificação de job morto

# ──────────────────── 3. índice de slot esparso não permite sobre-inscrição
zerar
falsos=""
for n in 1 3; do   # simula slots criados quando o total era 3
  mkdir -p "$LK/slot-$n"
  sleep "40$TAG" &
  falsos="$falsos $!"
  echo $! > "$LK/slot-$n/pid"
  echo "ocupante-falso-$n" > "$LK/slot-$n/cmd"
done
if AFIACAO_MAX_HEAVY=2 AFIACAO_HEAVY_TIMEOUT=3 "$HEAVY" true >/dev/null 2>&1; then
  bad "sobre-inscrição: 3º entrou com teto 2 (pegou o índice livre no meio)"
else
  ok "teto respeitado por CONTAGEM, não por índice livre"
fi
# shellcheck disable=SC2086  # $falsos é lista de pids, split é intencional
{ kill -9 $falsos; wait $falsos; } 2>/dev/null

# ─────────────────────────────────────── 4. FIFO: atendimento na ordem de chegada
zerar
: > "$ORD"
AFIACAO_MAX_HEAVY=1 "$HEAVY" sleep "6$TAG" >/dev/null 2>&1 & hold=$!
sleep 1
for w in A B C D E; do
  AFIACAO_MAX_HEAVY=1 AFIACAO_HEAVY_TIMEOUT=60 "$HEAVY" \
    sh -c "echo $w >> $ORD; sleep 1" >/dev/null 2>&1 &
  sleep 0.4
done
wait "$hold" 2>/dev/null
sleep 14
got=$(tr '\n' ' ' < "$ORD" | xargs)
if [ "$got" = "A B C D E" ]; then
  ok "FIFO: chegada A B C D E → atendimento $got"
else
  bad "fora de ordem (starvation): chegada A B C D E → atendimento '$got'"
fi

# ──────────────────────────── 5. recuperação de slot órfão (dono morto) mantida
zerar
mkdir -p "$LK/slot-1"
sh -c 'exit 0' & morto=$!
wait "$morto" 2>/dev/null           # pid agora garantidamente morto
echo "$morto" > "$LK/slot-1/pid"
echo "dono-morto" > "$LK/slot-1/cmd"
if AFIACAO_MAX_HEAVY=1 AFIACAO_HEAVY_TIMEOUT=6 "$HEAVY" true >/dev/null 2>&1; then
  ok "slot de dono morto não bloqueia a admissão"
else
  bad "slot órfão não foi recuperado — fila travada por dono morto"
fi
# Não basta CONTORNAR o órfão pegando o próximo índice: ele tem de ser RECOLHIDO.
# Como a admissão passou a ser por contagem, um órfão não conta como vivo e o
# waiter entra por outro índice mesmo sem limpeza nenhuma — o lockdir acumularia
# lixo e os índices subiriam até estourar o teto de busca, aí sim travando.
if [ "$(n_slots)" = "0" ]; then
  ok "slot órfão foi REMOVIDO do lockdir (sem acúmulo de lixo)"
else
  bad "slot órfão continua no lockdir ($(n_slots) remanescente(s)) — só foi contornado"
fi

# ─────────────── 6. ticket órfão não trava a fila (risco que o FIFO introduz)
zerar
sh -c 'exit 0' & morto2=$!
wait "$morto2" 2>/dev/null
echo "waiter-fantasma" > "$LK/fila/0000000000000000001-$morto2"   # ts antigo = 1º da fila
if AFIACAO_MAX_HEAVY=1 AFIACAO_HEAVY_TIMEOUT=6 "$HEAVY" true >/dev/null 2>&1; then
  ok "waiter morto na frente da fila não bloqueia quem está atrás"
else
  bad "ticket órfão travou a fila — FIFO virou deadlock"
fi

# ─────────────────────────────────────────── 7. exit code do comando preservado
zerar
AFIACAO_MAX_HEAVY=1 "$HEAVY" sh -c 'exit 7' >/dev/null 2>&1
rc=$?
if [ "$rc" = "7" ]; then ok "exit code propagado (7)"; else bad "exit code perdido: esperado 7, veio $rc"; fi
zerar
AFIACAO_MAX_HEAVY=1 "$HEAVY" true >/dev/null 2>&1
rc=$?
if [ "$rc" = "0" ]; then ok "exit 0 propagado"; else bad "exit 0 virou $rc"; fi

echo
[ "$fail" = "0" ] && echo "TUDO VERDE" || echo "HOUVE FALHA"
exit "$fail"
