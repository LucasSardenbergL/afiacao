#!/usr/bin/env bash
# codex-async.sh — transporte pro ritual Codex (2ª opinião) SEM segurar a sessão.
#
# Por quê (diagnóstico 2026-07, 240 sessões): ~350+ execuções de `codex exec`
# rodaram em FOREGROUND com esperas de até 23min — a sessão Claude parada e o
# founder virando o "botão de retomar". Este wrapper é pensado pra rodar via
# Bash com run_in_background:true — a sessão segue trabalhando e integra o
# parecer quando o processo termina (o harness re-invoca a sessão ao concluir).
#
# O RITUAL (consult/challenge/review, prompts, quando usar) continua o da skill
# /codex (gstack) + docs/agent/money-path.md — este script só troca o TRANSPORTE.
# ⚠️ NUNCA aponte o Codex pro supabase/schema-snapshot.sql (~36k linhas — trava;
#    ver money-path.md). Fatos de schema vão NO PRÓPRIO prompt, via psql-ro.
#
# Uso:
#   scripts/codex-async.sh [-m MODELO] [-r low|medium|high|xhigh|max|ultra] [-t SEGUNDOS] "PROMPT"
#   echo "PROMPT" | scripts/codex-async.sh -r max -
# Defaults: -m gpt-6-astra · -r max · -t 1200 (20min hard-stop)
#
# Garantias:
#   - preflight (binário + auth + SALDO da cota) ANTES de gastar tempo/quota, com instrução clara;
#   - saldo acima do teto → exit 79 SEM gastar a chamada, dizendo quando a janela reabre
#     (≠ 75, que é ter BATIDO na parede: a diferença permite contar o que o sensor poupou);
#   - retry com backoff (20s/60s) só em transitório (rate limit/timeout/overload),
#     classificado SEM o eco do prompt no stderr (senão o texto do prompt decide o fluxo);
#   - cota esgotada NÃO é transitório → falha na hora instruindo o Caminho B, e mostra QUANDO a
#     janela reabre copiando o "try again at …" do servidor (lido SEM o eco do prompt; o stderr
#     cru morre no trap) — sem ele, "(o servidor não informou)", nunca um horário calculado;
#   - modelo recusado pela conta (400) → exit 78, instruindo CONFIG (≠ cota, ≠ retry);
#   - mktemp XXXXXX (sem colisão de tmp entre execuções paralelas);
#   - sandbox read-only (consulta nunca escreve no repo);
#   - CUSTO no cabeçalho (segundos da tentativa vencedora + tokens), pro registro no PR.
set -u

# gpt-6-astra exige codex-cli ≥ 0.153.1 (lançado 2026-09-03; o cask `codex` do brew subiu
# 0.144.1 → 0.153.4 em 2026-09-05). Ping `codex exec --model gpt-6-astra -c
# model_reasoning_effort="max" --sandbox read-only "responda apenas: OK"`, 2026-09-05,
# codex-cli 0.153.4, conta paga (plan_type=prolite): rc=0 (6s).
# `astra` é a geração acima da família 5.6 ⇒ é o default, em `max` (ordem do founder
# 2026-09-05: "GPT-6 Astra no nível max"; um degrau acima do `xhigh`). O catálogo 0.153.4 lista
# ainda `ultra` (a conta aceita: ping rc=0, 7s) — mas `ultra` NÃO é degrau de raciocínio: o
# catálogo o define como "Maximum reasoning with automatic task delegation" (= max + delegação
# a subagentes; a API pública nem o lista). Medição 2026-09-05, mesmo prompt de 2,9 KB:
# xhigh 56s/10,0k tokens · max 131s/14,2k · ultra 66s/5,2k (n=1). QUAL nível usar:
# money-path.md §Segunda opinião → "Nível de reasoning" (piso por risco → natureza → cota;
# `-r xhigh` só fora do money-path; `-r ultra` fora do ritual até piloto com ganho medido).
#
# Histórico da família 5.6 (default até 2026-09-05):
# gpt-5.6-* exige codex-cli ≥ 0.143 (server rejeita CLI antigo com 400).
# ⚠️ O default É MEDIÇÃO, não escolha. Ping `codex exec --model M -c
# model_reasoning_effort="xhigh" --sandbox read-only "responda apenas: OK"`, 2026-08-23,
# codex-cli 0.144.1, conta paga (plan_type=prolite):
#   gpt-5.6-sol → rc=0 (97s)   gpt-5.6-terra → rc=0 (45s)   gpt-5.6-luna → rc=0 (87s)
#   gpt-5.6 → 400   ·   gpt-5.3-codex → 400   ·   gpt-5.1-codex-max → 400
# `sol` era o frontier da família 5.6 ⇒ foi o default, em `xhigh` (decisão do founder: a 2ª
# opinião do money-path roda sempre no teto).
#
# 🔴 A LIÇÃO que custou 2 dias: em 22/08 estes MESMOS pings davam 400 para `sol`, e a
# conclusão foi "esta conta não tem direito ao sol" → o default virou `terra`. Era FALSO.
# A causa era o `plan_type` CONGELADO num token de 21/08 que dizia `free` (a conta é paga):
# o servidor cobra pelo CLAIM do token, não pela assinatura viva, e `codex logout && codex
# login` reemitiu o token e devolveu o `sol` na hora. `terra`/`luna` respondiam porque são
# do tier de baixo — e foi justamente isso que fez a heurística "se ALGUM modelo passa, o
# login está OK" dar o login por bom. Ela é falsa: um token pode estar VÁLIDO e mentir
# sobre o plano. Trocar de modelo "resolve" o sintoma e esconde a causa.
modelo="gpt-6-astra"; reasoning="max"; timeout_s=1200
while getopts "m:r:t:" opt; do
  case "$opt" in
    m) modelo="$OPTARG" ;;
    r) reasoning="$OPTARG" ;;
    t) timeout_s="$OPTARG" ;;
    *) echo "uso: codex-async.sh [-m modelo] [-r reasoning] [-t seg] \"PROMPT\"" >&2; exit 64 ;;
  esac
done
shift $((OPTIND-1))

prompt="${1:-}"
if [ "$prompt" = "-" ] || [ -z "$prompt" ]; then prompt="$(cat)"; fi
[ -n "$prompt" ] || { echo "ERRO: prompt vazio" >&2; exit 64; }

# --- preflight (barato, ANTES de gastar contexto/quota) -----------------------
command -v codex >/dev/null 2>&1 || {
  echo "PREFLIGHT_FAIL: codex CLI não encontrado. Instale: npm install -g @openai/codex" >&2
  exit 69
}
# Sonda POSITIVA do `pkill` — o encerramento do watchdog depende dele (ver o hard-stop
# abaixo). `command -v` NÃO basta: um pkill presente-porém-quebrado esvaziaria o guard
# igual, e o `sleep` vazaria em silêncio (docs/historico/sonda-ausente-em-script-que-apaga.md).
# Prova de verdade: cria UM filho descartável e exige que `pkill -P` o MATE — `wait` devolve
# 128+sinal quando morreu por sinal, e 0 quando sobreviveu ao timer. Neste ponto do script a
# sonda é o único filho de `$$` (nada foi posto em background ainda), então `-P` sem padrão
# atinge ela e mais nada — e é exatamente a forma usada depois, então a sonda testa o que usamos.
# Degrada ABERTO de propósito (a consulta segue): matar o sleep é higiene, não o hard-stop.
# Mas nunca em SILÊNCIO — sem este aviso, o vazamento volta a ser invisível.
sleep 1 & _sonda_pkill=$!
pkill -P "$$" >/dev/null 2>&1
wait "$_sonda_pkill" 2>/dev/null
if [ $? -gt 128 ]; then pkill_ok=1; else
  pkill_ok=0
  echo "AVISO: 'pkill -P' não respondeu neste ambiente — o sleep interno do watchdog vai" >&2
  echo "  sobreviver a cada consulta por até ${timeout_s}s (processo por invocação). Instale" >&2
  echo "  o pkill (procps) ou espere ver processos 'sleep ${timeout_s}' acumulando." >&2
fi

if [ -z "${CODEX_API_KEY:-}${OPENAI_API_KEY:-}" ] && [ ! -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  echo "PREFLIGHT_FAIL: sem auth do Codex. Rode 'codex login' (ou exporte CODEX_API_KEY/OPENAI_API_KEY) e re-rode." >&2
  exit 77
fi

# Plano DECLARADO no claim do token (não é a assinatura viva — é o que o servidor
# obedece). Lê só `chatgpt_plan_type`; o token em si NUNCA é impresso. Sem `jq`: ele não
# está no PATH mínimo dos testes, e o payload de um JWT é base64 comum, não cifra.
# SENSOR, não guard: se não der para ler, devolve "desconhecido" — a instrução manual
# continua valendo e nada é fabricado.
plano_do_token() {
  local auth="${CODEX_HOME:-$HOME/.codex}/auth.json" tok payload
  [ -r "$auth" ] || { printf 'desconhecido'; return; }
  tok="$(grep -o '"access_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$auth" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  case "$tok" in *.*.*) ;; *) printf 'desconhecido'; return ;; esac
  payload="${tok#*.}"; payload="${payload%%.*}"
  payload="$(printf '%s' "$payload" | tr '_-' '/+')"
  case $(( ${#payload} % 4 )) in 2) payload="${payload}==" ;; 3) payload="${payload}=" ;; esac
  printf '%s' "$payload" | openssl base64 -d -A 2>/dev/null \
    | sed -n 's/.*"chatgpt_plan_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1 | grep . || printf 'desconhecido'
}

# --- sensor de SALDO da cota (preflight) --------------------------------------
# Todo rollout do codex carrega o medidor OFICIAL da cota, que o wrapper ignorava:
#   "primary":{"used_percent":94.0,"window_minutes":10080,"resets_at":1789834903}
# (10080 min = 7 dias = a janela rolante do plano). Medido 2026-09-18: `resets_at`
# 1789834903 → 19/09 13:21:43, IDÊNTICO ao "try again at Sep 19th, 2026 1:21 PM" que o
# servidor devolve no 429 — é a mesma verdade, só que ANTES de gastar a chamada.
# Por que isto existe: entre 10/09 e 15/09 foram 36 chamadas mortas contra uma cota já
# em 100% (bateu 14/09 19:40, reabriu só 19/09 13:21). Cada uma custou minutos de espera
# e um parecer que nunca veio. Ver docs/historico/cota-codex-medida-em-tokens.md.
#
# SENSOR, não guard destrutivo: sem leitura → devolve VAZIO e a consulta SEGUE (com
# aviso). O oposto — fail-closed — trancaria o ritual inteiro por um arquivo ilegível.
# Mas "seguir" nunca é SILENCIOSO: quem chama imprime o ramo que não conseguiu medir.
#
# Quatro armadilhas, cada uma com caso na suíte:
#  (a) `"primary":null` (37 de 2.821 linhas em setembro — 1,3%): é AUSÊNCIA de leitura,
#      não saldo zero. O padrão casa só `{`, então null não vira "0% livre, pode ir".
#  (b) LEITURA OBSOLETA: um saldo de 100% lido antes do reset trancaria o wrapper PARA
#      SEMPRE, mesmo com a janela já virada. Por isso `resets_at` no passado descarta a
#      leitura (degrada para vazio) em vez de recusar — o sensor não sabe o saldo NOVO.
#  (c) ORDEM dos arquivos: nada de `ls -t`/`stat` (BSD×GNU divergem). O caminho é
#      AAAA/MM/DD/rollout-<ISO>-<id>.jsonl, então `sort` lexicográfico JÁ é cronológico.
#  (d) O PONTO CEGO que a 1ª versão tinha, e que só o teste ao vivo pegou: a sessão que
#      BATE na parede não recebe medidor nenhum — o 429 vem antes. Com a cota estourada
#      os rollouts mais recentes são todos falhas, e olhar só os 5 últimos devolvia
#      "desconhecido" JUSTAMENTE quando o sensor mais importa (medido 2026-09-18: os 5
#      mais recentes, 0 com bloco; dos 40, 27). Daí a profundidade de 40.
# Por que uma leitura ANTIGA ainda serve: enquanto `resets_at` está no futuro a janela é
# A MESMA, e dentro de uma janela o consumo só sobe — a leitura é um PISO do saldo de
# agora. Piso é o lado certo de errar num guard: nunca deixa passar o que devia barrar;
# no máximo barra cedo demais, e aí `CODEX_ASYNC_TETO_SALDO=0` destranca.
# Imprime "<used_percent> <resets_at>" ou NADA.
saldo_de_cota() {
  local s="${CODEX_HOME:-$HOME/.codex}/sessions" f bloco pct reset agora
  [ -d "$s" ] || return 0
  agora="$(date +%s)"
  while IFS= read -r f; do
    [ -r "$f" ] || continue
    bloco="$(grep -o '"primary":{[^}]*}' "$f" 2>/dev/null | tail -1)"
    [ -n "$bloco" ] || continue
    pct="$(printf '%s' "$bloco"   | sed -n 's/.*"used_percent"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p')"
    reset="$(printf '%s' "$bloco" | sed -n 's/.*"resets_at"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
    [ -n "$pct" ] && [ -n "$reset" ] || continue
    [ "$reset" -gt "$agora" ] || return 0   # (b) janela já virou: leitura obsoleta
    printf '%s %s' "$pct" "$reset"
    return 0
  done <<< "$(find "$s" -name 'rollout-*.jsonl' -type f 2>/dev/null | sort | tail -40 | sed '1!G;h;$!d')"
}

# Guard: recusa ANTES de gastar a chamada quando o saldo já passou do teto.
# Teto em CODEX_ASYNC_TETO_SALDO (default 85; `0` desliga o sensor por completo).
# 85 e não 99: acima disso não cabe um adversarial money-path inteiro (mediana medida
# 2026-09-18: ~1,4 pp por consulta no astra/max), e o que resta deve ficar pro money-path.
teto_saldo="${CODEX_ASYNC_TETO_SALDO:-85}"
if [ "$teto_saldo" != "0" ]; then
  leitura="$(saldo_de_cota)"
  if [ -z "$leitura" ]; then
    echo "SALDO_DESCONHECIDO: não consegui ler used_percent de nenhum rollout recente — seguindo sem o sensor." >&2
  else
    saldo="${leitura%% *}"; reset_epoch="${leitura##* }"
    # compara com o teto em inteiro (o shell não faz float; used_percent vem como 94.0)
    if [ "${saldo%%.*}" -ge "$teto_saldo" ]; then
      quando="$(date -r "$reset_epoch" '+%d/%m %H:%M' 2>/dev/null \
             || date -d "@$reset_epoch" '+%d/%m %H:%M' 2>/dev/null || echo "epoch $reset_epoch")"
      echo "SALDO_ALTO: a cota está em ${saldo}% (teto $teto_saldo%) e a janela de 7 dias só reabre em $quando." >&2
      echo "  Não gastei a chamada. Opções:" >&2
      echo "  1) Caminho B (seguir sem 2ª opinião, registrando no PR que o Codex não foi consultado);" >&2
      echo "  2) esperar o reset e re-rodar;" >&2
      echo "  3) CODEX_ASYNC_TETO_SALDO=0 pra ignorar o sensor (só se a consulta valer o resto da cota)." >&2
      exit 79
    fi
    echo "saldo da cota: ${saldo}% usado (teto $teto_saldo%)" >&2
  fi
fi

# --- sensor de custo: segundos + tokens ---------------------------------------
# Desde 2026-09-05 cada consult registra no PR nível + segundos + tokens (money-path.md
# §Segunda opinião → "Nível de reasoning"); é o sensor de que o piloto do `ultra` depende.
#
# ⚠️ POR QUE NÃO `codex exec --json`, que seria o caminho óbvio (medido 2026-09-05, codex-cli
# 0.153.4, conta paga, este worktree — duas execuções reais por modo, sucesso e 400):
#   1. `--json` REROTEIA O DIAGNÓSTICO. Sem ele, o stderr traz o log inteiro (eco do prompt,
#      warnings, linhas `ERROR:`) e o stdout traz só a última mensagem. Com `--json`, o stderr
#      encolhe para uma linha ("Reading additional input from stdin...", 39 bytes medidos) e o
#      erro migra para o stdout como eventos `{"type":"error"...}` / `turn.failed`. TODA a
#      classificação abaixo lê o stderr — cota→75, modelo→78, permanente, transitório —, com as
#      lições que custaram 2 dias. Trocar a fonte por causa de um SENSOR poria o guard em risco.
#   2. `--json` MUDA O EIXO DO NÚMERO. O `turn.completed.usage` reporta `input_tokens` (19.985
#      medidos, com 12.160 de cache) enquanto o rodapé textual da mesma classe de execução diz
#      7.823 — o rodapé cobra o NÃO-cacheado. As medições já registradas (xhigh 10,0k · max
#      14,2k · ultra 5,2k, em CLAUDE.md e money-path.md) vieram do rodapé: publicar `input_tokens`
#      trocaria a régua no meio do piloto, que é comparação de consumo entre níveis.
# ⇒ lê-se o rodapé textual. Se um dia ele sumir, o cabeçalho degrada para `tokens ?` — é sensor,
#   não guard: ausente ≠ zero, e fabricar 0 registraria um consult que "não custou nada".

# stderr sem as linhas que vieram do ECO do prompt (awk O(n+m); ver a nota longa da
# classificação, mais abaixo, sobre por que NÃO se usa `grep -Fvxf` nem filtro por prefixo).
sem_eco_do_prompt() {
  awk 'NR==FNR{p[$0];next} !($0 in p)' <(printf '%s\n' "$prompt") "$1" 2>/dev/null
}

# rodapé de custo do codex: as DUAS últimas linhas do stderr são `tokens used` e o número
# ("7.823" — separador de milhar; imprime-se LITERAL, sem reformatar, pra não inventar locale).
# Recebe o ARQUIVO de stderr; imprime o número ou NADA (ausente — quem chama imprime "?").
#
# O prompt não pode decidir o número — mesma lição da classificação de erro logo abaixo, e o
# ritual cola parecer anterior (com rodapé!) dentro do prompt o tempo todo. Duas camadas
# INDEPENDENTES, cada uma com seu caso na suíte:
#   (a) POSIÇÃO: lê as duas últimas linhas não-vazias, não a última ocorrência do marcador.
#       Buscar o marcador acharia a citação colada no prompt sempre que o codex não emitisse
#       rodapé nenhum.
#   (b) CAUDA DO ECO: o stderr reimprime o prompt inteiro sob "user"; se o stderr TERMINA
#       exatamente nas duas últimas linhas do prompt, o que se está lendo é o eco, não o
#       rodapé → devolve vazio. É o único jeito de o eco chegar ao fim do arquivo.
# Por que (b) e não "remover toda linha igual a alguma do prompt", como faz a classificação:
# lá o alvo é o BLOCO inteiro do eco; aqui isso apagaria também o marcador REAL sempre que o
# prompt citasse "tokens used" no meio — perder o sensor no consult meta (o que discute este
# wrapper) é justamente o caso em que ele interessa. Medido: com a remoção total, o caso
# "prompt cita rodapé antigo + codex responde com rodapé" degradava para "?" sem precisar.
tokens_do_rodape() {
  awk '
    NR==FNR { if (NF) { pp = pu; pu = $0 }; next }   # cauda do PROMPT (2 últimas não-vazias)
    NF      { ep = eu; eu = $0 }                     # cauda do STDERR
    END {
      if (eu == pu && ep == pp) exit                 # o fim do stderr É o fim do eco → ambíguo
      if (ep ~ /^[[:space:]]*tokens used[[:space:]]*$/ &&
          eu ~ /^[[:space:]]*[0-9][0-9.,]*[[:space:]]*$/) { gsub(/[[:space:]]/, "", eu); print eu }
    }' <(printf '%s\n' "$prompt") "$1"
}

out="$(mktemp -t codex-async.XXXXXX)" || exit 70
err="$(mktemp -t codex-async-err.XXXXXX)" || exit 70
marcador="$(mktemp -t codex-async-marca.XXXXXX)" || exit 70
acervo="$(mktemp -t codex-async-acervo.XXXXXX)" || exit 70   # união dos filhos de TODAS as tentativas
fanout_incerto=0
trap 'rm -f "$err" "$marcador" "$acervo"' EXIT

# --- sensor de FAN-OUT (multi-agente) -----------------------------------------
# UMA invocação podia virar ATÉ 4 execuções cobradas: o codex-cli 0.153.4 entrega ao
# modelo o bloco `<multi_agent_role>` com `spawn_agent` e "4 available concurrency
# slots", e nos prompts adversariais do ritual o modelo abria a revisão em threads
# irmãs — cada uma com `fork_turns:"all"` (o contexto INTEIRO replicado) e cobrada à
# parte. Medido em ~/.codex/sessions de 04–18/09: 25 das 167 consultas (15%) geraram
# 40 threads de subagente = 39,5M tokens = 22,4% do consumo do mês.
# O teto `-c features.multi_agent_v2.max_concurrent_threads_per_session=1` (abaixo)
# fecha a porta — provado ao vivo: com o teto, o CLI recusa ("o limite de agentes foi
# atingido") e nenhum rollout de subagente nasce; sem ele, o mesmo prompt abre 2.
# Este sensor é o SEGUNDO EIXO, de propósito por FORA do flag: uma chave de config só
# vale na versão que a conhece, e o codex ignora config desconhecida em silêncio (sem
# --strict-config). Se um upgrade reabrir a porta, aqui aparece; olhar só o flag não vê.
# SENSOR, não guard: sem leitura → "?" e a consulta SEGUE — mas nunca em silêncio.
# Filtra por `cwd`: worktrees paralelas escrevem no MESMO ~/.codex/sessions.
# Imprime UM CAMINHO POR LINHA dos rollouts de subagente desta cwd, ou o token `?`.
# Caminhos (não a contagem) porque as tentativas se somam por UNIÃO: o mesmo rollout ainda
# sendo escrito reaparece na tentativa seguinte, e somar contagens o contaria duas vezes.
# ⚠️ Toda falha de LEITURA vira `?`, nunca 0 — `find` que morre no meio, arquivo ilegível,
# `head` que falha e cabeçalho vazio são AUSÊNCIA DE MEDIDA. Arredondá-los para zero era o
# "ausente ≠ zero" dentro do próprio sensor que existe para não confiar no flag (achado da
# 2ª opinião, 2026-09-20: os três ramos devolviam 0 com exit 0).
subagentes_desta_rodada() {
  local s="${CODEX_HOME:-$HOME/.codex}/sessions" f cab lista
  [ -d "$s" ] && [ -e "$marcador" ] || { printf '?'; return; }
  lista="$(find "$s" -name 'rollout-*.jsonl' -type f -newer "$marcador" 2>/dev/null)" \
    || { printf '?'; return; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -r "$f" ] || { printf '?'; return; }
    cab="$(head -1 "$f" 2>/dev/null)" || { printf '?'; return; }
    [ -n "$cab" ] || { printf '?'; return; }   # arquivo nascendo: não sei o que tem dentro
    case "$cab" in *'"thread_source":"subagent"'*) ;; *) continue ;; esac
    case "$cab" in *"\"cwd\":\"$PWD\""*) printf '%s\n' "$f" ;; esac
  done <<< "$lista"
}

rc=1
tentativa=0
# backoffs sobrescritíveis por env (testes usam "0 0 0" pra não esperar de verdade)
read -ra backoffs <<< "${CODEX_ASYNC_BACKOFFS:-0 20 60}"
for backoff in "${backoffs[@]}"; do
  tentativa=$((tentativa+1))
  [ "$backoff" -gt 0 ] && { echo "retry em ${backoff}s (tentativa $tentativa)…" >&2; sleep "$backoff"; }

  # relógio DESTA tentativa (o backoff acima fica de fora de propósito: o que o PR registra
  # é quanto o Codex levou para responder, não quanto o wrapper esperou entre tentativas)
  t_ini=$(date +%s)
  : > "$marcador"   # linha de base do sensor de fan-out DESTA tentativa
  # hard-stop próprio: codex às vezes trava com processo vivo (money-path.md)
  # `features.multi_agent_v2.max_concurrent_threads_per_session=1` = 1 slot (só o /root):
  # sem ele são 4, e o modelo delega. NÃO troque por `--disable multi_agent` nem por
  # `agents.max_concurrent_threads_per_session`/`agents.max_depth`: os três foram medidos
  # ao vivo em 20/09 e os dois primeiros são INERTES (seguem 4 slots); o `agents.*` só
  # desce pra 2 (deixa 1 subagente) e `max_depth` não muda nada. Valor 0 é recusado.
  codex exec --model "$modelo" -c model_reasoning_effort="$reasoning" \
    -c features.multi_agent_v2.max_concurrent_threads_per_session=1 \
    --sandbox read-only "$prompt" >"$out" 2>"$err" &
  pid=$!
  # fds do watchdog → /dev/null: se o sleep herdasse o stdout/stderr do chamador, seguraria
  # o pipe aberto até o timeout inteiro (chamador em foreground ficaria esperando EOF).
  # Isto é cinto: a sobrevivência do sleep ao kill do subshell é tratada ATIVAMENTE no
  # encerramento (`pkill -P`, logo abaixo) — mas continua valendo se o pkill faltar.
  ( sleep "$timeout_s" && kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid"; rc=$?
  segundos=$(( $(date +%s) - t_ini ))
  # ORDEM OBRIGATÓRIA: o `sleep` PRIMEIRO, o subshell depois. `kill "$watchdog"` mata só o
  # SUBSHELL — o `sleep` de dentro é reparentado para o init e sobrevive o timeout INTEIRO
  # (20min no default), um processo vazado POR INVOCAÇÃO. Inverter não conserta: com o pai
  # já morto, `-P "$watchdog"` não acha mais ninguém. Medido 2026-09-20: 921 `sleep 1200`
  # vivos numa M2 com kern.maxproc=2000 — passando desse teto TODO `fork` falha, e o
  # vermelho que sai daí se disfarça de asserção frouxa. NÃO mexe no hard-stop: isto tudo
  # roda DEPOIS do `wait "$pid"`, com o codex já encerrado.
  [ "$pkill_ok" = 1 ] && pkill -P "$watchdog" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  # fan-out medido POR FORA do flag (ver comentário do sensor). Vale para a tentativa que
  # falhou também — por isso fica aqui, e não só no cabeçalho do sucesso. E ACUMULA: a
  # tentativa 1 pode abrir filhos e falhar, e os tokens dela já foram cobrados — zerar no
  # retry apagaria do cabeçalho do PR exatamente o custo que motivou este sensor.
  medida="$(subagentes_desta_rodada)"
  if [ "$medida" = '?' ]; then fanout_incerto=1
  else printf '%s' "$medida" | grep . >> "$acervo" || true; fi
  if [ "$fanout_incerto" -eq 1 ]; then fanout='?'
  else fanout="$(sort -u "$acervo" 2>/dev/null | awk 'NF{n++} END{print n+0}')"; fi
  case "$fanout" in
    0) ;;
    '?') echo "FAN_OUT_DESCONHECIDO: não consegui contar threads de subagente desta rodada (sigo sem o sensor)." >&2 ;;
    *)  echo "FAN_OUT: o codex abriu $fanout thread(s) de SUBAGENTE nesta consulta — cada uma é cobrada à parte" >&2
        echo "  e replica o contexto inteiro. O teto de 1 slot devia impedir isto: confira se o codex-cli ainda" >&2
        echo "  aceita 'features.multi_agent_v2.max_concurrent_threads_per_session' (\`codex features list\`)." >&2 ;;
  esac

  if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
    tokens="$(tokens_do_rodape "$err")"
    if [ -n "$tokens" ]; then custo="$tokens tokens"; else custo="tokens ?"; fi
    # o fan-out entra no cabeçalho só quando NÃO é zero: 0 é o esperado e não merece ruído,
    # mas "?" e qualquer número > 0 precisam chegar ao PR junto com o custo.
    case "$fanout" in 0) extra="" ;; *) extra=" · $fanout subagente(s)" ;; esac
    echo "=== PARECER CODEX (modelo $modelo · reasoning $reasoning · tentativa $tentativa · ${segundos}s · $custo$extra) ==="
    cat "$out"
    echo
    echo "(cópia em $out)"
    exit 0
  fi

  # --- classificação do erro ------------------------------------------------
  # ⚠️ O stderr do codex ECOA o prompt inteiro (bloco "user") ANTES das linhas de erro
  # (medido 2026-08-22, codex-cli 0.144.1). Classificar o arquivo CRU faz o CONTEÚDO do
  # prompt decidir o controle de fluxo — e o ritual /codex cola log, stderr e `cat -n`
  # dentro do prompt o tempo todo. Custou nos DOIS sentidos:
  #   · `5[0-9][0-9]` casava o número de linha de um `cat -n` colado (qualquer 500-599) e
  #     um 400 PERMANENTE virava "transitório": 3 tentativas + 80s por um erro que não muda;
  #   · o inverso — prompt citando "usage limit", ou a própria frase "model is not supported"
  #     (o prompt que DIAGNOSTICOU este bug tinha as duas) — abortava na 1ª tentativa com
  #     COTA_ESGOTADA/MODELO_NAO_ACEITO sem retry nenhum.
  # ⇒ tira-se o eco: as linhas que vieram do prompt saem, e classifica-se o resto.
  #   (Por que não casar só linhas `ERROR:`, a alternativa óbvia: prompts do ritual colam
  #   stderr de erro o tempo todo — "diagnostique este log" —, e essas linhas COMEÇAM com
  #   `ERROR:`. O filtro por prefixo deixaria o veneno passar inteiro; tirar o eco não.
  #   Medido: implementar a alternativa reprova 5 casos da suíte, incluindo um
  #   COTA_ESGOTADA falso e o rate-limit simples (`429 rate limit exceeded` não é `ERROR:`).
  #   ⚠️ A nota anterior aqui justificava isso dizendo que a mensagem de cota NÃO vinha
  #   prefixada — medição de 2026-08-22 mostrou que VEM (`ERROR: You've hit your usage
  #   limit...`). O argumento estava errado; a decisão continua certa por este outro.)
  # `awk` com hash, NÃO `grep -Fvxf`: com um prompt de 5.000 linhas — tamanho normal no
  # ritual — o BSD grep do macOS leva 29s POR TENTATIVA (O(n·m)), ~2min nas 3. O GNU grep
  # do CI e o ugrep resolvem na hora, então a lentidão seria invisível no CI e só doeria na
  # máquina do founder. awk é O(n+m): <1s com 50.000 linhas. (medido 2026-08-22)
  diag="$(sem_eco_do_prompt "$err")"
  classifica() { printf '%s\n' "$diag" | grep -qiE "$1"; }

  # cota esgotada = NÃO-transitório → Caminho B na hora (money-path.md)
  if classifica 'usage limit|quota|plan limit'; then
    echo "COTA_ESGOTADA: o servidor recusou por limite de uso." >&2
    # QUANDO a janela reabre: só o servidor sabe, e diz no próprio erro ("…or try again at Sep
    # 14th, 2026 10:23 PM.", medido 2026-09-10, codex-cli 0.153.4). O `$err` que carrega a frase
    # morre no trap — sem copiá-la aqui, descobrir o reset custou um ping `codex exec` extra.
    # Lê-se do `$diag` (SEM o eco), nunca do `$err` cru: o ritual cola erro de cota antigo no
    # prompt, e o eco imprimiria a reabertura de OUTRO dia como a de agora. Copia-se o texto,
    # nunca se calcula horário; se o servidor não mandou, diz-se isso (ausente ≠ inventado).
    reabre="$(printf '%s\n' "$diag" | awk 'r == "" && match($0, /try again at .*/) { r = substr($0, RSTART, RLENGTH) }
      END { sub(/[.[:space:]]+$/, "", r); print r }')"
    if [ -n "$reabre" ]; then echo "  janela reabre (servidor): $reabre" >&2
    else echo "  janela reabre: (o servidor não informou)" >&2; fi
    echo "  plano DECLARADO no seu token: $(plano_do_token)" >&2
    echo "  ⚠️ CONFIRA ESSE PLANO ANTES de aceitar o limite como real: o servidor cobra pelo" >&2
    echo "     CLAIM do token, não pela assinatura viva — um token velho declara o plano" >&2
    echo "     ANTIGO. Em 2026-08-23 o 'limite' era o do 'free' declarado por um token de 2" >&2
    echo "     dias atrás, numa conta PAGA, e a mensagem mandava esperar quase um mês." >&2
    echo "     Se o plano acima não é o que você assina, reemita o token:" >&2
    echo "       codex logout && codex login" >&2
    echo "  → Se o plano BATE com o que você assina, aí o limite é real: siga o Caminho B" >&2
    echo "    (validação adversária própria + registrar 'REVISÃO INDEPENDENTE PENDENTE')" >&2
    echo "    — docs/agent/money-path.md." >&2
    exit 75
  fi
  # modelo recusado = erro de CONFIG. Não é cota (esperar não resolve) nem transitório
  # (repetir não resolve): as duas saídas erradas custam tempo apontando para o lugar errado.
  # ⚠️ HISTÓRICO DESTA NOTA — ela já esteve errada DUAS vezes, em sentidos opostos, e é o
  # melhor aviso que este arquivo tem sobre como se erra aqui:
  #   v1 dizia "é o acesso da conta"        → corrigida em 22/08 por parecer errada;
  #   v2 dizia "o eixo é o MODELO, não a conta; trocar o modelo RESOLVE; só suspeite do
  #      login se um modelo SABIDAMENTE servido também falhar" → **também errada**, e foi
  #      esta que custou 2 dias rodando no tier de baixo.
  # O que se mediu em 23/08: o 400 do `sol` vinha do `plan_type` CONGELADO num token de
  # 21/08 que dizia `free` numa conta paga. `codex logout && codex login` reemitiu o token e
  # o `sol` voltou NA HORA — mesmos pings, mesmo dia, 400 → rc=0.
  # ⇒ A heurística da v2 é FALSA: `terra`/`luna` respondiam porque são o tier de baixo, que
  #   segue servido com o plano rebaixado. **Um modelo responder NÃO inocenta o login.**
  #   Trocar o modelo remove o SINTOMA sem explicá-lo — e foi isso que encerrou a
  #   investigação com a causa intacta. Verifique o token ANTES (custa uma linha de JSON).
  if classifica 'model is not supported|unsupported_model|model_not_found'; then
    echo "MODELO_NAO_ACEITO: o servidor recusou o modelo '$modelo' (HTTP 400)." >&2
    echo "  1) SUSPEITE PRIMEIRO DO TOKEN, não do direito de acesso: o servidor cobra pelo" >&2
    echo "     CLAIM do token, e um token velho carrega o plano ANTIGO ('free' numa conta" >&2
    echo "     paga). Em 2026-08-23 era exatamente isso — 'codex logout && codex login'" >&2
    echo "     reemitiu o token e devolveu o modelo na hora. Confira o plano com:" >&2
    echo "       codex login status   (e o claim chatgpt_plan_type do ~/.codex/auth.json)" >&2
    echo "  ⚠️ Outro modelo responder NÃO inocenta o login: os tiers de baixo (terra/luna)" >&2
    echo "     seguem servidos com o plano rebaixado. Foi essa inferência que custou 2 dias." >&2
    echo "  2) Só depois troque o modelo com -m, ou ajuste 'model =' em \${CODEX_HOME:-~/.codex}/config.toml;" >&2
    echo "     medidos OK (conta paga): gpt-6-astra (2026-09-05, exige codex-cli ≥ 0.153.1);" >&2
    echo "     gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna (2026-08-23)." >&2
    echo "  (não é cota nem falha transitória: esperar e repetir não consertam nenhum dos dois.)" >&2
    exit 78
  fi
  # 400 de requisição inválida é PERMANENTE: repetir manda exatamente o mesmo request.
  # Explícito (e não "sobrou, então para"): um ramo que só faz `break` é indistinguível do
  # break final — não dá para testar nem para ler no stderr qual foi o julgamento.
  if classifica 'invalid_request_error|unsupported_parameter|invalid_value'; then
    echo "ERRO_PERMANENTE: o servidor recusou o pedido (HTTP 400). Não é cota nem falha" >&2
    echo "  transitória — repetir manda exatamente o mesmo request. Ajuste o pedido (modelo," >&2
    echo "  reasoning, tamanho do prompt) e re-rode. Motivo cru abaixo." >&2
    break
  fi
  # transitório (rede/limite/kill do watchdog) → tenta de novo.
  # 5xx só conta ancorado num marcador HTTP — solto, `5[0-9][0-9]` casa qualquer número de
  # 3 dígitos que passe por aqui (era o bug: número de linha vira "erro de servidor").
  if classifica 'rate.?limit|429|timed?.?out|overloaded|temporarily|connection|ECONN|ETIMEDOUT|status"?[:= ]*5[0-9][0-9]|HTTP/?[0-9.]* *5[0-9][0-9]' || [ "$rc" -ge 124 ]; then
    continue
  fi
  break  # erro não-transitório → não insiste
done

echo "CODEX_FALHOU (rc=$rc) após $tentativa tentativa(s). stderr (sem o eco do prompt):" >&2
# o eco é que escondia o erro: um 400 de 1 linha some no meio de 100 linhas de código
# colado, e foi assim que este bug passou dias parecendo "cota". `${diag:-}` porque um
# CODEX_ASYNC_BACKOFFS vazio não entra no loop e nunca chega a definir diag (set -u).
if [ -n "${diag:-}" ]; then printf '%s\n' "$diag" | tail -20 >&2; else tail -20 "$err" >&2; fi
exit "$rc"
