#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  test-setup-contrato.sh — rede de falsificação das testemunhas do setup do vitest            ║
# ║  (`src/test/setup-ambiente-node.test.ts` + `src/test/setup-ambiente-dom.test.tsx`).          ║
# ║                                                                                              ║
# ║  O que está em jogo: `src/integrations/supabase/client.ts` passa `localStorage` como storage ║
# ║  do auth, e 474 módulos importam esse client. Se o storage NÃO chegar, o supabase-js não     ║
# ║  quebra — ele cai calado no `memoryLocalStorageAdapter` dele                                 ║
# ║  (node_modules/@supabase/auth-js/src/GoTrueClient.ts:369-386). Nada explode; a sessão só     ║
# ║  deixa de sobreviver. É um flip SILENCIOSO, e as testemunhas existem para torná-lo           ║
# ║  impossível de passar despercebido.                                                          ║
# ║                                                                                              ║
# ║  Duas metades, e a segunda é a que vale:                                                     ║
# ║   (A) CONTROLE — as duas testemunhas rodam e têm de estar VERDES. Sem verde do qual sair,    ║
# ║       "ficou vermelho" não é informação.                                                     ║
# ║   (B) SABOTAGEM — uma camada por vez é quebrada no código e o conjunto tem de ficar          ║
# ║       VERMELHO **por causa dela**: exigimos rc≠0 E a MARCA do ramo na saída. Vermelho sem a  ║
# ║       marca é vermelho por outro motivo, e aprovaria uma asserção sem dente.                 ║
# ║                                                                                              ║
# ║  Este arquivo existe porque o laço equivalente vivia só como prosa num bloco ```bash de      ║
# ║  docs/superpowers/plans/2026-09-07-vitest-workers-e-ambiente.md. Falsificação que só roda à  ║
# ║  mão é ausência de dado, não aprovação (regra da casa).                                      ║
# ║                                                                                              ║
# ║  Uso:  bash scripts/test-setup-contrato.sh [--falsificar]                                    ║
# ║  Sem `--falsificar` roda só (A). ⚠️ COMMITE antes de (B): ela MUTA a fonte em disco.         ║
# ║  ⚠️ NÃO rode (B) em paralelo com vitest NA MESMA worktree: um `vitest run` concorrente lê o  ║
# ║  arquivo sabotado e reprova sem motivo — é o vermelho que ninguém reproduz depois. No CI     ║
# ║  eles são passos SEQUENCIAIS do mesmo job.                                                   ║
# ║                                                                                              ║
# ║  Exit 0 = rede viva. 1 = controle vermelho, ou alguma sabotagem passou verde / sem a marca.  ║
# ║  70 = via de prova não observável (fail-CLOSED: sem git/bun/python3 este teste NÃO passa em  ║
# ║  silêncio — ele SABOTA e RESTAURA fonte; sonda ausente aqui destrói trabalho).               ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 70

# Os alvos das sabotagens. `ALVO_PARTICAO` é o vitest.config.ts: desde o #2336 quem decide
# qual setup roda em qual ambiente NÃO é um import dinâmico dentro do setup, e sim o
# `setupFiles` de cada project — atacar o mecanismo velho seria sabotar código que não existe
# mais, e a sabotagem sairia INVÁLIDA (texto-alvo ausente) em vez de provar camada nenhuma.
ALVO_COMUM="src/test/setup.ts"
ALVO_PARTICAO="vitest.config.ts"
ALVO_CLIENT="src/integrations/supabase/client.ts"
# Uma testemunha por PROJECT — a partição é por extensão, então `.ts` cai no `node` e `.tsx`
# no `dom`. As duas na mesma invocação de propósito: o controle verde e cada vermelho falam
# dos dois ambientes ao mesmo tempo.
TESTEMUNHAS=("src/test/setup-ambiente-node.test.ts" "src/test/setup-ambiente-dom.test.tsx")

# Forma CANÔNICA da casa (`[ "${1:-}" = "--falsificar" ]`) — não é estilo: é o que
# `scripts/falsificacao-cobertura.test.ts` casa para saber que esta suíte TEM o modo. Guarda
# equivalente porém escrita de outro jeito deixa o vigia achar que o modo não existe.
FALSIFICAR=0
if [ "${1:-}" = "--falsificar" ]; then FALSIFICAR=1; fi

aviso() { printf '%s\n' "$*"; }
FALHAS=0

# ── sondas fail-CLOSED ────────────────────────────────────────────────────────────────────────
# `command -v` não basta: presente-porém-QUEBRADO esvazia o guard igual. Exigimos resposta
# POSITIVA de cada ferramenta antes de tocar em qualquer arquivo.
command -v git >/dev/null 2>&1 || { aviso "❌ VIA_NAO_OBSERVAVEL: git ausente (a restauração depende dele)"; exit 70; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { aviso "❌ VIA_NAO_OBSERVAVEL: fora de repositório git"; exit 70; }
command -v python3 >/dev/null 2>&1 || { aviso "❌ VIA_NAO_OBSERVAVEL: python3 ausente (aplica e CONFERE cada sabotagem)"; exit 70; }
[ "$(python3 -c 'print("sonda-ok")' 2>/dev/null)" = "sonda-ok" ] || { aviso "❌ VIA_NAO_OBSERVAVEL: python3 presente mas quebrado"; exit 70; }
command -v bunx >/dev/null 2>&1 || { aviso "❌ VIA_NAO_OBSERVAVEL: bunx ausente"; exit 70; }
bunx --version >/dev/null 2>&1 || { aviso "❌ VIA_NAO_OBSERVAVEL: bunx presente mas quebrado"; exit 70; }
for f in "$ALVO_COMUM" "$ALVO_PARTICAO" "$ALVO_CLIENT" "${TESTEMUNHAS[@]}"; do
  [ -f "$f" ] || { aviso "❌ VIA_NAO_OBSERVAVEL: $f ausente"; exit 70; }
done

# ── backup + restauração ──────────────────────────────────────────────────────────────────────
TMPD="$(mktemp -d)" || exit 70
mkdir -p "$TMPD/bkp" || exit 70
for f in "$ALVO_COMUM" "$ALVO_PARTICAO" "$ALVO_CLIENT"; do
  cp "$f" "$TMPD/bkp/$(basename "$f")" || exit 70
done

restaurar() {
  local f base
  for f in "$ALVO_COMUM" "$ALVO_PARTICAO" "$ALVO_CLIENT"; do
    base="$(basename "$f")"
    if [ -f "$TMPD/bkp/$base" ]; then
      cp "$TMPD/bkp/$base" "$f"
    else
      git checkout -- "$f" 2>/dev/null   # cinto e suspensório: backup sumiu, volta pelo índice
    fi
  done
}
# Restaura SEMPRE — inclusive em falha, `exit` no meio, ou Ctrl-C.
trap 'restaurar; rm -rf "$TMPD"' EXIT

# A árvore precisa estar limpa ANTES de (B): a rede muta fonte em disco, e conferir a
# restauração com `git status` só é possível se o ponto de partida for vazio. No modo normal
# (A) nada é mutado, então a exigência não se aplica — e exigi-la ali tornaria o script
# inutilizável durante o desenvolvimento, sem ganho de segurança nenhum.
# ⚠️ Só os arquivos que ESTE script muta — não a árvore inteira. Medido em 2026-09-09: o
# `test:falsificacao` do CI roda vários gates em sequência, e um deles (`sonda:cron-prova`)
# deixa `supabase/functions/_shared/sonda-cron-prova.json` modificado. Um guard sobre a árvore
# toda reprovava ESTE script por sujeira ALHEIA — vermelho de 900s que não dizia nada sobre o
# contrato de storage. O guard existe para garantir que a RESTAURAÇÃO é conferível, e isso só
# depende dos arquivos sabotados.
ARQUIVOS_MUTADOS=(src/test/setup.ts src/integrations/supabase/client.ts)
if [ "$FALSIFICAR" -eq 1 ] && [ -n "$(git status --short -- "${ARQUIVOS_MUTADOS[@]}")" ]; then
  aviso "❌ ALVO sujo — commite antes de --falsificar. A rede sabota fonte em disco e a"
  aviso "   (só estes contam: ${ARQUIVOS_MUTADOS[*]})"
  aviso "   restauração depende de um ponto de partida limpo. \`git status --short\`:"
  git status --short
  exit 70
fi

# ── (A) CONTROLE ──────────────────────────────────────────────────────────────────────────────
# NO_COLOR + strip de ANSI: DUAS camadas, de propósito. O vitest colore quando acha que há
# TTY, e no runner do CI a linha de resumo sai como
#   ESC[2m Test Files ESC[22m ESC[1mESC[32m2 passed...
# — o `Test Files +N passed` abaixo NÃO casa nisso, porque entre as duas palavras há sequência
# de escape, não espaço. Medido em 2026-09-09 (run 34345092455): o controle passou (2 arquivos,
# 13 testes) e este arnês o leu como REPROVADO, derrubando o `test:hooks` no CI enquanto passava
# verde local. Depender só do NO_COLOR seria uma camada só — quem define TTY é o runner, não nós.
sem_ansi() { LC_ALL=C sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$1"; }
# COLUMNS: o vitest corta o nome do teste pela largura do terminal. No runner do CI ela e
# estreita, e `instala um storage funcional` virava `instala um storage funcion…` — a marca
# sumia por RETICENCIAS, com o vermelho intacto. Medido 2026-09-09 (run 34376550300):
# reproduzido local com --project node, o nome aparece INTEIRO; no CI, nao.
rodar_testemunhas() { NO_COLOR=1 FORCE_COLOR=0 COLUMNS=400 bunx vitest run "${TESTEMUNHAS[@]}" >"$1" 2>&1; }

# ── auto-verificação do PARSER (a correção de 2026-09-09 precisa de testemunha) ───────────
# Alimenta o leitor com a linha EXATA que o runner do CI produziu no run 34345092455 — com as
# sequências de escape no meio de "Test Files" e "2 passed" — e exige que ele reconheça. Sem
# isto, remover o `sem_ansi` volta a passar verde local e vermelho no CI, que foi o defeito.
FIX_ANSI=$(printf '\033[2m Test Files \033[22m \033[1m\033[32m2 passed\033[39m\033[22m\033[90m (2)\033[39m\n')
FIX_TMP="$TMPD/ansi-fixture.txt"; printf '%s\n' "$FIX_ANSI" > "$FIX_TMP"
if sem_ansi "$FIX_TMP" | grep -qaE "Test Files +2 passed \(2\)"; then
  aviso "  ✅ parser: reconhece a linha de resumo COLORIDA do CI"
else
  aviso "  ❌ parser CEGO a cor — o arnês reprovaria um controle verde no CI (foi o defeito de 2026-09-09)"
  FALHAS=$((FALHAS + 1))
fi
# E o contrafactual, que é o que dá sentido ao caso acima: SEM a limpeza, a mesma linha NÃO casa.
if grep -qaE "Test Files +2 passed \(2\)" "$FIX_TMP"; then
  aviso "  ❌ a fixture não tem cor — o caso acima passaria mesmo com o parser cego"
  FALHAS=$((FALHAS + 1))
else
  aviso "  ✅ contrafactual: a linha crua (com cor) de fato NÃO casa sem a limpeza"
fi

aviso "═══ (A) CONTROLE — as ${#TESTEMUNHAS[@]} testemunhas do contrato têm de estar VERDES ═══"
SAIDA_CTRL="$TMPD/controle.txt"
rodar_testemunhas "$SAIDA_CTRL"
RC_CTRL=$?
# EVIDÊNCIA POSITIVA: `rc 0` sozinho não prova que os arquivos rodaram. Exigimos a linha de
# resumo do vitest dizendo que os DOIS passaram — ausência de vermelho não é aprovação.
if [ "$RC_CTRL" -eq 0 ] && sem_ansi "$SAIDA_CTRL" | grep -qaE "Test Files +${#TESTEMUNHAS[@]} passed \(${#TESTEMUNHAS[@]}\)"; then
  aviso "  ✅ controle VERDE — ${#TESTEMUNHAS[@]} arquivos passaram"
else
  aviso "  ❌ controle NÃO fechou (rc=$RC_CTRL, ou o vitest não reportou os ${#TESTEMUNHAS[@]} arquivos passando):"
  sem_ansi "$SAIDA_CTRL" | grep -aE "Test Files|Tests |FAIL|Error" | head -20
  FALHAS=$((FALHAS + 1))
fi

if [ "$FALSIFICAR" -eq 0 ]; then
  aviso ""
  if [ "$FALHAS" -eq 0 ]; then
    aviso "✅ (A) fechou. Rode com --falsificar para exigir vermelho de cada camada sabotada."
    exit 0
  fi
  aviso "❌ $FALHAS problema(s) em (A)."
  exit 1
fi

# Sabotar sobre vermelho não prova camada nenhuma: cada "✅ sabotada → VERMELHO" seria um
# veredito FABRICADO sobre uma camada que ninguém mediu.
if [ "$FALHAS" -ne 0 ]; then
  aviso ""
  aviso "❌ (A) NÃO fechou. Abortando ANTES de (B) — 'ficou vermelho' só é informação se"
  aviso "   existir um verde do qual sair."
  exit 1
fi

# ── (B) SABOTAGEM ─────────────────────────────────────────────────────────────────────────────
# O `python3` confere que a substituição ACONTECEU. Sabotagem que não aplica deixa tudo verde e
# o verde vira prova de nada — a mesma doença de "ausência de sinal = aprovação".
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

SABOTAGENS=0
# rodar_sabotagem <nome> <arquivo> <de> <para> <marca...>
# As marcas são casadas com `grep -F` (string literal), ASCII e em CAIXA FIXA — sem `-i`. Marca
# frouxa casa com qualquer vermelho e devolve a aprovação que ela deveria negar.
rodar_sabotagem() {
  local nome="$1" arq="$2" de="$3" para="$4"
  shift 4
  SABOTAGENS=$((SABOTAGENS + 1))

  if ! sabotar "$arq" "$de" "$para"; then
    aviso "  ❌ [$nome] a sabotagem NÃO aplicou (texto-alvo ausente em $arq) — nada foi provado"
    FALHAS=$((FALHAS + 1))
    restaurar
    return
  fi

  local saida="$TMPD/sabotagem-$SABOTAGENS.txt"
  local rc
  rodar_testemunhas "$saida"
  rc=$?
  restaurar

  if [ "$rc" -eq 0 ]; then
    aviso "  ❌ [$nome] sabotada → tudo VERDE. A camada é redundante, ou a testemunha não a alcança."
    FALHAS=$((FALHAS + 1))
    return
  fi

  # Uma marca pode trazer ALTERNATIVAS separadas por `|`: a MESMA camada produz mensagens
  # diferentes conforme o ambiente. Medido 2026-09-09: sem o shim, o macOS diz
  # "Cannot read properties of undefined (reading \'setItem\')" — o `localStorage` do Node existe
  # como binding vazio — e o runner do CI, sem esse binding, diz outra coisa. Aceitar as duas
  # NÃO é afrouxar para "lançou algo": cada alternativa continua sendo específica do ramo do
  # storage. É a mesma lição do `LC_ALL` (falsificar num ambiente só não prova a asserção).
  local faltando="" marca
  for marca in "$@"; do
    local achou=0 alt
    while IFS= read -r alt; do
      [ -z "$alt" ] && continue
      sem_ansi "$saida" | grep -qaF -- "$alt" && { achou=1; break; }
    done <<EOF_ALT
$(printf '%s\n' "$marca" | tr '|' '\n')
EOF_ALT
    [ "$achou" -eq 1 ] || faltando="$faltando '$marca'"
  done
  if [ -n "$faltando" ]; then
    aviso "  ❌ [$nome] vermelho (rc=$rc) mas SEM a marca do ramo:$faltando"
    aviso "     Vermelho por outro motivo não prova que esta camada está coberta."
    # Sem este dump o vermelho é indiagnosticável a distância: foi preciso um ciclo de CI
    # inteiro só para descobrir QUAL mensagem o runner produzia.
    aviso "     ── o que a saída sabotada trouxe (linhas de falha) ──"
    sem_ansi "$saida" | grep -aE '×|✗|→|FAIL|Error|Test Files' | head -12 | sed 's/^/     /' >&2
    FALHAS=$((FALHAS + 1))
    return
  fi
  aviso "  ✅ [$nome] sabotada → VERMELHO (rc=$rc) com a marca do ramo"
}

aviso ""
aviso "═══ (B) SABOTAGEM — uma camada por vez, exigindo vermelho POR CAUSA dela ═══"

# 1) Sem o shim, o `localStorage` do Node 22+ é declarado-porém-QUEBRADO (sem
#    --localstorage-file) e sombreia o do jsdom. Os testes de storage morrem nos dois ambientes.
rodar_sabotagem 'shim-de-storage-removido' "$ALVO_COMUM" \
  'installStorageShim("localStorage");' \
  '// SABOTADO: shim de localStorage removido' \
  "reading 'setItem'|localStorage is not defined|storage funcional"

# 2) `configurable: false` no descriptor: o shim entra, mas nenhum teste consegue mais
#    desligar/religar o storage depois do setup. A marca é o erro do próprio motor JS.
rodar_sabotagem 'descriptor-nao-reconfiguravel' "$ALVO_COMUM" \
  'value: shim,
    writable: true,
    configurable: true,' \
  'value: shim,
    writable: true,
    configurable: false,' \
  'Cannot redefine property'

# A partição de ambiente tem DOIS sentidos, e a 3ª e a 4ª sabotagem cobrem um cada. Até o #2336 o
# mecanismo era um `await import("./setup-dom")` guardado por `typeof document`, e uma sabotagem só
# bastava. Hoje quem decide é o `setupFiles` de cada project do vitest.config.ts — a exceção passou
# a ser DECLARADA, e um `setupFiles` errado erra nos dois sentidos, com sintomas opostos:
# sobra de DOM no `node` EXPLODE (barulhento), falta de DOM no `dom` fica CALADA. Sabotar só o
# sentido barulhento deixaria a testemunha `.tsx` sem nenhuma falsificação em cima dela.

# 3) DOM a mais no project errado: o `setup-dom.ts` entra no `setupFiles` do project `node`. A
#    marca aqui NÃO é o nome de um teste — sob esta mutação o setup crasha ANTES de qualquer `it`,
#    então nome de teste nenhum sai na saída. A marca é o erro do módulo indevidamente carregado,
#    com as DUAS strings exigidas juntas.
rodar_sabotagem 'setup-dom-vaza-para-o-project-node' "$ALVO_PARTICAO" \
  '          name: "node",
          environment: "node",' \
  '          name: "node",
          environment: "node",
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],' \
  'setup-dom' 'is not defined'

# 4) DOM a menos, o sentido CALADO: o project `dom` perde o `setup-dom.ts` e fica só com o comum.
#    Nada explode — o jsdom já dá `document`, e a suíte inteira continua importável. O que some é
#    `matchMedia` (que o jsdom não implementa) e o `asyncUtilTimeout: 5000`, que volta ao default
#    de 1000ms e passa a matar `findBy*` sob carga com "Unable to find role=…", erro que PARECE
#    elemento ausente. Marca = os nomes das duas testemunhas de DOM.
rodar_sabotagem 'project-dom-sem-o-setup-de-dom' "$ALVO_PARTICAO" \
  '          setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],' \
  '          setupFiles: ["./src/test/setup.ts"],' \
  'matchMedia existe e ecoa a query' \
  'o setup de DOM rodou: asyncUtilTimeout'

# 5) O FLIP que motiva tudo isto: o client troca o `localStorage` por um adapter de memória. O
#    supabase-js aceita em silêncio; só as testemunhas do contrato acusam.
rodar_sabotagem 'storage-do-client-vira-memoria' "$ALVO_CLIENT" \
  'auth: { storage: localStorage, persistSession: true, autoRefreshToken: true },' \
  'auth: { storage: ((): Storage => { const m = new Map<string, string>(); return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k: string) => m.get(k) ?? null, key: (i: number) => Array.from(m.keys())[i] ?? null, removeItem: (k: string) => { m.delete(k); }, setItem: (k: string, v: string) => { m.set(k, String(v)); } } as Storage; })(), persistSession: true, autoRefreshToken: true },' \
  'contrato storage-do-client'

# ── veredito ──────────────────────────────────────────────────────────────────────────────────
aviso ""
[ "$SABOTAGENS" -eq 5 ] || { aviso "❌ só $SABOTAGENS sabotagem(ns) rodou(ram) — esperadas 5"; FALHAS=$((FALHAS + 1)); }

# A restauração é ASSERÇÃO, não esperança: se a árvore não voltou ao ponto de partida, o verde
# acima vale menos que o estrago deixado em disco.
if [ -n "$(git status --short -- "$ALVO_COMUM" "$ALVO_PARTICAO" "$ALVO_CLIENT")" ]; then
  aviso "❌ os alvos NÃO voltaram ao estado original após as sabotagens:"
  git status --short -- "$ALVO_COMUM" "$ALVO_PARTICAO" "$ALVO_CLIENT"
  FALHAS=$((FALHAS + 1))
fi

if [ "$FALHAS" -eq 0 ]; then
  aviso "✅ CONTROLE VERDE + as 5 sabotagens VERMELHAS com a marca do ramo. Rede viva."
  exit 0
fi
aviso "❌ $FALHAS problema(s) — a rede NÃO está viva."
exit 1
