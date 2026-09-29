#!/usr/bin/env bash
# test-read-contexto-nudge.sh — TDD do hook .claude/hooks/read-contexto-nudge.sh
#
# Regra sob teste (duas, independentes):
#   (a) VOLUME    — a leitura vai injetar >= 10k tokens estimados → avisa (marcador READ-GRANDE)
#   (b) RELEITURA — mesmo arquivo, MESMO range, arquivo NÃO alterado, na mesma
#                   sessão → avisa (marcador READ-RELEITURA)
# Silêncio (exit 0, zero stdout) em tudo o mais. NUNCA emite permissionDecision:
# o hook não bloqueia nem auto-aprova — só anexa contexto.
#
# Os marcadores casados aqui são ASCII puro, caixa fixa e EXCLUSIVOS de um ramo —
# de propósito. `grep -i` sobre texto pt-BR acentuado casa o ramo errado sob
# pt_BR.UTF-8 (o `grep` do shell é shim p/ ugrep, que dobra Ã↔ã) e não sob LC_ALL=C:
# a asserção passaria a falsificar por acidente de locale, não por desenho (#1483).
# Por isso: `command grep`, sem -i, string ASCII. NÃO troque os marcadores por
# trechos da prosa em português — o hook os declara como contrato de teste.
#
# Uso:
#   bash scripts/test-read-contexto-nudge.sh              # suíte (exit 0 = verde)
#   bash scripts/test-read-contexto-nudge.sh --falsificar # sabota o hook e EXIGE vermelho
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="${HOOK_SOB_TESTE:-$here/../.claude/hooks/read-contexto-nudge.sh}"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }
[ -f "$HOOK" ] || { echo "VERMELHO — hook não encontrado: $HOOK"; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp"          # isola as marcas de sessão deste teste

# ------------------------------------------------------------ falsificação ---
# Suíte verde não prova nada se ela não souber ficar vermelha. Aqui cada
# sabotagem quebra UMA regra do hook e a suíte precisa acusar; se passar, é a
# ASSERÇÃO que está frouxa, não o hook que está bom.
#
# Roda nos DOIS locales de propósito: uma asserção pode falsificar por acidente
# de ambiente e não por desenho — `grep -qi` sobre pt-BR casa "NÃO"/"não" sob
# pt_BR.UTF-8 (ugrep dobra Ã↔ã) e não sob LC_ALL=C, ficando vermelha só no shell
# de quem escreveu (#1483). Se um locale acusa e o outro não, a suíte mente.
# shellcheck disable=SC2016  # os padrões de sed abaixo usam aspas simples de
# propósito: `${mtime}`/`${tokens}` são o TEXTO que o sed procura dentro do hook,
# e precisam chegar até ele sem serem expandidos por este shell.
if [ "${1:-}" = "--falsificar" ]; then
  falhou=0
  printf '== falsificacao (sabota o hook e EXIGE vermelho NO ASSERT que a sabotagem declara) ==\n'

  # Os logs das rodadas saem SEM cor (`sem_cor`), para o ID casar logo depois da palavra.
  esc="$(printf '\033')"
  sem_cor() { LC_ALL=C sed "s/${esc}\[[0-9;]*m//g" "$1"; }
  # Asserts EXECUTADOS numa rodada (ok + FALHA): o recibo de que a suíte rodou inteira.
  asserts() { LC_ALL=C grep -cE '^  (ok +|FALHA )' "$1" || true; }
  # A camada 4: o stderr INTEIRO do hook, recolhido pelo EMBRULHO do alvo em cada rodada, contra o do
  # controle, por linha. A suíte normal joga esse stderr fora (`2>/dev/null`: o contrato é o stdout),
  # e o hook que morre de `set -u` no ramo de um assert CALA — o silêncio passaria por julgamento.
  # shellcheck source=scripts/lib/falsificacao-stderr.sh disable=SC1091
  . "$here/lib/falsificacao-stderr.sh"
  vermelhos() { { LC_ALL=C grep -Eo '^  FALHA [A-Za-z]+[0-9]+[a-z]? ' "$1" || true; } | LC_ALL=C awk '{ printf "%s ", $2 }'; }

  # Locale UTF-8 por SONDA POSITIVA, não por nome fixo (mesmo padrão de test-claude-md-budget.sh).
  # `pt_BR.UTF-8` cravado aqui dá 2 locales na M2 e (C, C) no runner ubuntu, onde pt_BR NÃO existe:
  # o bash cai para C, avisa no stderr, e a metade UTF-8 vira uma 2ª passada em C — metade da
  # cobertura fingindo ser inteira, que é a falsificação-em-UM-ambiente do #1483. Com a sonda:
  # pt_BR.UTF-8 na M2, C.UTF-8 no ubuntu — UTF-8 de verdade nos dois.
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 (pt_BR/en_US/C) — a metade UTF-8 nao rodaria.\n'
    printf '  Rodar so LC_ALL=C e chamar de verde e a falsificacao em UM ambiente do #1483.\n'
    exit 1
  fi

  # sabota <descricao> <regra-que-deve-quebrar> <expressao-sed>
  # O delimitador do sed é `%` porque os padrões contêm `|` (o `||` do shell) —
  # reusar `|` como delimitador produziria um sed INVÁLIDO, que escreveria uma
  # cópia vazia. Cópia vazia também fica vermelha, e a falsificação passaria
  # parecendo boa sem ter sabotado regra nenhuma. Daí as 4 travas abaixo.
  copia="$tmp/sabotado.sh"
  aplica() {  # escreve a cópia sabotada; 1 = falsificação VAZIA (já acusada), nada a julgar
    local erro fumaca
    erro="$(sed "$expr" "$HOOK" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:50}"; falhou=1; return 1
    fi
    if cmp -s "$HOOK" "$copia"; then
      printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, hook intacto — falsificacao vazia\n' "$desc"; falhou=1; return 1
    fi
    if ! bash -n "$copia" 2>/dev/null; then
      printf '  \033[31mFALHA\033[0m "%s": quebrou a SINTAXE — vermelho pelo motivo errado\n' "$desc"; falhou=1; return 1
    fi
    # (4) o miolo do hook é um programa jq dentro de STRING — `bash -n` não entra nele, então um
    #     jq inválido passa pelas 3 travas acima. Aqui o sintoma NÃO é ruído: o alvo silencia o
    #     stderr do jq (`… | jq -r '…' 2>/dev/null`), então o jq quebrado devolve campo vazio, o
    #     `[ "$tool" = "Read" ]` falha e o hook vira NO-OP CEGO — que cala TODA asserção de fala e
    #     é indistinguível, por comportamento, da sabotagem legítima "sempre silencia". Por isso a
    #     trava é ESTRUTURAL: destampa o stderr numa 2ª cópia e deixa o jq falar.
    #     (O irmão test-orfaos-custosos.sh usa a mesma ideia sem destampar, porque o awk dele
    #     escapa para o stderr sozinho — a trava de lá não transfere literalmente.)
    #     Marcadores ASCII, sem `-i`, via `command grep` (o grep do shell é shim p/ ugrep). O
    #     `awk` fica na alternância de propósito: se o hook ganhar um, a trava já o cobre.
    #     `stat` NÃO entra: o alvo usa `stat -c` (GNU) e o macOS cospe "illegal option" em toda
    #     execução — casá-lo reprovaria as 6 sabotagens legítimas na máquina do founder.
    sed 's%2>/dev/null%%g' "$copia" > "$copia.fumaca"
    fumaca="$(jq -nc --arg f "$HOOK" \
                '{hook_event_name:"PreToolUse", tool_name:"Read", session_id:"fumaca",
                  tool_input:{file_path:$f}}' | bash "$copia.fumaca" 2>&1 >/dev/null)"
    if printf '%s' "$fumaca" | command grep -qE 'jq:|awk|AWK|compile error'; then
      printf '  \033[31mFALHA\033[0m "%s": quebrou o programa jq (%s) — vermelho pelo motivo errado\n' \
        "$desc" "${fumaca:0:60}"; falhou=1; return 1
    fi
  }

  # -- CONTROLE: a suite tem de estar VERDE antes de qualquer sed --------------------
  # "Ficou vermelho" so e informacao se existir um verde do qual sair. Sem esta trava, um arnes
  # incondicionalmente vermelho (fixture podre, stub quebrado, assercao nova mal escrita) APROVA
  # com louvor: toda sabotagem produz o vermelho exigido e o gate anuncia "toda sabotagem foi
  # detectada" -- falsificacao sem linha de base, que prova que o teste REAGE, nao que ele estava
  # certo antes de reagir. Mesma familia de `ausente != zero`.
  #
  # O controle roda a MESMA invocacao do laco de sabotagem (copia em $tmp, LC_ALL forcado, a mesma
  # variavel de override) e so troca a sabotagem por NADA. Por isso ele NAO e redundante com o
  # `bun run test:hooks` do step anterior do CI: la a suite roda no locale AMBIENTE e sobre o alvo
  # REAL. Se for justamente essa invocacao (copia + LC_ALL) que esta vermelha por motivo alheio,
  # o `test:hooks` fica verde e todo este bloco vira teatro.
  # Abortamos ANTES do primeiro sed: com a base vermelha nenhum veredito de (B) e legivel.
  # O LOG do controle é a régua das camadas do laço: quantos asserts a suíte executa, e que o assert
  # declarado SABE ficar verde nesta invocação.
  controle="$tmp/controle.sh"
  cp "$HOOK" "$controle"
  for loc in C "$utf8"; do
    ctl="$tmp/controle.$loc.log"; : > "$ctl.stderr"
    emb_alvo="$(embrulha_alvo "$controle" "$ctl.stderr")" || { printf '  FALHA nao consegui embrulhar o controle\n'; exit 1; }
    LC_ALL="$loc" HOOK_SOB_TESTE="$emb_alvo" bash "$0" >"$ctl.cru" 2>&1; rc=$?
    sem_cor "$ctl.cru" > "$ctl"
    if [ "$rc" -eq 0 ] && [ "$(asserts "$ctl")" -gt 0 ]; then
      printf '  \033[32mok\033[0m   [%-11s] controle (sem sabotagem) -> VERDE (%s asserts; %s)\n' "$loc" "$(asserts "$ctl")" "$(linha_de_base "$ctl")"
    else
      printf '  \033[31mFALHA\033[0m [%s] controle SEM sabotagem ja esta VERMELHO (exit %s, %s asserts) — sem linha de base, falsificar nao prova nada\n' "$loc" "$rc" "$(asserts "$ctl")"
      falhou=1
    fi
  done
  if [ "$falhou" -ne 0 ]; then
    printf '\033[31m== falsificacao ABORTADA: sem verde de partida ==\033[0m\n'
    printf '   Conserte a suite primeiro; sabotar sobre vermelho produz veredito fabricado.\n'
    exit 1
  fi

  # <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E (cada um tem de virar), `|` = OU
  # (basta um). O ID é o 1º token que o assert imprime (`FALHA R8 …`). Exit≠0 NÃO é dente: até
  # 2026-09-27 este laço contava "-> vermelho" para QUALQUER rodada que saísse ≠0 — assert alheio,
  # aborto, o hook morrendo calado no ramo que o assert mede. Colaterais ficam de fora de propósito.
  # docs/historico/falsificacao-exit-nao-e-dente.md
  SABOTAGENS="sempre_silencia:R2 sem_corte_10k:R1 mtime_fora_da_chave:R10 range_fora_da_chave:R9
              stat_bsd_na_frente:Sgnu2 decide_permissao:R5"

  # registra <nome> <descricao> <regra-que-deve-quebrar> <expressao-sed> — a TABELA das
  # sabotagens. Nome da lista sem registro e registro fora da lista são FALHA (no fim do laço): o
  # primeiro não sabotaria nada, o segundo nunca rodaria.
  registradas=""
  registra() {
    case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1) — o 2o registro sobrescreveria o 1o" >&2; exit 2 ;; esac
    registradas="$registradas $1"
    printf -v "desc_$1" '%s' "$2"; printf -v "regra_$1" '%s' "$3"; printf -v "expr_$1" '%s' "$4"
  }
  registra sempre_silencia "sempre silencia"      "avisar quando a leitura e cara" \
         's%^jq -n --arg m%exit 0 # SABOTADO%'
  registra sem_corte_10k "sem corte de 10k"     "silenciar leitura barata" \
         's%\[ "\$tokens" -ge 10000 \] || exit 0%:%'
  registra mtime_fora_da_chave "mtime fora da chave"  "reler arquivo ALTERADO e legitimo" \
         's%chave="\${mtime}|%chave="%'
  registra range_fora_da_chave "range fora da chave"  "ler OUTRO trecho nao e releitura" \
         's%\${inicio}|\${limite}|%%'
  # A regressao de portabilidade: voltar ao `stat -f` na frente. So o bloco (c),
  # com o stub do contrato GNU, deixa isto vermelho — no macOS puro passaria
  # verde, que foi exatamente como o defeito entrou (#1808). Delimitador `#`
  # porque o padrao tem `%`.
  registra stat_bsd_na_frente "stat BSD na frente"   "mtime portavel entre BSD e GNU" \
         's#^mtime="$(stat -c '"'"'%Y'"'"'#mtime="$(stat -f '"'"'%m'"'"'#'

  registra decide_permissao "decide permissao"     "nunca emitir permissionDecision" \
         's%hookEventName:"PreToolUse"%hookEventName:"PreToolUse", permissionDecision:"deny"%'

  # A rodada só conta como vermelha com as QUATRO camadas (as do sync-reprocess):
  #   1. a sabotagem APLICOU (as travas de aplica());
  #   2. a suíte rodou INTEIRA (nº de asserts = o do controle: aborto no meio não é assert);
  #   3. CADA assert declarado está VERDE no controle e VERMELHO aqui (o mesmo assert virou);
  #   4. nenhuma linha de erro que o controle não tem (`camada4`: o stderr INTEIRO do hook, por linha
  #      normalizada) — o hook que morre no ramo do assert derruba o assert certo por CRASH, não por
  #      julgamento, e o erro de ferramenta não está em lista-negra nenhuma.
  # Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
  # suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
  # shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
  repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
  [ -z "$repetidos" ] || { printf '  \033[31mFALHA\033[0m SABOTAGENS com nome repetido: %s\n' "$repetidos"; falhou=1; }
  case "$SABOTAGENS" in *'|'*) printf '  \033[31mFALHA\033[0m SABOTAGENS com | (OU): declare por , (E)\n'; falhou=1 ;; esac
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    v="desc_$sab"; desc="${!v-}"; v="regra_$sab"; regra="${!v-}"; v="expr_$sab"; expr="${!v-}"
    if [ -z "$expr" ]; then
      printf '  \033[31mFALHA\033[0m "%s": na lista SABOTAGENS e SEM registro — nada foi sabotado\n' "$sab"; falhou=1; continue
    fi
    aplica || continue
    for loc in C "$utf8"; do
      ctl="$tmp/controle.$loc.log"; log="$tmp/sabotada-$sab.$loc.log"; : > "$log.stderr"
      emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { printf '  FALHA [%s] "%s": nao consegui embrulhar a copia\n' "$loc" "$desc"; falhou=1; continue; }
      LC_ALL="$loc" HOOK_SOB_TESTE="$emb_alvo" bash "$0" >"$log.cru" 2>&1; rc=$?
      sem_cor "$log.cru" > "$log"
      if [ "$rc" -eq 0 ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s" passou VERDE — a suite nao cobre: %s\n' "$loc" "$desc" "$regra"
        falhou=1; continue
      fi
      # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
      faltam=""
      for exigido in ${exigidos//,/ }; do
        if ! LC_ALL=C grep -Eq "^  ok +($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^  FALHA ($exigido) " "$log"; then
          faltam="$faltam $exigido"
        fi
      done
      if [ "$(asserts "$log")" != "$(asserts "$ctl")" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": a suite NAO rodou inteira (%s de %s asserts) — vermelho de aborto, nao de assert\n' \
          "$loc" "$desc" "$(asserts "$log")" "$(asserts "$ctl")"
        falhou=1
      elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": vermelha com erro que o CONTROLE nao tem — o assert caiu por crash, nao por julgamento\n' "$loc" "$desc"
        printf '%s\n' "$novas" | head -3 | LC_ALL=C sed 's/^/       /'
        falhou=1
      elif [ -n "$faltam" ]; then
        printf '  \033[31mFALHA\033[0m [%s] "%s": vermelha, mas o assert declarado NAO virou (verde no controle -> vermelho aqui):%s · vermelhos: %s\n' \
          "$loc" "$desc" "$faltam" "$(vermelhos "$log")"
        falhou=1
      else
        printf '  \033[32mok\033[0m   [%-11s] "%s" -> vermelho no assert declarado (%s) · vermelhos: %s\n' \
          "$loc" "$desc" "$exigidos" "$(vermelhos "$log")"
      fi
    done
  done
  for r in $registradas; do
    case " $SABOTAGENS " in
      *[[:space:]]"$r:"*) ;;
      *) printf '  \033[31mFALHA\033[0m "%s": registrada e FORA da lista SABOTAGENS — nunca roda, e o verde nao a cobre\n' "$r"; falhou=1 ;;
    esac
  done

  printf '\n'
  if [ "$falhou" -eq 0 ]; then echo "VERDE — toda sabotagem ficou vermelha NO assert que declara, nos 2 locales"; exit 0; fi
  echo "VERMELHO — ha sabotagem sem o vermelho certo"; exit 1
fi

# ---------------------------------------------------------------- fixtures ---
# grande: 400 linhas de ~1KB = ~400KB → ~111k tokens. Espelha o formato que mais
# dói de verdade (docs/historico/bugs-resolvidos.md: 376 linhas, 486KB) — poucas
# linhas MUITO longas, que estouram mesmo dentro do teto de 2000 linhas do Read.
linha="$(printf 'x%.0s' $(seq 1 1000))"
# O redirect fica FORA do laço: com `>>` por iteração o arquivo era aberto e fechado 400 vezes.
grande="$tmp/grande.md"
for _ in $(seq 1 400); do printf '%s\n' "$linha"; done > "$grande"
pequeno="$tmp/pequeno.ts"; printf 'export const a = 1;\n%.0s' $(seq 1 50) > "$pequeno"
imagem="$tmp/diagrama.png"; printf 'PNG%s' "$linha" > "$imagem"

run() {  # $1=file_path $2=session $3=limit(0=ausente) $4=offset(0=ausente)
  jq -nc --arg f "$1" --arg s "$2" --argjson l "${3:-0}" --argjson o "${4:-0}" \
    '{hook_event_name:"PreToolUse", tool_name:"Read", session_id:$s,
      tool_input:({file_path:$f}
                  + (if $l > 0 then {limit:$l} else {} end)
                  + (if $o > 0 then {offset:$o} else {} end))}' \
  | bash "$HOOK" 2>/dev/null
}

fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "${1//$'\n'/ | }"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "${1//$'\n'/ | }"; fail=1; }
# marcador ASCII exclusivo, sem -i, via `command grep` (o grep do shell é shim p/ ugrep)
tem() { printf '%s' "$2" | command grep -q "$1"; }
check(){ # $1=descrição $2=esperado(READ-GRANDE|READ-RELEITURA|silencio) $3=saída
  local desc="$1" esp="$2" out="$3"
  if [ "$esp" = "silencio" ]; then
    if [ -z "$out" ]; then ok "$desc"; else bad "$desc (esperava silêncio, veio: '${out:0:70}')"; fi
  else
    if tem "$esp" "$out"; then ok "$desc"; else bad "$desc (esperava $esp, veio: '${out:0:70}')"; fi
  fi
}

echo "== read-contexto-nudge =="

# --- (a) volume --------------------------------------------------------------
# 1. arquivo pequeno → silêncio
check "R1 arquivo pequeno → silêncio" silencio "$(run "$pequeno" s1)"

# 2. arquivo grande → avisa volume
out2="$(run "$grande" s2)"
check "R2 arquivo grande (~111k tok) → avisa volume" READ-GRANDE "$out2"

# 3. JSON bem-formado com os dois canais (founder + agente).
#    printf, não echo: echo interpreta o \n escapado e corrompe o JSON (CLAUDE.md).
if printf '%s' "$out2" | jq -e '.systemMessage and .hookSpecificOutput.additionalContext' >/dev/null 2>&1
then ok "R3 JSON válido com systemMessage + additionalContext"
else bad "R3 JSON inválido ou incompleto"; fi

# 4. hookEventName correto
if printf '%s' "$out2" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"' >/dev/null 2>&1
then ok "R4 hookEventName = PreToolUse"
else bad "R4 hookEventName errado"; fi

# 5. NÃO decide permissão. Emitir permissionDecision:"allow" pularia o prompt de
#    permissão de TODA leitura — auto-aprovaria ler ~/.ssh/id_rsa. E "deny"/"ask"
#    quebraria investigação legítima. O hook só anexa contexto.
if printf '%s' "$out2" | command grep -q 'permissionDecision'
then bad "R5 emitiu permissionDecision (não pode decidir permissão)"
else ok "R5 não decide permissão (nem allow, nem deny, nem ask)"; fi

# 6. o que conta é o VOLUME lido, não a presença de `limit`. Com linhas de ~1KB,
#    limit=10 lê ~10KB (~2,8k tok) → silêncio...
check "R6 grande + limit=10 (~2,8k tok) → silêncio" silencio "$(run "$grande" s6 10)"

# 6b. ...mas limit=50 nas MESMAS linhas lê ~50KB (~13k tok) e ainda dói: `limit`
#     não é garantia de leitura barata. Este caso já pegou uma premissa errada
#     minha ("usou limit → não avisa") — o corte é por tokens, não por flag.
check "R6b grande + limit=50 (~13k tok) → avisa mesmo com limit" READ-GRANDE "$(run "$grande" s6b 50)"

# 6c. O CONSELHO muda de lado no break-even medido (2026-08-06): um subagente
#     custa US$ 1,06 na mediana, então delegar só compensa a partir de ~40k
#     tokens — abaixo disso o certo é recortar (rg + offset/limit), de graça.
#     A 1ª versão do hook mandava delegar já a partir de 10k, conselho que PERDIA
#     dinheiro na maioria dos disparos. Marcadores ASCII em CAIXA FIXA ("SE PAGA"
#     / "PERDE"), sem -i: prosa acentuada casaria o ramo errado sob pt_BR (#1483).
grande_out="$(run "$grande" s6c)"          # ~111k tok → faixa do subagente
peq_out="$(run "$grande" s6d 50)"          # ~13k tok  → faixa do recorte
if tem "SE PAGA" "$grande_out" && ! tem "PERDE" "$grande_out"
then ok "R6c leitura >=40k: conselho é DELEGAR (o subagente se paga)"
else bad "R6c leitura de 111k deveria recomendar subagente (veio: '${grande_out:0:80}')"; fi

if tem "PERDE" "$peq_out" && ! tem "SE PAGA" "$peq_out"
then ok "R6d leitura 10-40k: conselho é RECORTAR (delegar perderia dinheiro)"
else bad "R6d leitura de 13k deveria desaconselhar subagente (veio: '${peq_out:0:80}')"; fi

# 7. o teto de 2000 linhas do Read entra na conta: arquivo de linhas CURTAS cujo
#    total passa de 10k tok, mas cujas 2000 primeiras linhas não → silêncio.
# Mesmo idioma do `$pequeno` lá em cima (`printf 'FMT%.0s' $(seq …)`): um único printf, um
# único open. O laço com `>>` abria o arquivo 12.000 vezes e custava ~26s SOZINHO — mais que
# toda a suíte —, e a falsificação re-executa a suíte inteira por sabotagem x locale.
curto="$tmp/muitas-linhas-curtas.ts"; printf 'const x = 1;\n%.0s' $(seq 1 12000) > "$curto"
check "R7 60k linhas curtas (teto de 2000 linhas) → silêncio" silencio "$(run "$curto" s7)"

# --- (b) releitura -----------------------------------------------------------
# 8. mesmo arquivo, mesma sessão, sem alteração → avisa releitura
_=$(run "$pequeno" s8)
check "R8 2ª leitura idêntica → avisa releitura" READ-RELEITURA "$(run "$pequeno" s8)"

# 9. ranges diferentes NÃO são releitura — é leitura complementar do arquivo.
#    Os dois ranges são pequenos E existem dentro do arquivo (400 linhas), senão
#    o caso passaria por acidente: offset além do fim lê 0 byte e silenciaria
#    sozinho, sem provar nada sobre a regra de releitura.
_=$(run "$grande" s9 10 1)
check "R9 mesmo arquivo, range diferente → silêncio" silencio "$(run "$grande" s9 10 200)"

# 10. arquivo alterado entre as leituras → releitura legítima, silêncio
mudou="$tmp/mudou.ts"; printf 'a\n' > "$mudou"
_=$(run "$mudou" s10)
sleep 1; printf 'b\n' >> "$mudou"          # mtime muda
check "R10 arquivo alterado entre leituras → silêncio" silencio "$(run "$mudou" s10)"

# 11. a marca é POR SESSÃO — outra sessão relendo o mesmo arquivo não herda
_=$(run "$pequeno" s11)
check "R11 outra sessão, 1ª leitura → silêncio" silencio "$(run "$pequeno" s11b)"

# --- (c) portabilidade da chave: os DOIS contratos do `stat` ------------------
# A chave da releitura carrega o mtime, e `stat` DIVERGE entre BSD (macOS, do
# founder) e GNU (Linux, do CI): no GNU `-f` é --file-system e NÃO consome
# formato, então `stat -f '%m' arq` trata '%m' como um segundo OPERANDO — sai
# !=0 e ainda imprime no stdout o bloco MULTI-LINHA do filesystem. Num `a || b`
# isso concatena os dois e o mtime vira lixo de várias linhas; a chave deixa de
# ter uma linha só, e `grep -Fx` passa a ler cada linha como um PADRÃO
# independente: as constantes do bloco casam sempre e o hook grita "releitura"
# justamente quando reler é LEGÍTIMO. Verde no macOS, cego no Linux — o mesmo
# defeito já corrigido em .claude/hooks/branch-pos-squash-guard.sh.
# Verde num ambiente NÃO prova (#1483): aqui os dois contratos são exercitados
# por stub, e o caso (i) existe para que um mtime CONSTANTE não passe de graça.
echo "── portabilidade do stat: a chave discrimina nos DOIS contratos ──"
STAT_REAL="$(command -v stat || echo /usr/bin/stat)"

_porta() {  # $1=nome do contrato  $2=corpo do stub de `stat`
  local nome="$1" corpo="$2" d="$tmp/statbox-$1" alvo="$tmp/port-$1.md" o
  mkdir -p "$d"
  # `_m` devolve o mtime REAL resolvendo sozinho o contrato do stat de verdade
  # (o teste roda nas duas plataformas); `$STAT_REAL` é caminho absoluto, então
  # o stub não chama a si mesmo.
  # shellcheck disable=SC2016  # o corpo do stub é LITERAL: $STAT_REAL/$1/$v são
  # dele, resolvidos quando o stub roda — expandir aqui escreveria um stub vazio.
  { printf '%s\n' '#!/bin/sh' \
      '_m() { v="$("$STAT_REAL" -c %Y "$1" 2>/dev/null)"' \
      '  case "$v" in ""|*[!0-9]*) v="$("$STAT_REAL" -f %m "$1" 2>/dev/null)" ;; esac' \
      '  case "$v" in ""|*[!0-9]*) v=0 ;; esac; printf "%s" "$v"; }'
    printf '%s\n' "$corpo"; } > "$d/stat"
  chmod +x "$d/stat"

  _run() {  # mesma forma do run() global, com o stub de stat na frente do PATH
    jq -nc --arg f "$1" --arg s "$2" --argjson l "${3:-0}" --argjson o "${4:-0}" \
      '{hook_event_name:"PreToolUse", tool_name:"Read", session_id:$s,
        tool_input:({file_path:$f}
                    + (if $l > 0 then {limit:$l} else {} end)
                    + (if $o > 0 then {offset:$o} else {} end))}' \
    | env PATH="$d:$PATH" STAT_REAL="$STAT_REAL" bash "$HOOK" 2>/dev/null
  }

  # (i) ainda DETECTA a releitura de verdade. Sem este caso, um mtime constante
  #     (o próprio bug, ou um `mtime=0` fixo) passaria (ii) e (iii) de graça.
  printf 'a\n' > "$alvo"
  _=$(_run "$alvo" "p$nome-1")
  o="$(_run "$alvo" "p$nome-1")"
  if tem READ-RELEITURA "$o"
  then ok "S${nome}1 [$nome] 2ª leitura idêntica ainda avisa releitura"
  else bad "S${nome}1 [$nome] releitura idêntica parou de avisar (veio: '${o:0:60}')"; fi

  # (ii) o mtime discrimina: arquivo alterado entre as leituras não é releitura
  _=$(_run "$alvo" "p$nome-2")
  sleep 1; printf 'b\n' >> "$alvo"
  check "S${nome}2 [$nome] arquivo alterado → silêncio" silencio "$(_run "$alvo" "p$nome-2")"

  # (iii) o range discrimina: outro trecho é leitura complementar, não releitura
  _=$(_run "$grande" "p$nome-3" 10 1)
  check "S${nome}3 [$nome] range diferente → silêncio" silencio "$(_run "$grande" "p$nome-3" 10 200)"
}

# GNU: `-c %Y` devolve o epoch; `-f` NÃO consome formato — '%m' vira operando
# inexistente (exit !=0) e o arquivo real despeja o bloco multi-linha. É o
# contrato exato que cegou o hook no CI.
# shellcheck disable=SC2016  # corpo literal do stub: $1/$@ são do stub, não desta shell
_porta gnu 'case "$1" in
  -c) [ "$2" = "%Y" ] && { _m "$3"; exit 0; }; exit 1 ;;
  -f) shift; rc=0
      for op in "$@"; do
        if [ -e "$op" ]; then
          echo "  File: \"$op\""
          echo "    ID: 9a1b2c3d Namelen: 255     Type: ext2/ext3"
          echo "Block size: 4096       Fundamental block size: 4096"
          echo "Blocks: Total: 20971520   Free: 15000000   Available: 14000000"
          echo "Inodes: Total: 5242880    Free: 5000000"
        else
          echo "stat: cannot read file system information for '"'"'$op'"'"'" >&2; rc=1
        fi
      done
      exit "$rc" ;;
esac
exit 1'

# BSD: `-c` não existe (falha limpo); `-f %m` devolve o epoch.
# shellcheck disable=SC2016  # idem
_porta bsd 'case "$1" in
  -c) echo "stat: illegal option -- c" >&2; exit 1 ;;
  -f) [ "$2" = "%m" ] && { _m "$3"; exit 0; }; exit 1 ;;
esac
exit 1'

# --- fail-safes --------------------------------------------------------------
# 12. arquivo inexistente → silêncio (o próprio Read reporta o erro)
check "R12 arquivo inexistente → silêncio" silencio "$(run "$tmp/nao-existe.ts" s12)"

# 13. binário/imagem → silêncio (a heurística de bytes não vale; não dar conselho errado)
check "R13 imagem → silêncio" silencio "$(run "$imagem" s13)"

# 14. outra ferramenta no payload → silêncio (defesa se o matcher mudar)
check "R14 tool_name != Read → silêncio" silencio \
  "$(jq -nc --arg f "$grande" '{hook_event_name:"PreToolUse",tool_name:"Grep",session_id:"s14",tool_input:{file_path:$f}}' | bash "$HOOK" 2>/dev/null)"

# 15. o aviso de volume sai UMA VEZ por arquivo/sessão — na 2ª vez quem fala é a
#     releitura, senão o mesmo arquivo grande gritaria volume a cada leitura.
_=$(run "$grande" s15)
out15="$(run "$grande" s15)"
if tem READ-RELEITURA "$out15" && ! tem READ-GRANDE "$out15"
then ok "R15 2ª leitura de arquivo grande → só releitura, sem repetir volume"
else bad "R15 2ª leitura de grande: esperava só READ-RELEITURA (veio: '${out15:0:70}')"; fi

# 16. o payload real do Claude Code traz file_path relativo em alguns clientes;
#     caminho não resolvível → silêncio, nunca erro.
check "R16 caminho relativo não resolvível → silêncio" silencio "$(run "src/nao/existe.ts" s16)"

echo
if [ "$fail" -eq 0 ]; then echo "VERDE — todos os casos passaram"; exit 0; fi
echo "VERMELHO — ha casos falhando"; exit 1
