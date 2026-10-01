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
ALVO_STRIPPER_JS="src/lib/gates/limpeza-fonte.ts"
ALVO_CLI="$GATE"

TMPD="$(mktemp -d)"
# Por ora o trap só limpa o tmp. A restauração dos ALVOS por `git checkout` só é armada DEPOIS de
# provar que eles não têm alteração não commitada, e só no modo que sabota. Até 2026-10-01 ela vinha
# aqui, antes da checagem: o script dizia "commite antes", saía 70 — e o trap de saída apagava
# justamente a edição que a checagem protegia (medido: a edição sumiu, rc=70). E restaurava também
# no modo (A), que não sabota nada e roda em todo `test:hooks`.
trap 'rm -rf "$TMPD"' EXIT

FALHAS=0
# Forma CANÔNICA da casa (`[ "${1:-}" = "--falsificar" ]`) — não é estilo: é o que
# `scripts/falsificacao-cobertura.test.ts` casa para saber que esta suíte TEM o modo. Guarda
# equivalente porém escrita de outro jeito deixa o vigia achar que o modo não existe.
FALSIFICAR=0
if [ "${1:-}" = "--falsificar" ]; then FALSIFICAR=1; fi
aviso() { printf '%s\n' "$*"; }

# ── sondas fail-CLOSED: este script SABOTA e RESTAURA fonte; sem git ele destrói ──────────────
command -v git >/dev/null 2>&1 || { aviso "❌ git ausente — abortando (o script restaura por git checkout)"; exit 70; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { aviso "❌ fora de repositório git — abortando"; exit 70; }
command -v bun >/dev/null 2>&1 || { aviso "❌ bun ausente — abortando"; exit 70; }
bun --version >/dev/null 2>&1 || { aviso "❌ bun presente mas quebrado — abortando"; exit 70; }
[ -f "$GATE" ] && [ -d "$DIR_FIXTURES" ] || { aviso "❌ gate ou fixtures ausentes — abortando"; exit 70; }
if [ "$FALSIFICAR" -eq 1 ]; then
  for f in "$ALVO_SCANNER" "$ALVO_STRIPPER" "$ALVO_STRIPPER_JS" "$ALVO_CLI"; do
    git diff --quiet -- "$f" || { aviso "❌ $f tem alteração NÃO COMMITADA — a restauração por git checkout a perderia. Commite antes."; exit 70; }
  done
  trap 'rm -rf "$TMPD"; git checkout -- "$ALVO_SCANNER" "$ALVO_STRIPPER" "$ALVO_STRIPPER_JS" "$ALVO_CLI" 2>/dev/null' EXIT
fi

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
[ "$N_FIX" -ge 28 ] || { aviso "❌ só $N_FIX fixture(s) materializada(s) — corpo pequeno demais para provar nada"; exit 70; }

# O veredito do CLI é o PAR "<rc> <MARCA>": o rc sozinho não separa "o fiscal acusou" (1 + a linha
# de violação) de "o bun MORREU" (1 + stack trace) — e é esse o vermelho que a sabotagem que só quebra
# o TypeScript produz. A marca vale ANCORADA no começo da linha e com o NÚMERO que só o fiscal imprime:
# a exceção do bun mostra o código-fonte (`console.error(\`❌ ${…} … leem SQL…\`)`), e a busca solta
# achava ali a marca de violação (Codex, 2026-09-27). Lido em LC_ALL=C; locale do CLI vem do chamador.
classifica() { # <rc> <saída>
  local s="$2"
  # here-string, não pipe: sob `pipefail`, o `grep -q` que sai cedo mata o `printf` (141)
  if LC_ALL=C grep -qE '^❌ INDETERMINADO ' <<<"$s"; then printf '%s INDETERMINADO\n' "$1"
  elif LC_ALL=C grep -qE '^❌ [0-9]+ .*leem SQL de -f/stdin sem ON_ERROR_STOP:$' <<<"$s"; then printf '%s VIOLA\n' "$1"
  elif LC_ALL=C grep -qE '^✅ psql-ro/ON_ERROR_STOP: [0-9]+ ' <<<"$s"; then printf '%s LIMPO\n' "$1"
  else printf '%s OUTRO\n' "$1"; fi
}
veredito_do_caso() { local saida rc; saida="$(bun "$GATE" "$TMPD/casos/$1" 2>&1)"; rc=$?; classifica "$rc" "$saida"; }
veredito_do_repo() { local saida rc; saida="$(bun "$GATE" 2>&1)"; rc=$?; classifica "$rc" "$saida"; }

# Confere TODAS as expectativas num locale. Devolve 0 se todas baterem.
conferir() {
  local loc="$1" quebrou=0
  for d in "$TMPD"/casos/*; do
    local base esperado obtido
    base="$(basename "$d")"
    case "$base" in
      viola-*) esperado="1 VIOLA" ;;
      limpo-*) esperado="0 LIMPO" ;;
      indeterminado-*) esperado="2 INDETERMINADO" ;;
      *) continue ;;
    esac
    obtido="$(LC_ALL="$loc" LANG="$loc" veredito_do_caso "$base")"
    if [ "$obtido" != "$esperado" ]; then
      quebrou=1
      aviso "    ✗ [$loc] $base → $obtido, esperado $esperado"
    fi
  done
  return "$quebrou"
}

# O corpo REAL do repo continua limpo — rc 0 COM a linha de limpo — neste locale?
repo_limpo() { [ "$(LC_ALL="$1" LANG="$1" veredito_do_repo)" = "0 LIMPO" ]; }

aviso "═══ (A) EXPECTATIVA — $N_FIX fixtures, dois locales ═══"
for LOC in $LOCALES; do
  if conferir "$LOC"; then
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

# O que cada ID DECLARA: `V<letra>` = a fixture viola-<letra>-*, que sabotada tem de sair "0 LIMPO" (a
# violação ESCAPOU); `L<letra>` = limpo-<letra>-*, que tem de sair "1 VIOLA" (falso positivo, com a
# linha de violação); `I<letra>` = indeterminado-<letra>-*, que tem de sair "0 LIMPO" (o alarme
# CALOU e a fonte que o fiscal não sabe julgar passou como limpa); REPO = o corpo real, que tem de
# sair "2 INDETERMINADO" (o piso ou a contagem cruzada acusou).
esperado_sabotado() { case "$1" in V?|I?) echo "0 LIMPO" ;; L?) echo "1 VIOLA" ;; REPO) echo "2 INDETERMINADO" ;; *) echo "ID-DESCONHECIDO" ;; esac; }
caso_do_id() { # VA → viola-a-…; vazio se o ID não tem fixture
  local pre letra d
  case "$1" in V?) pre=viola ;; L?) pre=limpo ;; I?) pre=indeterminado ;; *) return 0 ;; esac
  letra="$(printf '%s' "${1#?}" | tr '[:upper:]' '[:lower:]')"
  for d in "$TMPD/casos/$pre-$letra"-*; do [ -d "$d" ] && basename "$d"; done
}
veredito_do_id() { # <locale> <ID>
  if [ "$2" = REPO ]; then LC_ALL="$1" LANG="$1" veredito_do_repo; return; fi
  local caso; caso="$(caso_do_id "$2")"
  if [ -z "$caso" ]; then echo "SEM-FIXTURE"; return; fi
  LC_ALL="$1" LANG="$1" veredito_do_caso "$caso"
}

# registra <nome> <rótulo> <arquivo> <texto original> <texto sabotado> — a TABELA das sabotagens.
# Nome da lista sem registro e registro fora da lista são FALHA: o primeiro não sabotaria nada, o
# segundo nunca rodaria.
registradas=""
registra() {
  case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1) — o 2o registro sobrescreveria o 1o" >&2; exit 2 ;; esac
  registradas="$registradas $1"
  printf -v "rotulo_$1" '%s' "$2"; printf -v "arq_$1" '%s' "$3"
  printf -v "de_$1" '%s' "$4"; printf -v "para_$1" '%s' "$5"
}
CAMADAS=0

# (A) ja E o CONTROLE explicito deste arnes -- e o unico dos 5 do `test:falsificacao` que nascera
# com linha de base. O que faltava era ABORTAR: com FALHAS>0 em (A) a rede ja esta vermelha sem
# sabotagem, e cada "✅ sabotada -> VERMELHO" de (B) vira veredito FABRICADO sobre uma camada que
# ninguem mediu. "Ficou vermelho" so e informacao se existir um verde do qual sair.
if [ "$FALSIFICAR" -eq 1 ] && [ "$FALHAS" -ne 0 ]; then
  aviso ""
  aviso "❌ (A) NAO fechou: $FALHAS problema(s) na rede base. Abortando ANTES de (B) —"
  aviso "   sabotar sobre vermelho nao prova camada nenhuma."
  exit 1
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

aviso ""
aviso "═══ (B) SABOTAGEM — uma camada por vez, exigindo vermelho POR CAUSA dela ═══"

# <sabotagem>:<o que TEM de acusá-la> — IDs por `,` (cada um, nos DOIS locales). Exit≠0 NÃO é dente:
# até 2026-09-27 valia QUALQUER fixture com rc ≠ esperado no 1º locale que quebrasse — e a sabotagem
# que só quebra o TypeScript faz o bun morrer com exit 1, toda `limpo-*` "quebrava" e a camada saía
# ✅ sem nenhum julgamento. docs/historico/falsificacao-exit-nao-e-dente.md
SABOTAGENS="descoberta_de_vinculo:VB refutacao_da_semente:LE forma_c:LJ,LM forma_f:VA forma_file_longa:VG
            deteccao_errorstop:VA valor_errorstop:VF deteccao_stdin:VD repasse_opaco:VH
            mascara_de_contexto:LF limpeza_de_comentario:REPO herestring:REPO pilha_de_contexto:VA
            piso_do_walker:REPO
            pipe_entrando:VL pipe_nao_e_ou_logico:LK
            ancora_do_caminho:VM,REPO sem_c_le_sql:VN recusa_todo_emitido:LL interpolacao_opaca:LL
            prefixo_rodavel:LO vinculo_emitido:LM referencia_parentetica:LN referencia_so_o_caminho:VO
            literal_simples:REPO literal_template:REPO contagem_cruzada:IA stripper_js_linha:REPO"

registra descoberta_de_vinculo 'descoberta-de-vínculo' "$ALVO_SCANNER" \
  'if (MARCA_WRAPPER.test(rhs)) vinculados.add(nome);' \
  'if (false && MARCA_WRAPPER.test(rhs)) vinculados.add(nome);'

registra refutacao_da_semente 'refutação-da-semente' "$ALVO_SCANNER" \
  'if (!vinculados.has(nome) && !MARCA_WRAPPER.test(rhs)) refutados.add(nome);' \
  'if (false) refutados.add(nome);'

registra forma_c 'forma -c (protegida)' "$ALVO_SCANNER" \
  "if (clusterContem(nu, 'c')) temC = true;" \
  "if (false) temC = true;"

registra forma_f 'forma -f (exige)' "$ALVO_SCANNER" \
  "if (clusterContem(nu, 'f')) temF = true;" \
  "if (false) temF = true;"

registra forma_file_longa 'forma --file longa' "$ALVO_SCANNER" \
  "if (nu === '--file' || nu.startsWith('--file=')) temF = true;" \
  "if (false) temF = true;"

registra deteccao_errorstop 'detecção de ON_ERROR_STOP' "$ALVO_SCANNER" \
  'return { temC, temF, temErrorStop };' \
  'return { temC, temF, temErrorStop: true };'

registra valor_errorstop 'VALOR do ON_ERROR_STOP' "$ALVO_SCANNER" \
  "return !['off', '0', 'false', 'no'].includes(bruto);" \
  'return true;'

registra deteccao_stdin 'detecção de stdin (< << <<<)' "$ALVO_SCANNER" \
  "if (c === '<') return true;" \
  'if (false) return true;'

registra repasse_opaco 'repasse opaco ("$@")' "$ALVO_SCANNER" \
  'const opaco = repassaArgumentosOpacos(palavras.slice(1));' \
  'const opaco = false;'

registra mascara_de_contexto 'máscara de contexto (prosa)' "$ALVO_SCANNER" \
  'if (contexto[ini] !== 1) continue;' \
  'if (false) continue;'

registra limpeza_de_comentario 'limpeza de comentário' "$ALVO_STRIPPER" \
  "if (c === '#' && ANTES_DE_COMENTARIO.has(anterior)) {" \
  "if (false && ANTES_DE_COMENTARIO.has(anterior)) {"

# A sabotagem tem de reproduzir o furo REAL: consumir só UM `<` faz o segundo virar um `<<`
# sozinho. Desligar o ramo inteiro NÃO reproduz — o `<<` cai no leitor de cabeçalho, que não acha
# delimitador em `<` e desiste, e a sabotagem fica inócua. Sabotagem inócua vira "camada
# redundante" no relatório, que é um veredito FABRICADO sobre uma camada que ninguém testou.
registra herestring 'herestring <<< (não é heredoc)' "$ALVO_STRIPPER" \
  '        marcar(i + 3, 1);' \
  '        marcar(i + 1, 1); i += 1; if (true) continue;'

registra pilha_de_contexto 'pilha de contexto (substituicao dentro de aspas duplas)' "$ALVO_STRIPPER" \
  "if (c === '\$' && fonte[i + 1] === '(') {" \
  "if (false && fonte[i + 1] === '(') {"

registra piso_do_walker 'piso de denominador (walker vazio)' "$ALVO_CLI" \
  '  for (const r of raizes) andar(resolve(base, r));' \
  '  if (raizes.length > 0) return achados;'

# ── 2026-10-01: o cano no lado shell e o eixo da instrução EMITIDA (literal TS de gerador) ──────
registra pipe_entrando 'pipe para dentro do wrapper (… | wrapper)' "$ALVO_SCANNER" \
  'return /(?:^|[^|])\|&?$/.test(t);' \
  'return false;'

registra pipe_nao_e_ou_logico 'OU lógico (||) NÃO é cano' "$ALVO_SCANNER" \
  'return /(?:^|[^|])\|&?$/.test(t);' \
  'return /\|&?$/.test(t);'

# A âncora quebrada esvazia o eixo inteiro SEM disparar a contagem cruzada (as duas metades contam
# com a mesma âncora, e 0 = 0): só o PISO dos emitidos separa isso de "nenhuma instrução sem a
# flag". É o REPO, aqui, que prova o piso.
registra ancora_do_caminho 'âncora do caminho do wrapper' "$ALVO_SCANNER" \
  'const ANCORA_CAMINHO = /\/\.config\/afiacao\/psql-ro(?![\w-])/g;' \
  'const ANCORA_CAMINHO = /\/\.config\/afiacao\/psql-ro-NUNCA(?![\w-])/g;'

registra sem_c_le_sql 'emitida sem -c lê SQL (colar é stdin)' "$ALVO_SCANNER" \
  'const precisaErrorStop = temF || !temC;' \
  'const precisaErrorStop = temF;'

registra recusa_todo_emitido 'emitida lê o ON_ERROR_STOP (não recusa tudo)' "$ALVO_SCANNER" \
  'const violaEmitida = precisaErrorStop && !temErrorStop;' \
  'const violaEmitida = true;'

registra interpolacao_opaca 'interpolação opaca (o cozido é lido inteiro)' "$ALVO_SCANNER" \
  "cozido: n.head.text + n.templateSpans.map((s) => INTERPOLACAO_OPACA + s.literal.text).join('')," \
  "cozido: n.head.text + n.templateSpans.map((s) => '\\n' + s.literal.text).join(''),"

registra prefixo_rodavel 'âncora sem prefixo é agulha, não caminho' "$ALVO_SCANNER" \
  "if (prefixo === '') continue;" \
  'if (false) continue;'

registra vinculo_emitido 'atribuição do caminho é vínculo' "$ALVO_SCANNER" \
  'if (VINCULO.test(antes)) continue;' \
  'if (false) continue;'

registra referencia_parentetica '(caminho) é referência' "$ALVO_SCANNER" \
  "if (ABRE_REFERENCIA.test(antes) && depois.startsWith(')')) continue;" \
  'if (false) continue;'

registra referencia_so_o_caminho 'o parêntese só absolve se contém SÓ o caminho' "$ALVO_SCANNER" \
  "if (ABRE_REFERENCIA.test(antes) && depois.startsWith(')')) continue;" \
  'if (ABRE_REFERENCIA.test(antes)) continue;'

registra literal_simples 'parser: literal de aspas' "$ALVO_SCANNER" \
  'if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {' \
  'if (false) {'

registra literal_template 'parser: template com interpolação' "$ALVO_SCANNER" \
  '} else if (ts.isTemplateExpression(n)) {' \
  '} else if (false) {'

registra contagem_cruzada 'contagem cruzada stripper × parser' "$ALVO_SCANNER" \
  'if (noCodigo !== nosLiterais) {' \
  'if (false) {'

# O stripper COMPARTILHADO que para de limpar `//`: o comentário com o caminho sobra no código, e só
# o parser — a máquina de FORA — sabe que ali não há literal. É a sub-limpeza vista por fora.
registra stripper_js_linha 'stripper JS: comentário de linha' "$ALVO_STRIPPER_JS" \
  "if (c === '/' && prox === '/') {" \
  "if (false && prox === '/') {"

# A camada só conta como vermelha se CADA ID declarado deu o veredito declarado nos DOIS locales —
# o par (rc, marca) que só o julgamento produz. Crash do bun sai "1 OUTRO"; sabotagem que nem aplica
# é acusada antes, e restaurada.
# Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
# suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
# shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
[ -z "$repetidos" ] || { aviso "  ❌ SABOTAGENS com nome repetido: $repetidos"; FALHAS=$((FALHAS + 1)); }
case "$SABOTAGENS" in *'|'*) aviso "  ❌ SABOTAGENS com | (OU): declare por , (E)"; FALHAS=$((FALHAS + 1)) ;; esac
for item in $SABOTAGENS; do
  sab="${item%%:*}"; exigidos="${item#*:}"
  v="rotulo_$sab"; rotulo="${!v-}"; v="arq_$sab"; arq="${!v-}"
  v="de_$sab"; de="${!v-}"; v="para_$sab"; para="${!v-}"
  if [ -z "$de" ]; then
    aviso "  ❌ [$sab] está na lista SABOTAGENS e SEM registro — nada foi sabotado"; FALHAS=$((FALHAS + 1)); continue
  fi
  CAMADAS=$((CAMADAS + 1))
  if ! sabotar "$arq" "$de" "$para"; then
    aviso "  ❌ [$rotulo] a sabotagem não aplicou — nada foi provado"
    FALHAS=$((FALHAS + 1))
    git checkout -- "$arq"
    continue
  fi
  log="$TMPD/sabotada-$sab.log"; : > "$log"
  for exigido in ${exigidos//,/ }; do
    for LOC in $LOCALES; do
      printf '%s %s %s\n' "$exigido" "$LOC" "$(veredito_do_id "$LOC" "$exigido")" >> "$log"
    done
  done
  git checkout -- "$arq"
  faltam=""
  for exigido in ${exigidos//,/ }; do
    for LOC in $LOCALES; do
      if ! LC_ALL=C grep -qxF "$exigido $LOC $(esperado_sabotado "$exigido")" "$log"; then
        faltam="$faltam [$(LC_ALL=C grep -m1 "^$exigido $LOC " "$log" || echo "$exigido $LOC ?")]"
      fi
    done
  done
  if [ -z "$faltam" ]; then
    aviso "  ✅ [$rotulo] sabotada → VERMELHO no declarado ($exigidos: $(esperado_sabotado "${exigidos%%,*}")) em [$LOCALES]"
  else
    aviso "  ❌ [$rotulo] sabotada, mas o vermelho declarado NÃO veio — medido:$faltam"
    FALHAS=$((FALHAS + 1))
  fi
done
for r in $registradas; do
  case " $SABOTAGENS " in
    *[[:space:]]"$r:"*) ;;
    *) aviso "  ❌ [$r] registrada e FORA da lista SABOTAGENS — nunca roda"; FALHAS=$((FALHAS + 1)) ;;
  esac
done

aviso ""
if [ "$FALHAS" -eq 0 ]; then
  aviso "✅ REDE VIVA: $N_FIX fixtures × locales [$LOCALES]; as $CAMADAS camadas ficaram vermelhas NO veredito declarado."
  exit 0
fi
aviso "❌ $FALHAS problema(s) na rede — ver acima. Rede que não falsifica não prova."
exit 1
