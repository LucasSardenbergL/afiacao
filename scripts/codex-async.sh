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
#   scripts/codex-async.sh [-m MODELO] [-r low|medium|high|xhigh] [-t SEGUNDOS] "PROMPT"
#   echo "PROMPT" | scripts/codex-async.sh -r xhigh -
# Defaults: -m gpt-5.6-sol · -r xhigh · -t 1200 (20min hard-stop)
#
# Garantias:
#   - preflight (binário + auth) ANTES de gastar tempo/quota, com instrução clara;
#   - retry com backoff (20s/60s) só em transitório (rate limit/timeout/overload),
#     classificado SEM o eco do prompt no stderr (senão o texto do prompt decide o fluxo);
#   - cota esgotada NÃO é transitório → falha na hora instruindo o Caminho B;
#   - modelo recusado pela conta (400) → exit 78, instruindo CONFIG (≠ cota, ≠ retry);
#   - mktemp XXXXXX (sem colisão de tmp entre execuções paralelas);
#   - sandbox read-only (consulta nunca escreve no repo).
set -u

# gpt-5.6-* exige codex-cli ≥ 0.143 (server rejeita CLI antigo com 400).
# ⚠️ O default É MEDIÇÃO, não escolha. Ping `codex exec --model M -c
# model_reasoning_effort="xhigh" --sandbox read-only "responda apenas: OK"`, 2026-08-23,
# codex-cli 0.144.1, conta paga (plan_type=prolite):
#   gpt-5.6-sol → rc=0 (97s)   gpt-5.6-terra → rc=0 (45s)   gpt-5.6-luna → rc=0 (87s)
#   gpt-5.6 → 400   ·   gpt-5.3-codex → 400   ·   gpt-5.1-codex-max → 400
# `sol` é o frontier da família 5.6 ⇒ é o default, em `xhigh` (decisão do founder: a 2ª
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
modelo="gpt-5.6-sol"; reasoning="xhigh"; timeout_s=1200
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
if [ -z "${CODEX_API_KEY:-}${OPENAI_API_KEY:-}" ] && [ ! -f "${CODEX_HOME:-$HOME/.codex}/auth.json" ]; then
  echo "PREFLIGHT_FAIL: sem auth do Codex. Rode 'codex login' (ou exporte CODEX_API_KEY/OPENAI_API_KEY) e re-rode." >&2
  exit 77
fi

out="$(mktemp -t codex-async.XXXXXX)" || exit 70
err="$(mktemp -t codex-async-err.XXXXXX)" || exit 70
trap 'rm -f "$err"' EXIT

rc=1
tentativa=0
# backoffs sobrescritíveis por env (testes usam "0 0 0" pra não esperar de verdade)
read -ra backoffs <<< "${CODEX_ASYNC_BACKOFFS:-0 20 60}"
for backoff in "${backoffs[@]}"; do
  tentativa=$((tentativa+1))
  [ "$backoff" -gt 0 ] && { echo "retry em ${backoff}s (tentativa $tentativa)…" >&2; sleep "$backoff"; }

  # hard-stop próprio: codex às vezes trava com processo vivo (money-path.md)
  codex exec --model "$modelo" -c model_reasoning_effort="$reasoning" \
    --sandbox read-only "$prompt" >"$out" 2>"$err" &
  pid=$!
  # fds do watchdog → /dev/null: o sleep interno sobrevive ao kill do subshell
  # e, se herdasse o stdout/stderr do chamador, seguraria o pipe aberto até o
  # timeout inteiro (chamador em foreground ficaria esperando EOF)
  ( sleep "$timeout_s" && kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null

  if [ "$rc" -eq 0 ] && [ -s "$out" ]; then
    echo "=== PARECER CODEX (modelo $modelo · reasoning $reasoning · tentativa $tentativa) ==="
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
  diag="$(awk 'NR==FNR{p[$0];next} !($0 in p)' <(printf '%s\n' "$prompt") "$err" 2>/dev/null)"
  classifica() { printf '%s\n' "$diag" | grep -qiE "$1"; }

  # cota esgotada = NÃO-transitório → Caminho B na hora (money-path.md)
  if classifica 'usage limit|quota|plan limit'; then
    echo "COTA_ESGOTADA: janela rolante de 7d do ChatGPT Plus esgotou. Siga o Caminho B (validação adversária própria + registrar 'REVISÃO INDEPENDENTE PENDENTE') — docs/agent/money-path.md." >&2
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
    echo "     medidos OK em 2026-08-23 (conta paga): gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna." >&2
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
