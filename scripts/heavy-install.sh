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
#   bash scripts/heavy-install.sh --status    # só compara — contrato de 4 estados:
#     exit 0  sincronizado com origin/main
#     exit 0  EM VOO — instalado == scripts/heavy.sh desta worktree, mas ≠ origin/main
#             (alguém rodou --daqui de propósito; mensagem distingue do sincronizado)
#     exit 1  DIVERGENTE (a comparação foi FEITA e deu diferente) OU heavy ausente
#     exit 3  NÃO CONSEGUI VERIFICAR — origin/main ilegível (sem fetch), fonte vazia,
#             mktemp falhou, ou o CHAMADOR (o hook) estourou o teto de tempo. A
#             mensagem diz o que fazer; NUNCA é o mesmo que "divergente" (ausência
#             de dado ≠ afirmação de divergência).
set -euo pipefail

DEST="${AFIACAO_HEAVY_DEST:-$HOME/.local/bin/heavy}"
here="$(cd "$(dirname "$0")" && pwd)"

modo="instalar"
fonte="main"
for arg in "$@"; do
  case "$arg" in
    --daqui)   fonte="daqui" ;;
    --status)  modo="status" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "heavy-install: opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

# --status não pode AFIRMAR "divergente" quando a causa real é "não consegui
# comparar" — as 4 causas (fonte ilegível/vazia, mktemp falhou, teto de tempo do
# chamador) caem aqui. Fora do --status, mantém o fail-closed de sempre (exit 1):
# esta função é o único lugar que decide isso, para não duplicar o `if` 4 vezes.
falhar_fonte() {
  if [ "$modo" = "status" ]; then
    echo "heavy-install --status: NÃO CONSEGUI VERIFICAR — a comparação nem rodou (ver mensagem acima); resolva a causa e rode de novo." >&2
    exit 3
  fi
  exit 1
}

if ! tmp_fonte="$(mktemp)"; then
  echo "heavy-install: mktemp falhou (checar \$TMPDIR: espaço em disco / permissão)" >&2
  falhar_fonte
fi
tmp_dest=""
# shellcheck disable=SC2329  # invocada indiretamente pelo trap EXIT
limpar() {
  rm -f "$tmp_fonte"
  if [ -n "$tmp_dest" ]; then rm -f "$tmp_dest"; fi
}
trap limpar EXIT
# `timeout(1)` (ex.: o teto de 3s que o hook SessionStart aplica no --status)
# mata com SIGTERM. Havia aqui um `trap 'exit 143' TERM` com a premissa de que,
# sem handler, o processo morreria pela disposição PADRÃO do sinal sem rodar o
# trap EXIT acima, vazando o mktemp. MEDIDO (2026-07-20, scratchpad descartável)
# e FALSO nos dois eixos:
#   1) Sob o `timeout` do GNU coreutils (o que o hook usa): 0 tmp vazado COM o
#      trap e 0 tmp vazado SEM o trap. O coreutils cria um novo grupo de
#      processos pro comando e manda o SIGTERM pro GRUPO inteiro — o bash
#      recebe o sinal direto, não fica esperando nenhum subprocess bloqueado
#      morrer primeiro. E o bash RODA o trap EXIT mesmo sem handler custom
#      para o sinal fatal: `bash -c 'trap "echo OK" EXIT; sleep 6'` seguido de
#      `kill -TERM` no PID imprime OK, rc=143. Não existe a tal disposição
#      "padrão" que pule o trap EXIT — a premissa do parágrafo antigo era
#      falsa mesmo sem o `timeout` de grupo entrar em cena.
#   2) Pior: um `trap TERM` aqui fica em TENSÃO com o teto de 3s. Se o SIGTERM
#      chegar só a ESTE processo — não ao grupo — enquanto um subprocess
#      daqui (`git show`) está bloqueado em primeiro plano (`timeout
#      --foreground`, um `timeout` sem setpgid, ou um `kill` direto ao PID
#      cobrem esse caso), o bash represa o trap até o subprocess terminar.
#      Medido: ~9,5s até morrer COM o trap (quase o tempo total do subprocess
#      bloqueante do teste) contra ~9ms SEM ele. Um trap aqui é exatamente o
#      tipo de coisa que desativaria o teto que este script existe para
#      respeitar quando chamado pelo hook.
# Por isso: SEM trap TERM. O trap EXIT sozinho já limpa em todo caminho
# medido, e tirar o TERM fecha a tensão do item 2 sem reabrir o item 1.

# ── materializa a fonte ───────────────────────────────────────────────────────
if [ "$fonte" = "daqui" ]; then
  desc="scripts/heavy.sh desta worktree"
  cp "$here/heavy.sh" "$tmp_fonte" 2>/dev/null || {
    echo "heavy-install: $here/heavy.sh não encontrado" >&2; falhar_fonte; }
else
  desc="origin/main:scripts/heavy.sh"
  # `git show` porque a worktree pode estar em QUALQUER branch — o arquivo de
  # origin/main não está no working tree. Lê o object DB compartilhado, sem rede.
  git -C "$here" show origin/main:scripts/heavy.sh > "$tmp_fonte" 2>/dev/null || {
    echo "heavy-install: não consegui ler $desc" >&2
    echo "  → 'git fetch origin' resolve; ou use --daqui para instalar o desta worktree." >&2
    falhar_fonte; }
fi

# Fail-closed: nunca publicar arquivo vazio/parcial por cima do semáforo.
if [ ! -s "$tmp_fonte" ]; then
  echo "heavy-install: fonte vazia ($desc) — abortando, destino intacto" >&2
  falhar_fonte
fi

sha_de() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha_fonte="$(sha_de "$tmp_fonte")"
sha_dest=""
if [ -f "$DEST" ]; then sha_dest="$(sha_de "$DEST")"; fi

# ── --status: só reporta, contrato de 4 estados (ver header) ─────────────────
if [ "$modo" = "status" ]; then
  if [ -z "$sha_dest" ]; then
    echo "heavy NÃO instalado ($DEST ausente) — fonte $desc"
    exit 1
  elif [ "$sha_fonte" = "$sha_dest" ]; then
    echo "heavy sincronizado com $desc (${sha_fonte:0:12})"
    exit 0
  else
    # "Em voo": o instalado pode bater com O ARQUIVO DESTA WORKTREE (alguém
    # rodou --daqui de propósito) e só divergir do origin/main — não é o mesmo
    # que estar desatualizado/errado. Só faz sentido comparar contra o arquivo
    # local quando a fonte checada FOI origin/main (fonte=main); se o próprio
    # --status já rodou com --daqui, a fonte já É o local — não há "em voo" a
    # detectar nesse caso (não há origin/main no meio da comparação).
    if [ "$fonte" = "main" ] && [ -s "$here/heavy.sh" ]; then
      sha_local="$(sha_de "$here/heavy.sh")"
      if [ "$sha_local" = "$sha_dest" ]; then
        echo "heavy EM VOO — instalado (${sha_dest:0:12}) == scripts/heavy.sh desta worktree, ≠ $desc (${sha_fonte:0:12}). Parece --daqui proposital nesta worktree; se não foi você, confira quem instalou."
        exit 0
      fi
    fi
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
