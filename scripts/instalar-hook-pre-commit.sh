#!/usr/bin/env bash
# instalar-hook-pre-commit.sh — instala o freio LOCAL da senha do bootstrap.
#
# Por que existe uma segunda camada, se o CI já reprova: porque o CI só reprova DEPOIS que o commit
# existe e foi empurrado. Nesse ponto a senha já está no remoto e a única saída é ROTACIONAR — o CI
# detecta e obriga a rotação, ele não impede o vazamento. Quem impede é este hook.
#
# Por que UM arquivo cobre as ~30 worktrees: elas compartilham o mesmo diretório de hooks. Medido
# em 2026-09-09 — `core.hooksPath` aponta, no escopo `local` do repo principal E no
# `config.worktree` de cada worktree, para o mesmo `<repo>/.git/hooks`. `git rev-parse --git-path
# hooks` devolve o caminho EFETIVO (respeita `core.hooksPath`), então instalar aqui vale para todas
# as worktrees existentes e para as futuras, sem tocar em nenhuma delas.
#
# O que fica versionado é a LÓGICA (`scripts/gate-senha-bootstrap.sh`); o que é instalado é um SHIM
# de três linhas que a chama. Assim o hook nunca envelhece em relação ao repo: melhorar o gate no
# repo melhora o hook instalado, sem reinstalar nada.
#
# Uso: bun run hooks:instalar              instala (ou confirma que já está instalado)
#      bun run hooks:instalar --verificar  só responde se está instalado (exit 0/1), não escreve
set -uo pipefail

ASSINATURA='# gerado por scripts/instalar-hook-pre-commit.sh — nao edite aqui, edite o gate no repo'

VERIFICAR=0
[ "${1:-}" = "--verificar" ] && VERIFICAR=1

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "❌ não é um repositório git." >&2; exit 2
fi

# Caminho EFETIVO dos hooks — honra `core.hooksPath`. Ler o config na mão erraria em worktree.
HOOKS="$(git rev-parse --git-path hooks 2>/dev/null)"
if [ -z "$HOOKS" ]; then
  echo "❌ não consegui resolver o diretório de hooks (git rev-parse --git-path hooks)." >&2; exit 2
fi
# `--git-path` pode devolver caminho relativo ao cwd; normaliza para absoluto.
case "$HOOKS" in /*) ;; *) HOOKS="$(cd "$(dirname "$HOOKS")" 2>/dev/null && pwd)/$(basename "$HOOKS")" ;; esac
ALVO="$HOOKS/pre-commit"

if [ "$VERIFICAR" -eq 1 ]; then
  if [ -f "$ALVO" ] && grep -qF 'gate-senha-bootstrap.sh' "$ALVO"; then
    echo "HOOK-INSTALADO: $ALVO"
    exit 0
  fi
  echo "HOOK-AUSENTE: $ALVO não chama o gate-senha-bootstrap.sh" >&2
  echo "   Instale com: bun run hooks:instalar" >&2
  exit 1
fi

# Hook de terceiros: NÃO sobrescreve em silêncio. Perder o pre-commit de outra ferramenta seria uma
# regressão invisível — melhor parar e deixar a decisão com quem sabe o que aquele hook faz.
if [ -f "$ALVO" ] && ! grep -qF "$ASSINATURA" "$ALVO"; then
  if grep -qF 'gate-senha-bootstrap.sh' "$ALVO"; then
    echo "✅ já existe um pre-commit que chama o gate (instalado à mão?). Nada a fazer: $ALVO"
    exit 0
  fi
  echo "❌ já existe um pre-commit de OUTRA origem em $ALVO — não vou sobrescrever." >&2
  echo "   Acrescente a esse hook a linha:" >&2
  # shellcheck disable=SC2016  # aspas simples de propósito: é TEXTO para o humano copiar e colar
  # no hook dele. Expandir aqui escreveria o caminho desta máquina no conselho — errado em worktree.
  echo '     "$(git rev-parse --show-toplevel)"/scripts/gate-senha-bootstrap.sh --staged || exit 1' >&2
  exit 2
fi

mkdir -p "$HOOKS" || { echo "❌ não consegui criar $HOOKS" >&2; exit 2; }

cat > "$ALVO" <<'SHIM'
#!/usr/bin/env bash
# gerado por scripts/instalar-hook-pre-commit.sh — nao edite aqui, edite o gate no repo
# Freio da senha do bootstrap. A LOGICA mora no repo (versionada); isto e so o gancho.
set -uo pipefail
TOPO="$(git rev-parse --show-toplevel 2>/dev/null)"
GATE="$TOPO/scripts/gate-senha-bootstrap.sh"
if [ ! -x "$GATE" ]; then
  # Degradacao ANUNCIADA, nunca silenciosa: branch antigo (anterior ao gate) ou checkout parcial.
  # Bloquear aqui faria o hook ser desinstalado no primeiro incomodo, que e o pior desfecho.
  echo "⚠️  pre-commit: $GATE ausente neste checkout — commit liberado SEM o freio da senha." >&2
  echo "   O CI continua reprovando; se este branch toca db/*.sql, confira o placeholder a mao." >&2
  exit 0
fi
exec "$GATE" --staged
SHIM

chmod +x "$ALVO" || { echo "❌ não consegui tornar $ALVO executável" >&2; exit 2; }

# Evidência POSITIVA de que a instalação funciona: roda o hook recém-escrito e exige resposta.
saida="$("$ALVO" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] || ! printf '%s' "$saida" | grep -q 'BOOTSTRAP-SENHA'; then
  echo "❌ o hook foi escrito mas não respondeu como esperado (rc=$rc). Não considere instalado." >&2
  printf '%s\n' "$saida" | cut -c1-300 >&2
  exit 2
fi
echo "✅ pre-commit instalado em $ALVO"
echo "   Cobre TODAS as worktrees que compartilham este diretório de hooks."
echo "   Não cobre: 'git commit --no-verify', outra máquina/clone, e o commit do sync do Lovable."
