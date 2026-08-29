#!/usr/bin/env bash
# test-codex-prompt-paginacao.sh — TDD do resolvedor PR→SHA de scripts/codex-prompt-paginacao.sh.
#
# O DEFEITO que este teste prende (achado pela 2ª opinião do Codex, 2026-08-29): `sha_de`
# resolvia o número do PR com `git log --grep "(#N)" -1`. O `--grep` varre a mensagem INTEIRA
# (assunto + corpo) e `-1` fica com o commit MAIS RECENTE — então um PR posterior que cite
# "(#N)" em prosa no corpo ROUBA o SHA do PR real. Medido na main: `(#1856)` casava
# 4dd2a0271 (o citador) em vez de 4b592b506 (o PR), e `(#1889)` casava 0ed5a9b31 em vez de
# b559e8bdd. O prompt saía com SHA plausível e ERRADO — falha SILENCIOSA num gerador que
# nasceu exatamente para o prompt não envelhecer em silêncio.
#
# A âncora certa é a convenção de squash-merge do repo: o marcador `(#N)` FECHA o ASSUNTO.
#
# Uso: bash scripts/test-codex-prompt-paginacao.sh [--falsificar]   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
GERADOR="$here/codex-prompt-paginacao.sh"
falsificar=0
[ "${1:-}" = "--falsificar" ] && falsificar=1

falhas=0
ok()   { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; falhas=$((falhas + 1)); }

[ -f "$GERADOR" ] || { echo "ABORT: $GERADOR não existe"; exit 69; }

# ── Extrai a função `sha_de` do script real, por balanço de chaves.
#    Fail-CLOSED: se o símbolo sumir (renome/refactor), o teste ABORTA em vez de virar no-op
#    verde — sonda ausente não é sonda satisfeita.
defn="$(awk '
  /^sha_de\(\)/ { dentro = 1 }
  dentro {
    print
    n = gsub(/\{/, "{"); abertas += n
    n = gsub(/\}/, "}"); abertas -= n
    if (abertas <= 0) exit
  }
' "$GERADOR")"

case "$defn" in
  *"git log"*) : ;;
  *) echo "ABORT: não achei a definição de sha_de() com 'git log' em $GERADOR"
     echo "       (símbolo renomeado? conserte o extrator, não contorne)"; exit 65 ;;
esac

if [ "$falsificar" = 1 ]; then
  # SABOTAGEM: reintroduz o defeito exato. O teste TEM de ficar vermelho — se ficar verde,
  # ele não estava medindo nada.
  # shellcheck disable=SC2016  # o $1 NÃO pode expandir aqui: a string é o corpo da
  # função, expandido só no `eval` abaixo (é a sabotagem, tem de ser literal).
  defn='sha_de() { git log origin/main --format=%h --grep "(#$1)" -1 -- 2>/dev/null || true; }'
  echo "-- modo falsificação: sha_de sabotado para a versão --grep/-1 --"
fi

# ── Fixture: repositório com a MESMA forma que enganou o gerador na main.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo"
cd "$repo" || exit 70
git init -q .
git config user.email t@t.local
git config user.name teste
git config commit.gpgsign false

: > a.txt; git add a.txt
# (1) O PR REAL: o marcador FECHA o assunto.
git commit -q -m "fix(paginação): o offset desloca sob escrita concorrente — keyset (#1856)"
sha_real_1856="$(git rev-parse --short HEAD)"

: > b.txt; git add b.txt
# (2) PR POSTERIOR que CITA o anterior em prosa no CORPO. É este que o `-1` escolhia.
git commit -q -m "fix(edges): fetchAll lança FalhaLeituraCritica (#1858)" \
  -m "O helper nasceu (#1856) repetindo o mesmo vazamento; o #1856 mergeou em voo."
sha_citador="$(git rev-parse --short HEAD)"

: > c.txt; git add c.txt
git commit -q -m "fix(paginação): página curta não é fim de tabela (#1889)"
sha_real_1889="$(git rev-parse --short HEAD)"

: > d.txt; git add d.txt
git commit -q -m "feat(sonda): a monthly-report escapava do grep (#1946)" \
  -m "Mesma família do (#1889), que trocou o critério de parada."
git update-ref refs/remotes/origin/main HEAD

eval "$defn"

echo "== resolvedor PR→SHA =="

got="$(sha_de 1856)"
if [ "$got" = "$sha_real_1856" ]; then
  ok "#1856 → o PR real ($sha_real_1856), não o citador ($sha_citador)"
else
  fail "#1856 → esperado '$sha_real_1856' (assunto fecha com o marcador), veio '$got'"
fi

got="$(sha_de 1889)"
if [ "$got" = "$sha_real_1889" ]; then
  ok "#1889 → o PR real ($sha_real_1889), não o citador posterior"
else
  fail "#1889 → esperado '$sha_real_1889', veio '$got'"
fi

# Um número que ninguém entregou não pode devolver o SHA de quem só o citou.
got="$(sha_de 9999)"
if [ -z "$got" ]; then
  ok "PR inexistente → vazio (não inventa SHA)"
else
  fail "PR inexistente → esperado vazio, veio '$got'"
fi

# Prefixo não pode casar: (#185) é outro PR que não (#1856).
got="$(sha_de 185)"
if [ -z "$got" ]; then
  ok "#185 não casa com (#1856)/(#1858) — marcador é o número INTEIRO"
else
  fail "#185 casou indevidamente com '$got'"
fi

echo
if [ "$falhas" -eq 0 ]; then
  if [ "$falsificar" = 1 ]; then
    echo "FALSIFICAÇÃO FALHOU: o defeito foi reintroduzido e o teste passou — teste cego."
    exit 1
  fi
  echo "verde: $0"
  exit 0
fi
if [ "$falsificar" = 1 ]; then
  echo "falsificação OK: $falhas asserção(ões) ficaram vermelhas com o defeito reintroduzido."
  exit 0
fi
echo "VERMELHO: $falhas falha(s)."
exit 1
