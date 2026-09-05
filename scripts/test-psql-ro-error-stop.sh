#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════╗
# ║  test-psql-ro-error-stop.sh — rede de falsificação do fiscal de                 ║
# ║  `psql-ro` + `ON_ERROR_STOP` (docs/historico/psql-ro-exit-zero-em-sql-que-      ║
# ║  falhou.md). Roda o CLI DE VERDADE sobre arquivos DE VERDADE, nos DOIS locales. ║
# ║                                                                                 ║
# ║  Duas metades, e a segunda é a que vale:                                        ║
# ║   (A) EXPECTATIVA — cada fixture de `scripts/fixtures/psql-ro-error-stop/`      ║
# ║       materializada em tmp: `viola-*` tem de sair 1, `limpo-*` tem de sair 0.   ║
# ║   (B) SABOTAGEM — uma CAMADA por vez é quebrada no código e o conjunto tem de   ║
# ║       ficar VERMELHO por causa dela. Camada cuja sabotagem fica verde é         ║
# ║       redundante ou o teste não a alcança, e as duas respostas mudam o commit   ║
# ║       (regra da casa, aprendida no #2167).                                      ║
# ║                                                                                 ║
# ║  Uso:  bash scripts/test-psql-ro-error-stop.sh [--falsificar]  (0 = rede viva)  ║
# ║  Sem `--falsificar` roda só (A). ⚠️ COMMITE antes: (B) restaura por git checkout.║
# ║  ⚠️ NÃO rode (B) em paralelo com vitest NA MESMA worktree: ele MUTA a fonte em      ║
# ║  disco, e um `vitest run` concorrente lê o arquivo sabotado e reprova sem motivo   ║
# ║  — medido nesta própria sessão, e é exatamente o vermelho que ninguém consegue     ║
# ║  reproduzir depois. No CI eles são passos SEQUENCIAIS do mesmo job.                ║
# ╚═════════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 70
GATE="scripts/psql-ro-error-stop-gate.ts"
DIR_FIXTURES="scripts/fixtures/psql-ro-error-stop"
ALVO_SCANNER="scripts/lib/psql-ro-error-stop.ts"
ALVO_STRIPPER="src/lib/gates/limpeza-shell.ts"
ALVO_CLI="$GATE"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"; git checkout -- "$ALVO_SCANNER" "$ALVO_STRIPPER" "$ALVO_CLI" 2>/dev/null' EXIT

FALHAS=0
FALSIFICAR=0
for arg in "$@"; do [ "$arg" = --falsificar ] && FALSIFICAR=1; done
aviso() { printf '%s\n' "$*"; }

# ── sondas fail-CLOSED: este script SABOTA e RESTAURA fonte; sem git ele destrói ──────────────
command -v git >/dev/null 2>&1 || { aviso "❌ git ausente — abortando (o script restaura por git checkout)"; exit 70; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { aviso "❌ fora de repositório git — abortando"; exit 70; }
command -v bun >/dev/null 2>&1 || { aviso "❌ bun ausente — abortando"; exit 70; }
bun --version >/dev/null 2>&1 || { aviso "❌ bun presente mas quebrado — abortando"; exit 70; }
[ -f "$GATE" ] && [ -d "$DIR_FIXTURES" ] || { aviso "❌ gate ou fixtures ausentes — abortando"; exit 70; }
for f in "$ALVO_SCANNER" "$ALVO_STRIPPER"; do
  git diff --quiet -- "$f" || { aviso "❌ $f tem alteração NÃO COMMITADA — a restauração por git checkout a perderia. Commite antes."; exit 70; }
done

# ── locales: sonda POSITIVA. "Setei LC_ALL" não prova que o locale EXISTE — glibc/musl caem em C
# silenciosamente, e aí "rodei nos dois" é uma frase, não uma medição.
LOCALES="C"
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then LOCALES="C $cand"; break; fi
done
case "$LOCALES" in
  "C") aviso "⚠️  nenhum locale UTF-8 disponível — a rede roda só em C (metade da prova de locale)" ;;
  *)   aviso "locales: $LOCALES" ;;
esac

# ── materializa as fixtures (uma por diretório: o veredito do CLI é do CORPO inteiro) ─────────
N_FIX=0
for f in "$DIR_FIXTURES"/*.fixture; do
  base="$(basename "$f" .fixture)"
  mkdir -p "$TMPD/casos/$base"
  cp "$f" "$TMPD/casos/$base/$base"
  N_FIX=$((N_FIX + 1))
done
[ "$N_FIX" -ge 18 ] || { aviso "❌ só $N_FIX fixture(s) materializada(s) — corpo pequeno demais para provar nada"; exit 70; }

# Roda o CLI num caso e devolve o rc. Locale vem do chamador.
rc_do_caso() {
  bun "$GATE" "$TMPD/casos/$1" >/dev/null 2>&1
}

# Confere TODAS as expectativas num locale. Devolve 0 se todas baterem.
# `$2` = "silencioso" para o modo sabotagem (queremos só saber SE quebrou, e qual).
conferir() {
  local loc="$1" modo="${2:-ruidoso}" quebrou=0
  for d in "$TMPD"/casos/*; do
    local base esperado rc
    base="$(basename "$d")"
    case "$base" in viola-*) esperado=1 ;; limpo-*) esperado=0 ;; *) continue ;; esac
    LC_ALL="$loc" LANG="$loc" rc_do_caso "$base"
    rc=$?
    if [ "$rc" -ne "$esperado" ]; then
      quebrou=1
      [ "$modo" = ruidoso ] && aviso "    ✗ [$loc] $base → rc=$rc, esperado $esperado"
      [ "$modo" = silencioso ] && { PRIMEIRA_QUEBRA="$base (rc=$rc, esperado $esperado)"; return 1; }
    fi
  done
  return "$quebrou"
}

# O corpo REAL do repo continua limpo (rc 0) neste locale?
repo_limpo() {
  LC_ALL="$1" LANG="$1" bun "$GATE" >/dev/null 2>&1
}

aviso "═══ (A) EXPECTATIVA — $N_FIX fixtures, dois locales ═══"
for LOC in $LOCALES; do
  if conferir "$LOC" ruidoso; then
    aviso "  ✅ [$LOC] todas as $N_FIX fixtures deram o veredito esperado"
  else
    aviso "  ❌ [$LOC] a rede base NÃO fecha"
    FALHAS=$((FALHAS + 1))
  fi
  if repo_limpo "$LOC"; then
    aviso "  ✅ [$LOC] corpo real do repo: limpo (rc 0)"
  else
    aviso "  ❌ [$LOC] corpo real do repo NÃO saiu 0"
    FALHAS=$((FALHAS + 1))
  fi
done

# ── (B) SABOTAGEM: uma camada por vez ────────────────────────────────────────────────────────
# Formato: nome|arquivo|texto original|texto sabotado
# O `python3` confere que a substituição ACONTECEU — sabotagem que não aplica deixa tudo verde e
# o verde vira prova de nada. É a mesma doença de "ausência de sinal = aprovação".
sabotar() {
  ARQ="$1" DE="$2" PARA="$3" python3 - <<'PY'
import os, sys
arq, de, para = os.environ['ARQ'], os.environ['DE'], os.environ['PARA']
s = open(arq, encoding='utf-8').read()
if de not in s:
    sys.stderr.write('SABOTAGEM NAO APLICOU: texto-alvo ausente\n')
    sys.exit(3)
open(arq, 'w', encoding='utf-8').write(s.replace(de, para, 1))
PY
}

CAMADAS=0
rodar_sabotagem() {
  local nome="$1" arq="$2" de="$3" para="$4"
  CAMADAS=$((CAMADAS + 1))
  if ! sabotar "$arq" "$de" "$para"; then
    aviso "  ❌ [$nome] a sabotagem não aplicou — nada foi provado"
    FALHAS=$((FALHAS + 1))
    git checkout -- "$arq"
    return
  fi

  local pegou=0 onde=""
  for LOC in $LOCALES; do
    PRIMEIRA_QUEBRA=""
    if ! conferir "$LOC" silencioso; then
      pegou=1; onde="[$LOC] fixture $PRIMEIRA_QUEBRA"; break
    fi
    if ! repo_limpo "$LOC"; then
      pegou=1; onde="[$LOC] o corpo real do repo deixou de sair 0"; break
    fi
  done
  git checkout -- "$arq"

  if [ "$pegou" -eq 1 ]; then
    aviso "  ✅ [$nome] sabotada → VERMELHO em $onde"
  else
    aviso "  ❌ [$nome] sabotada → tudo VERDE. Camada redundante, ou o teste não a alcança."
    FALHAS=$((FALHAS + 1))
  fi
}

if [ "$FALSIFICAR" -eq 0 ]; then
  aviso ""
  if [ "$FALHAS" -eq 0 ]; then
    aviso "✅ (A) fechou. Rode com --falsificar para exigir vermelho de cada camada sabotada."
    exit 0
  fi
  aviso "❌ $FALHAS problema(s) em (A)."
  exit 1
fi

aviso ""
aviso "═══ (B) SABOTAGEM — uma camada por vez, exigindo vermelho POR CAUSA dela ═══"

rodar_sabotagem 'descoberta-de-vínculo' "$ALVO_SCANNER" \
  'if (MARCA_WRAPPER.test(rhs)) vinculados.add(nome);' \
  'if (false && MARCA_WRAPPER.test(rhs)) vinculados.add(nome);'

rodar_sabotagem 'refutação-da-semente' "$ALVO_SCANNER" \
  'if (!vinculados.has(nome) && !MARCA_WRAPPER.test(rhs)) refutados.add(nome);' \
  'if (false) refutados.add(nome);'

rodar_sabotagem 'forma -c (protegida)' "$ALVO_SCANNER" \
  "if (clusterContem(nu, 'c')) temC = true;" \
  "if (false) temC = true;"

rodar_sabotagem 'forma -f (exige)' "$ALVO_SCANNER" \
  "if (clusterContem(nu, 'f')) temF = true;" \
  "if (false) temF = true;"

rodar_sabotagem 'forma --file longa' "$ALVO_SCANNER" \
  "if (nu === '--file' || nu.startsWith('--file=')) temF = true;" \
  "if (false) temF = true;"

rodar_sabotagem 'detecção de ON_ERROR_STOP' "$ALVO_SCANNER" \
  'return { temC, temF, temErrorStop };' \
  'return { temC, temF, temErrorStop: true };'

rodar_sabotagem 'VALOR do ON_ERROR_STOP' "$ALVO_SCANNER" \
  "return !['off', '0', 'false', 'no'].includes(bruto);" \
  'return true;'

rodar_sabotagem 'detecção de stdin (< << <<<)' "$ALVO_SCANNER" \
  "if (c === '<') return true;" \
  'if (false) return true;'

rodar_sabotagem 'repasse opaco ("$@")' "$ALVO_SCANNER" \
  'const opaco = repassaArgumentosOpacos(palavras.slice(1));' \
  'const opaco = false;'

rodar_sabotagem 'máscara de contexto (prosa)' "$ALVO_SCANNER" \
  'if (contexto[ini] !== 1) continue;' \
  'if (false) continue;'

rodar_sabotagem 'limpeza de comentário' "$ALVO_STRIPPER" \
  "if (c === '#' && ANTES_DE_COMENTARIO.has(anterior)) {" \
  "if (false && ANTES_DE_COMENTARIO.has(anterior)) {"

# A sabotagem tem de reproduzir o furo REAL: consumir só UM `<` faz o segundo virar um `<<`
# sozinho. Desligar o ramo inteiro NÃO reproduz — o `<<` cai no leitor de cabeçalho, que não acha
# delimitador em `<` e desiste, e a sabotagem fica inócua. Sabotagem inócua vira "camada
# redundante" no relatório, que é um veredito FABRICADO sobre uma camada que ninguém testou.
rodar_sabotagem 'herestring <<< (não é heredoc)' "$ALVO_STRIPPER" \
  '        marcar(i + 3, 1);' \
  '        marcar(i + 1, 1); i += 1; if (true) continue;'

rodar_sabotagem 'pilha de contexto (substituicao dentro de aspas duplas)' "$ALVO_STRIPPER" \
  "if (c === '\$' && fonte[i + 1] === '(') {" \
  "if (false && fonte[i + 1] === '(') {"

rodar_sabotagem 'piso de denominador (walker vazio)' "$ALVO_CLI" \
  '  for (const r of raizes) andar(resolve(base, r));' \
  '  if (raizes.length > 0) return achados;'

aviso ""
if [ "$FALHAS" -eq 0 ]; then
  aviso "✅ REDE VIVA: $N_FIX fixtures × locales [$LOCALES]; as $CAMADAS camadas ficaram vermelhas ao serem sabotadas."
  exit 0
fi
aviso "❌ $FALHAS problema(s) na rede — ver acima. Rede que não falsifica não prova."
exit 1
