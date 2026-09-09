#!/usr/bin/env bash
# test-gate-senha-bootstrap.sh — suíte HERMÉTICA do scripts/gate-senha-bootstrap.sh.
#
# Roda contra uma raiz sintética montada em $TMPDIR (o gate aceita `--raiz`), mais UM caso contra o
# repo de verdade — a fixture prova o comportamento, o repo real prova que o critério não reprova o
# material que existe.
#
# ── O caso que dá nome à suíte: o gate não pode IMPRIMIR o que protege ───────────────────────────
# Um gate de segredo que ecoa a linha ofensora "para ajudar" publica a senha no log do CI, que
# persiste. O caso N7 sabota com `SENHA-FALSA-DO-TESTE-NAO-VAZE` e exige DUAS coisas ao mesmo
# tempo: vermelho E a string ausente de toda a saída. Vermelho sozinho passaria com um gate que
# vaza.
#
# ── E o HOOK, end-to-end ─────────────────────────────────────────────────────────────────────────
# N8..N13 instalam o pre-commit num repo git montado em $TMPDIR (com `core.hooksPath` fixado ali,
# senão um hooksPath global da máquina de quem roda a suíte seria sobrescrito) e fazem `git commit`
# de verdade: barrado com senha, aceito com placeholder. Provar o gate não prova o hook — entre os
# dois há o instalador, o bit de execução e a resolução do caminho. N13 AFIRMA o buraco conhecido
# (`--no-verify` passa), para a limitação viver na suíte e não só na prosa.
#
# ── Falsificação: controle verde na MESMA invocação, e sabotagem que MUDA o arquivo ──────────────
# Antes de CADA sabotagem a raiz é remontada e reconferida verde; se não estiver, a suíte ABORTA —
# uma suíte sempre-vermelha aprova tudo (docs/historico/falsificacao-sem-linha-de-base.md). E
# depois de cada sabotagem o hash da raiz é comparado com o de antes: sabotagem que não mudou nada
# é INERTE, e o vermelho que ela "provoca" viria de outro lugar
# (docs/historico/... guard-noop-sabotagem). Uma por vez, de propósito: sabotar tudo junto não
# distingue "as duas direções funcionam" de "uma funciona e a outra é inalcançável".
#
# ── Dois locales ─────────────────────────────────────────────────────────────────────────────────
# Tudo roda sob LC_ALL=C e sob um locale UTF-8 (pt_BR preferido). Falsificar em UM ambiente não
# prova a asserção (#1483) — e aqui há um eixo sensível a isso: o gate casa a keyword `PASSWORD`
# por classe de caractere mas o PLACEHOLDER em caixa fixa; sob `grep -i` num locale que dobre
# caixa, `troque_esta_senha` minúsculo passaria por canônico. O caso S9 existe para isso.
#
# Uso: bash scripts/test-gate-senha-bootstrap.sh              (exit 0 = verde)
#      bash scripts/test-gate-senha-bootstrap.sh --falsificar (sabota; exige VERMELHO em cada uma)
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO/scripts/gate-senha-bootstrap.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Senha de mentira, com marca própria: nunca uma senha de verdade entra num teste, e a marca
# permite afirmar "esta string NÃO apareceu na saída" sem nomear nada real.
FALSA='SENHA-FALSA-DO-TESTE-NAO-VAZE'

falhas=0
ok()     { printf '  ok   — %s\n' "$1"; }
falhou() { printf '  FALHA — %s\n' "$1"; falhas=$((falhas + 1)); }

if [ ! -x "$GATE" ]; then
  echo "❌ $GATE ausente ou não-executável — a suíte não tem o que medir (fail-closed)." >&2
  exit 2
fi

# ── locale UTF-8: sonda POSITIVA, nunca degradar em silêncio ─────────────────────────────────────
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
if [ -z "$utf8" ]; then
  echo "❌ nenhum locale UTF-8 (pt_BR/en_US/C) neste ambiente — metade da suíte não rodaria."
  echo "   Rodar só LC_ALL=C e chamar de verde é a falsificação em UM ambiente do #1483."
  exit 1
fi

# ── raiz sintética ───────────────────────────────────────────────────────────────────────────────
RAIZ="$TMP/raiz"
montar() {
  rm -rf "$RAIZ"
  mkdir -p "$RAIZ/db" "$RAIZ/supabase/migrations" "$RAIZ/scripts"
  # O arquivo protegido, na forma canônica.
  cat > "$RAIZ/db/claude-rw-bootstrap.sql" <<'EOF'
-- fixture do bootstrap
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_rw') THEN
    CREATE ROLE claude_rw LOGIN NOINHERIT PASSWORD 'TROQUE_ESTA_SENHA';
  END IF;
END
$$;
EOF
  # O falso positivo REAL do repo: comentário que cita a palavra sem abrir literal. Tem de ficar
  # VERDE — se um dia alguém "endurecer" o gate para casar a palavra solta, este caso fica vermelho
  # aqui antes de virar ruído em cima de db/revoga-master-alias-fiscal-omie.sql.
  cat > "$RAIZ/db/outro.sql" <<'EOF'
--   - Os placeholders têm `encrypted_password` = hash bcrypt ALEATÓRIO — artefato do
--     `auth.admin.createUser()` sem `password`.
SELECT 1;
EOF
  printf '%s\n' 'CREATE TABLE t (id int);' > "$RAIZ/supabase/migrations/20260101000000_x.sql"
  printf '%s\n' 'SELECT 2;' > "$RAIZ/scripts/audit.sql"
}

# Hash da raiz INTEIRA (nomes + conteúdo): pega edição, criação, remoção e rename.
hash_raiz() {
  local acc=""
  acc="$(cd "$RAIZ" && find . -type f 2>/dev/null | sort | while IFS= read -r f; do
    printf '%s:' "$f"; cksum < "$f" 2>/dev/null
  done)"
  printf '%s' "$acc" | cksum | awk '{print $1 "-" $2}'
}

rodar() { "$GATE" --raiz "$RAIZ" > "$TMP/saida" 2>&1; printf '%s' "$?"; }

controle() {
  montar
  local rc; rc="$(rodar)"
  if [ "$rc" -ne 0 ] || ! grep -q 'BOOTSTRAP-SENHA-OK' "$TMP/saida"; then
    printf 'ABORTA — controle não está verde (rc=%s). Sabotar agora aprovaria qualquer coisa.\n' "$rc"
    cut -c1-300 "$TMP/saida"
    exit 1
  fi
}

# sabotagem <descrição> <marcador> <rc-esperado> <comando>
sabotagem() {
  local desc="$1" marca="$2" rc_esp="$3" cmd="$4" antes depois rc
  controle
  antes="$(hash_raiz)"
  ( cd "$RAIZ" && eval "$cmd" ) >/dev/null 2>&1
  depois="$(hash_raiz)"
  if [ "$antes" = "$depois" ]; then
    printf 'ABORTA — a sabotagem "%s" não mudou a raiz (no-op). O vermelho viria de outro lugar.\n' "$desc"
    exit 1
  fi
  rc="$(rodar)"
  if [ "$rc" -ne "$rc_esp" ]; then falhou "$desc — esperava rc=$rc_esp, veio rc=$rc"; return; fi
  if ! grep -q "$marca" "$TMP/saida"; then falhou "$desc — rc certo, mas sem o marcador $marca"; return; fi
  if grep -q "$FALSA" "$TMP/saida"; then falhou "$desc — VAZOU a senha falsa na saída do gate"; return; fi
  ok "$desc — vermelho com $marca, sem vazar"
}

# ── modo normal ──────────────────────────────────────────────────────────────────────────────────
modo_normal() {
  local rc

  montar
  rc="$(rodar)"
  if [ "$rc" -eq 0 ] && grep -q 'BOOTSTRAP-SENHA-OK' "$TMP/saida"; then
    ok 'N1 raiz sintética limpa passa'
  else
    falhou "N1 raiz limpa deveria passar (rc=$rc)"
  fi

  # N2 — o comentário com `encrypted_password` não pode ser cobrado.
  if grep -q 'outro.sql' "$TMP/saida"; then
    falhou 'N2 comentário citando password foi cobrado como literal (critério largo demais)'
  else
    ok 'N2 comentário que cita password sem abrir literal fica verde'
  fi

  # N3 — o repo de VERDADE passa. Sem isto a suíte só prova coisas sobre fixtures.
  "$GATE" > "$TMP/real" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'BOOTSTRAP-SENHA-OK' "$TMP/real"; then
    ok 'N3 repo de verdade passa no modo árvore'
  else
    falhou "N3 repo de verdade reprovou (rc=$rc)"
  fi

  # ── modo --staged, sobre um repo git sintético ────────────────────────────────────────────────
  local G="$TMP/git"
  rm -rf "$G"; mkdir -p "$G"
  git init -q "$G" >/dev/null 2>&1
  git -C "$G" config user.email t@t; git -C "$G" config user.name t

  # N4 — commit sem nenhum .sql: nada a medir, e isso é VERDE (o hook não pode barrar tudo).
  printf '%s\n' 'oi' > "$G/leia.md"; git -C "$G" add leia.md >/dev/null 2>&1
  "$GATE" --raiz "$G" --staged > "$TMP/s4" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'nada a medir' "$TMP/s4"; then
    ok 'N4 --staged sem .sql: verde (e funciona sem HEAD, no commit inicial)'
  else
    falhou "N4 --staged sem .sql deveria passar (rc=$rc)"
  fi

  # N5 — bootstrap limpo staged: verde.
  mkdir -p "$G/db"
  cp "$RAIZ/db/claude-rw-bootstrap.sql" "$G/db/"
  git -C "$G" add db/claude-rw-bootstrap.sql >/dev/null 2>&1
  "$GATE" --raiz "$G" --staged > "$TMP/s5" 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then ok 'N5 --staged com placeholder: verde'; else falhou "N5 rc=$rc"; fi

  # N6 — O CASO QUE JUSTIFICA LER O ÍNDICE: senha no que foi `git add`-ado, árvore já restaurada.
  # Um hook que lesse a árvore de trabalho diria verde aqui e o commit levaria a senha.
  sed "s/TROQUE_ESTA_SENHA/$FALSA/" "$RAIZ/db/claude-rw-bootstrap.sql" > "$G/db/claude-rw-bootstrap.sql"
  git -C "$G" add db/claude-rw-bootstrap.sql >/dev/null 2>&1
  cp "$RAIZ/db/claude-rw-bootstrap.sql" "$G/db/claude-rw-bootstrap.sql"   # árvore LIMPA de novo
  if grep -q "$FALSA" "$G/db/claude-rw-bootstrap.sql"; then
    falhou 'N6 fixture inválida — a árvore deveria estar limpa'
  else
    "$GATE" --raiz "$G" --staged > "$TMP/s6" 2>&1; rc=$?
    if [ "$rc" -eq 1 ] && grep -q 'BOOTSTRAP-SENHA-LITERAL' "$TMP/s6"; then
      ok 'N6 --staged pega senha no ÍNDICE com a árvore limpa'
    else
      falhou "N6 índice sujo + árvore limpa deveria reprovar (rc=$rc)"
    fi
    # N7 — e não pode ter impresso a senha.
    if grep -q "$FALSA" "$TMP/s6"; then
      falhou 'N7 o gate IMPRIMIU a senha falsa — é o defeito que ele existe para não ter'
    else
      ok 'N7 o gate reprova sem imprimir o literal'
    fi
  fi

  # ── hook pre-commit, END-TO-END: um `git commit` de verdade sendo barrado ──────────────────────
  # Provar o GATE não prova o HOOK: entre os dois há o instalador, o `core.hooksPath`, o bit de
  # execução e a resolução do caminho do gate a partir do toplevel. Cada um desses já foi, em algum
  # repo, o motivo de um hook "instalado" que nunca rodou.
  local H="$TMP/hook"
  rm -rf "$H"; mkdir -p "$H/scripts" "$H/db"
  git init -q "$H" >/dev/null 2>&1
  git -C "$H" config user.email t@t; git -C "$H" config user.name t
  # HERMÉTICO por decreto: sem esta linha, um `core.hooksPath` global na máquina de quem roda a
  # suíte faria o instalador escrever no diretório de hooks REAL dessa pessoa.
  git -C "$H" config core.hooksPath "$H/.git/hooks"
  cp "$GATE" "$H/scripts/gate-senha-bootstrap.sh"

  ( cd "$H" && bash "$REPO/scripts/instalar-hook-pre-commit.sh" ) > "$TMP/inst" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ -x "$H/.git/hooks/pre-commit" ]; then
    ok 'N8 instalador escreve um pre-commit executável e ele responde'
  else
    falhou "N8 instalador falhou (rc=$rc)"
  fi
  # `if <cmd>` e não `cmd; if [ $? ]`: o `$?` indireto é a marca SC2181 que este repo já pagou —
  # com `set -e` ativo o bloco de erro fica inalcançável e o diagnóstico cala.
  if ( cd "$H" && bash "$REPO/scripts/instalar-hook-pre-commit.sh" --verificar ) >/dev/null 2>&1; then
    ok 'N9 --verificar responde instalado'
  else
    falhou 'N9 --verificar não reconheceu o hook recém-instalado'
  fi

  # N10 — o commit com senha é BARRADO, e nenhum commit nasce.
  sed "s/TROQUE_ESTA_SENHA/$FALSA/" "$RAIZ/db/claude-rw-bootstrap.sql" > "$H/db/claude-rw-bootstrap.sql"
  git -C "$H" add db/claude-rw-bootstrap.sql >/dev/null 2>&1
  git -C "$H" commit -q -m 'tenta com senha' > "$TMP/c1" 2>&1; rc=$?
  if [ "$rc" -ne 0 ] && ! git -C "$H" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    ok 'N10 git commit com senha no índice é BARRADO e nenhum commit nasce'
  else
    falhou "N10 o commit com senha passou (rc=$rc) — o hook não está no caminho"
  fi
  if grep -q "$FALSA" "$TMP/c1"; then falhou 'N11 a saída do commit VAZOU a senha'; else ok 'N11 a recusa do commit não imprime a senha'; fi

  # N12 — com o placeholder, o commit passa. Um hook que barrasse tudo seria desinstalado no
  # primeiro incômodo, e um guard desinstalado protege zero.
  cp "$RAIZ/db/claude-rw-bootstrap.sql" "$H/db/claude-rw-bootstrap.sql"
  git -C "$H" add db/claude-rw-bootstrap.sql >/dev/null 2>&1
  git -C "$H" commit -q -m 'com placeholder' >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && git -C "$H" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    ok 'N12 commit com o placeholder passa'
  else
    falhou "N12 commit limpo foi barrado (rc=$rc) — falso positivo"
  fi

  # N13 — o BURACO, afirmado em vez de suposto: `--no-verify` pula qualquer hook, por desenho do
  # git. Este caso existe para que a limitação apareça na suíte, e não só na prosa do PR.
  sed "s/TROQUE_ESTA_SENHA/$FALSA/" "$RAIZ/db/claude-rw-bootstrap.sql" > "$H/db/claude-rw-bootstrap.sql"
  git -C "$H" add db/claude-rw-bootstrap.sql >/dev/null 2>&1
  git -C "$H" commit -q --no-verify -m 'no-verify' >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    ok 'N13 --no-verify passa (limitação conhecida: só o CI pega este caso)'
  else
    falhou 'N13 --no-verify foi barrado — o git mudou de comportamento, revise a doc do PR'
  fi
}

# ── modo falsificação ────────────────────────────────────────────────────────────────────────────
modo_falsificar() {
  sabotagem 'S1 senha real no bootstrap' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "sed -i.bak 's/TROQUE_ESTA_SENHA/$FALSA/' db/claude-rw-bootstrap.sql && rm -f db/*.bak"

  sabotagem 'S2 senha em OUTRO db/*.sql' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "printf \"ALTER ROLE x PASSWORD '%s';\n\" '$FALSA' >> db/outro.sql"

  sabotagem 'S3 senha em supabase/migrations' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "printf \"CREATE USER y PASSWORD '%s';\n\" '$FALSA' >> supabase/migrations/20260101000000_x.sql"

  sabotagem 'S4 senha em scripts/*.sql' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "printf \"ALTER ROLE z PASSWORD '%s';\n\" '$FALSA' >> scripts/audit.sql"

  sabotagem 'S5 dollar-quote em vez de aspa' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "printf 'ALTER ROLE w PASSWORD \$\$x\$\$;\n' >> db/outro.sql"

  # O eixo de LOCALE, e o que ele mede: se o gate casasse o placeholder com `grep -i`, esta linha
  # passaria por CANÔNICA e a sabotagem ficaria VERDE. O marcador esperado é LITERAL (não
  # SEM-ANCORA) porque a linha continua abrindo um literal — que é o diagnóstico mais informativo
  # dos dois. A primeira versão desta suíte exigia SEM-ANCORA aqui: a expectativa é que estava
  # errada, não o gate.
  sabotagem 'S6 placeholder em caixa minúscula não vale como canônico' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "sed -i.bak \"s/PASSWORD 'TROQUE_ESTA_SENHA'/password 'troque_esta_senha'/\" db/claude-rw-bootstrap.sql && rm -f db/*.bak"

  sabotagem 'S7 placeholder trocado por outro texto' 'BOOTSTRAP-SENHA-LITERAL' 1 \
    "sed -i.bak 's/TROQUE_ESTA_SENHA/COLOQUE_AQUI/' db/claude-rw-bootstrap.sql && rm -f db/*.bak"

  sabotagem 'S8 arquivo-âncora renomeado' 'BOOTSTRAP-SEM-ANCORA' 1 \
    "mv db/claude-rw-bootstrap.sql db/bootstrap-novo-nome.sql"

  # A EVASÃO que a âncora existe para pegar: `format(%L)` monta a senha sem escrever `PASSWORD '`,
  # então a varredura por literal fica cega. Nenhum achado + âncora sumida = SEM-ANCORA, e a
  # reescrita passa a exigir uma decisão consciente em vez de apagar a cobertura em silêncio.
  sabotagem 'S10 CREATE ROLE reescrito com format(%L): âncora some sem deixar literal' 'BOOTSTRAP-SEM-ANCORA' 1 \
    "sed -i.bak \"s|CREATE ROLE claude_rw LOGIN NOINHERIT PASSWORD 'TROQUE_ESTA_SENHA';|EXECUTE format('CREATE ROLE claude_rw LOGIN NOINHERIT PASSWORD %L', v_senha);|\" db/claude-rw-bootstrap.sql && rm -f db/*.bak"

  sabotagem 'S9 escopo esvaziado (diretórios movidos)' 'BOOTSTRAP-GATE-FALHA' 2 \
    "rm -rf db supabase scripts"
}

rodada() {
  printf '== %s · locale %s ==\n' "${1:-normal}" "${LC_ALL:-default}"
  if [ "${1:-normal}" = "falsificar" ]; then modo_falsificar; else modo_normal; fi
}

if [ "${1:-}" = "--falsificar" ]; then
  LC_ALL=C rodada falsificar
  LC_ALL="$utf8" rodada falsificar
else
  LC_ALL=C rodada normal
  LC_ALL="$utf8" rodada normal
fi

if [ "$falhas" -gt 0 ]; then
  printf 'RESULTADO: %s falha(s)\n' "$falhas"
  exit 1
fi
printf 'RESULTADO: tudo ok\n'
