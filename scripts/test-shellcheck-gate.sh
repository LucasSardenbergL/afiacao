#!/usr/bin/env bash
# test-shellcheck-gate.sh — suíte HERMÉTICA do scripts/shellcheck-gate.sh (sem rede, sem git).
#
# O gate roda numa raiz de repo montada em $TMPDIR (o próprio gate faz `cd $(dirname $0)/..`), então
# nada aqui toca os arquivos de verdade — e a suíte não pode "passar" por ter medido o repo real.
#
# Cada caso vermelho casa a MARCA do achado (o código SCxxxx / a frase do guard), nunca só
# "saiu != 0": um gate que quebrasse por outro motivo qualquer — glob errado, cd falhando, binário
# sumido — daria exit != 0 igual, e a suíte diria VERDE sobre uma asserção que não mede nada.
#
# Os casos existem porque cada um é uma saída de emergência que esvaziaria o gate em silêncio:
#   · SC2181/SC2015/SC2006 → as três classes que FABRICAM VEREDITO num harness de prova (o `$?`
#     indireto que o `set -e` torna inalcançável; o `A && B || C` que não é if-then-else; a crase
#     executada dentro de heredoc interpolado). Se o gate não as pega, ele é decorativo.
#   · glob vazio → `db/` renomeado faria o gate ler ZERO arquivo e reportar verde. Cobertura que
#     some sozinha é pior que gate nenhum, porque o verde continua chegando.
#   · shellcheck ausente E shellcheck presente-porém-quebrado → sonda de gate é fail-CLOSED, e
#     `command -v` não basta (docs/historico/sonda-ausente-em-script-que-apaga.md).
#
# Uso: bash scripts/test-shellcheck-gate.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
GATE="$here/shellcheck-gate.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok=0
ruim=0

pass() { ok=$((ok+1));   echo "  ✅ $1"; }
fail() { ruim=$((ruim+1)); echo "  ❌ $1"; }

# ── pré-flight: sem shellcheck a suíte inteira seria teatro ───────────────────────────────────────
# Exigimos resposta POSITIVA (não `command -v`): sem isto, TODO caso vermelho ficaria vermelho pelo
# motivo errado (binário ausente), e os casos passariam parecendo que mediram as classes de bug.
if ! shellcheck --version 2>/dev/null | grep -q 'ShellCheck'; then
  echo "❌ shellcheck não respondeu ao --version — a suíte não pode distinguir 'gate mordeu' de"
  echo "   'ferramenta faltando'. Instale (brew/apt install shellcheck) e rode de novo."
  exit 1
fi

# monta_raiz <dir> — raiz de repo mínima com o gate no lugar que ele espera, e um arquivo LIMPO em
# cada um dos globs (assim o caso verde prova que houve leitura, e não vacuidade).
# A lista precisa acompanhar GLOBS= do gate: o guard de glob vazio é fail-closed, então um glob
# novo sem diretório aqui reprova TODOS os casos abaixo por "escopo quebrado" — vermelho por
# tabela, que é justamente o que o item 1 desta suíte existe para detectar.
monta_raiz() {
  local raiz="$1" d
  mkdir -p "$raiz/scripts" "$raiz/.claude/hooks" "$raiz/db" "$raiz/db/lib"
  cp "$GATE" "$raiz/scripts/shellcheck-gate.sh"
  for d in scripts .claude/hooks db db/lib; do
    printf '#!/usr/bin/env bash\nset -euo pipefail\necho "limpo"\n' > "$raiz/$d/limpo.sh"
  done
}

# roda_gate <raiz> — devolve o rc no global RC e a saída no global OUT
RC=0
OUT=""
roda_gate() {
  OUT="$(bash "$1/scripts/shellcheck-gate.sh" 2>&1)"
  RC=$?
}

# espera_vermelho <rotulo> <marca> — exige rc!=0 E a marca presente na saída
espera_vermelho() {
  local rot="$1" marca="$2"
  if [ "$RC" -eq 0 ]; then
    fail "$rot: o gate ficou VERDE — a sabotagem não foi vista"
  elif ! printf '%s' "$OUT" | grep -qF "$marca"; then
    fail "$rot: ficou vermelho, mas SEM a marca [$marca] — vermelho pelo motivo errado não conta"
  else
    pass "$rot (rc=$RC, casou [$marca])"
  fi
}

echo "── 1. controle: raiz limpa fica VERDE (e leu mesmo os 4 globs) ──"
raiz="$tmp/limpa"; monta_raiz "$raiz"
roda_gate "$raiz"
if [ "$RC" -ne 0 ]; then
  fail "controle: raiz limpa deu rc=$RC — todo caso vermelho abaixo seria vermelho por tabela"
  echo "$OUT"
elif ! printf '%s' "$OUT" | grep -q '0 achados em 5 arquivos'; then
  fail "controle: o gate não disse quantos arquivos leu — verde sem denominador é ausência de dado"
else
  pass "controle: verde com os 5 arquivos lidos"
fi

echo "── 2. as classes que FABRICAM VEREDITO num harness de prova ──"

# SC2181 — `$?` indireto. Num arquivo com `set -e` e a função chamada nua, o bloco de erro vira
# inalcançável: o harness perde o diagnóstico e ninguém fica sabendo. Foi o achado real do #2087.
raiz="$tmp/sc2181"; monta_raiz "$raiz"
cat > "$raiz/db/test-sabotado.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
f() {
  python3 -c 'import sys; sys.exit(3)'
  if [ $? -ne 0 ]; then
    echo "falsificacao INVALIDA"
    return
  fi
}
f
SH
roda_gate "$raiz"; espera_vermelho "SC2181 (\$? indireto) em db/" "SC2181"

# SC2015 — `A && B || C` não é if-then-else: se B falhar, C roda TAMBÉM. Num assert isso conta
# PASS e FAIL na mesma linha.
raiz="$tmp/sc2015"; monta_raiz "$raiz"
cat > "$raiz/db/test-sabotado.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
V=1
ok()  { echo "ok $1"; }
bad() { echo "bad $1"; }
[ "$V" = "1" ] && ok "A1" || bad "A1"
SH
roda_gate "$raiz"; espera_vermelho "SC2015 (A && B || C) em db/" "SC2015"

# SC2006 — crase. Dentro de heredoc INTERPOLADO o shell EXECUTA o conteúdo e injeta o resultado no
# SQL; o comentário chega mutilado ao psql. Também foi achado real do #2087.
raiz="$tmp/sc2006"; monta_raiz "$raiz"
cat > "$raiz/db/test-sabotado.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
X=`echo oi`
echo "$X"
SH
roda_gate "$raiz"; espera_vermelho "SC2006 (crase) em db/" "SC2006"

# O mesmo bug em scripts/ e em .claude/hooks/ — o escopo antigo já os cobria, e a suíte prova que
# ampliar para db/ não afrouxou os dois que já estavam dentro.
for d in scripts .claude/hooks; do
  raiz="$tmp/esc-$(printf '%s' "$d" | tr -d './')"; monta_raiz "$raiz"
  cat > "$raiz/$d/sabotado.sh" <<'SH'
#!/usr/bin/env bash
X=`echo oi`
echo "$X"
SH
  roda_gate "$raiz"; espera_vermelho "SC2006 em $d/ (escopo antigo segue coberto)" "SC2006"
done

echo "── 3. as saídas de emergência que dariam VERDE sem medir nada ──"

# Glob vazio: `db/` sem nenhum .sh. Sem o guard, o gate leria 2 globs, acharia 0 problemas e
# reportaria verde — a cobertura de db/ teria sumido em silêncio.
raiz="$tmp/vazio"; monta_raiz "$raiz"; rm -f "$raiz/db/limpo.sh"
roda_gate "$raiz"; espera_vermelho "glob vazio (db/ sem .sh) falha em vez de ficar verde" "não casou nenhum arquivo"

# Sonda ausente: shellcheck fora do PATH. Um gate que "pula quando a ferramenta falta" é verde por
# AUSÊNCIA DE DADO.
raiz="$tmp/sem-bin"; monta_raiz "$raiz"
# Ausencia simulada por SIMBOLO, nao por diretorio. "/usr/bin nao tem shellcheck" e verdade no
# macOS (homebrew) e FALSO no runner Ubuntu, onde o apt instala exatamente em /usr/bin: a
# simulacao achava o binario, o gate ficava VERDE e o caso que existe para provar o fail-closed
# aprovava a si mesmo. Aqui o PATH tem so o que o gate precisa — e nada mais.
# Zerar o PATH inteiro nao serve: o gate morreria por falta de grep, um vermelho pelo motivo
# ERRADO (por isso `espera_vermelho` casa a MARCA da mensagem, nao so o rc).
bin_sem_shellcheck() { # destino
  local d="$1" f alvo
  mkdir -p "$d"
  for f in bash env cat grep sed tr wc xargs cut sort awk find mktemp dirname basename rm ls; do
    alvo=$(command -v "$f" 2>/dev/null) || continue
    ln -sf "$alvo" "$d/$f"
  done
  # Asseracao POSITIVA: sandbox que ainda resolve shellcheck torna o caso teatro — e teatro que
  # so aparece na maquina de quem tem o binario noutro diretorio. Medir > assumir.
  if PATH="$d" command -v shellcheck >/dev/null 2>&1; then
    echo "❌ sandbox de ausencia ainda resolve shellcheck — caso invalido" >&2
    exit 2
  fi
}
bin_sem_shellcheck "$tmp/bin-sem-shellcheck"
OUT="$(PATH="$tmp/bin-sem-shellcheck" bash "$raiz/scripts/shellcheck-gate.sh" 2>&1)"; RC=$?
espera_vermelho "shellcheck AUSENTE falha (fail-closed)" "não respondeu ao --version"

# Sonda quebrada: binário PRESENTE que não responde. `command -v` acharia e deixaria passar — é
# exatamente o furo do doc sonda-ausente-em-script-que-apaga.md.
raiz="$tmp/bin-quebrado"; monta_raiz "$raiz"
mkdir -p "$tmp/path-fake"
printf '#!/bin/sh\nexit 1\n' > "$tmp/path-fake/shellcheck"
chmod +x "$tmp/path-fake/shellcheck"
OUT="$(PATH="$tmp/path-fake:/usr/bin:/bin" bash "$raiz/scripts/shellcheck-gate.sh" 2>&1)"; RC=$?
espera_vermelho "shellcheck QUEBRADO (existe mas não responde) falha" "não respondeu ao --version"

echo ""
echo "── resultado: $ok ok · $ruim falha(s) ──"
[ "$ruim" -eq 0 ]
