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
#     exit 0  EM VOO — instalado == scripts/heavy.sh desta worktree, ≠ origin/main, e esse
#             arquivo do disco NÃO está na história da main: mudança local não mergeada
#             (alguém rodou --daqui de propósito; mensagem distingue do sincronizado)
#     exit 1  DIVERGENTE (a comparação foi FEITA e deu diferente), DEFASADO (instalado ==
#             disco, mas o disco é uma versão ANTIGA da main — worktree atrasado) OU ausente
#     exit 3  NÃO CONSEGUI VERIFICAR — origin/main ilegível (sem fetch), fonte vazia,
#             mktemp falhou, a DIREÇÃO do "instalado == disco ≠ main" não foi desempatável,
#             ou o CHAMADOR (o hook) estourou o teto de tempo. A mensagem diz o que fazer;
#             NUNCA é o mesmo que "divergente" (ausência de dado ≠ afirmação de divergência).
#   "Instalado mas fora do PATH" entra como NOTA na mensagem dos exit 0, sem exit
#   code próprio — o PATH lido é o DESTE processo, e no hook isso é o PATH do app
#   (nag permanente e falso). Ver o bloco comentado no --status.
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
# "Instalado mas FORA do PATH" é NOTA na mensagem, não um 5º estado de saída — e
# a assimetria é deliberada. Quem lê o $PATH aqui é ESTE processo, e ele muda com
# o chamador: à MÃO no terminal é o PATH do perfil de shell (a leitura CERTA — é
# lá que o founder digita `heavy`); pelo vigia-worktree.sh é o PATH do processo
# do app, que não vem do perfil e pode divergir — o próprio hook documenta essa
# divergência medida para /opt/homebrew/bin no fallback do `timeout`.
# (Medido nesta máquina em 2026-07-20: o PATH do app TEM ~/.local/bin, 12
# entradas — hoje a nota não dispararia por aqui. O risco não é o hoje: é uma
# máquina/versão do app onde não tenha, e aí um exit code novo faria o hook
# avisar em TODA sessão sobre um problema inexistente no shell onde o `heavy` de
# fato roda — nag permanente, que treina todo mundo a ignorar o bloco 4,
# inclusive o aviso de divergência que ele existe pra dar. E quebraria as
# asserções de silêncio do test-hooks-sessionstart.sh, que são o CONTRATO desse
# silêncio.) Por isso a nota só aparece nos estados que o hook descarta (exit 0):
# quem a lê é humano, com o PATH certo na mão. No DIVERGENTE/ausente o remédio já
# é reinstalar, e o caminho de instalação termina avisando do PATH sozinho.
# O heavy-guard.sh NÃO depende disto: quando o nome nu não resolve, ele reescreve
# com o caminho absoluto — o comando pesado roda com PATH ou sem.
nota_path=""
case ":$PATH:" in
  *":$(dirname "$DEST"):"*) : ;;
  *) nota_path=" · ⚠️ $(dirname "$DEST") fora do PATH deste processo: 'heavy' digitado à mão sai 127 (o hook heavy-guard usa o caminho absoluto e não é afetado)" ;;
esac

# ── desempate de DIREÇÃO: "instalado == disco ≠ main" tem DUAS causas opostas ──
# Ler o sha do scripts/heavy.sh DESTE worktree e concluir "em voo" é a classe
# "sensor que julga contra a REF mas lê DADO versionado do DISCO"
# (docs/historico/sonda-le-worktree-defasado.md): o mesmo sinal sai de
#   (a) disco À FRENTE da main — mudança em voo, alguém rodou --daqui: exit 0 certo;
#   (b) disco ATRÁS da main — worktree defasado cujo heavy.sh é velho, e o instalado
#       veio daquele arquivo velho: é EXATAMENTE o caso que este script existe para
#       pegar (32 das 39 worktrees em 2026-07-20), e o ramo "em voo" é o SILENCIOSO
#       no vigia-worktree.sh — o heavy velho ficaria instalado indefinidamente.
# O desempate vem do git, não de heurística de texto: o blob do arquivo do disco
# está na HISTÓRIA de origin/main para esse caminho?
#   está      ⇒ ATRAS      (versão que já esteve na main ⇒ o disco é a antiga)
#   não está  ⇒ A_FRENTE   (conteúdo que nunca foi mergeado ⇒ em voo de verdade)
# `git log --raw` dá os blobs old+new de cada revisão do path em UM fork (medido:
# 0,33s com 6.535 commits, bem dentro do teto de 3s que o hook aplica) — por isso
# não há um `rev-parse` por commit aqui.
# FAIL-CLOSED: git que não responde, ref ilegível ou história vazia NÃO podem cair
# em A_FRENTE, que é o ramo mudo — viram INDETERMINADO (exit 3, "não consegui
# verificar"). E `command -v git` não basta: o controle é uma resposta POSITIVA —
# a enumeração tem de CONTER o blob da ponta de origin/main (o que ela acabou de
# comparar). Enumeração que não contém a própria ponta não é enumeração confiável
# (docs/historico/sonda-ausente-em-script-que-apaga.md).
direcao_do_disco() {
  local blob_disco blob_ponta pares c b achou_ponta=0 commit_disco=""
  blob_disco="$(git -C "$here" hash-object -- "$here/heavy.sh" 2>/dev/null || true)"
  blob_ponta="$(git -C "$here" rev-parse --verify --quiet "origin/main:scripts/heavy.sh" 2>/dev/null || true)"
  case "$blob_disco$blob_ponta" in
    *[!0-9a-f]* | "") echo INDETERMINADO; return 0 ;;
  esac
  [ ${#blob_disco} -eq 40 ] && [ ${#blob_ponta} -eq 40 ] || { echo INDETERMINADO; return 0; }
  # Coerência: neste ramo sha_local ≠ sha_fonte (o `if` que chama isto garante),
  # logo os blobs TÊM de diferir. Iguais = a mecânica de hashing está mentindo
  # (filtro de conteúdo em .gitattributes, por exemplo) — não arrisque um veredito.
  [ "$blob_disco" != "$blob_ponta" ] || { echo INDETERMINADO; return 0; }

  # Pathspec `:(top)`: `git log -- <pathspec>` é relativo ao CWD, e o `git -C "$here"`
  # põe o CWD em scripts/ — `-- scripts/heavy.sh` ali vira scripts/scripts/heavy.sh e a
  # enumeração sai VAZIA. (A sintaxe `rev:path` do `git show` acima não tem esse problema:
  # ela é sempre relativa à RAIZ. Ler as duas como "mesmo caminho" foi o que o caso 13 da
  # suíte pegou.) `:(top)` ancora na raiz do repo, de qualquer CWD.
  pares="$(git -C "$here" log --no-abbrev --raw --format='%H' origin/main -- ':(top)scripts/heavy.sh' 2>/dev/null |
    awk '/^[0-9a-f]{40}$/ { c = $0; next }
         /^:/ { for (i = 1; i <= NF; i++)
                  if ($i ~ /^[0-9a-f]{40}$/ && $i !~ /^0{40}$/) print c, $i }' || true)"
  [ -n "$pares" ] || { echo INDETERMINADO; return 0; }
  while read -r c b; do
    if [ "$b" = "$blob_ponta" ]; then achou_ponta=1; fi
    if [ "$b" = "$blob_disco" ] && [ -z "$commit_disco" ]; then commit_disco="$c"; fi
  done <<EOF
$pares
EOF
  # O controle POSITIVO. Sem ele, um `git log` que devolve lixo (ou a história de
  # outro path) viraria "o blob do disco não está lá" ⇒ A_FRENTE ⇒ silêncio.
  [ "$achou_ponta" = 1 ] || { echo INDETERMINADO; return 0; }
  if [ -n "$commit_disco" ]; then echo "ATRAS $commit_disco"; else echo A_FRENTE; fi
  return 0
}

if [ "$modo" = "status" ]; then
  if [ -z "$sha_dest" ]; then
    echo "heavy NÃO instalado ($DEST ausente) — fonte $desc"
    exit 1
  elif [ "$sha_fonte" = "$sha_dest" ]; then
    echo "heavy sincronizado com $desc (${sha_fonte:0:12})${nota_path}"
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
        # "instalado == disco ≠ main": desempate obrigatório antes de calar (ver
        # direcao_do_disco acima). Sem ele, o worktree ATRASADO sai 0 e o vigia cala.
        direcao="$(direcao_do_disco)"
        case "$direcao" in
          ATRAS\ *)
            echo "heavy DEFASADO — instalado ${sha_dest:0:12} == scripts/heavy.sh DESTE worktree, mas esse arquivo é uma versão ANTIGA de $desc (entrou na main em ${direcao#ATRAS }); a main já está em ${sha_fonte:0:12}. Não é mudança em voo: é worktree atrasado → rode 'bun run heavy:install'."
            exit 1
            ;;
          A_FRENTE)
            echo "heavy EM VOO — instalado (${sha_dest:0:12}) == scripts/heavy.sh desta worktree, ≠ $desc (${sha_fonte:0:12}), e esse conteúdo não está na história da main: mudança local não mergeada. Parece --daqui proposital nesta worktree; se não foi você, confira quem instalou.${nota_path}"
            exit 0
            ;;
          *)
            # Não passa por falhar_fonte de propósito: ali a frase é "a comparação
            # nem rodou", e aqui ela RODOU — o que faltou foi desempatar a direção.
            # Dizer a causa certa é o ponto do exit 3 (ausência de dado ≠ veredito).
            echo "heavy-install --status: instalado == scripts/heavy.sh desta worktree e ≠ $desc, mas NÃO CONSEGUI desempatar a direção (git não respondeu, ou a enumeração da história não continha o blob da ponta de origin/main)." >&2
            echo "  → 'git fetch origin' resolve o caso comum; ou 'bun run heavy:install' sincroniza com origin/main sem depender deste desempate." >&2
            exit 3
            ;;
        esac
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
