#!/usr/bin/env bash
# test-guard-noop-sabotagem.sh — guarda o predicado "o alvo da sabotagem ainda existe?" dos evals
# de falsificação (`--falsify`). Esse predicado decide entre DUAS acusações opostas, e errar nele
# é caro nos dois sentidos:
#   • "alvo sumiu"  ⇒ o eval REPROVA o CI sem que nada esteja errado (flake em gate de falsificação
#     ensina a re-rodar o CI, e re-rodar apaga sinal);
#   • "alvo existe" quando não existe ⇒ a sabotagem vira no-op e o eval aprova asserção sem dente.
#
# O DEFEITO QUE ESTE TESTE MATA (medido no run 34116946335, main, 2026-09-07): o guard era
#     if ! printf '%s' "$ORIG" | command grep -qF "$de"; then  → "alvo sumiu do gerador"
# Sob `set -o pipefail` o status do pipeline NÃO é o do grep. `grep -q` sai no PRIMEIRO match sem
# drenar o stdin (comportamento documentado do GNU grep); o `printf`, que ainda tinha bytes a
# escrever, morre de SIGPIPE e o pipeline devolve 141 — com o grep tendo respondido 0/ACHOU.
# `PIPESTATUS=141 0`. O `if !` lê 141 como "não achei" e acusa alvo ausente com o alvo presente.
# É CORRIDA: só dispara quando o `printf` não termina antes de o leitor fechar, o que depende do
# escalonamento. No CI foram 2 das 11 sabotagens, 1 run em 6, sempre com o texto byte-idêntico.
# Família `ausente ≠ zero` na dimensão SHELL: o veredito veio de um canal que não foi consultado
# (docs/historico/evidencia-positiva-shell.md).
#
# Por que o teste força um leitor que sai cedo, em vez de esperar a corrida: o BSD grep do macOS
# DRENA o stdin antes de sair, então a corrida não reproduz aqui nem em 400 tentativas — falsificar
# só no macOS não prova nada (lição do #1483). O shim abaixo tem a semântica do GNU grep -q e torna
# a condição DETERMINÍSTICA nos dois ambientes: o guard tem de acertar o veredito mesmo assim.
#
# Exit 0 = os guards respondem "presente" com o alvo presente. 1 = algum guard fabricou "sumiu".
# 2 = via de prova não observável (fail-CLOSED: sem python3 o teste NÃO passa em silêncio).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

command -v python3 >/dev/null 2>&1 || { echo "❌ VIA_NAO_OBSERVAVEL: python3 ausente."; exit 2; }

EVALS=(
  ".claude/skills/lovable-deploy-verify/evals/sonda-veredito-401-eval.sh"
  ".claude/skills/lovable-deploy-verify/evals/edges-pendentes-sql-eval.sh"
)

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# ── shim: `grep` com a semântica do GNU `-q` (sai no 1º match, SEM drenar o stdin) ───────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/grep" <<'SHIM'
#!/usr/bin/env python3
import sys
args = sys.argv[1:]
padrao, i = None, 0
while i < len(args):
    if args[i] == '--':
        padrao = args[i + 1]; break
    if args[i].startswith('-'):
        i += 1; continue
    padrao = args[i]; break
if padrao is None:
    sys.exit(2)
alvo, buf = padrao.encode(), b''
while True:
    bloco = sys.stdin.buffer.read(4096)
    if not bloco:
        sys.exit(1)
    buf += bloco
    if alvo in buf:
        sys.exit(0)          # ACHOU: fecha o pipe agora — é isto que mata o escritor
SHIM
chmod +x "$TMP/bin/grep"

# ORIG > capacidade do pipe, com o alvo NO COMEÇO: o escritor bloqueia e o leitor acha de imediato.
ALVO_TESTE='ALVO_QUE_EXISTE_NO_TEXTO'
python3 -c "import sys; sys.stdout.write('$ALVO_TESTE' + 'b' * 1048576)" > "$TMP/orig.txt" || exit 2

# extrai o guard REAL do eval: tudo entre a assinatura de `sabotar()` e a sabotagem propriamente
# dita (o `printf | python3` que reescreve o arquivo). Pega `if`, `case` ou o que vier depois.
extrair_guard() {
  awk '/local nome="\$1" de="\$2" para="\$3"/ {f=1; next} f && /python3/ {exit} f' "$1"
}

# rodar_guard <arquivo> <valor_de_$de> — executa o guard REAL do eval e devolve a saída dele.
rodar_guard() {
  local arq="$1" de="$2" guard
  guard=$(extrair_guard "$arq")
  [ -n "$guard" ] || { echo "GUARD_NAO_LOCALIZADO"; return; }
  {
    echo 'set -uo pipefail'
    echo 'cegas=0'
    echo "ORIG=\$(cat '$TMP/orig.txt')"
    echo "nome='guard sob leitor que sai cedo'; de='$de'"
    echo 'g() {'
    printf '%s\n' "$guard"
    printf '%s\n' '  printf "VEREDITO_ALVO_PRESENTE\n"'
    echo '}'
    echo 'g'
  } > "$TMP/probe.sh"
  PATH="$TMP/bin:$PATH" bash "$TMP/probe.sh" 2>&1
}

# verificar_guard <arquivo> — 0 só se o guard acertar os DOIS sentidos. Exigir apenas o "presente"
# deixaria passar o guard REMOVIDO (sem guard nenhum, nada acusa e tudo parece presente), que é a
# cegueira oposta: sabotagem no-op vira asserção sem dente. O critério é 3 estados, não 2 —
# presente, ausente, e "a busca não pôde ser feita", este último nunca virando um dos outros dois.
verificar_guard() {
  local arq="$1" com sem
  com=$(rodar_guard "$arq" "$ALVO_TESTE")
  case "$com" in
    *VEREDITO_ALVO_PRESENTE*) ;;
    *) printf '     com o alvo PRESENTE o guard respondeu: %s\n' "${com:-<vazio>}"; return 1 ;;
  esac
  sem=$(rodar_guard "$arq" 'ALVO_QUE_NAO_EXISTE_EM_LUGAR_NENHUM')
  case "$sem" in
    *VEREDITO_ALVO_PRESENTE*) printf '     com o alvo AUSENTE o guard NÃO acusou (guard removido/sem dente)\n'; return 1 ;;
    *GUARD_NAO_LOCALIZADO*)   printf '     guard não localizado em %s (mudou a assinatura de sabotar()?)\n' "$arq"; return 1 ;;
  esac
  return 0
}

rc=0
if [ "$FALSIFICAR" = 0 ]; then
  echo "== guard NO-OP das sabotagens — o alvo presente NÃO pode virar 'alvo sumiu' =="
  for e in "${EVALS[@]}"; do
    [ -f "$e" ] || { printf '  [XX ] %s — arquivo ausente\n' "$e"; rc=1; continue; }
    if verificar_guard "$e"; then
      printf '  [ok ] %s\n' "$(basename "$e")"
    else
      printf '  [XX ] %s — guard fabricou "alvo sumiu" com o alvo PRESENTE\n' "$(basename "$e")"; rc=1
    fi
  done
  [ "$rc" -eq 0 ] && echo "  os ${#EVALS[@]} guards acertam sob leitor que sai cedo"
  exit "$rc"
fi

# ── falsificação: devolve o pipeline frágil e EXIGE vermelho ─────────────────────────────────────
echo "== test-guard-noop-sabotagem --falsificar — devolve o pipeline e exige vermelho =="
cegas=0
for e in "${EVALS[@]}"; do
  base=$(basename "$e")
  # CONTROLE VERDE na MESMA invocação, ANTES de sabotar: sem ele uma suíte sempre-vermelha
  # aprovaria a sabotagem de graça. → docs/historico/falsificacao-sem-linha-de-base.md
  if ! verificar_guard "$e"; then
    printf '  [XX ] CONTROLE VERMELHO com %s íntegro — nada foi sabotado\n' "$base"; cegas=$((cegas + 1)); continue
  fi
  cp "$e" "$TMP/sabotado.sh" || exit 2
  guard=$(extrair_guard "$TMP/sabotado.sh")
  # shellcheck disable=SC2016  # aspas simples LITERAIS: é o pipeline frágil que voltamos de propósito
  FRAGIL='  if ! printf '"'"'%s'"'"' "$ORIG" | command grep -qF -- "$de"; then
    printf '"'"'  [XX ] sabotagem NO-OP (alvo sumiu)\n'"'"'; cegas=$((cegas + 1)); return
  fi'
  GUARD="$guard" FRAGIL="$FRAGIL" python3 - "$TMP/sabotado.sh" <<'PY' || exit 2
import os, sys
p = sys.argv[1]
t = open(p).read()
g, f = os.environ['GUARD'], os.environ['FRAGIL']
assert g in t, 'guard não encontrado para sabotar'
open(p, 'w').write(t.replace(g, f, 1))
PY
  if verificar_guard "$TMP/sabotado.sh"; then
    printf '  [XX ] sabotagem PASSOU DESPERCEBIDA: o pipeline voltou a %s e o teste seguiu verde\n' "$base"
    cegas=$((cegas + 1))
  else
    printf '  [ok ] pegada: pipeline frágil devolvido a %s ⇒ vermelho\n' "$base"
  fi
done
echo "--falsificar: $cegas cegueira(s) (esperado: 0)"
[ "$cegas" -eq 0 ] || exit 1
exit 0
