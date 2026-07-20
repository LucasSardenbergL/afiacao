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

# ── 8 — fonte vazia com --daqui: falha e NÃO destrói o destino
sha_antes="$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)"
git init -q "$TD/semfonte"
mkdir -p "$TD/semfonte/scripts"
cp "$here/heavy-install.sh" "$TD/semfonte/scripts/heavy-install.sh"
touch "$TD/semfonte/scripts/heavy.sh"  # arquivo vazio
if bash "$TD/semfonte/scripts/heavy-install.sh" --daqui >/dev/null 2>&1; then
  bad "fonte vazia instalou mesmo assim"
else
  ok "fonte vazia → exit != 0"
fi
if [ "$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)" = "$sha_antes" ]; then
  ok "destino intacto após falha"
else
  bad "destino corrompido por fonte vazia"
fi

# ── 9 — origin/main ilegível (repo sem origin/main): falha e NÃO destrói o destino
sha_antes="$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)"
git init -q "$TD/semmain"
mkdir -p "$TD/semmain/scripts"
cp "$here/heavy-install.sh" "$TD/semmain/scripts/heavy-install.sh"
if bash "$TD/semmain/scripts/heavy-install.sh" >/dev/null 2>&1; then
  bad "origin/main ilegível instalou mesmo assim"
else
  ok "origin/main ilegível → exit != 0"
fi
if [ "$(shasum -a 256 "$AFIACAO_HEAVY_DEST" | cut -d' ' -f1)" = "$sha_antes" ]; then
  ok "destino intacto após falha (origin/main ilegível)"
else
  bad "destino corrompido por origin/main ilegível"
fi

# ── 10 · 11 · 12 — --status: reporta sincronizado, divergente, e ausente
# Voltar ao sincronizado com origin/main (o --daqui acima deixou divergente)
bash "$INST" >/dev/null 2>&1
if bash "$INST" --status >/dev/null 2>&1; then
  ok "--status quando sincronizado sai 0"
else
  bad "--status quando sincronizado sai != 0"
fi

# --status divergente: mudar o arquivo instalado, depois verificar
printf '#!/usr/bin/env bash\necho DIVERGENTE\n' > "$AFIACAO_HEAVY_DEST"
if ! bash "$INST" --status >/dev/null 2>&1; then
  ok "--status quando divergente sai != 0"
else
  bad "--status quando divergente sai 0"
fi

# --status quando ausente: remover o arquivo e verificar
rm "$AFIACAO_HEAVY_DEST"
if ! bash "$INST" --status >/dev/null 2>&1; then
  ok "--status quando ausente sai != 0"
else
  bad "--status quando ausente sai 0"
fi

echo
if [ "$fail" = 0 ]; then echo "test-heavy-install.sh: TUDO VERDE"; else echo "test-heavy-install.sh: FALHAS ACIMA"; fi
exit "$fail"
