#!/usr/bin/env bash
# test-ocupacao-por-arquivo.sh — TDD de `ocupacao-contexto.sh --por-arquivo`.
#
# POR QUÊ ESTE TESTE EXISTE, e por que o caso 5 dá nome à suíte:
#
# A régua responde "que ARQUIVO ocupa mais contexto", e a resposta decide o que
# destilar primeiro. Três jeitos distintos de ela mentir, todos baratos:
#
#   (a) inverter a TESE — o custo de um tool_result é `tamanho × requests que
#       ainda virão`, não o tamanho. Um Read grande no fim da sessão é barato; o
#       mesmo Read no começo é o item mais caro que existe. Se o cálculo trocar
#       posição por restante, o ranking sai exatamente ao contrário e continua
#       parecendo plausível;
#   (b) contar request 2,28× — uma resposta com vários blocos vira várias linhas
#       no JSONL, todas repetindo o mesmo `usage` (medido neste repo: 329 linhas
#       para 144 requests). Sem dedupe por requestId, TODO multiplicador infla;
#   (c) devolver TABELA VAZIA quando o que houve foi FALHA. Ao levantar a linha
#       de base desta régua, um `xargs -a` — que não existe no BSD/macOS — com
#       `2>/dev/null` converteu `invalid option` em saída vazia. O veredito a um
#       passo de ser escrito era "`docs/agent` nunca é lido"; a verdade eram 200
#       leituras em 17 dias. Só o controle POSITIVO pegou.
#
# (c) é a família `ausente ≠ zero` do CLAUDE.md aplicada ao shell: silêncio de
# ferramenta quebrada é indistinguível de silêncio de ocupação zero, e só uma
# checagem explícita os separa. Por isso a régua sai VERMELHA em vez de imprimir
# uma tabela vazia, e por isso este arquivo se chama assim.
#
# Uso: bash scripts/test-ocupacao-por-arquivo.sh              (exit 0 = verde)
#      bash scripts/test-ocupacao-por-arquivo.sh --falsificar (sabota o alvo; exige vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${OCUPACAO_OVERRIDE:-$here/ocupacao-contexto.sh}"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

falhas=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
ruim() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; falhas=$((falhas+1)); }
# Casa string ASCII, caixa fixa, sem -i: sob pt_BR.UTF-8 o `grep -i` dobra
# acento e casa o ramo errado (#1483). Todo marcador testado aqui é ASCII.
tem() { printf '%s' "$1" | command grep -qF "$2"; }

# ---- fixture sintética ------------------------------------------------------
# Formato real do transcript: a linha do `tool_use` carrega `message.usage` e
# `requestId`; a do `tool_result` não carrega nem um nem outro, só `sessionId`.
linha_req() { # <requestId> <sessao>
  jq -nc --arg r "$1" --arg s "$2" \
    '{requestId:$r, sessionId:$s, message:{usage:{input_tokens:1}}}'
}
linha_use() { # <requestId> <sessao> <toolid> <nome> <file_path|"">
  jq -nc --arg r "$1" --arg s "$2" --arg i "$3" --arg n "$4" --arg f "$5" \
    '{requestId:$r, sessionId:$s, message:{usage:{input_tokens:1}, content:[
       ({type:"tool_use", id:$i, name:$n}
        + (if $f == "" then {} else {input:{file_path:$f}} end))]}}'
}
linha_res() { # <sessao> <toolid> <n_chars>
  jq -nc --arg s "$1" --arg i "$2" --argjson n "$3" \
    '{sessionId:$s, message:{content:[{type:"tool_result", tool_use_id:$i, content:("x"*$n)}]}}'
}

WT=/Users/x/Projetos/afiacao/.claude/worktrees/wt-a   # worktree "interno"
WT2=/Users/x/Projetos/afiacao-claude-outro            # worktree "ao lado"

# projects/<dir>/<sessao>.jsonl — o dir tem de casar *afiacao* para a auto-coleta
novo_projects() { # <nome> -> ecoa o dir de projects
  d="$tmp/$1/projects/-Users-x-Projetos-afiacao-teste"
  mkdir -p "$d"; printf '%s' "$tmp/$1/projects"
}

roda() { CLAUDE_PROJECTS_DIR="$1" bash "$ALVO" --por-arquivo --linhas 99 "${@:2}" 2>/dev/null; }

# ---- fixture 1: a TESE (mesmo arquivo, mesmo tamanho, posições opostas) ------
# 200 requests. `cedo.md` é lido no 1º, `tarde.md` no 199º — bytes IDÊNTICOS, e
# por isso a única coisa que pode ordená-los é a posição.
#   cedo  = 3500/3.5 × (200-1)   = 199.000 tok·req
#   tarde = 3500/3.5 × (200-199) =     1.000 tok·req
monta_tese() { # <dir projects> [repeticoes por request: 1 = normal, 3 = blocos]
  P="$1"; rep="${2:-1}"
  J="$P/-Users-x-Projetos-afiacao-teste/tese.jsonl"; : > "$J"
  i=1
  while [ "$i" -le 200 ]; do
    r=1
    while [ "$r" -le "$rep" ]; do
      case "$i" in
        1)   linha_use "req_$i" s1 t_cedo  Read "$WT/docs/agent/cedo.md"  >> "$J" ;;
        199) linha_use "req_$i" s1 t_tarde Read "$WT/docs/agent/tarde.md" >> "$J" ;;
        *)   linha_req "req_$i" s1 >> "$J" ;;
      esac
      r=$((r+1))
    done
    case "$i" in
      1)   linha_res s1 t_cedo  3500 >> "$J" ;;
      199) linha_res s1 t_tarde 3500 >> "$J" ;;
    esac
    i=$((i+1))
  done
}

if [ "${1:-}" != "--falsificar" ]; then echo "▶ ocupacao-contexto.sh --por-arquivo"; fi

P1="$(novo_projects tese)"; monta_tese "$P1"
saida="$(roda "$P1")"

# ---- 1) a tese: cedo custa mais que tarde -----------------------------------
pos_cedo="$(printf '%s\n' "$saida" | command grep -n 'cedo.md'  | cut -d: -f1 | head -1)"
pos_tarde="$(printf '%s\n' "$saida" | command grep -n 'tarde.md' | cut -d: -f1 | head -1)"
if [ -n "$pos_cedo" ] && [ -n "$pos_tarde" ] && [ "$pos_cedo" -lt "$pos_tarde" ]; then
  ok "arquivo lido CEDO ranqueia acima do mesmo tamanho lido no FIM"
else
  ruim "a tese inverteu (cedo=$pos_cedo tarde=$pos_tarde) — o calculo usa posicao, nao restante"
  printf '%s\n' "$saida" | sed 's/^/      /'
fi

# Fecha dos DOIS lados: ordem certa com pesos errados passaria no teste acima.
# 199× é a razão exata das posições; a asserção aceita só o intervalo em volta.
pct_cedo="$(printf '%s\n' "$saida" | command grep 'cedo.md'  | command sed 's/.* \([0-9.]*\)%$/\1/')"
if [ -n "$pct_cedo" ] && LC_ALL=C awk -v p="$pct_cedo" 'BEGIN{exit !(p > 99 && p <= 100)}'; then
  ok "peso proporcional aos requests restantes (cedo = ${pct_cedo}%, esperado ~99,5%)"
else
  ruim "cedo deveria levar ~99,5% da ocupacao, levou '${pct_cedo}%'"
fi

# ---- 2) dedupe por requestId ------------------------------------------------
# Mesma sessão, cada request escrito 3× com o MESMO requestId — a forma exata de
# uma resposta com vários blocos. A tabela tem de sair IDÊNTICA à de 1 bloco.
P2="$(novo_projects dedupe)"; monta_tese "$P2" 3
saida_dup="$(roda "$P2")"
if [ "$(printf '%s' "$saida" | command sed 's/sessoes=.*//')" \
   = "$(printf '%s' "$saida_dup" | command sed 's/sessoes=.*//')" ]; then
  ok "requestId repetido (varios blocos por resposta) nao infla a ocupacao"
else
  ruim "3 blocos por request mudaram o resultado — dedupe por requestId nao segurou"
  printf '%s\n' "$saida_dup" | sed 's/^/      /'
fi

# ---- 3) Bash entra como linha agregada, nunca sumido ------------------------
# Bash é ~40% da ocupação medida e não tem file_path. Omiti-lo sem dizer seria
# ausência apresentada como medida — o defeito que esta régua existe para achar.
# 100 requests, não 3: com sessão curta a coluna `tok*req(M)` arredonda para 0.0
# nos DOIS modos e o caso 4 abaixo compararia 0.0 com 0.0 — asserção que passa
# aconteça o que acontecer. O tamanho da fixture aqui é o que dá poder ao teste.
P3="$(novo_projects bash)"
J3="$P3/-Users-x-Projetos-afiacao-teste/b.jsonl"
{ linha_use req_1 s2 t_b Bash ""; linha_res s2 t_b 20000
  linha_use req_2 s2 t_r Read "$WT/docs/agent/x.md"; linha_res s2 t_r 20000
  i=3; while [ "$i" -le 100 ]; do linha_req "req_$i" s2; i=$((i+1)); done; } > "$J3"
saida_b="$(roda "$P3")"
if tem "$saida_b" "(Bash - sem arquivo)"; then
  ok "chamada sem file_path aparece como '(Bash - sem arquivo)'"
else
  ruim "Bash sumiu do ranking por arquivo — 40% da ocupacao omitida em silencio"
  printf '%s\n' "$saida_b" | sed 's/^/      /'
fi

# ---- 4) os dois modos somam o MESMO total (risco 2 do spec) -----------------
# Conta pelo FIM (NF-1): o rótulo agregado tem espaços e quebraria índice fixo.
# LC_ALL=C no awk do TESTE, não só no do alvo: sob pt_BR ele lê "1.2" como 1 (a
# vírgula é que separa decimal lá), a soma desaba para zero e a trava de fixture
# fraca logo abaixo — que compara com a string "0.0" — deixa passar um "0,0".
# Foi assim que este mesmo caso voltou a ser vazio depois de já ter sido curado.
soma_col5() { printf '%s\n' "$1" | command grep -E '%$' | LC_ALL=C awk '{s+=$(NF-1)} END{printf "%.1f", s}'; }
por_ferr="$(CLAUDE_PROJECTS_DIR="$P3" bash "$ALVO" --por-ferramenta --linhas 99 \
              "$J3" 2>/dev/null)"
sa="$(soma_col5 "$saida_b")"; sf="$(soma_col5 "$por_ferr")"
# CONTROLE POSITIVO antes da igualdade: `0.0 = 0.0` é verdade em toda régua
# quebrada que existe. A asserção só vale se as duas somas forem MEDIDAS.
if [ "$sa" = "0.0" ] || [ "$sa" = "0,0" ] || [ -z "$sa" ]; then
  ruim "soma por-arquivo veio '$sa' — fixture sem poder, a igualdade abaixo nao provaria nada"
elif [ "$sa" = "$sf" ]; then
  ok "total por ARQUIVO = total por FERRAMENTA ($sa M tok*req) — as duas reguas fecham"
else
  ruim "por-arquivo somou '$sa' e por-ferramenta '$sf' — as reguas discordam"
fi

# ---- 5) o caso que dá nome à suíte: vazio por FALHA sai VERMELHO ------------
# Três bocas por onde "não consegui medir" viraria "ocupação zero". Nenhuma pode
# imprimir tabela; todas têm de sair com exit != 0 e dizer por quê.
P5="$(novo_projects vazio)"
: > "$P5/-Users-x-Projetos-afiacao-teste/sem-eventos.jsonl"   # arquivo existe, 0 eventos
if saida_v="$(CLAUDE_PROJECTS_DIR="$P5" bash "$ALVO" --por-arquivo 2>&1)"; then rc=0; else rc=$?; fi
if [ "$rc" -ne 0 ] && tem "$saida_v" "ausência de dado"; then
  ok "sessao lida e NENHUM evento extraido -> vermelho (exit $rc), nao tabela vazia"
else
  ruim "extracao vazia saiu rc=$rc sem dizer 'ausencia de dado' — falha virou medida"
  printf '%s\n' "$saida_v" | sed 's/^/      /'
fi

P6="$tmp/janela/projects"; mkdir -p "$P6/-Users-x-Projetos-afiacao-teste"
if saida_j="$(CLAUDE_PROJECTS_DIR="$P6" bash "$ALVO" --por-arquivo 2>&1)"; then rc=0; else rc=$?; fi
if [ "$rc" -ne 0 ] && tem "$saida_j" "nenhuma sessão nos últimos"; then
  ok "nenhuma sessao na janela -> vermelho (exit $rc), nao 'ocupacao zero'"
else
  ruim "janela sem sessao saiu rc=$rc — silencio virou resposta"
fi

if saida_p="$(CLAUDE_PROJECTS_DIR="$P1" OCUPACAO_REPO_PADRAO=projeto-que-nao-existe \
              bash "$ALVO" --por-arquivo 2>&1)"; then rc=0; else rc=$?; fi
if [ "$rc" -ne 0 ] && tem "$saida_p" "nenhum projeto casando"; then
  ok "escopo que nao casa nenhum projeto -> vermelho (exit $rc)"
else
  ruim "escopo vazio saiu rc=$rc — filtro errado pareceria projeto ocioso"
fi

# ---- 6) marcador POSITIVO de fim -------------------------------------------
# Sem ele, uma execução morta no meio (OOM, pipe quebrado) é indistinguível de
# uma que terminou: os dois deixam uma tabela parcial na tela.
if tem "$saida" "OCUPACAO-CONTEXTO-OK"; then
  ok "execucao completa imprime OCUPACAO-CONTEXTO-OK"
else
  ruim "sem marcador positivo de fim — tabela truncada passaria por completa"
fi

# ---- 7) normalização: o mesmo arquivo em 2 worktrees é UM arquivo -----------
# Sem colapsar, ~30 worktrees pulverizam o doc mais caro do repo em 30 linhas
# minúsculas e ele não aparece no topo de ranking nenhum.
P7="$(novo_projects wt)"
J7="$P7/-Users-x-Projetos-afiacao-teste/w.jsonl"
{ linha_use req_1 s3 t_1 Read "$WT/docs/agent/mesmo.md";  linha_res s3 t_1 5000
  linha_use req_2 s3 t_2 Read "$WT2/docs/agent/mesmo.md"; linha_res s3 t_2 5000
  linha_req req_3 s3; } > "$J7"
n_mesmo="$(roda "$P7" | command grep -c 'docs/agent/mesmo.md' || true)"
linha_n="$(roda "$P7" | command grep 'docs/agent/mesmo.md' | awk '{print $2}')"
if [ "$n_mesmo" = "1" ] && [ "$linha_n" = "2" ]; then
  ok "mesmo arquivo em 2 worktrees colapsa em 1 linha com n=2"
else
  ruim "normalizacao falhou: $n_mesmo linha(s), n=$linha_n (esperado 1 linha, n=2)"
fi

# ---- 8) a saída não pode depender do LOCALE de quem roda --------------------
# Sob pt_BR.UTF-8 o printf do awk emite "0,2" e não "0.2" — e a chave de
# ordenação deste script é um `%018.3f`, então o `sort -rn` do meio do pipeline
# passa a ler o número com a vírgula do locale e pode REORDENAR o ranking.
# Não basta rodar a suíte sob um locale: o defeito só aparece no OUTRO. O teste
# força os dois ele mesmo, em vez de esperar que o ambiente colabore.
LOC_VIRGULA=""
for L in pt_BR.UTF-8 pt_BR.utf8 de_DE.UTF-8 fr_FR.UTF-8 es_ES.UTF-8; do
  if [ "$(LC_ALL="$L" awk 'BEGIN{printf "%.1f", 1.5}' 2>/dev/null)" = "1,5" ]; then
    LOC_VIRGULA="$L"; break
  fi
done
if [ -z "$LOC_VIRGULA" ]; then
  # Nenhum locale de vírgula instalado ⇒ o defeito não tem como se manifestar
  # AQUI. Isso é ausência de CASO, não aprovação — dizer "ok" seria a mesma
  # fabricação que a suíte inteira existe para impedir.
  printf '  \033[33mSKIP\033[0m  locale decimal-virgula ausente nesta maquina — caso 8 SEM cobertura\n'
else
  saida_loc="$(LC_ALL="$LOC_VIRGULA" bash "$ALVO" --por-arquivo --linhas 99 \
                 "$P1/-Users-x-Projetos-afiacao-teste/tese.jsonl" 2>/dev/null)"
  n_virg="$(printf '%s\n' "$saida_loc" | command grep -cE '[0-9],[0-9]+%?$' || true)"
  if [ "$n_virg" = "0" ] && tem "$saida_loc" "cedo.md"; then
    ok "sob $LOC_VIRGULA a saida sai com PONTO decimal (ranking nao muda com o ambiente)"
  else
    ruim "sob $LOC_VIRGULA sairam $n_virg numero(s) com virgula — saida depende do locale"
    printf '%s\n' "$saida_loc" | sed 's/^/      /'
  fi
fi

# ---- 9) transcript truncado não pode matar a varredura inteira --------------
# Caso NORMAL, não exótico: uma sessão viva está escrevendo o .jsonl agora, e a
# última linha vem pela metade. Sob `set -e`, o jq que sai != 0 abortava o script
# com exit 5 e ZERO mensagem — 684 outras sessões perdidas por causa de uma.
# Fail-closed onde importa (nada extraído ⇒ vermelho), mas o descarte parcial
# tem de ser ANUNCIADO: silenciá-lo seria o `2>/dev/null` que esta suíte
# persegue, cometido pela própria régua.
P9="$(novo_projects truncado)"
J9="$P9/-Users-x-Projetos-afiacao-teste/t.jsonl"
{ linha_use req_1 s4 t_a Read "$WT/docs/agent/vivo.md"; linha_res s4 t_a 4000
  linha_req req_2 s4
  printf '{"sessionId":"s4","requestId":"req_3","messa'; } > "$J9"
if saida_t="$(CLAUDE_PROJECTS_DIR="$P9" bash "$ALVO" --por-arquivo --linhas 99 2>&1)"; then rc=0; else rc=$?; fi
if [ "$rc" -eq 0 ] && tem "$saida_t" "docs/agent/vivo.md" && tem "$saida_t" "linha ilegível"; then
  ok "transcript truncado: mede o que veio antes da quebra E anuncia o descarte"
elif [ "$rc" -ne 0 ]; then
  ruim "transcript truncado abortou a varredura inteira (exit $rc) — 1 sessao viva derruba todas"
else
  ruim "transcript truncado passou CALADO — descarte silencioso e o defeito que esta suite persegue"
  printf '%s\n' "$saida_t" | sed 's/^/      /'
fi

# ---- 10) portabilidade BSD × GNU, por STUB ---------------------------------
# Esta suíte ficou VERDE no macOS e VERMELHA no CI (Linux) pelo mesmo código:
# `mktemp -t <prefixo>` é flag homônima — no BSD o argumento é um PREFIXO, no GNU
# é um TEMPLATE que exige ≥3 X's, e `mktemp: too few X's` derrubava o script
# inteiro via `set -e`, com exit 1 e sem mensagem própria.
# Rodar a suíte num SO não prova portabilidade nenhuma. O antídoto que
# `evidencia-positiva-shell.md` §6 já prescrevia é este: testar o OUTRO contrato
# por stub, na máquina que se tem.
STUB="$tmp/stub-gnu"; mkdir -p "$STUB"
# shellcheck disable=SC2016  # aspas simples de propósito no bloco todo: isto é o
# CÓDIGO-FONTE do stub sendo escrito em disco. `$@`/`$ult` têm de chegar literais
# ao arquivo — expandir aqui gravaria os valores desta shell e o stub nasceria
# inerte, aprovando exatamente o que deveria reprovar.
{ printf '#!/usr/bin/env bash\n'
  printf '# imita o contrato GNU: template posicional precisa de >=3 X consecutivos\n'
  printf 'ult=""; for a in "$@"; do ult="$a"; done\n'
  printf 'case "$ult" in\n'
  printf '  -*) ;;\n'
  printf '  *XXX*) ;;\n'
  printf '  *) echo "mktemp: too few X'"'"'s in template '"'"'$ult'"'"'" >&2; exit 1 ;;\n'
  printf 'esac\n'
  printf 'exec /usr/bin/mktemp "$@"\n'; } > "$STUB/mktemp"
chmod +x "$STUB/mktemp"
# Controle positivo do próprio stub: ele TEM de reprovar a forma BSD, senão o
# caso abaixo passaria por um stub inerte — verde por cegueira.
if PATH="$STUB:$PATH" mktemp -t sem-xis >/dev/null 2>&1; then
  ruim "stub GNU inerte (aceitou 'mktemp -t sem-xis') — o caso de portabilidade nao prova nada"
else
  saida_g="$(PATH="$STUB:$PATH" CLAUDE_PROJECTS_DIR="$P1" bash "$ALVO" \
               --por-arquivo --linhas 99 2>&1 || true)"
  if tem "$saida_g" "OCUPACAO-CONTEXTO-OK" && ! tem "$saida_g" "too few X"; then
    ok "roda sob o contrato GNU de mktemp (stub) — nao so sob o do BSD"
  else
    ruim "quebrou sob o contrato GNU de mktemp — verde no macOS, vermelho no CI"
    printf '%s\n' "$saida_g" | command grep -F "mktemp" | sed 's/^/      /'
  fi
fi

# ---- falsificação -----------------------------------------------------------
# Sabota uma CÓPIA do alvo (nunca o arquivo versionado) e EXIGE vermelho. Suíte
# que não fica vermelha quando a invariante quebra é teatro.
if [ "${1:-}" = "--falsificar" ]; then
  printf '\n== falsificacao (sabota o ALVO e EXIGE vermelho) ==\n'

  # ── CONTROLE: verde ANTES do primeiro sed ─────────────────────────────────
  # "Ficou vermelho" só informa se existir um verde do qual sair. Sem esta
  # trava, um arnês incondicionalmente vermelho APROVA TUDO: toda sabotagem
  # produz o vermelho exigido e o gate anuncia "cobre tudo". O controle roda na
  # MESMA invocação, com o mesmo OCUPACAO_OVERRIDE, trocando a sabotagem por
  # NADA — por isso não é redundante com a suíte crua do `test:hooks`.
  if [ "$falhas" -ne 0 ]; then
    printf '\n❌ falsificacao ABORTADA: os casos acima ja estao VERMELHOS.\n'
    printf '   Sem linha de base, sabotar nao prova nada.\n'
    exit 1
  fi
  controle="$tmp/controle.sh"
  cp "$ALVO" "$controle"; chmod +x "$controle"
  if OCUPACAO_OVERRIDE="$controle" bash "$0" >/dev/null 2>&1; then
    ok "controle (copia SEM sabotagem) -> VERDE"
  else
    ruim "controle SEM sabotagem ja esta VERMELHO — sem linha de base, sabotar nao prova nada"
    printf '\n❌ falsificacao ABORTADA: sem verde de partida.\n'
    exit 1
  fi

  copia="$tmp/sabotado.sh"
  sabota() { # <descricao> <invariante que deve quebrar> <expressao sed>
    desc="$1"; regra="$2"; expr="$3"
    erro=$(sed "$expr" "$ALVO" 2>&1 >"$copia"); chmod +x "$copia"
    # (1) sed inválido escreve cópia vazia — vermelha sem ter sabotado nada
    if [ -n "$erro" ]; then
      ruim "\"$desc\": sed invalido (${erro:0:60}) — sabotagem vazia"; return
    fi
    # (2) padrão que não casou deixa o alvo intacto
    if cmp -s "$ALVO" "$copia"; then
      ruim "\"$desc\": padrao nao casou, alvo intacto — sabotagem vazia"; return
    fi
    # (3) sintaxe de shell quebrada = vermelho pelo motivo errado
    if ! bash -n "$copia" 2>/dev/null; then
      ruim "\"$desc\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; return
    fi
    # (4) `bash -n` não vê runtime: fixture de FUMAÇA que a cópia tem de
    # atravessar sem erro de bash, senão o poder aparente sai inflado.
    fum="$(CLAUDE_PROJECTS_DIR="$P3" bash "$copia" --por-arquivo 2>&1 || true)"
    if printf '%s' "$fum" | command grep -qE 'unbound variable|command not found|syntax error'; then
      ruim "\"$desc\": quebrou o RUNTIME (${fum:0:60}) — vermelho pelo motivo errado"; return
    fi
    if OCUPACAO_OVERRIDE="$copia" bash "$0" >/dev/null 2>&1; then
      ruim "\"$desc\" passou VERDE — a suite NAO cobre: $regra"
    else
      ok "\"$desc\" -> vermelho"
    fi
  }

  # Uma camada por vez: a que ficar VERDE é redundante ou inalcançada.
  sabota "custo vira posicao em vez de restante" \
         "a TESE — Read caro no comeco viraria barato e o ranking inverteria" \
         's/restantes = req\[rsess\[i\]\] - rpos\[i\]/restantes = rpos[i]/'
  # shellcheck disable=SC2016  # aspas simples de propósito: `$3` é o campo do
  # AWK dentro do alvo, não uma variável desta shell. Expandir escreveria um
  # padrão que não casa — sabotagem vazia, que a trava (2) pega só depois de
  # custar uma rodada.
  sabota "dedupe por requestId desligado" \
         "varios blocos por resposta inflariam TODO multiplicador (2,28x medido)" \
         's/if ($3 != "-" \&\& (k in visto)) next/if (0) next/'
  # shellcheck disable=SC2016  # idem: `$BRUTO` é o TEXTO literal procurado
  # dentro do alvo. Aqui expandir seria pior que inútil — casaria o caminho do
  # mktemp desta execução, que não existe no arquivo.
  sabota "extracao vazia deixa de ser erro" \
         "jq morto / formato mudado imprimiria tabela vazia como 'ocupacao zero'" \
         's/if \[ ! -s "\$BRUTO" \]; then/if false; then/'
  sabota "janela sem sessao vira sucesso" \
         "recorte errado pareceria projeto ocioso (exit 0 com tabela vazia)" \
         's/exit 3$/exit 0/'
  sabota "chamada sem file_path e descartada" \
         "Bash — 40% da ocupacao — sumiria do ranking sem uma palavra" \
         's/k = "(" t " - sem arquivo)"/k = "x"/'
  sabota "normalizacao de worktree desligada" \
         "o mesmo doc lido de 30 worktrees viraria 30 linhas e nunca apareceria no topo" \
         's|sub("\^\.\*/" padrao "\[\^/\]\*/", "", q)|q = q|'
  sabota "marcador positivo de fim removido" \
         "execucao morta no meio passaria por completa" \
         's/^echo "OCUPACAO-CONTEXTO-OK/echo "fim/'
  # shellcheck disable=SC2016  # `$(mktemp …)` aqui é o TEXTO que o sed casa e
  # escreve no alvo; expandir rodaria o mktemp desta shell e gravaria um caminho
  # fixo — sabotagem que não sabota, e o alvo passaria a usar um arquivo só.
  sabota "mktemp volta a forma so-BSD (-t <prefixo>)" \
         "verde no macOS e vermelho no CI pelo mesmo codigo — flag homonima BSD x GNU" \
         's|^BRUTO=$(mktemp .*)$|BRUTO=$(mktemp -t ocupacao-contexto)|'
  sabota "jq volta a rodar solto sob set -e" \
         "1 sessao viva com linha parcial abortaria a varredura das outras 684" \
         's/^  if ! jq -rc /  if jq -rc /'
  # shellcheck disable=SC2016  # idem: `$parse_falhou` é o TEXTO procurado dentro
  # do alvo — a variável não existe nesta shell, e expandir escreveria um padrão
  # vazio que não casa nada.
  sabota "descarte por linha ilegivel deixa de ser anunciado" \
         "sessao truncada sairia da conta em silencio — o 2>\/dev\/null que a suite persegue" \
         's/^if \[ "\$parse_falhou" -gt 0 \]; then/if false; then/'
  if [ -n "$LOC_VIRGULA" ]; then
    sabota "LC_ALL=C removido (saida a merce do locale)" \
           "sob $LOC_VIRGULA o printf sai com virgula e o sort -rn pode reordenar o ranking" \
           's/^export LC_ALL=C$/: LC_ALL/'
  else
    # Sem locale de vírgula não há como sabotar isto AQUI. Anunciar em vez de
    # pular calado: o laço estaria reportando cobertura que não exerceu.
    printf '  \033[33mSKIP\033[0m  sabotagem do LC_ALL=C sem locale decimal-virgula — NAO exercitada\n'
  fi

  echo
  if [ "$falhas" -eq 0 ]; then
    echo "✅ falsificacao: toda sabotagem virou vermelho"; exit 0
  else
    echo "❌ falsificacao: $falhas sabotagem(ns) sobreviveu(ram) — a suite nao cobre o que promete"
    exit 1
  fi
fi

echo
if [ "$falhas" -eq 0 ]; then
  printf '\033[32mVERDE\033[0m — todos os casos passaram\n'
else
  printf '\033[31mVERMELHO\033[0m — %d caso(s)\n' "$falhas"
fi
exit "$falhas"
