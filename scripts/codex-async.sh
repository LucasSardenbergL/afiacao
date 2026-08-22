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
# Defaults: -m gpt-5.6-luna · -r high · -t 1200 (20min hard-stop)
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
# ⚠️ O default É MEDIÇÃO, não escolha: `gpt-5.6-sol` era o default e está MORTO para esta
# conta — todo ritual /codex do repo falhava. Ping `codex exec --model M --sandbox read-only
# "responda apenas: OK"` em 2026-08-22 (codex-cli 0.144.1, conta ChatGPT):
#   gpt-5.6-luna  → rc=0 "OK"     gpt-5.6-terra → rc=0 "OK"
#   gpt-5.6-sol   → 400           gpt-5.6       → 400        gpt-5.1-codex-max → 400
# A disponibilidade muda por tier: RE-MEÇA com o ping antes de confiar nesta lista.
modelo="gpt-5.6-luna"; reasoning="high"; timeout_s=1200
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
  # ⇒ tira-se o eco: `grep -Fvxf` remove as linhas que são do prompt e classifica-se o resto.
  #   (Filtrar por prefixo `ERROR:` seria mais frágil: nem toda mensagem do codex o traz —
  #   a de cota, p.ex., não vem prefixada, e sumiria da classificação.)
  diag="$(grep -aFvxf <(printf '%s\n' "$prompt") "$err" 2>/dev/null)"
  classifica() { printf '%s\n' "$diag" | grep -qiE "$1"; }

  # cota esgotada = NÃO-transitório → Caminho B na hora (money-path.md)
  if classifica 'usage limit|quota|plan limit'; then
    echo "COTA_ESGOTADA: janela rolante de 7d do ChatGPT Plus esgotou. Siga o Caminho B (validação adversária própria + registrar 'REVISÃO INDEPENDENTE PENDENTE') — docs/agent/money-path.md." >&2
    exit 75
  fi
  # modelo recusado = erro de CONFIG. Não é cota (esperar não resolve) nem transitório
  # (repetir não resolve): as duas saídas erradas custam tempo apontando para o lugar errado.
  # ⚠️ O eixo é o MODELO, não o acesso da conta — a nota anterior aqui dizia o contrário e
  # estava errada. Medido 2026-08-22 (challenge retroativo do #1859), stderr cru do servidor:
  #   gpt-5.6-sol  → 400 "The 'gpt-5.6-sol' model is not supported when using Codex with a
  #                  ChatGPT account" — IDÊNTICO em -r high e -r xhigh (o effort não é a causa)
  #   gpt-5.6      → mesmo 400
  #   gpt-5.6-terra / gpt-5.6-luna → rc=0, respondem normalmente
  # Ou seja: "nenhum modelo passa ⇒ é a conta" é inferência de ausência de dado. Trocar o
  # modelo RESOLVE. Só suspeite do login se um modelo SABIDAMENTE servido também falhar.
  if classifica 'model is not supported|unsupported_model|model_not_found'; then
    echo "MODELO_NAO_ACEITO: o modelo '$modelo' não é aceito por esta conta Codex (HTTP 400)." >&2
    echo "  → passe outro com -m, ou ajuste 'model =' em \${CODEX_HOME:-~/.codex}/config.toml;" >&2
    echo "  → medidos OK nesta conta (2026-08-22): gpt-5.6-terra, gpt-5.6-luna. Recusados: -sol, gpt-5.6;" >&2
    echo "  → só se um SABIDAMENTE servido também falhar é acesso da conta: 'codex login' e confira a assinatura." >&2
    echo "  (não é cota nem falha transitória: esperar e repetir não consertam config.)" >&2
    exit 78
  fi
  # 400 de requisição inválida é PERMANENTE: repetir manda exatamente o mesmo request.
  # Explícito (e não "sobrou, então para") para não depender de nenhum regex falhar por acaso.
  if classifica 'invalid_request_error|unsupported_parameter|invalid_value'; then
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

echo "CODEX_FALHOU (rc=$rc) após $tentativa tentativa(s). stderr:" >&2
tail -20 "$err" >&2
exit "$rc"
