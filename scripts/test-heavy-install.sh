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

# ── 13 · 14 · 15 — a DIREÇÃO de "instalado == disco ≠ main" (classe
# "sensor que julga contra a REF mas lê DADO versionado do DISCO",
# docs/historico/sonda-le-worktree-defasado.md).
# O mesmo sinal sai de duas causas OPOSTAS, e uma delas é o ramo MUDO do
# vigia-worktree.sh (exit 0). Sem estes três casos, o worktree ATRASADO —
# justo o que este script existe para pegar — saía 0 e o heavy velho ficava.
# Cada caso casa a MARCA do ramo (ASCII, caixa fixa, sem -i), não "saiu != 0".

# 13 — disco ATRÁS da main ⇒ DEFASADO, e com rc=1: é o código que o
# vigia-worktree.sh transforma em AVISO (`case "$rc" in 1) avisos=...`). rc=0
# ali é silêncio — por isso o teste cobra o 1, não um "diferente de zero".
git init -q --bare "$TD/up-atras"
atras="$TD/atras"
git init -q "$atras"
git -C "$atras" remote add origin "$TD/up-atras"
mkdir -p "$atras/scripts"
cp "$here/heavy-install.sh" "$atras/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho VERSAO-ANTIGA\n' > "$atras/scripts/heavy.sh"
git -C "$atras" add -A
git -C "$atras" -c user.email=t@t -c user.name=t commit -qm v1
printf '#!/usr/bin/env bash\necho VERSAO-NOVA\n' > "$atras/scripts/heavy.sh"
git -C "$atras" add -A
git -C "$atras" -c user.email=t@t -c user.name=t commit -qm v2
git -C "$atras" push -q origin HEAD:main
git -C "$atras" fetch -q origin
# o worktree defasado DE VERDADE: checkout do commit anterior → o heavy.sh do
# disco volta a ser o VELHO, enquanto origin/main já está no novo.
git -C "$atras" checkout -q HEAD~1
D_ATRAS="$TD/bin-atras/heavy"
AFIACAO_HEAVY_DEST="$D_ATRAS" bash "$atras/scripts/heavy-install.sh" --daqui >/dev/null 2>&1
out_atras="$(AFIACAO_HEAVY_DEST="$D_ATRAS" bash "$atras/scripts/heavy-install.sh" --status 2>&1)"
rc_atras=$?
if [ "$rc_atras" = 1 ]; then
  ok "disco ATRAS da main: rc=1 (o vigia FALA; 0 seria o ramo mudo)"
else
  bad "disco ATRAS da main: rc=$rc_atras, esperado 1 — vigia cala e o heavy velho fica"
fi
case "$out_atras" in
  *DEFASADO*) ok "disco ATRAS da main: marca DEFASADO" ;;
  *) bad "disco ATRAS da main: sem a marca DEFASADO (saiu: $out_atras)" ;;
esac
case "$out_atras" in
  *"EM VOO"*) bad "disco ATRAS da main veredito EM VOO — exatamente o defeito da classe" ;;
  *) ok "disco ATRAS da main NAO sai como EM VOO" ;;
esac

# 14 — disco À FRENTE (VERSAO-LOCAL nunca commitada em $work) ⇒ EM VOO, exit 0.
# É o caso legítimo do --daqui: tem de continuar calando, senão o fix do 13 vira nag.
D_VOO="$TD/bin-voo/heavy"
AFIACAO_HEAVY_DEST="$D_VOO" bash "$INST" --daqui >/dev/null 2>&1
out_voo="$(AFIACAO_HEAVY_DEST="$D_VOO" bash "$INST" --status 2>&1)"
rc_voo=$?
if [ "$rc_voo" = 0 ]; then ok "disco A FRENTE: exit 0"; else bad "disco A FRENTE: rc=$rc_voo, esperado 0 (nag falso no --daqui proposital)"; fi
case "$out_voo" in
  *"EM VOO"*) ok "disco A FRENTE: marca EM VOO" ;;
  *) bad "disco A FRENTE: sem a marca EM VOO (saiu: $out_voo)" ;;
esac

# 15 — FAIL-CLOSED: git que não responde NÃO pode cair no ramo mudo.
# Mesmíssimo cenário do 14 (que sai 0), só com o subcomando `log` emudecido:
# se o veredito continuar 0, a sonda ausente estaria virando aprovação.
# `command -v git` não bastaria aqui — o git existe e responde a tudo menos ao
# `log` (docs/historico/sonda-ausente-em-script-que-apaga.md).
mkdir -p "$TD/stubbin"
cat > "$TD/stubbin/git" <<'STUB'
#!/usr/bin/env bash
# Repassa ao git real, menos `git log` (exit 1, stdout vazio). O subcomando é a
# primeira palavra que não é opção — `-C <dir>` e `-c <k=v>` carregam VALOR.
pula=0
for a in "$@"; do
  if [ "$pula" = 1 ]; then pula=0; continue; fi
  case "$a" in
    -C|--git-dir|--work-tree|-c) pula=1; continue ;;
    -*) continue ;;
  esac
  if [ "$a" = "log" ]; then exit 1; fi
  break
done
exec "${GIT_REAL:?stub: GIT_REAL nao definido}" "$@"
STUB
chmod +x "$TD/stubbin/git"
out_mudo="$(GIT_REAL="$(command -v git)" PATH="$TD/stubbin:$PATH" AFIACAO_HEAVY_DEST="$D_VOO" bash "$INST" --status 2>&1)"
rc_mudo=$?
if [ "$rc_mudo" = 3 ]; then
  ok "git mudo: exit 3 (NAO CONSEGUI VERIFICAR, nao o ramo mudo)"
else
  bad "git mudo: rc=$rc_mudo, esperado 3 — ausencia de dado virou veredito (saiu: $out_mudo)"
fi

# 16 — o CONTROLE POSITIVO, que o caso 15 NÃO alcança: aqui o `git log` RESPONDE,
# com uma história não-vazia e bem-formada, só que de outro conteúdo — nenhum
# blob dela é o da ponta de origin/main. Sem exigir resposta POSITIVA (a ponta
# presente na enumeração), "o blob do disco não está lá" viraria A_FRENTE ⇒ exit
# 0 ⇒ silêncio: ausência de dado promovida a aprovação. O guard de lista vazia do
# caso 15 não cobre este eixo — a lista aqui tem conteúdo.
mkdir -p "$TD/stubbin-fake"
cat > "$TD/stubbin-fake/git" <<'STUB'
#!/usr/bin/env bash
pula=0
for a in "$@"; do
  if [ "$pula" = 1 ]; then pula=0; continue; fi
  case "$a" in
    -C|--git-dir|--work-tree|-c) pula=1; continue ;;
    -*) continue ;;
  esac
  if [ "$a" = "log" ]; then
    # história sintética, bem-formada, de blobs que não existem neste repo
    echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    printf ':100755 100755 %s %s M\tscripts/heavy.sh\n' \
      bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc
    exit 0
  fi
  break
done
exec "${GIT_REAL:?stub: GIT_REAL nao definido}" "$@"
STUB
chmod +x "$TD/stubbin-fake/git"
out_fake="$(GIT_REAL="$(command -v git)" PATH="$TD/stubbin-fake:$PATH" AFIACAO_HEAVY_DEST="$D_VOO" bash "$INST" --status 2>&1)"
rc_fake=$?
if [ "$rc_fake" = 3 ]; then
  ok "historia sem o blob da PONTA: exit 3 (controle positivo)"
else
  bad "historia sem o blob da PONTA: rc=$rc_fake, esperado 3 — enumeracao nao conferida virou veredito (saiu: $out_fake)"
fi

echo
if [ "$fail" = 0 ]; then echo "test-heavy-install.sh: TUDO VERDE"; else echo "test-heavy-install.sh: FALHAS ACIMA"; fi
exit "$fail"
