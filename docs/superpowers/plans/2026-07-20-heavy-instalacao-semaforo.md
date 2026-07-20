# Instalação do `heavy` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer com que uma mudança em `scripts/heavy.sh` mergeada na `main` chegue ao `~/.local/bin/heavy` que todas as sessões usam — hoje isso é cópia manual e o #1459 ficou mergeado e inerte.

**Architecture:** Um instalador (`scripts/heavy-install.sh`) que copia **atomicamente** de `origin/main` para `~/.local/bin/heavy`, e um bloco no hook SessionStart existente (`vigia-worktree.sh`) que **avisa** — nunca instala — quando o binário em uso diverge. O hook não reimplementa a comparação: chama `heavy-install.sh --status` e lê o exit code.

**Tech Stack:** bash puro (macOS/Darwin: `stat -f`, `shasum`), git, hook SessionStart do Claude Code, `bun run` como front-end de script.

Spec: [`docs/superpowers/specs/2026-07-20-heavy-instalacao-semaforo-design.md`](../specs/2026-07-20-heavy-instalacao-semaforo-design.md)

## Global Constraints

- **Idioma:** comentários, mensagens e nomes em **pt-BR** (convenção do repo).
- **`shellcheck scripts/*.sh .claude/hooks/*.sh` deve sair exit 0** — faz parte do health stack.
- **`bash scripts/test-heavy.sh` deve continuar verde** (11 asserções de concorrência). Esse arquivo **não é modificado** por nenhuma task deste plano.
- **macOS-only** é aceitável e esperado (`stat -f`, `sysctl`), como o resto da família `heavy`. O CI é ubuntu e **não** roda estes testes.
- **Fonte padrão de instalação é `origin/main`**, nunca o `scripts/heavy.sh` da worktree. Em 2026-07-20, 32 das 39 worktrees carregavam o `heavy.sh` pré-#1459; instalar "o daqui" por padrão andaria o semáforo para trás.
- **Nunca tocar `/tmp/afiacao-heavy-slots`** nos testes (há sessões reais nele) nem o `~/.local/bin` real — usar `AFIACAO_HEAVY_DEST` e sandbox.
- **Fail-closed:** fonte vazia/ilegível → erro e destino **intacto**. Nunca instalar arquivo parcial.
- Commits com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Instalador — fonte `origin/main`, cópia atômica, idempotente

**Files:**
- Create: `scripts/heavy-install.sh`
- Create: `scripts/test-heavy-install.sh`
- Modify: `package.json` (bloco `scripts`, após a linha `"claude:size"`)

**Interfaces:**
- Produces:
  - `scripts/heavy-install.sh` — sem flags: instala `origin/main:scripts/heavy.sh` em `$AFIACAO_HEAVY_DEST` (default `$HOME/.local/bin/heavy`). Exit 0 = instalado ou já sincronizado; exit 1 = fonte ilegível/vazia; exit 2 = flag desconhecida.
  - Variável de ambiente `AFIACAO_HEAVY_DEST` — override do destino, usada pelos testes.
  - Backup em `$(dirname "$DEST")/.heavy.bak`.
  - `bun run heavy:install`.
- Consumes: nada (primeira task).

- [ ] **Step 1: Escrever o teste que falha**

Crie `scripts/test-heavy-install.sh`:

```bash
#!/usr/bin/env bash
# test-heavy-install.sh — TDD do instalador do semáforo (scripts/heavy-install.sh).
#
# As duas asserções que realmente FALSIFICAM (spec 2026-07-20):
#   • inode do destino MUDA a cada instalação efetiva → trocar tmp+mv por `cp` = vermelho.
#     Medido: `cp` sobre o destino preserva o inode (reescreve in-place) e corromperia um
#     `heavy` dormindo na fila, que relê o script por offset de byte; `mv` publica inode novo.
#   • o default instala o de origin/main, NÃO o da worktree → protege contra reinstalar a
#     versão antiga que 32 das 39 worktrees carregavam em 2026-07-20.
#
# Isolado: sandbox em /tmp + AFIACAO_HEAVY_DEST. Nunca toca ~/.local/bin real.
# macOS/local (stat -f), como o resto da família heavy. Uso: bash scripts/test-heavy-install.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
TD="$(mktemp -d /tmp/heavy-install-test.XXXXXX)"
# shellcheck disable=SC2329  # invocada indiretamente pelo trap EXIT
limpar() { rm -rf "$TD"; }
trap limpar EXIT

fail=0
ok()  { echo "  ok    $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

# ── sandbox: origin/main tem VERSAO-MAIN, o working tree tem VERSAO-LOCAL.
# Essa divergência É o caso das 32 worktrees antigas — sem ela o teste 3 não prova nada.
git init -q --bare "$TD/upstream"
work="$TD/work"
git init -q "$work"
git -C "$work" remote add origin "$TD/upstream"
mkdir -p "$work/scripts"
cp "$here/heavy-install.sh" "$work/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho VERSAO-MAIN\n' > "$work/scripts/heavy.sh"
git -C "$work" add -A
git -C "$work" -c user.email=t@t -c user.name=t commit -qm base
git -C "$work" push -q origin HEAD:main
git -C "$work" fetch -q origin
printf '#!/usr/bin/env bash\necho VERSAO-LOCAL\n' > "$work/scripts/heavy.sh"

INST="$work/scripts/heavy-install.sh"
export AFIACAO_HEAVY_DEST="$TD/bin/heavy"
BAK="$TD/bin/.heavy.bak"

echo "test-heavy-install.sh — alvo: $here/heavy-install.sh"
echo "sandbox: $TD"

# ── 1 · 3 · 7 — instala quando ausente, de origin/main, executável
bash "$INST" >/dev/null 2>&1
if [ -f "$AFIACAO_HEAVY_DEST" ]; then ok "instala quando ausente"; else bad "não instalou"; fi
if grep -q VERSAO-MAIN "$AFIACAO_HEAVY_DEST" 2>/dev/null; then
  ok "default instala o de origin/main"
else
  bad "default NÃO veio de origin/main — instalaria a versão antiga das 32 worktrees"
fi
if [ -x "$AFIACAO_HEAVY_DEST" ]; then ok "destino executável"; else bad "destino sem +x"; fi

# ── 5 — idempotência: 2ª execução não reescreve o arquivo
ino_a="$(stat -f %i "$AFIACAO_HEAVY_DEST" 2>/dev/null || echo A)"
bash "$INST" >/dev/null 2>&1
ino_b="$(stat -f %i "$AFIACAO_HEAVY_DEST" 2>/dev/null || echo B)"
if [ "$ino_a" = "$ino_b" ]; then ok "idempotente: 2ª execução não reescreve"; else bad "reescreveu sem necessidade"; fi

# ── 2 · 6 · 4 — instalação efetiva: inode NOVO, backup, e --daqui pega o local
bash "$INST" --daqui >/dev/null 2>&1
ino_c="$(stat -f %i "$AFIACAO_HEAVY_DEST" 2>/dev/null || echo C)"
if [ "$ino_b" != "$ino_c" ]; then
  ok "instalação efetiva publica INODE NOVO (mv atômico, não cp in-place)"
else
  bad "inode preservado — cp in-place corromperia um heavy em execução"
fi
if grep -q VERSAO-MAIN "$BAK" 2>/dev/null; then
  ok "backup .heavy.bak guarda o conteúdo anterior"
else
  bad "backup ausente ou com conteúdo errado"
fi
if grep -q VERSAO-LOCAL "$AFIACAO_HEAVY_DEST" 2>/dev/null; then
  ok "--daqui instala o da worktree"
else
  bad "--daqui não instalou o local"
fi

# ── 8 — fonte inválida (repo sem origin/main): falha e NÃO destrói o destino
sha_antes="$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)"
git init -q "$TD/semmain"
mkdir -p "$TD/semmain/scripts"
cp "$here/heavy-install.sh" "$TD/semmain/scripts/heavy-install.sh"
if bash "$TD/semmain/scripts/heavy-install.sh" >/dev/null 2>&1; then
  bad "fonte inválida instalou mesmo assim"
else
  ok "fonte inválida → exit != 0"
fi
if [ "$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)" = "$sha_antes" ]; then
  ok "destino intacto após falha"
else
  bad "destino corrompido por fonte inválida"
fi

echo
if [ "$fail" = 0 ]; then echo "test-heavy-install.sh: TUDO VERDE"; else echo "test-heavy-install.sh: FALHAS ACIMA"; fi
exit "$fail"
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
bash scripts/test-heavy-install.sh; echo "exit=$?"
```

Esperado: `cp: .../heavy-install.sh: No such file or directory` e `exit=1`. O instalador ainda não existe.

- [ ] **Step 3: Escrever o instalador**

Crie `scripts/heavy-install.sh`:

```bash
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
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
chmod +x scripts/heavy-install.sh scripts/test-heavy-install.sh
bash scripts/test-heavy-install.sh; echo "exit=$?"
```

Esperado: 10 linhas `ok`, `test-heavy-install.sh: TUDO VERDE`, `exit=0`.

- [ ] **Step 5: FALSIFICAR — sabotar e exigir vermelho**

Sem isto o teste é teatro. Três sabotagens, uma de cada vez, revertendo após cada uma:

```bash
# (a) atomicidade: trocar tmp+mv por cp in-place
cp scripts/heavy-install.sh /tmp/hi.bak
perl -0pi -e 's/tmp_dest="\$\(dirname "\$DEST"\)\/\.heavy\.tmp\.\$\$"\ncp "\$tmp_fonte" "\$tmp_dest"\nchmod \+x "\$tmp_dest"\nmv -f "\$tmp_dest" "\$DEST"/cp "\$tmp_fonte" "\$DEST"\nchmod +x "\$DEST"/' scripts/heavy-install.sh
bash scripts/test-heavy-install.sh; echo "exit=$?   # esperado: FAIL 'inode preservado' + exit=1"
cp /tmp/hi.bak scripts/heavy-install.sh

# (b) fonte errada: default passa a instalar o da worktree
perl -pi -e 's/^fonte="main"$/fonte="daqui"/' scripts/heavy-install.sh
bash scripts/test-heavy-install.sh; echo "exit=$?   # esperado: FAIL 'default NÃO veio de origin/main' + exit=1"
cp /tmp/hi.bak scripts/heavy-install.sh

# (c) fail-open: instalar mesmo com fonte vazia
perl -pi -e 's/^if \[ ! -s "\$tmp_fonte" \]; then$/if false; then/' scripts/heavy-install.sh
bash scripts/test-heavy-install.sh; echo "exit=$?   # esperado: FAIL 'fonte inválida instalou' + exit=1"
cp /tmp/hi.bak scripts/heavy-install.sh; rm -f /tmp/hi.bak

# confirma que voltou ao verde
bash scripts/test-heavy-install.sh; echo "exit=$?   # esperado: exit=0"
```

Se qualquer sabotagem sair **verde**, a asserção correspondente não prova nada — conserte o teste antes de seguir.

- [ ] **Step 6: Registrar no package.json**

Em `package.json`, no bloco `scripts`, após a linha `"claude:size": "bash scripts/check-claude-md-budget.sh"` (acrescente a vírgula na linha anterior):

```json
    "claude:size": "bash scripts/check-claude-md-budget.sh",
    "heavy:install": "bash scripts/heavy-install.sh"
```

- [ ] **Step 7: shellcheck**

```bash
shellcheck scripts/heavy-install.sh scripts/test-heavy-install.sh; echo "exit=$?"
```

Esperado: `exit=0`, sem saída.

- [ ] **Step 8: Commit**

```bash
git add scripts/heavy-install.sh scripts/test-heavy-install.sh package.json
git commit -m "$(cat <<'EOF'
feat(heavy): instalador atômico do semáforo, fonte origin/main

~/.local/bin/heavy é CÓPIA de scripts/heavy.sh — mergear na main não atualiza o
semáforo em uso (#1459 ficou mergeado e inerte). `bun run heavy:install` fecha isso.

Fonte é origin/main, não a worktree: 32 das 39 worktrees carregavam o heavy.sh
pré-#1459, então instalar "o daqui" andaria o semáforo para trás (--daqui força o
local, para provar mudança em voo). Cópia atômica (tmp no dir do destino + mv):
cp in-place preserva o inode e corromperia um heavy dormindo na fila, que relê o
script por offset de byte.

8 asserções em scripts/test-heavy-install.sh, cada uma falsificada.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Aviso no SessionStart (`vigia-worktree.sh`)

**Files:**
- Modify: `.claude/hooks/vigia-worktree.sh` (novo bloco após o bloco 3, antes de `# --- saída ---`)
- Modify: `.claude/settings.json` (array `permissions.allow`)

**Interfaces:**
- Consumes: `bash scripts/heavy-install.sh --status` da Task 1 — exit 0 = sincronizado, exit 1 = divergente ou ausente, stdout = a frase legível.
- Produces: nada consumido por tasks posteriores.

- [ ] **Step 1: Acrescentar o bloco no hook**

Em `.claude/hooks/vigia-worktree.sh`, insira entre o bloco `# --- 3) sessões Claude vivas ---` e `# --- saída ---`:

```bash
# --- 4) semáforo `heavy` desatualizado ou ausente -----------------------------
# ~/.local/bin/heavy é CÓPIA de scripts/heavy.sh: mergear na main NÃO atualiza o
# semáforo em uso (#1459 ficou inerte). Só AVISA — não instala: o CI é ubuntu e
# nunca prova o heavy (test-heavy.sh é macOS-only), então auto-instalar propagaria
# para todas as sessões um script não validado, sem ninguém no circuito.
# A comparação NÃO é reimplementada aqui: quem define "divergente" é o
# heavy-install.sh --status, num lugar só. Script ausente (worktree antiga) → silêncio.
if [ -x scripts/heavy-install.sh ]; then
  if ! st="$(bash scripts/heavy-install.sh --status 2>/dev/null)"; then
    avisos="${avisos}${st:-heavy divergente} → rode 'bun run heavy:install' (o heavy em uso é CÓPIA de scripts/heavy.sh; merge na main não atualiza o semáforo). "
  fi
fi
```

- [ ] **Step 2: Exercitar os três caminhos do hook**

O hook lê `scripts/heavy-install.sh` relativo ao cwd, então rode da raiz da worktree:

```bash
# (a) sincronizado → silêncio (JSON sem menção a heavy)
bash scripts/heavy-install.sh >/dev/null 2>&1
echo '{}' | bash .claude/hooks/vigia-worktree.sh | grep -c heavy
# esperado: 0

# (b) divergente → avisa. Caminho FIXO (não $$: cada invocação teria um PID
# diferente e o segundo comando leria um arquivo que nunca existiu).
printf 'outro\n' > /tmp/heavy-fake-teste
AFIACAO_HEAVY_DEST=/tmp/heavy-fake-teste bash .claude/hooks/vigia-worktree.sh </dev/null | grep -o "DIVERGENTE"
# esperado: DIVERGENTE

# (c) ausente → avisa
AFIACAO_HEAVY_DEST=/tmp/heavy-nao-existe-teste bash .claude/hooks/vigia-worktree.sh </dev/null | grep -o "NÃO instalado"
# esperado: NÃO instalado

rm -f /tmp/heavy-fake-teste
```

- [ ] **Step 3: Confirmar que o hook nunca quebra a sessão**

```bash
# rodando de FORA da worktree: sem scripts/heavy-install.sh no cwd, o bloco 4
# não deve rodar nem quebrar. Captura o caminho antes de sair do diretório.
HOOK="$PWD/.claude/hooks/vigia-worktree.sh"
(cd /tmp && echo '{}' | bash "$HOOK" >/dev/null 2>&1; echo "exit=$?")
```

Esperado: `exit=0`. O hook é best-effort — qualquer falha interna vira silêncio.

- [ ] **Step 4: Liberar o comando no settings.json**

Em `.claude/settings.json`, no array `permissions.allow`, após a linha `"Bash(bun run claude:size)",`:

```json
      "Bash(bun run claude:size)",
      "Bash(bun run heavy:install)",
      "Bash(scripts/heavy-install.sh:*)",
```

Sem isto, cada sessão pede permissão para o remédio que o próprio hook acabou de sugerir.

- [ ] **Step 5: shellcheck + validar o JSON**

```bash
shellcheck .claude/hooks/vigia-worktree.sh; echo "shellcheck=$?"
jq -e . .claude/settings.json >/dev/null; echo "json=$?"
```

Esperado: `shellcheck=0` e `json=0`.

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/vigia-worktree.sh .claude/settings.json
git commit -m "$(cat <<'EOF'
feat(heavy): SessionStart avisa quando o semáforo em uso diverge da main

Quarto bloco do vigia-worktree.sh: chama heavy-install.sh --status e injeta o
aviso quando o ~/.local/bin/heavy diverge de origin/main — ou está ausente (hoje
o heavy-guard fail-opens em silêncio nesse caso, então máquina sem semáforo não
avisava ninguém).

Só avisa, não instala: o CI é ubuntu e nunca prova o heavy (test-heavy.sh é
macOS-only). O hook não reimplementa a comparação — uma definição de "divergente",
num lugar só.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Documentar o remédio em `worktrees.md`

**Files:**
- Modify: `docs/agent/worktrees.md:49` (o parágrafo ⚠️ da §`heavy`)

**Interfaces:**
- Consumes: `bun run heavy:install` e `--daqui` (Task 1); aviso do SessionStart (Task 2).
- Produces: nada.

- [ ] **Step 1: Substituir o parágrafo ⚠️**

Em `docs/agent/worktrees.md`, troque a linha 49 inteira (começa com `⚠️ **\`~/.local/bin/heavy\` é CÓPIA`) por:

```markdown
⚠️ **`~/.local/bin/heavy` é CÓPIA, não symlink: mergear na `main` não atualiza o semáforo em uso** (mesma armadilha do Lovable — repo ≠ produção; o #1459 ficou mergeado e INERTE até a cópia manual). **Remédio: `bun run heavy:install`** (`scripts/heavy-install.sh`) — fonte **`origin/main`**, NÃO o `scripts/heavy.sh` desta worktree: em 2026-07-20, 32 das 39 worktrees carregavam o `heavy.sh` pré-#1459, então instalar "o daqui" andaria o semáforo **para trás** (`--daqui` força o local, para provar mudança em voo antes de mergear). A cópia é **atômica** (tmp no dir do DESTINO + `mv`): `cp` por cima do destino reescreve o MESMO inode e corrompe um `heavy` em execução, que relê o script por offset de byte — o `mv` publica inode novo e quem está na fila termina no arquivo antigo. Convivência de versões é segura (o antigo ignora o subdir `fila/`; só não entra no FIFO). O hook `vigia-worktree.sh` **avisa** no SessionStart quando o instalado diverge do `origin/main` (ou está ausente) — não auto-instala, porque o CI é ubuntu e **nunca prova o `heavy`** (`test-heavy.sh` é macOS-only). Symlink foi rejeitado: faria a versão em vigor ser função de qual branch o repo principal tem em check-out. Cobertura não é retroativa — worktree antiga não tem o hook novo nem o instalador.
```

- [ ] **Step 2: Conferir que o CLAUDE.md não estourou**

O `worktrees.md` cresceu, mas o CLAUDE.md não foi tocado. Confirme:

```bash
bun run claude:size; echo "exit=$?"
git diff --stat CLAUDE.md
```

Esperado: `exit=0` e diff vazio para `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/agent/worktrees.md
git commit -m "$(cat <<'EOF'
docs(heavy): registra o remédio da lacuna cópia-manual em worktrees.md

O ⚠️ já descrevia a armadilha; agora tem o remédio (bun run heavy:install, fonte
origin/main, --daqui para mudança em voo) e o aviso do SessionStart. Registra por
que symlink foi rejeitado e que a cobertura não é retroativa.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verificação final e PR

**Files:** nenhum (só verificação).

**Interfaces:** Consumes tudo das Tasks 1-3.

- [ ] **Step 1: Health stack completo**

`| tail` engole o exit code — capture explicitamente:

```bash
shellcheck scripts/*.sh .claude/hooks/*.sh > /tmp/sc.log 2>&1; echo "shellcheck=$?"
bash scripts/test-heavy-install.sh > /tmp/thi.log 2>&1; echo "test-install=$?"
bash scripts/test-heavy.sh > /tmp/th.log 2>&1; echo "test-heavy=$?"
bash scripts/test-heavy-guard.sh > /tmp/thg.log 2>&1; echo "test-guard=$?"
```

Esperado: os quatro `=0`. O `test-heavy.sh` leva ~50s e **não pode** ter regredido — as 11 asserções de concorrência são o contrato do #1459.

- [ ] **Step 2: Instalar de verdade e confirmar idempotência na máquina real**

```bash
bash scripts/heavy-install.sh --status; echo "status=$?"
bun run heavy:install
bun run heavy:install   # 2ª vez: "já sincronizado — nada a fazer"
heavy --status | head -3
```

Esperado: a 2ª execução diz `já sincronizado`; o `heavy --status` continua funcionando (slots/fila).

- [ ] **Step 3: Abrir o PR e armar o watcher**

```bash
git push -u origin claude/youthful-wright-ca4cec
gh pr create --title "feat(heavy): fechar a lacuna \"merge ≠ semáforo em uso\"" --body "$(cat <<'EOF'
## Problema

`~/.local/bin/heavy` é uma **cópia manual** de `scripts/heavy.sh` — mergear na `main`
não atualiza o semáforo que todas as sessões usam. Mordeu no #1459: a correção de 3
bugs de concorrência ficou mergeada e **inerte** até alguém copiar à mão.

## Achado que definiu o desenho

```
 32 worktrees  a7c9fc34c946   ← heavy.sh pré-#1459
  7 worktrees  1b7da797ebb6   ← versão vigente
```

**32 das 39 worktrees carregam o `heavy.sh` antigo.** Um check que comparasse o
instalado contra o arquivo da worktree local daria alarme falso em 82% das sessões — e
seguir o conselho dele **reinstalaria a versão bugada**. Por isso a referência do check
e do instalador é `origin/main`, nunca o arquivo local.

## O que entra

- `bun run heavy:install` — cópia **atômica** (tmp no dir do destino + `mv`) de
  `origin/main:scripts/heavy.sh`. `--daqui` instala o da worktree (mudança em voo),
  `--status` só compara. Backup em `.heavy.bak`, idempotente, fail-closed.
- Aviso no SessionStart (`vigia-worktree.sh`) quando o instalado diverge — **ou está
  ausente**, caso em que hoje o `heavy-guard` fail-opens em silêncio.
- 8 asserções em `scripts/test-heavy-install.sh`, **cada uma falsificada**. As duas que
  carregam peso: o inode do destino muda a cada instalação efetiva (trocar `mv` por `cp`
  → vermelho) e o default vem de `origin/main` (inverter → vermelho).

## O que NÃO entra, e por quê

- **Auto-instalação:** o CI é ubuntu e nunca prova o `heavy` (`test-heavy.sh` é
  macOS-only). Auto-instalar propagaria para as ~22 sessões vivas um script não
  validado, sem ninguém no circuito.
- **Gate de CI:** o alvo mora fora do repo, na máquina do founder.
- **Symlink:** faria a versão em vigor ser função de qual branch o repo principal tem
  em check-out. (A hipótese de que corromperia processo em voo foi **testada e é
  falsa** — `git checkout` grava inode novo. `cp` é que preserva o inode; daí o `mv`.)

## Limite conhecido

Cobertura não é retroativa: as 32 worktrees antigas não têm o hook novo nem o
instalador. Cresce sozinha conforme worktrees nascem de `bun run wt`.

Spec: `docs/superpowers/specs/2026-07-20-heavy-instalacao-semaforo-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Em seguida, arme o watcher em background (Bash `run_in_background: true`) e avise o founder no desfecho:

```bash
bash scripts/pr-watch.sh <nº do PR>
```

- [ ] **Step 4: Avisar o founder do passo manual**

O `heavy:install` **não** roda sozinho depois do merge. Entregue no chat, com `cd` antes:

```bash
cd /Users/lucassardenberg/Projetos/afiacao && bun run heavy:install
```

(Nesta sessão o instalador já rodou no Step 2, então na prática dirá "já sincronizado" — o comando existe para a **próxima** vez que o `heavy.sh` mudar.)
