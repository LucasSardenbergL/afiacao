#!/usr/bin/env bash
# Gate de shell lint — o MESMO comando que o health stack local roda e que o CI roda.
#
# Por que existe (medido em 2026-08-28, #2087): o escopo histórico era
# `scripts/*.sh .claude/hooks/*.sh`, e `db/*.sh` — 267 arquivos — nunca esteve dentro. Esses
# `db/test-*.sh` são as PROVAS EXECUTADAS do SQL de risco (ritual prove-sql-money-path: PG17
# descartável, sabotagem, falsificação). É o pior lugar do repo para não ter linter: um harness de
# prova com bug de shell não falha ruidosamente — ele passa e AFIRMA que a invariante vale.
# Ao ampliar o escopo o shellcheck achou 83 avisos em 21 arquivos, e três eram DEFEITO, não estilo:
#   · `cmd <<PY ... PY; if [ $? -ne 0 ]` com `set -e` ativo e a função chamada NUA — o `set -e`
#     matava o script no `cmd` e o bloco de erro era INALCANÇÁVEL (o "falsificação inválida" nunca
#     imprimia, FALSIF_ERR nunca contava). SC2181 era a marca disso.
#   · crase dentro de heredoc INTERPOLADO (`<<SQL`) — o shell executava `SET`/`test.role` e o psql
#     recebia o comentário mutilado, com o `command not found` entrando na variável capturada.
#   · normalização com `grep -v '^$'` sob `pipefail`: lista vazia devolve 1 e matava o harness
#     exatamente no caso que ele existe para reportar ("a sabotagem não derrubou nada").
# Nenhum dos três aparece como teste vermelho: os dois primeiros calam um diagnóstico, o terceiro
# mata o processo antes da mensagem. Só um linter os vê.
#
# Entra em ZERO, sem baseline nem allowlist — arquivo-lista de exceção é o começo do gate que
# ninguém lê (mesma regra dos gates docs:links/docs:indice). Exceção pontual é
# `# shellcheck disable=SCxxxx` NO PONTO DE USO e COM O PORQUÊ escrito ao lado; disable mudo não
# passa em review.
set -uo pipefail   # NÃO `-e`: o veredito deste script é decidido no fim, de propósito.

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

# ── Sonda: fail-CLOSED e POSITIVA ────────────────────────────────────────────────────────────────
# `command -v shellcheck` não basta — binário presente-porém-quebrado esvaziaria o gate igual, e
# um gate que "pula" quando a ferramenta falta é verde por AUSÊNCIA DE DADO
# (docs/historico/sonda-ausente-em-script-que-apaga.md). Exigimos resposta positiva.
VERSAO="$(shellcheck --version 2>/dev/null)"
if ! printf '%s' "$VERSAO" | grep -q 'ShellCheck'; then
  echo "❌ shellcheck não respondeu ao --version (ausente ou quebrado)." >&2
  echo "   macOS: brew install shellcheck · Debian/Ubuntu: apt-get install -y shellcheck" >&2
  exit 2
fi
# A versão vai para o log SEMPRE: shellcheck muda o conjunto de checagens entre releases, e é isso
# que explica um "verde no laptop, vermelho no CI" (lição #1483 — falsificar em UM ambiente não
# prova a asserção). Sem esta linha, a divergência vira mistério.
printf '%s\n' "$VERSAO" | grep -E '^version:' | sed 's/^/  shellcheck /'

# ── Escopo ───────────────────────────────────────────────────────────────────────────────────────
GLOBS=( 'scripts/*.sh' '.claude/hooks/*.sh' 'db/*.sh' )

ARQUIVOS=()
for g in "${GLOBS[@]}"; do
  # shellcheck disable=SC2206  # split intencional: `g` é um GLOB para o shell expandir, não um path
  casados=( $g )
  # Guard anti-vacuidade: sem `nullglob`, um glob que não casa nada volta LITERAL — e
  # `shellcheck 'db/*.sh'` erraria; com `nullglob` voltaria VAZIO e o gate ficaria verde sem ter
  # lido arquivo nenhum. Um diretório renomeado apagaria a cobertura em silêncio. Aqui isso é
  # falha, não silêncio: o gate precisa provar que MEDIU alguma coisa.
  if [ "${#casados[@]}" -eq 0 ] || [ ! -e "${casados[0]}" ]; then
    echo "❌ o glob '$g' não casou nenhum arquivo — escopo do gate quebrou (diretório movido?)." >&2
    exit 2
  fi
  ARQUIVOS+=( "${casados[@]}" )
done
echo "  escopo: ${#ARQUIVOS[@]} arquivos (${GLOBS[*]})"

# ── Execução ─────────────────────────────────────────────────────────────────────────────────────
# Um processo por arquivo, em paralelo: shellcheck com ~290 arquivos de uma vez leva minutos.
# `xargs` devolve !=0 se QUALQUER filho falhar (BSD: 1 · GNU: 123) — é isso que vira o veredito.
SAIDA="$(mktemp)"
trap 'rm -f "$SAIDA"' EXIT
printf '%s\n' "${ARQUIVOS[@]}" | xargs -P 4 -n 1 shellcheck --format=gcc > "$SAIDA" 2>&1
rc=$?   # capturado ANTES de qualquer recorte da saída — `| head`/`| tail` engoliriam o código

if [ "$rc" -ne 0 ] || [ -s "$SAIDA" ]; then
  cat "$SAIDA"
  n=$(wc -l < "$SAIDA" | tr -d ' ')
  echo "" >&2
  echo "❌ shellcheck: $n achado(s). O gate entra em ZERO — não há baseline." >&2
  echo "   Conserte, ou justifique NO PONTO DE USO com '# shellcheck disable=SCxxxx  # <porquê>'." >&2
  exit 1
fi

echo "✅ shellcheck: 0 achados em ${#ARQUIVOS[@]} arquivos."
