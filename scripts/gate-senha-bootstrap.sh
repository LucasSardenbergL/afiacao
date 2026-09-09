#!/usr/bin/env bash
# gate-senha-bootstrap.sh — a senha real de `claude_rw` NÃO entra na história do repo.
#
# O QUE PROTEGE. `db/claude-rw-bootstrap.sql` é a única colagem manual que resta
# (docs/historico/db-aplicar-colagem-manual-vira-comando.md). O founder troca o placeholder
# `TROQUE_ESTA_SENHA` pela senha real, cola no SQL Editor do Lovable, e tem de restaurar o
# placeholder depois. Em 2026-09-07/08 a senha real ficou na árvore de trabalho DUAS vezes;
# nenhuma foi commitada, mas o que impediu foi um agente conferir na hora. Este script é o freio
# de MÁQUINA que substitui essa conferência — o repo trata frase-em-doc como guarda insuficiente.
#
# ── A DECISÃO DE DESENHO CENTRAL: o gate NUNCA imprime a linha ofensora ──────────────────────────
# Um gate que "ajuda" mostrando o trecho errado publicaria a senha no log do CI, que persiste e é
# lido por quem passar. Aqui isso não depende de disciplina de quem edita: as duas regexes casam
# apenas a PALAVRA-CHAVE e a aspa de abertura (`PASSWORD '`), então `grep -o` é incapaz de emitir o
# conteúdo do literal. A saída é sempre `arquivo` + NÚMERO de linha. O `test-gate-senha-bootstrap.sh`
# sabota com uma senha falsa e exige que ela não apareça na saída — é um eixo de teste próprio.
#
# ── O CRITÉRIO, e por que ele não precisa remover comentário ─────────────────────────────────────
# O risco não é a palavra "password" — é um LITERAL de senha. O gate mede duas coisas, ambas
# afirmações POSITIVAS (nunca "não achei nada", que é ausência de dado):
#   SUSPEITA  = `PASSWORD` seguido de literal (aspa simples ou dollar-quote).
#   CANONICA  = `PASSWORD 'TROQUE_ESTA_SENHA'`, caixa fixa no placeholder.
# Verde exige `#SUSPEITA == #CANONICA` em todo o escopo. Medido em 2026-09-09 contra o repo inteiro
# (db/, supabase/migrations/, scripts/): 1 ocorrência de SUSPEITA no repo todo, e é a CANONICA. Os
# comentários que citam senha de passagem (`encrypted_password` = hash …, em
# db/revoga-master-alias-fiscal-omie.sql) NÃO casam, porque não abrem literal. Por isso não há
# stripper de comentário aqui — o CLAUDE.md proíbe stripper local justamente porque ele erra dos
# dois lados, e a forma escolhida dispensa a limpeza. Se algum dia um comentário escrever
# `PASSWORD 'x'` literalmente, o gate reprova: é ruído barato de reescrever, e uma senha "comentada"
# vaza igual — ali o falso positivo é, na verdade, verdadeiro.
#
# A palavra-chave é casada por classe explícita (`[Pp][Aa]…`) e NÃO por `grep -i`: SQL é
# case-insensitive na keyword, mas o placeholder é um literal EXATO — com `-i` global,
# `troque_esta_senha` minúsculo passaria por canônico e o gate perderia o dente.
#
# ── Dois modos, uma implementação ────────────────────────────────────────────────────────────────
#   (sem flag)  varre a ÁRVORE — é o que o CI roda contra o commit já existente.
#   --staged    varre o conteúdo do ÍNDICE dos arquivos staged — é o que o pre-commit roda.
# A diferença importa: `git commit` grava o ÍNDICE. Editar a senha, `git add`, restaurar o
# placeholder na árvore e commitar leva a senha assim mesmo — um hook que lesse a árvore seria cego
# exatamente nesse caso. Os dois modos passam pela MESMA função de análise de propósito: duas
# implementações divergem, e a que ninguém olha é a que fica errada.
#
# Uso: bash scripts/gate-senha-bootstrap.sh [--staged] [--raiz <dir>]
# Exit: 0 = BOOTSTRAP-SENHA-OK · 1 = achado (senha/âncora) · 2 = não consegui avaliar (fail-CLOSED).
set -uo pipefail   # NÃO `-e`: o veredito é decidido no fim, de propósito.

MODO=arvore
RAIZ=""
while [ $# -gt 0 ]; do
  case "$1" in
    --staged) MODO=staged; shift ;;
    --raiz)   RAIZ="${2:-}"; shift 2 || { echo "BOOTSTRAP-GATE-FALHA: --raiz sem valor" >&2; exit 2; } ;;
    *) echo "BOOTSTRAP-GATE-FALHA: argumento desconhecido '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$RAIZ" ]; then RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; fi
cd "$RAIZ" || { echo "BOOTSTRAP-GATE-FALHA: raiz inacessível" >&2; exit 2; }

ANCORA='db/claude-rw-bootstrap.sql'

# Montadas por concatenação para a aspa simples caber sem escape ilegível.
KW='[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][[:space:]]*'
AP="'"
RE_SUSPEITA="${KW}[${AP}\$]"
RE_CANONICA="${KW}${AP}TROQUE_ESTA_SENHA${AP}"

achados=0
medidos=0

# analisar <rótulo-do-arquivo> <caminho-do-conteúdo>
# O conteúdo pode vir da árvore ou de um blob do índice materializado em $TMP — a análise é a mesma.
analisar() {
  local rotulo="$1" corpo="$2" susp canon linhas_susp linhas_canon fora
  # `grep -o` só pode emitir `PASSWORD '` — a regex não alcança o literal. É o que torna
  # impossível vazar a senha por aqui, mesmo se alguém acrescentar um `echo` de depuração.
  susp="$(grep -coE "$RE_SUSPEITA" "$corpo" 2>/dev/null)" || susp=0
  canon="$(grep -coE "$RE_CANONICA" "$corpo" 2>/dev/null)" || canon=0
  medidos=$((medidos + 1))
  [ "$susp" -eq "$canon" ] && return 0

  # Relatório: números de linha suspeitos que não são canônicos. Nada de conteúdo.
  linhas_susp="$(grep -noE "$RE_SUSPEITA" "$corpo" 2>/dev/null | cut -d: -f1 | sort -u)"
  linhas_canon="$(grep -noE "$RE_CANONICA" "$corpo" 2>/dev/null | cut -d: -f1 | sort -u)"
  fora="$(comm -23 <(printf '%s\n' "$linhas_susp") <(printf '%s\n' "$linhas_canon") | tr '\n' ' ')"
  echo "BOOTSTRAP-SENHA-LITERAL: $rotulo tem PASSWORD com literal fora da forma canônica" >&2
  echo "   linha(s): ${fora:-$linhas_susp}   (ocorrências: $susp · canônicas: $canon)" >&2
  echo "   O conteúdo NÃO é impresso de propósito. Restaure o placeholder TROQUE_ESTA_SENHA." >&2
  achados=$((achados + 1))
}

TMP="$(mktemp -d)" || { echo "BOOTSTRAP-GATE-FALHA: mktemp" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT

if [ "$MODO" = arvore ]; then
  # Escopo generoso: senha em migration ou em script SQL vaza igual. Medido: nenhum deles casa hoje.
  alvos=()
  while IFS= read -r f; do alvos+=( "$f" ); done < <(
    find db supabase/migrations scripts -name '*.sql' -type f 2>/dev/null | sort
  )
  if [ "${#alvos[@]}" -eq 0 ]; then
    echo "BOOTSTRAP-GATE-FALHA: escopo vazio — nenhum .sql encontrado (diretório movido?)." >&2
    exit 2
  fi
  # Âncora anti-vacuidade: o arquivo protegido tem de existir E carregar a forma canônica. Sem
  # isto, renomear o arquivo (ou reescrever o CREATE ROLE para outra forma, tipo `format(%L)`)
  # apagaria a cobertura em silêncio e o gate seguiria verde — cobertura que some sozinha é pior
  # que gate nenhum, porque o verde continua chegando.
  if [ ! -f "$ANCORA" ]; then
    echo "BOOTSTRAP-SEM-ANCORA: $ANCORA não existe. Se foi movido, aponte o gate para o novo caminho." >&2
    exit 1
  fi
  if ! grep -qE "$RE_CANONICA" "$ANCORA"; then
    echo "BOOTSTRAP-SEM-ANCORA: $ANCORA não carrega a forma canônica PASSWORD 'TROQUE_ESTA_SENHA'." >&2
    echo "   O gate mede a FORMA; sem ela ele não prova nada. Restaure o placeholder." >&2
    exit 1
  fi
  for f in "${alvos[@]}"; do analisar "$f" "$f"; done
else
  # --staged: o que vai ser COMMITADO, lido do índice.
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "BOOTSTRAP-GATE-FALHA: não é um repositório git — não consigo ler o índice." >&2
    exit 2
  fi
  # Primeiro commit não tem HEAD: compara contra a árvore vazia em vez de morrer (o hook precisa
  # valer já no commit inicial de um clone novo).
  base=HEAD
  git rev-parse --verify -q HEAD >/dev/null 2>&1 || base=4b825dc642cb6eb9a060e54bf8d69288fbee4904
  lista="$TMP/lista"
  if ! git diff --cached --name-only --diff-filter=ACMR "$base" -- '*.sql' > "$lista" 2>"$TMP/err"; then
    echo "BOOTSTRAP-GATE-FALHA: git diff --cached falhou — bloqueando por precaução (fail-closed)." >&2
    cut -c1-200 "$TMP/err" >&2
    exit 2
  fi
  n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    blob="$TMP/blob.$n"
    if ! git show ":$f" > "$blob" 2>/dev/null; then
      echo "BOOTSTRAP-GATE-FALHA: não consegui ler '$f' do índice — bloqueando (fail-closed)." >&2
      exit 2
    fi
    analisar "$f (índice)" "$blob"
  done < "$lista"
  if [ "$n" -eq 0 ]; then
    echo "BOOTSTRAP-SENHA-OK: nenhum .sql no commit — nada a medir."
    exit 0
  fi
fi

if [ "$achados" -gt 0 ]; then
  echo "" >&2
  echo "❌ $achados arquivo(s) com literal de senha. NADA foi impresso do conteúdo." >&2
  if [ "$MODO" = arvore ]; then
    echo "   ⚠️ Se isto reprovou no CI, o commit JÁ ESTÁ no remoto: ROTACIONE a senha do claude_rw" >&2
    echo "      (ALTER ROLE no SQL Editor + ~/.config/afiacao/claude_rw.pgpass) antes de reescrever." >&2
  fi
  exit 1
fi
echo "BOOTSTRAP-SENHA-OK: $medidos arquivo(s) medido(s), zero literal de senha."
