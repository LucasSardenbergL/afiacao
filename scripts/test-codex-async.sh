#!/usr/bin/env bash
# test-codex-async.sh — TDD do scripts/codex-async.sh com `codex` STUBADO (sem quota).
#
# Contrato testado: 0=parecer entregue · 64=uso errado · 69=binário ausente ·
# 75=cota esgotada (SEM retry; mostra o "try again at" COPIADO do servidor, lido sem o
# eco do prompt — nunca horário calculado) · 77=sem auth · retry só em transitório ·
# watchdog mata execução travada · cabeçalho traz o CUSTO (segundos da tentativa
# vencedora + tokens do rodapé, "tokens ?" quando ausente — nunca 0).
#
# Uso: bash scripts/test-codex-async.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# CODEX_ASYNC_ALVO: a CÓPIA (de controle ou sabotada) que o `--falsificar` serve — nunca o versionado.
ASYNC="${CODEX_ASYNC_ALVO:-$here/codex-async.sh}"

# Linhas do stdin que NÃO estão no arquivo-base (diferença de conjunto). A base é lida por
# `getline`, explicitamente, porque as duas formas óbvias são CEGAS — cada uma numa forma de
# base, e foram as duas versões anteriores deste medidor:
#   · `awk -v pre="$lista"` — o awk do BSD MORRE com quebra de linha no valor de `-v`
#     ("newline in string"): base com ≥2 linhas → saída vazia;
#   · `awk 'NR==FNR{p[$0];next} ...' base -` — com a base VAZIA, NR==FNR segue verdadeiro na
#     entrada 2, que vira "base", e nada sai: base vazia (a máquina LIMPA, o caso comum) → vazio.
# Nos dois casos "vazio" é lido como "não vazou". Base ilegível → tudo sai como novo: o erro
# vai para o lado do VERMELHO, e a sonda de base povoada acusa.
fora_da_base() { # arquivo-base → filtra o stdin
  BASE="$1" awk 'BEGIN { while ((getline l < ENVIRON["BASE"]) > 0) p[l] } !($0 in p)'
}

# ── modo falsificação ───────────────────────────────────────────────────────
# Sabota o WRAPPER numa cópia e EXIGE vermelho PELO MOTIVO CERTO: cada sabotagem declara a
# marca ASCII, caixa fixa, que a suíte tem de imprimir — "ficou vermelha" não basta (um erro
# de sintaxe também fica). Três camadas, UMA POR VEZ: a que ficar verde é redundante ou
# inalcançada. Julgada nos DOIS locales (#1483) e só depois de um CONTROLE verde na MESMA
# invocação do laço (docs/historico/falsificacao-sem-linha-de-base.md).
if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (sabota o WRAPPER; exige vermelho pela marca certa, 2 locales) ==\n'
  fals="$(mktemp -d)"; trap 'rm -rf "$fals"' EXIT
  falhas=0
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "nenhum locale UTF-8 (pt_BR/en_US/C) neste ambiente — metade da falsificacao nao rodaria."
    exit 1
  fi
  original="$fals/original.sh"; cp "$here/codex-async.sh" "$original"

  # As sabotagens do watchdog VAZAM `sleep` de propósito — é exatamente o que elas provam.
  # Sem recolher, UMA falsificação deixa ~170 processos vivos por 20min e a M2 do founder
  # bate no kern.maxproc (2000): daí pra frente todo `fork` falha e a suíte fica vermelha
  # por AMBIENTE, indistinguível de asserção frouxa. Foi assim que a máquina caiu em 20/09.
  # Recolhe SÓ o que nasceu nesta invocação E já está órfão (ppid=1): órfão de watchdog é
  # inerte por construção — o pai que rodaria o `&& kill` morreu, então ele não vai matar
  # mais nada. Se o `ps` faltar ou mudar de formato, o awk não devolve nada e NADA é morto
  # (a degradação é para o lado seguro: sobra lixo, nunca se mata o processo de ninguém).
  sleeps_orfaos() { ps -A -o pid=,ppid=,args= 2>/dev/null | awk '$2==1 && $3=="sleep" {print $1}'; }
  suite() { # alvo locale → $saida_suite/$rc_suite (MESMA invocação do laço; só o alvo muda)
    local lixo; sleeps_orfaos > "$fals/base_orfaos"
    saida_suite="$(LC_ALL="$2" CODEX_ASYNC_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?
    lixo="$(sleeps_orfaos | fora_da_base "$fals/base_orfaos")"
    [ -n "$lixo" ] && printf '%s\n' "$lixo" | xargs kill 2>/dev/null
    return 0
  }

  # CONTROLE primeiro: sem linha de base verde, um arnês sempre-vermelho aprova TODA sabotagem.
  for loc in C "$utf8"; do
    suite "$original" "$loc"
    if [ "$rc_suite" -eq 0 ]; then printf '  ok    controle verde (locale %s)\n' "$loc"
    else printf '  FAIL [controle-vermelho]  a suite ja falha SEM sabotagem (locale %s, exit %s)\n' "$loc" "$rc_suite"
         printf '%s\n' "$saida_suite" | grep -m3 'FAIL' ; falhas=1; fi
  done
  [ "$falhas" -eq 0 ] || { echo "FALSIFICACAO ABORTADA: sem controle verde nada abaixo tem valor."; exit 1; }

  sabotar() { # id  marca-esperada  script-python-de-sabotagem
    local id="$1" marca="$2" prog="$3" alvo="$fals/$1.sh"
    cp "$original" "$alvo"
    ALVO="$alvo" python3 -c "$prog" || { printf '  FAIL [%s]  a sabotagem nao pegou no arquivo\n' "$id"; falhas=1; return; }
    bash -n "$alvo" 2>/dev/null || { printf '  FAIL [%s]  sabotagem quebrou a SINTAXE (vermelho por crash nao prova nada)\n' "$id"; falhas=1; return; }
    for loc in C "$utf8"; do
      suite "$alvo" "$loc"
      if [ "$rc_suite" -eq 0 ]; then
        printf '  FAIL [%s]  sabotagem passou VERDE (locale %s) — a camada nao esta coberta\n' "$id" "$loc"; falhas=1
      elif printf '%s' "$saida_suite" | grep -qF "FAIL [$marca]"; then
        printf '  ok    [%s] vermelho pela marca FAIL [%s] (locale %s)\n' "$id" "$marca" "$loc"
      else
        # dizer PELO QUE ficou vermelha: sem isto, uma falha de AMBIENTE (a M2 do founder
        # estoura o kern.maxproc com ~30 worktrees e o `fork` falha) é indistinguível de uma
        # asserção frouxa — e as duas pedem ações opostas.
        printf '  FAIL [%s]  vermelho pelo motivo ERRADO (locale %s): faltou FAIL [%s]. Veio:\n' "$id" "$loc" "$marca"
        printf '%s\n' "$saida_suite" | grep -m3 'FAIL' | sed 's/^/        /'
        falhas=1
      fi
    done
  }

  # (1) tirar o teto da invocação = o defeito original de volta
  sabotar teto teto-ausente '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="    -c features.multi_agent_v2.max_concurrent_threads_per_session=1 \\\n"
assert s.count(a)==1
io.open(p,"w",encoding="utf-8").write(s.replace(a,""))'

  # (2) sensor cego: conta 0 sempre (o fan-out volta a passar em silencio)
  # sensor cego = devolve NENHUM caminho (não "0": a função imprime caminhos, e um "0"
  # solto seria lido como um caminho e viraria contagem 1 — o oposto da sabotagem).
  sabotar sensor fanout-silencioso '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="subagentes_desta_rodada() {"
i=s.index(a); j=s.index("\n",i)+1
io.open(p,"w",encoding="utf-8").write(s[:j]+"  return\n"+s[j:])'

  # (3) tirar o filtro por cwd: o alarme passa a acusar a worktree vizinha
  # shellcheck disable=SC2016  # o programa é python: `$PWD`/`$((n+1))` têm de chegar LITERAIS
  # (são o texto que o sed-equivalente procura no wrapper); expandir aqui apagaria o alvo.
  sabotar cwd fanout-cwd-alheia '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="    case \"$cab\" in *\"\\\"cwd\\\":\\\"$PWD\\\"\"*) printf '"'"'%s\\n'"'"' \"$f\" ;; esac"
assert s.count(a)==1, s.count(a)
io.open(p,"w",encoding="utf-8").write(s.replace(a,"    printf '"'"'%s\\n'"'"' \"$f\""))'

  # (4) a consulta NÃO acontece: o wrapper aborta antes de chamar o codex. Os "controles"
  # que só procuravam AUSÊNCIA de alarme passavam verdes aqui — 2ª opinião, 2026-09-20.
  # Esta sabotagem é o que prova que eles pararam de passar.
  sabotar sem_consulta controle-sem-consulta '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="# --- preflight (barato, ANTES de gastar contexto/quota) -----------------------\n"
assert s.count(a)==1
io.open(p,"w",encoding="utf-8").write(s.replace(a,a+"exit 77\n"))'

  # (5) tirar o `pkill -P`: o `kill` sozinho mata o SUBSHELL e o `sleep` de dentro vaza
  # (reparentado para o init, vivo o timeout inteiro). Era o defeito medido em 20/09.
  # shellcheck disable=SC2016  # o programa é python: `$pkill_ok`/`$watchdog` têm de chegar
  # LITERAIS (são o texto procurado no wrapper); expandir aqui apagaria o alvo.
  sabotar watchdog_pkill watchdog-sleep-vazado '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="  [ \"$pkill_ok\" = 1 ] && pkill -P \"$watchdog\" 2>/dev/null\n"
assert s.count(a)==1
io.open(p,"w",encoding="utf-8").write(s.replace(a,""))'

  # (6) o codex HERDA o stdin do chamador: um `<&0` explícito desliga a regra do bash que dá
  # /dev/null ao job `&` — é o mesmo efeito de um refactor que rodasse o codex em foreground.
  # shellcheck disable=SC2016  # o programa é python: `$prompt`/`$out`/`$err` têm de chegar
  # LITERAIS (são o texto procurado no wrapper); expandir aqui apagaria o alvo.
  sabotar stdin_herdado stdin-herdado '
import io,os
p=os.environ["ALVO"]; s=io.open(p,encoding="utf-8").read()
a="    --sandbox read-only \"$prompt\" >\"$out\" 2>\"$err\" &\n"
assert s.count(a)==1
io.open(p,"w",encoding="utf-8").write(s.replace(a,a[:-2]+"<&0 &\n"))'

  echo
  if [ "$falhas" -eq 0 ]; then echo "PASS — toda sabotagem ficou vermelha pela marca certa"; else echo "FALHOU"; fi
  exit "$falhas"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/codexhome_ok" "$tmp/codexhome_vazio" "$tmp/codexhome_free" "$tmp/codexhome_pago"
: > "$tmp/codexhome_ok/auth.json"
# `sessions/` existe em toda conta que já rodou o codex uma vez. O sensor de fan-out usa a
# AUSÊNCIA dela como "não consigo medir" (é o sinal de que não estamos olhando onde o codex
# escreve), então os homes do caminho feliz precisam tê-la — senão todo cabeçalho sairia com
# "?" e o alarme viraria ruído de fundo. O home SEM ela é criado de propósito mais abaixo.
mkdir -p "$tmp/codexhome_ok/sessions" "$tmp/codexhome_free/sessions" "$tmp/codexhome_pago/sessions"

# auth.json com JWT FALSO carregando só o claim do plano (nada de segredo — o payload de um
# JWT é base64, não cifra). Serve para provar que a mensagem de cota LÊ o plano declarado.
jwt_com_plano() { # plano → token falso `header.payload.assinatura`
  local payload
  payload=$(printf '{"https://api.openai.com/auth":{"chatgpt_plan_type":"%s"}}' "$1" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf 'ZmFrZQ.%s.assinatura-irrelevante' "$payload"
}
printf '{"tokens":{"access_token":"%s"}}' "$(jwt_com_plano free)"    > "$tmp/codexhome_free/auth.json"
printf '{"tokens":{"access_token":"%s"}}' "$(jwt_com_plano prolite)" > "$tmp/codexhome_pago/auth.json"

# stub de codex: comportamento por CODEX_STUB_MODE; conta invocações em CODEX_STUB_COUNT
cat >"$tmp/bin/codex" <<'STUB'
#!/bin/sh
echo x >> "$CODEX_STUB_COUNT"
# argumentos da invocação: é o que prova que um flag de transporte (ex.: o teto
# multi-agente) REALMENTE viaja até o codex, e não só existe num comentário.
[ -n "${CODEX_STUB_ARGS:-}" ] && printf '%s\n' "$*" >> "$CODEX_STUB_ARGS"
# stderr FIEL ao codex real (medido 2026-08-22, codex-cli 0.144.1): header, o PROMPT
# ECOADO sob "user", e só então as linhas ERROR:. O eco é o que envenena qualquer
# classificação feita sobre o arquivo cru.
for a in "$@"; do prompt="$a"; done
{ echo "OpenAI Codex v0.144.1"; echo "--------"; echo "model: stub"
  echo "sandbox: read-only"; echo "--------"; echo "user"; printf '%s\n' "$prompt"
  # no modo ok_eco_no_fim o eco é a ÚLTIMA coisa do stderr (nem warning, nem rodapé) — é a
  # única forma de o eco do prompt alcançar o fim do arquivo, onde mora o rodapé real.
  [ "$CODEX_STUB_MODE" = "ok_eco_no_fim" ] || \
    echo "warning: Model metadata for \`stub\` not found. Defaulting to fallback metadata."
} >&2
# rodapé de custo do codex real (medido 2026-09-05, codex-cli 0.153.4): as DUAS últimas
# linhas do stderr são o marcador `tokens used` e o número com separador de milhar.
rodape() { printf 'tokens used\n%s\n' "$1" >&2; }
case "$CODEX_STUB_MODE" in
  ok)        echo "parecer: aprovado com ressalvas"; rodape "14.243"; exit 0 ;;
  # codex que NÃO emitiu o rodapé (versão antiga/futura, saída truncada): ausente ≠ zero.
  ok_sem_tokens) echo "parecer sem rodape"; exit 0 ;;
  ok_eco_no_fim) echo "parecer com eco no fim do stderr"; exit 0 ;;
  # rodapé presente mas com valor NÃO numérico: vale o mesmo que ausente, nunca 0.
  ok_tokens_sujo) echo "parecer com rodape sujo"; rodape "N/A"; exit 0 ;;
  # demora medível: prova que os segundos do cabeçalho MEDEM, não são constante impressa.
  ok_lento)  sleep 2; echo "parecer lento"; rodape "1.111"; exit 0 ;;
  # 1ª tentativa LENTA e falha; 2ª responde na hora. Os segundos têm de ser os da tentativa
  # que produziu o parecer — somar as tentativas daria ≥4s.
  ratelimit_lento) n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pós-retry lento"; rodape "2.222"; exit 0
             else sleep 4; echo "429 rate limit exceeded" >&2; exit 1; fi ;;
  # mensagem REAL medida 2026-08-22 (vem prefixada com ERROR:, ao contrario do que o stub
  # anterior supunha) — o texto e literal do servidor.
  quota)     echo "ERROR: You've hit your usage limit. To continue using Codex and get access to GPT-5.3-Codex, start a free trial of Plus today (https://chatgpt.com/explore/plus), or try again at Sep 20th, 2026 10:37 PM." >&2; exit 1 ;;
  # variante SEM prefixo: o classificador nao pode depender de conhecer o vocabulario de
  # prefixos do codex-cli, que muda entre versoes.
  quota_sem_prefixo) echo "You have reached your usage limit" >&2; exit 1 ;;
  # mensagem REAL medida 2026-09-10 (codex-cli 0.153.4), texto literal do servidor. É a única
  # fonte do horário em que a janela reabre — e o stderr cru que a carrega morre no trap.
  quota_0153) echo "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 14th, 2026 10:23 PM." >&2; exit 1 ;;
  modelo)    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-5.6-sol'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2; exit 1 ;;
  ratelimit) n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pós-retry"; exit 0
             else echo "429 rate limit exceeded" >&2; exit 1; fi ;;
  # 400 permanente SEM marcador nenhum: nao casa cota, modelo, nem invalid_request_error.
  # E o unico caso em que so a REMOCAO DO ECO decide — por isso ele testa o bug original.
  generico400) echo 'ERROR: {"type":"error","status":400,"error":{"message":"malformed request"}}' >&2; exit 1 ;;
  # 400 permanente que NAO e cota nem modelo-recusado (repetir manda o mesmo request)
  permanente) echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Unsupported parameter: reasoning.effort is not supported with this model."}}' >&2; exit 1 ;;
  # 5xx de VERDADE, em linha de ERRO: transitorio legitimo, tem de continuar retentando
  erro5xx)   n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pos-503"; exit 0
             else echo 'ERROR: {"type":"error","status":503,"error":{"message":"upstream unavailable"}}' >&2; exit 1; fi ;;
  # numero 500-599 DENTRO da mensagem de erro, sem ser status HTTP (contagem de tokens).
  # Isola a ancora: aqui remover o eco do prompt nao salva — o "5120" esta na linha de ERRO.
  num5xx)    echo 'ERROR: {"type":"error","status":400,"error":{"type":"context_length_exceeded","message":"prompt has 5120 tokens; maximum for this model is 4096"}}' >&2; exit 1 ;;
  # o defeito de transporte medido em 2026-09-20: o codex-cli 0.153.4 entrega `spawn_agent`
  # ao modelo, e cada subagente nasce como rollout PRÓPRIO, cobrado à parte. O stub reproduz
  # o único rastro que o wrapper consegue ver de fora: o arquivo em CODEX_HOME/sessions.
  ok_spawna) d="$CODEX_HOME/sessions/2026/09/20"; mkdir -p "$d"
             printf '{"type":"session_meta","payload":{"thread_source":"subagent","cwd":"%s"}}\n' "$PWD" \
               > "$d/rollout-2026-09-20T00-00-00-filho.jsonl"
             echo "parecer com fan-out"; rodape "9.999"; exit 0 ;;
  # subagente de OUTRA worktree: ~/.codex/sessions é COMPARTILHADO entre as sessões
  # paralelas. Sem o filtro por cwd, o alarme dispararia pelo trabalho do vizinho.
  ok_spawna_alheio) d="$CODEX_HOME/sessions/2026/09/20"; mkdir -p "$d"
             printf '{"type":"session_meta","payload":{"thread_source":"subagent","cwd":"/outra/worktree"}}\n' \
               > "$d/rollout-2026-09-20T00-00-00-alheio.jsonl"
             echo "parecer sem fan-out proprio"; rodape "9.999"; exit 0 ;;
  # codex real com stdin em pipe: LÊ o stdin INTEIRO e o anexa como bloco `<stdin>` (`codex
  # exec --help`). Com o pipe do chamador ABERTO, isto só termina quando o pipe fechar.
  ok_le_stdin) cat >/dev/null; echo "parecer: aprovado com ressalvas"; rodape "14.243"; exit 0 ;;
  trava)     sleep 30 ;;
  *)         echo "erro desconhecido" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/codex"

fail=0
# ambiente controlado: PATH mínimo com o stub; sem env keys; backoffs zerados
run() {
  local mode="$1"; shift
  : > "$tmp/count"; : > "$tmp/args"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/codexhome_ok" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_STUB_ARGS="$tmp/args" LC_ALL="${LC_ALL:-C}" \
    CODEX_ASYNC_BACKOFFS="0 0 0" bash "$ASYNC" "$@" </dev/null
}
# igual ao run(), mas com CODEX_HOME escolhido (para variar o plano declarado no token)
run_home() {
  local home="$1" mode="$2"; shift 2
  : > "$tmp/count"; : > "$tmp/args"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/$home" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_STUB_ARGS="$tmp/args" LC_ALL="${LC_ALL:-C}" \
    CODEX_ASYNC_BACKOFFS="0 0 0" bash "$ASYNC" "$@" </dev/null
}
# igual ao run(), mas SEM o `</dev/null` — o stdin é o do CHAMADOR, que é o que se mede — e com
# UMA tentativa: o que se testa é se a consulta trava, não o retry (o vermelho custa 1 watchdog).
run_herda_stdin() {
  local mode="$1"; shift
  : > "$tmp/count"; : > "$tmp/args"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/codexhome_ok" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_STUB_ARGS="$tmp/args" LC_ALL="${LC_ALL:-C}" \
    CODEX_ASYNC_BACKOFFS="0" bash "$ASYNC" "$@"
}
invocacoes() { wc -l < "$tmp/count" | tr -d ' '; }

caso_exit() { # nome want_exit rc
  if [ "$3" -eq "$2" ]; then echo "  ok    exit $3 | $1"
  else echo "  FAIL  want exit $2, got $3 | $1"; fail=1; fi
}

echo "── caminho feliz ──"
out="$(run ok "pergunta qualquer" 2>/dev/null)"; rc=$?
caso_exit "parecer entregue → 0" 0 "$rc"
if printf '%s' "$out" | grep -q "parecer: aprovado"; then echo "  ok    stdout contém o parecer"
else echo "  FAIL  parecer ausente do stdout"; fail=1; fi

echo "── preflight ──"
run ok 2>/dev/null; caso_exit "prompt vazio → 64" 64 $?
env -i PATH="/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "codex ausente do PATH → 69" 69 $?
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" CODEX_HOME="$tmp/codexhome_vazio" \
  CODEX_STUB_MODE=ok CODEX_STUB_COUNT="$tmp/count" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "sem auth (nem env, nem auth.json) → 77" 77 $?

echo "── cota e retry ──"
run quota "x" >/dev/null 2>&1; rc=$?
caso_exit "cota esgotada → 75" 75 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    cota NÃO faz retry (1 invocação)"
else echo "  FAIL  cota fez retry ($(invocacoes) invocações)"; fail=1; fi
run quota_sem_prefixo "x" >/dev/null 2>&1
caso_exit "cota SEM prefixo ERROR: também vira 75" 75 $?

echo "── cota: suspeitar do TOKEN antes de aceitar o limite ──"
# 2026-08-23: o COTA_ESGOTADA mandou esperar até 20/09 — mas a "cota" era a do plano FREE
# que um token congelado declarava, numa conta paga. Relogar devolveu tudo. A mensagem tem
# de mostrar o plano DECLARADO no token e mandar conferi-lo antes de aceitar o limite.
saida=$(run_home codexhome_free quota "x" 2>&1); rc=$?
caso_exit "cota continua 75" 75 "$rc"
case "$saida" in
  *free*) echo "  ok    mostra o plano declarado no token (free)" ;;
  *) echo "  FAIL  não mostra o plano — o humano não vê que o token está rebaixado"; fail=1 ;;
esac
case "$saida" in
  *logout*) echo "  ok    plano rebaixado → manda REEMITIR o token (logout+login)" ;;
  *) echo "  FAIL  não manda relogar: repete o erro que custou 2 dias"; fail=1 ;;
esac

saida=$(run_home codexhome_pago quota "x" 2>&1)
case "$saida" in
  *prolite*) echo "  ok    plano pago é mostrado tal como declarado" ;;
  *) echo "  FAIL  não mostra o plano pago"; fail=1 ;;
esac
case "$saida" in
  *Caminho\ B*) echo "  ok    plano confere → Caminho B (aí sim o limite é real)" ;;
  *) echo "  FAIL  perdeu o Caminho B no caso em que ele é a ação certa"; fail=1 ;;
esac

# sensor ausente degrada (auth.json sem JWT legível) — mensagem informativa, não guard
saida=$(run_home codexhome_ok quota "x" 2>&1)
case "$saida" in
  *desconhecido*) echo "  ok    plano ilegível → 'desconhecido', sem fingir que leu" ;;
  *) echo "  FAIL  não degradou o sensor de plano"; fail=1 ;;
esac

echo "── cota: QUANDO a janela reabre (copiado do servidor, nunca calculado) ──"
# 2026-09-10 (codex-cli 0.153.4): o COTA_ESGOTADA imprimia só o texto fixo + o plano. O horário
# de reset vem no próprio erro do servidor, mas morria junto com o stderr cru, que o trap apaga —
# descobrir quando a janela reabria custou um ping `codex exec` extra em background.
saida=$(run quota_0153 "x" 2>&1); rc=$?
caso_exit "cota com horario do servidor continua 75" 75 "$rc"
case "$saida" in
  *"try again at Sep 14th, 2026 10:23 PM"*) echo "  ok    mostra quando a janela reabre, copiado do servidor" ;;
  *) echo "  FAIL  perdeu o horario de reabertura que o servidor mandou"; fail=1 ;;
esac

# O prompt COLA um erro de cota antigo, com horário (o ritual cola log o tempo todo), e o servidor
# não manda horário nenhum. Do stderr CRU, o eco imprimiria a reabertura de OUTRO dia como a de
# agora: a extração tem de ler o stderr SEM o eco. A metade negativa passaria por vacuidade num
# wrapper que não imprime horário nenhum — por isso a positiva, e a sabotagem "ler do arquivo
# cru" que falsificou as duas.
prompt_com_reset="diagnostique o erro de ontem:
ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 2027 09:00 AM."
saida=$(run quota_sem_prefixo "$prompt_com_reset" 2>&1); rc=$?
caso_exit "prompt com horario de reset + cota sem horario → 75" 75 "$rc"
case "$saida" in
  *"Jan 1st"*) echo "  FAIL  horario do ECO DO PROMPT impresso como reabertura"; fail=1 ;;
  *) echo "  ok    horario colado no prompt NAO vira reabertura" ;;
esac
case "$saida" in
  *"janela reabre: (o servidor"*) echo "  ok    servidor sem horario → a saida diz que ele nao informou" ;;
  *) echo "  FAIL  servidor sem horario e a saida nao diz isso (ausente != inventado)"; fail=1 ;;
esac

echo "── modelo recusado pela conta ──"
# 400 do servidor quando o modelo do config não vale para a conta (2026-08-22: os 10
# nomes testados foram recusados, então NÃO é erro de digitação do nome — é direito de
# acesso). Antes caía no CODEX_FALHOU genérico: rc=1 e um tail de stderr, sem dizer o
# que fazer. Confundir com cota manda para o Caminho B, que é esperar — e esperar não
# conserta config.
saida=$(run modelo "x" 2>&1); rc=$?
caso_exit "modelo recusado → 78 (EX_CONFIG), não 75 nem 1" 78 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    modelo recusado NÃO faz retry (1 invocação)"
else echo "  FAIL  modelo recusado fez retry ($(invocacoes) invocações)"; fail=1; fi
case "$saida" in
  *MODELO_NAO_ACEITO*) echo "  ok    diagnóstico próprio (MODELO_NAO_ACEITO)" ;;
  *) echo "  FAIL  sem diagnóstico próprio: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-90)"; fail=1 ;;
esac
case "$saida" in
  *"codex login"*|*config.toml*) echo "  ok    diz o que FAZER (login/config)" ;;
  *) echo "  FAIL  não instrui a ação"; fail=1 ;;
esac
# 2026-08-23: o 400 de modelo NÃO era direito de acesso — era o `plan_type` CONGELADO num
# token velho (dizia `free`; a conta é paga). `terra`/`luna` respondiam, então a heurística
# "se algum modelo passa, o login está OK" deu o login por bom e mandou trocar de modelo.
# Trocar o modelo "resolveu" o sintoma e escondeu a causa por 2 dias. A mensagem tem de
# oferecer a hipótese barata de verificar.
case "$saida" in
  *logout*) echo "  ok    oferece a hipótese do token/plano congelado (logout+login)" ;;
  *) echo "  FAIL  não cita relogin — a causa real de 2026-08-23 fica invisível"; fail=1 ;;
esac
case "$saida" in
  *Caminho\ B*) echo "  FAIL  mandou para o Caminho B (esperar não conserta config)"; fail=1 ;;
  *) echo "  ok    NÃO manda para o Caminho B" ;;
esac

out="$(run ratelimit "x" 2>/dev/null)"; rc=$?
caso_exit "rate limit transitório → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    exatamente 1 retry (2 invocações)"
else echo "  FAIL  invocações=$(invocacoes), esperava 2"; fail=1; fi

echo "── classificação não pode ler o ECO DO PROMPT ──"
# O stderr do codex reimprime o prompt inteiro sob "user" (medido 2026-08-22). Classificar
# o arquivo CRU deixa o CONTEÚDO do prompt decidir o controle de fluxo — e o ritual /codex
# cola log, stderr e `cat -n` de arquivo dentro do prompt o tempo todo.

# (a) o CENÁRIO DO RELATO, tal como ocorreu: `5[0-9][0-9]` casava o número de linha de um
#     `cat -n` colado no prompt e um 400 que nunca mudaria queimava 3 tentativas + 80s.
#     Precisa das DUAS proteções para ficar verde (eco removido E 5xx ancorado) — sabotar
#     só uma delas não o derruba; por isso (b)/(c) e (e) existem, isolando cada camada.
prompt_numerado="revise este trecho:
   511	const a = 1;
   512	const b = 2;
   513	const c = 3;"
run generico400 "$prompt_numerado" >/dev/null 2>&1
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    400 permanente NÃO retenta (1 invocação)"
else echo "  FAIL  400 permanente retentou ($(invocacoes)x) — eco do prompt virou transitorio"; fail=1; fi

# (b) o inverso: prompt que FALA de cota, erro real transitório → tem de retentar
run ratelimit "por que deu 'You have reached your usage limit' ontem?" >/dev/null 2>&1; rc=$?
caso_exit "prompt citando cota + 429 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    prompt citando cota não vira COTA_ESGOTADA"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — eco do prompt virou cota"; fail=1; fi

# (c) idem modelo: ESTE bug foi levado ao Codex com a frase dentro do prompt.
run ratelimit "o 400 diz: model is not supported when using Codex — o que eu faço?" >/dev/null 2>&1; rc=$?
caso_exit "prompt citando 'model is not supported' + 429 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    prompt citando modelo não vira MODELO_NAO_ACEITO"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — eco do prompt virou modelo recusado"; fail=1; fi

# (d) não regredir: 5xx de VERDADE (em linha ERROR:) continua transitório
run erro5xx "x" >/dev/null 2>&1; rc=$?
caso_exit "503 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    503 real ainda retenta (2 invocações)"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — perdeu o retry legítimo"; fail=1; fi

# (h) por que a correção tira o ECO em vez de casar só linhas `ERROR:` — a alternativa
#     óbvia. Prompts do ritual colam stderr de erro o tempo todo, e essas linhas COMEÇAM
#     com "ERROR:": um filtro por prefixo deixaria o veneno passar inteiro. (A justificativa
#     anterior aqui dizia que a mensagem de cota não vinha prefixada; medição de 2026-08-22
#     mostrou que VEM — o argumento estava errado, a decisão continua certa por este outro.)
run ratelimit "diagnostique este log que colei:
ERROR: You've hit your usage limit. Try again at Sep 20th.
o que houve?" >/dev/null 2>&1
caso_exit "prompt com LINHA 'ERROR: ...usage limit' + 429 real → retry → 0" 0 $?
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    filtro por prefixo não bastaria — o eco tem de sair"
else echo "  FAIL  invocações=$(invocacoes), esperava 2"; fail=1; fi

# (e2) o ramo do 400 de requisição inválida tem de DIZER o julgamento — um ramo que só
#      faz `break` é indistinguível do break final: ninguém lê, nenhum teste falsifica.
saida=$(run permanente "x" 2>&1)
case "$saida" in
  *ERRO_PERMANENTE*) echo "  ok    400 inválido diz que é permanente (não para em silêncio)" ;;
  *) echo "  FAIL  parou sem dizer o julgamento — indistinguível do break final"; fail=1 ;;
esac

# (e) a âncora do 5xx, isolada: tirar o eco do prompt NÃO cobre este caso — o número
#     500-599 está DENTRO da linha de erro ("5120 tokens"), e não é status HTTP nenhum.
run num5xx "x" >/dev/null 2>&1; rc=$?
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    5xx só conta ancorado em HTTP (1 invocação)"
else echo "  FAIL  invocações=$(invocacoes), esperava 1 — '5120 tokens' virou 'erro 5xx'"; fail=1; fi

# (f) o relatório de falha também não pode devolver o prompt: `tail` do stderr CRU
#     despeja o eco inteiro, que é exatamente o ruído que escondeu o 400 no diagnóstico.
saida=$(run generico400 "$prompt_numerado" 2>&1)
case "$saida" in
  *"const b = 2;"*) echo "  FAIL  CODEX_FALHOU devolveu o prompt ecoado no stderr"; fail=1 ;;
  *) echo "  ok    CODEX_FALHOU mostra o diagnóstico, não o eco do prompt" ;;
esac
case "$saida" in
  *"malformed request"*) echo "  ok    …e o motivo cru continua visível" ;;
  *) echo "  FAIL  perdeu o motivo cru do erro"; fail=1 ;;
esac

# (g) prompt GRANDE: tirar o eco não pode ser O(n·m). Medido 2026-08-22 no macOS com um
#     prompt de 5.000 linhas: `grep -Fvxf` (BSD grep) levou 29s POR TENTATIVA — 3 tentativas
#     = ~2min de espera antes de o ritual sequer reportar o erro. O ugrep e o GNU grep do CI
#     resolvem na hora, então a lentidão seria INVISÍVEL no CI e só doeria na máquina do
#     founder. `awk` com hash é O(n+m): <1s. O teto de 20s abaixo é folgado de propósito —
#     é guarda contra a regressão catastrófica, não benchmark.
prompt_grande=$(awk 'BEGIN{for(i=1;i<=5000;i++) printf "%6d\tlinha de codigo %d;\n", i, i}')
t0=$(date +%s)
saida=$(run generico400 "$prompt_grande" 2>&1)
gasto=$(( $(date +%s) - t0 ))
if [ "$gasto" -le 20 ]; then echo "  ok    prompt de 5k linhas classificado em ${gasto}s (teto 20s)"
else echo "  FAIL  ${gasto}s para um prompt de 5k linhas — remoção do eco virou O(n*m)"; fail=1; fi
case "$saida" in
  *"linha de codigo 512"*) echo "  FAIL  vazou o prompt grande na saída"; fail=1 ;;
  *) echo "  ok    …e sem vazar o prompt na saída" ;;
esac

echo "── custo no cabeçalho (sensor do nível de reasoning) ──"
# Desde 2026-09-05 cada consult registra no PR nível + segundos + tokens (money-path.md
# §Segunda opinião → "Nível de reasoning"); é o sensor de que o piloto do `ultra` depende.
# O cabeçalho é a ÚNICA saída que o ritual copia, então o custo tem de estar nele.
cabecalho() { printf '%s\n' "$1" | grep -m1 '^=== PARECER CODEX'; }
segundos_do_cabecalho() { cabecalho "$1" | sed -n 's/.*· \([0-9][0-9]*\)s ·.*/\1/p'; }

out="$(run ok "pergunta qualquer" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *"· 14.243 tokens)"*) echo "  ok    cabeçalho traz os tokens do rodapé" ;;
  *) echo "  FAIL  sem tokens no cabeçalho: $(cabecalho "$out")"; fail=1 ;;
esac
if [ -n "$(segundos_do_cabecalho "$out")" ]; then echo "  ok    cabeçalho traz os segundos"
else echo "  FAIL  sem segundos no cabeçalho: $(cabecalho "$out")"; fail=1; fi

# ausente ≠ zero (CLAUDE.md): sem rodapé o cabeçalho diz "?" — fabricar 0 registraria no PR
# um consult que não custou nada, e o piloto do `ultra` compara justamente consumo.
out="$(run ok_sem_tokens "x" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *"tokens ?"*) echo "  ok    rodapé ausente → 'tokens ?'" ;;
  *) echo "  FAIL  rodapé ausente não virou '?': $(cabecalho "$out")"; fail=1 ;;
esac
case "$(cabecalho "$out")" in
  *"0 tokens"*) echo "  FAIL  fabricou 0 tokens onde o dado está AUSENTE"; fail=1 ;;
  *) echo "  ok    …e não fabricou 0" ;;
esac
if [ -n "$(segundos_do_cabecalho "$out")" ]; then echo "  ok    …e os segundos continuam (sensores independentes)"
else echo "  FAIL  perdeu os segundos junto com os tokens"; fail=1; fi

out="$(run ok_tokens_sujo "x" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *"tokens ?"*) echo "  ok    rodapé não-numérico → '?' (não copia lixo pro PR)" ;;
  *) echo "  FAIL  aceitou rodapé não-numérico: $(cabecalho "$out")"; fail=1 ;;
esac

# o PROMPT não pode decidir o número — mesma lição da classificação de erro. O ritual /codex
# cola saída de codex dentro do prompt o tempo todo (inclusive discutindo ESTE wrapper), e o
# stderr reimprime o prompt inteiro sob "user".
prompt_com_rodape="analise este consult anterior:
tokens used
999.999
por que custou tanto?"
out="$(run ok "$prompt_com_rodape" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *999.999*) echo "  FAIL  leu os tokens do ECO DO PROMPT, não do rodapé"; fail=1 ;;
  *"· 14.243 tokens)"*) echo "  ok    prompt com rodapé falso → vale o rodapé REAL" ;;
  *) echo "  FAIL  cabeçalho inesperado: $(cabecalho "$out")"; fail=1 ;;
esac
# o caso duro: o codex NÃO emite rodapé e o prompt tem um. Só a remoção do eco salva —
# ancorar no fim do stderr, sozinho, leria o número do prompt.
out="$(run ok_sem_tokens "$prompt_com_rodape" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *999.999*) echo "  FAIL  sem rodapé real, fabricou o número do prompt"; fail=1 ;;
  *"tokens ?"*) echo "  ok    sem rodapé real + prompt venenoso → '?'" ;;
  *) echo "  FAIL  cabeçalho inesperado: $(cabecalho "$out")"; fail=1 ;;
esac

# o caso extremo da camada de cauda: o prompt TERMINA no rodapé falso e o codex não emite
# rodapé nem warning depois — o eco é literalmente as duas últimas linhas do stderr. Ler pela
# posição, sozinho, publicaria 999.999 no PR como se o consult tivesse custado isso.
prompt_terminando_em_rodape="quanto custou o consult de ontem? o rodape dizia:
tokens used
999.999"
out="$(run ok_eco_no_fim "$prompt_terminando_em_rodape" 2>/dev/null)"
case "$(cabecalho "$out")" in
  *999.999*) echo "  FAIL  o ECO no fim do stderr virou o custo do consult"; fail=1 ;;
  *"tokens ?"*) echo "  ok    eco no fim do stderr → '?' (não confunde eco com rodapé)" ;;
  *) echo "  FAIL  cabeçalho inesperado: $(cabecalho "$out")"; fail=1 ;;
esac

# os segundos MEDEM (constante impressa passaria em tudo acima)
out="$(run ok_lento "x" 2>/dev/null)"; s_lento="$(segundos_do_cabecalho "$out")"
if [ -n "$s_lento" ] && [ "$s_lento" -ge 2 ]; then echo "  ok    execução de 2s → ${s_lento}s no cabeçalho (mede, não imprime constante)"
else echo "  FAIL  segundos='${s_lento:-vazio}' para execução de 2s"; fail=1; fi

# …e são os da TENTATIVA VENCEDORA, não a soma das tentativas (1ª dorme 4s e falha)
out="$(run ratelimit_lento "x" 2>/dev/null)"; s_retry="$(segundos_do_cabecalho "$out")"
if [ "$(invocacoes)" -ne 2 ]; then echo "  FAIL  invocações=$(invocacoes), esperava 2 (o caso não exercitou o retry)"; fail=1; fi
if [ -n "$s_retry" ] && [ "$s_retry" -lt 4 ]; then echo "  ok    retry: ${s_retry}s = tentativa vencedora (não somou os 4s da 1ª)"
else echo "  FAIL  segundos='${s_retry:-vazio}' — somou as tentativas em vez de medir a vencedora"; fail=1; fi
case "$(cabecalho "$out")" in
  *"· 2.222 tokens)"*) echo "  ok    …e os tokens são os da tentativa vencedora" ;;
  *) echo "  FAIL  tokens não são os da tentativa vencedora: $(cabecalho "$out")"; fail=1 ;;
esac

echo "── watchdog (execução travada) ──"
# -t 3, não -t 1: o stub conta a invocação na PRIMEIRA linha, mas sob swap (M2 8GB com
# vitest ao lado) o processo pode não ser escalonado a tempo e morrer antes de contar —
# visto 1× ao registrar esta suíte no CI, com invocações=2. O que se testa aqui é o
# watchdog matar e o kill contar como transitório, não a agilidade do escalonador.
run trava -t 3 "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 75 ]; then echo "  ok    exit $rc ≠ 0 (matou o processo travado)"
else echo "  FAIL  watchdog não matou (exit $rc)"; fail=1; fi
if [ "$(invocacoes)" -eq 3 ]; then echo "  ok    esgotou as 3 tentativas"
else echo "  FAIL  invocações=$(invocacoes), esperava 3"; fail=1; fi

echo "── watchdog: o sleep interno não pode VAZAR ──"
# `kill "$watchdog"` mata o SUBSHELL, não o `sleep` de dentro dele: o sleep é reparentado
# para o init e sobrevive o TIMEOUT INTEIRO (1200s no default). Cada invocação do wrapper
# deixava um processo vivo por 20min — esta suíte sozinha deixava 42, e a M2 do founder
# chegou a 921 com kern.maxproc=2000. Passando desse teto TODO `fork` falha, e o vermelho
# que sai daí se DISFARÇA de asserção frouxa (medido 2026-09-20).
# Timeout grande DE PROPÓSITO (≠ o `-t 3` do caso `trava`): se vazar, o sleep ainda tem de
# estar VIVO na hora de contar — com `-t 3` ele já teria morrido sozinho e o caso seria cego.
T_VAZ=977   # valor distintivo: nada mais nesta máquina roda `sleep 977`
pids_sleep() { # T → PIDs cujo comando é EXATAMENTE `sleep T`
  ps -A -o pid=,args= 2>/dev/null | sed -n "s/^ *\([0-9][0-9]*\)  *sleep $1\$/\1/p"
}
novos_sleep() { # T arquivo-da-base → PIDs de `sleep T` que NÃO estavam na base
  pids_sleep "$1" | fora_da_base "$2"
}
# Sonda do MEDIDOR, fail-CLOSED e PONTA A PONTA: prova que a cadeia inteira (pids_sleep +
# fora_da_base) isola um sleep NOVO nas DUAS formas de base — VAZIA (máquina limpa, o caso
# comum) e POVOADA com ≥2 linhas. Cada versão anterior deste medidor era cega numa delas, e a
# sonda de então só exercitava a forma que tinha mordido por último: um medidor cego devolve
# lista vazia, e "não consigo medir" vira "não vazou" (sonda-ausente-em-script-que-apaga.md).
visivel() { # T pid… → 0 quando `ps` já enxerga TODOS (teto de 2s: `ps` não vê o filho no fork)
  local t="$1" p; shift
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    for p in "$@"; do pids_sleep "$t" | grep -qx "$p" || { sleep 0.2; continue 2; }; done
    return 0
  done
  return 1
}
isola() { # T base novo [velho…] → 0 quando o novo sai e NENHUM velho sai
  local t="$1" base="$2" novo="$3" achou v; shift 3
  achou="$(novos_sleep "$t" "$base")"
  printf '%s\n' "$achou" | grep -qx "$novo" || return 1
  for v in "$@"; do printf '%s\n' "$achou" | grep -qx "$v" && return 1; done
  return 0
}
# forma 1 — base VAZIA (arquivo existe e não tem linha nenhuma)
: > "$tmp/base_sonda_vazia"
sleep "$T_VAZ" & sonda_nova=$!
if visivel "$T_VAZ" "$sonda_nova" && isola "$T_VAZ" "$tmp/base_sonda_vazia" "$sonda_nova"; then
  echo "  ok    o medidor isola um sleep NOVO com a base VAZIA (sonda $sonda_nova)"
else
  echo "  FAIL [medidor-cego]  base VAZIA: a medição não achou o sleep novo — o caso abaixo seria verde por CEGUEIRA"; fail=1
fi
kill "$sonda_nova" 2>/dev/null; wait "$sonda_nova" 2>/dev/null
# forma 2 — base POVOADA com 2 linhas
sleep "$T_VAZ" & sonda_a=$!
sleep "$T_VAZ" & sonda_b=$!
visivel "$T_VAZ" "$sonda_a" "$sonda_b"; povoou=$?
pids_sleep "$T_VAZ" > "$tmp/base_sonda"
sleep "$T_VAZ" & sonda_nova=$!
if [ "$povoou" -eq 0 ] && visivel "$T_VAZ" "$sonda_nova" \
   && isola "$T_VAZ" "$tmp/base_sonda" "$sonda_nova" "$sonda_a" "$sonda_b"; then
  echo "  ok    o medidor isola um sleep NOVO com a base POVOADA (sondas $sonda_a/$sonda_b → $sonda_nova)"
else
  echo "  FAIL [medidor-cego]  base POVOADA: a medição não isolou o sleep novo — o caso abaixo seria verde por CEGUEIRA"; fail=1
fi
kill "$sonda_a" "$sonda_b" "$sonda_nova" 2>/dev/null
wait "$sonda_a" "$sonda_b" "$sonda_nova" 2>/dev/null

pids_sleep "$T_VAZ" > "$tmp/base_vaz"
run ok -t "$T_VAZ" "x" >/dev/null 2>&1
# mesmo teto + mesmo ramo explícito. A folga só cobre a latência do sinal: se VAZOU, o sleep
# fica vivo 977s e nenhum teto de 2s o faria sumir.
novos_vaz=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  novos_vaz="$(novos_sleep "$T_VAZ" "$tmp/base_vaz")"
  [ -n "$novos_vaz" ] || break
  sleep 0.2
done
if [ -z "$novos_vaz" ]; then
  echo "  ok    nenhum 'sleep $T_VAZ' sobreviveu à invocação"
else
  echo "  FAIL [watchdog-sleep-vazado]  $(printf '%s\n' "$novos_vaz" | grep -c .) processo(s) 'sleep $T_VAZ' sobreviveram ao wrapper"
  fail=1
  # o próprio teste não pode poluir a máquina que ele acusa (um FAIL deixaria 977s de lixo)
  printf '%s\n' "$novos_vaz" | xargs kill 2>/dev/null
fi

echo "── stdin: é do WRAPPER, nunca do codex ──"
# `codex exec` com stdin em pipe LÊ o pipe (bloco `<stdin>`). Com o pipe do chamador ABERTO — o
# harness do Claude chama assim, em background — a leitura não termina e a consulta só morre no
# watchdog, 20min depois, sem parecer. O wrapper NÃO sofre disso, mas por uma regra IMPLÍCITA:
# job assíncrono (`&`) sem redirecionamento de entrada recebe /dev/null no stdin (POSIX, shell
# sem job control). Medido em 21/09 com o prompt por ARGUMENTO e o pipe aberto por 25s: o stub
# fiel leu 0 bytes e o wrapper respondeu em 0s. Este caso fixa o invariante — um refactor que
# tirasse o `&` (ou redirecionasse a entrada do job) traria o travamento de volta EM SILÊNCIO,
# e nenhum outro caso roda com o stdin aberto (todos passam `</dev/null`).
# FIFO com um escritor vivo no fd 7: ler dele BLOQUEIA (sem EOF), igual ao pipe do harness.
rm -f "$tmp/fifo_stdin"; mkfifo "$tmp/fifo_stdin"
exec 7<>"$tmp/fifo_stdin"
out="$(run_herda_stdin ok_le_stdin -t 3 "x" <"$tmp/fifo_stdin" 2>/dev/null)"; rc=$?
exec 7>&-   # fecha o escritor: um `cat` órfão do vermelho recebe EOF e sai (não vaza)
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "parecer: aprovado"; then
  echo "  ok    pipe do chamador ABERTO + prompt por argumento → parecer (o codex não herdou o stdin)"
else
  echo "  FAIL [stdin-herdado]  exit $rc sem parecer — o codex herdou o pipe aberto do chamador e travou lendo"; fail=1
fi

echo "── sensor de SALDO da cota (preflight) ──"
# Rollout sintético no layout real: <home>/sessions/AAAA/MM/DD/rollout-<ISO>-<id>.jsonl.
# O nome carrega o timestamp, então a ordem lexicográfica É a cronológica — é disso que o
# sensor depende (nada de `ls -t`/`stat`, que divergem entre BSD e GNU).
mk_rollout() { # home dia hora corpo
  local d="$tmp/$1/sessions/2026/09/$2"
  mkdir -p "$d"
  printf '%s\n' "$4" > "$d/rollout-2026-09-$2T$3-00-00-0000aaaa.jsonl"
}
novo_home() { mkdir -p "$tmp/$1"; : > "$tmp/$1/auth.json"; }   # auth vazio basta: o preflight só exige o arquivo
run_saldo() { # home teto modo args...
  local home="$1" teto="$2" mode="$3"; shift 3
  : > "$tmp/count"; : > "$tmp/args"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/$home" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_STUB_ARGS="$tmp/args" LC_ALL="${LC_ALL:-C}" CODEX_ASYNC_TETO_SALDO="$teto" CODEX_ASYNC_BACKOFFS="0 0 0" bash "$ASYNC" "$@" </dev/null
}
limites() { printf '{"rate_limits":{"primary":{"used_percent":%s,"window_minutes":10080,"resets_at":%s}}}' "$1" "$2"; }
futuro=$(( $(date +%s) + 86400 ))
passado=$(( $(date +%s) - 86400 ))

novo_home codexhome_alto;  mk_rollout codexhome_alto  14 10 "$(limites 94.0 "$futuro")"
run_saldo codexhome_alto 85 ok "x" >/dev/null 2>&1
caso_exit "saldo 94% ≥ teto 85 → 79" 79 $?
# A asserção que dá sentido ao sensor: recusar SEM gastar a chamada. Sem ela, um 79 emitido
# depois de chamar o codex passaria no teste e não pouparia cota nenhuma.
if [ "$(invocacoes)" -eq 0 ]; then echo "  ok    …e NÃO gastou a chamada (0 invocações)"
else echo "  FAIL  gastou $(invocacoes) invocação(ões) — o sensor não poupou nada"; fail=1; fi

novo_home codexhome_baixo; mk_rollout codexhome_baixo 14 10 "$(limites 12.0 "$futuro")"
run_saldo codexhome_baixo 85 ok "x" >/dev/null 2>&1
caso_exit "saldo 12% < teto → consulta segue" 0 $?

# (a) `primary":null` é AUSÊNCIA de leitura, não saldo zero. Se o padrão casasse null, o
# sensor leria "0%" e aprovaria tudo — falha ABERTA, do jeito que ninguém vê.
novo_home codexhome_null; mk_rollout codexhome_null 14 10 '{"rate_limits":{"primary":null,"plan_type":"prolite"}}'
saida="$(run_saldo codexhome_null 85 ok "x" 2>&1)"; rc=$?
caso_exit "primary:null → degrada e segue (não vira 0%)" 0 "$rc"
if printf '%s' "$saida" | grep -q "SALDO_DESCONHECIDO"; then echo "  ok    …e DIZ que não mediu (degradar não é silenciar)"
else echo "  FAIL  degradou calado — ausência virou aprovação"; fail=1; fi

# (b) leitura obsoleta: 100% de uma janela JÁ vencida não pode trancar a janela nova.
novo_home codexhome_velho; mk_rollout codexhome_velho 14 10 "$(limites 100.0 "$passado")"
run_saldo codexhome_velho 85 ok "x" >/dev/null 2>&1
caso_exit "reset no passado → leitura obsoleta, segue" 0 $?

# (d) o ponto cego que só o teste ao vivo pegou: a sessão que BATE na parede não recebe
# medidor. Com a cota estourada os rollouts mais recentes são todos falhas, e o sensor
# precisa enxergar ATRÁS deles — senão fica cego justamente quando importa.
novo_home codexhome_cego
mk_rollout codexhome_cego 14 10 "$(limites 97.0 "$futuro")"
mk_rollout codexhome_cego 18 19 '{"error":{"type":"usage_limit_exceeded"},"rate_limits":{"primary":null}}'
run_saldo codexhome_cego 85 ok "x" >/dev/null 2>&1
caso_exit "rollout recente sem medidor → acha o anterior → 79" 79 $?

run_saldo codexhome_alto 0 ok "x" >/dev/null 2>&1
caso_exit "CODEX_ASYNC_TETO_SALDO=0 desliga o sensor" 0 $?

echo "── fan-out multi-agente: 1 invocação = 1 execução cobrada ──"
# O defeito (medido 2026-09-20 sobre ~/.codex/sessions de 04–18/09): o codex-cli 0.153.4 dá ao
# modelo `spawn_agent` com 4 slots de concorrência, e nos prompts adversariais do ritual ele
# abria a revisão em até 3 threads irmãs — cada uma com o contexto inteiro replicado e COBRADA
# à parte. 25 das 167 consultas (15%) geraram 40 threads de subagente = 22,4% dos tokens do mês.
# Duas camadas, medidas separadamente porque uma NÃO cobre a outra:
#   (1) o teto de 1 slot, que fecha a porta — mas só na versão do CLI que conhece a chave;
#   (2) o sensor por FORA do flag, que conta o rastro em disco e grita se a porta reabrir.
# ⚠️ Os casos (2)/(4) abaixo são o CONTROLE VERDE da mesma leva: sem eles, um alarme
# sempre-ligado (ou sempre-desligado) passaria por sensor.

# (1) o teto viaja NA invocação — não basta existir no comentário
run ok "pergunta qualquer" >/dev/null 2>&1
# âncora nas bordas: a substring crua deixaria `=10` passar por `=1`, e não provaria
# que a chave veio no par `-c <chave>` (achado da 2ª opinião).
if grep -qE -- '(^| )-c features\.multi_agent_v2\.max_concurrent_threads_per_session=1( |$)' "$tmp/args"
then echo "  ok    o teto de 1 slot viaja na invocação do codex"
else echo "  FAIL [teto-ausente]  a invocação NÃO carrega o teto multi-agente — o fan-out volta"; fail=1; fi

# Um "não apareceu alarme" só vale se a consulta ACONTECEU. Sem esta prova positiva, um
# preflight que aborta com exit 77 faz TODOS os controles imprimirem ok (verificado pela 2ª
# opinião em 2026-09-20: os três passavam com fail=0 quando a consulta nem rodava).
consulta_aconteceu() { # rc saida rotulo → 0 se houve parecer de verdade
  local rc="$1" saida="$2" rot="$3" ok=0
  [ "$rc" -eq 0 ] || { echo "  FAIL [controle-sem-consulta]  $rot: exit $rc — a consulta não rodou"; ok=1; }
  printf '%s' "$saida" | grep -q '=== PARECER CODEX' \
    || { echo "  FAIL [controle-sem-consulta]  $rot: sem cabeçalho PARECER CODEX"; ok=1; }
  [ "$(invocacoes)" -ge 1 ] \
    || { echo "  FAIL [controle-sem-consulta]  $rot: 0 invocações do stub"; ok=1; }
  return "$ok"
}

# (2) CONTROLE: com a consulta comprovadamente feita e nenhum subagente no disco, nada de
# alarme — senão o sensor é sempre-vermelho e aprova qualquer sabotagem.
saida="$(run ok "pergunta qualquer" 2>&1)"; rc=$?
if consulta_aconteceu "$rc" "$saida" "controle sem subagente"
then echo "  ok    a consulta do controle rodou de verdade (exit 0 · parecer · stub chamado)"
else fail=1; fi
if printf '%s' "$saida" | grep -q 'FAN_OUT'
then echo "  FAIL [fanout-sempre-vermelho]  alarme de fan-out disparou SEM subagente nenhum"; fail=1
else echo "  ok    …e sem subagente não houve alarme"; fi
if printf '%s' "$saida" | grep -q 'subagente(s)'
then echo "  FAIL [fanout-fora-do-cabecalho]  cabeçalho anunciou subagentes que não existiram"; fail=1
else echo "  ok    …e o cabeçalho não inventa subagente"; fi

# (3) o defeito reproduzido: nasceu um rollout de subagente NESTA cwd durante a chamada
saida="$(run ok_spawna "pergunta qualquer" 2>&1)"; rc=$?
caso_exit "fan-out não derruba a consulta (o parecer ainda vale)" 0 "$rc"
if printf '%s' "$saida" | grep -q 'FAN_OUT: o codex abriu 1 thread'
then echo "  ok    o sensor VIU a thread de subagente e disse o número"
else echo "  FAIL [fanout-silencioso]  o fan-out passou EM SILÊNCIO — é assim que 22% da cota some sem dono"; fail=1; fi
# ⚠️ o que isto prova é a CONTAGEM de filhos, não os tokens deles: o wrapper não lê métrica
# nenhuma desses rollouts. Dizer "o custo real" seria conclusão maior que a asserção.
if printf '%s' "$saida" | grep -q '1 subagente(s)'
then echo "  ok    …e a CONTAGEM chegou ao cabeçalho que vai pro PR"
else echo "  FAIL [fanout-fora-do-cabecalho]  cabeçalho omitiu o fan-out — o PR registraria um custo falso"; fail=1; fi

# (4) o terceiro estado: sem `sessions/` não dá para medir — e isso se DIZ, não se
# arredonda para zero (ausência ≠ zero; um CODEX_HOME apontado para o lugar errado
# devolveria "nenhum subagente" para sempre).
mkdir -p "$tmp/codexhome_semsessions"; : > "$tmp/codexhome_semsessions/auth.json"
saida="$(run_home codexhome_semsessions ok "pergunta qualquer" 2>&1)"; rc=$?
if consulta_aconteceu "$rc" "$saida" "sem sessions/"; then :; else fail=1; fi
if printf '%s' "$saida" | grep -q 'FAN_OUT_DESCONHECIDO'
then echo "  ok    sem sessions/ → diz que não mediu (não finge zero)"
else echo "  FAIL [fanout-fingiu-zero]  degradou calado — ausência de medida virou 'sem fan-out'"; fail=1; fi
if printf '%s' "$saida" | grep -q '? subagente(s)'
then echo "  ok    …e o cabeçalho leva o '?' pro PR"
else echo "  FAIL [fanout-fingiu-zero]  cabeçalho escondeu que o sensor não mediu"; fail=1; fi

# (5) CONTROLE do filtro por cwd: ~/.codex/sessions é compartilhado entre worktrees.
# Sem este caso, contar QUALQUER subagente passaria — e acusaria o vizinho.
saida="$(run ok_spawna_alheio "pergunta qualquer" 2>&1)"; rc=$?
if consulta_aconteceu "$rc" "$saida" "cwd alheio"; then :; else fail=1; fi
alheio="$tmp/codexhome_ok/sessions/2026/09/20/rollout-2026-09-20T00-00-00-alheio.jsonl"
if [ -s "$alheio" ]; then echo "  ok    o fixture do vizinho NASCEU (o filtro foi mesmo exercido)"
else echo "  FAIL [controle-sem-consulta]  cwd alheio: o fixture não existe — 'sem alarme' não prova filtro"; fail=1; fi
if printf '%s' "$saida" | grep -q 'FAN_OUT'
then echo "  FAIL [fanout-cwd-alheia]  contou subagente de OUTRA worktree — alarme culpa o vizinho"; fail=1
else echo "  ok    subagente de outra cwd não conta (sessions é compartilhado)"; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
