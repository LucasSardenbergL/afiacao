#!/usr/bin/env bash
# heavy-install.sh — instala o semáforo `heavy` em ~/.local/bin/heavy.
#
# Por que existe: ~/.local/bin/heavy é uma CÓPIA de scripts/heavy.sh — mergear na
# `main` NÃO atualiza o semáforo que todas as sessões usam. Mordeu no #1459: a
# correção de 3 bugs de concorrência ficou mergeada e INERTE até a cópia manual.
# Mesma classe da armadilha do Lovable (repo ≠ produção).
#
# Fonte PADRÃO = origin/main, não o arquivo desta worktree: em 2026-07-20, 32 das
# 39 worktrees carregavam o heavy.sh pré-#1459 — instalar "o daqui" por padrão
# andaria o semáforo PARA TRÁS.
#
# Uso:
#   bun run heavy:install                     # instala o de origin/main
#   bash scripts/heavy-install.sh --daqui     # instala o DESTA worktree (mudança em voo)
#   bash scripts/heavy-install.sh --status    # só compara (0=sincronizado, 1=divergente/ausente)
set -euo pipefail

DEST="${AFIACAO_HEAVY_DEST:-$HOME/.local/bin/heavy}"
here="$(cd "$(dirname "$0")" && pwd)"

modo="instalar"
fonte="main"
for arg in "$@"; do
  case "$arg" in
    --daqui)   fonte="daqui" ;;
    --status)  modo="status" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "heavy-install: opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

tmp_fonte="$(mktemp)"
tmp_dest=""
# shellcheck disable=SC2329  # invocada indiretamente pelo trap EXIT
limpar() {
  rm -f "$tmp_fonte"
  if [ -n "$tmp_dest" ]; then rm -f "$tmp_dest"; fi
}
trap limpar EXIT

# ── materializa a fonte ───────────────────────────────────────────────────────
if [ "$fonte" = "daqui" ]; then
  desc="scripts/heavy.sh desta worktree"
  cp "$here/heavy.sh" "$tmp_fonte" 2>/dev/null || {
    echo "heavy-install: $here/heavy.sh não encontrado" >&2; exit 1; }
else
  desc="origin/main:scripts/heavy.sh"
  # `git show` porque a worktree pode estar em QUALQUER branch — o arquivo de
  # origin/main não está no working tree. Lê o object DB compartilhado, sem rede.
  git -C "$here" show origin/main:scripts/heavy.sh > "$tmp_fonte" 2>/dev/null || {
    echo "heavy-install: não consegui ler $desc" >&2
    echo "  → 'git fetch origin' resolve; ou use --daqui para instalar o desta worktree." >&2
    exit 1; }
fi

# Fail-closed: nunca publicar arquivo vazio/parcial por cima do semáforo.
if [ ! -s "$tmp_fonte" ]; then
  echo "heavy-install: fonte vazia ($desc) — abortando, destino intacto" >&2
  exit 1
fi

sha_de() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha_fonte="$(sha_de "$tmp_fonte")"
sha_dest=""
if [ -f "$DEST" ]; then sha_dest="$(sha_de "$DEST")"; fi

# ── --status: só reporta ──────────────────────────────────────────────────────
if [ "$modo" = "status" ]; then
  if [ -z "$sha_dest" ]; then
    echo "heavy NÃO instalado ($DEST ausente) — fonte $desc"
    exit 1
  elif [ "$sha_fonte" = "$sha_dest" ]; then
    echo "heavy sincronizado com $desc (${sha_fonte:0:12})"
    exit 0
  else
    echo "heavy DIVERGENTE — instalado ${sha_dest:0:12} ≠ $desc ${sha_fonte:0:12}"
    exit 1
  fi
fi

# ── instalar ──────────────────────────────────────────────────────────────────
if [ "$sha_fonte" = "$sha_dest" ]; then
  echo "heavy-install: já sincronizado com $desc (${sha_fonte:0:12}) — nada a fazer"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
if [ -n "$sha_dest" ]; then cp "$DEST" "$(dirname "$DEST")/.heavy.bak"; fi

# ATÔMICO. O tmp mora no dir do DESTINO, não em /tmp: `mv` entre filesystems
# diferentes degrada para copy+unlink e perde a atomicidade. O `mv` (rename(2))
# publica um INODE NOVO — um `heavy` dormindo na fila (até 30min, MAX_WAIT) segue
# lendo o arquivo antigo até terminar. `cp` por cima do destino reescreveria o
# MESMO inode e corromperia esse processo, que relê o script por offset de byte.
tmp_dest="$(dirname "$DEST")/.heavy.tmp.$$"
cp "$tmp_fonte" "$tmp_dest"
chmod +x "$tmp_dest"
mv -f "$tmp_dest" "$DEST"
tmp_dest=""

echo "heavy-install: instalado em $DEST ← $desc (${sha_fonte:0:12})"
case ":$PATH:" in
  *":$(dirname "$DEST"):"*) : ;;
  *) echo "heavy-install: ⚠️  $(dirname "$DEST") não está no PATH — o 'heavy' não será encontrado." >&2 ;;
esac
# Explícito: sem isto, o exit do `case` acima vira o exit do script.
exit 0
