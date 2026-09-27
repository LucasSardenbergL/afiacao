#!/usr/bin/env bash
# test-codex-async-nuvem.sh — TDD do scripts/codex-async.sh na SESSÃO CLOUD (CLAUDE_CODE_REMOTE=true),
# com codex, npm e curl STUBADOS (sem rede, sem quota, sem instalar nada de verdade).
#
# Contrato testado:
#   · codex ausente NA NUVEM → instala via npm (`install -g @openai/codex`) e segue; npm que falha
#     → 69 (a prova é o binário no PATH, não o exit do npm); FORA da nuvem nunca instala (no Mac o
#     dono é o brew); codex presente → não reinstala;
#   · pré-voo de rede: 403 do proxy no CONNECT (exit 56 + a frase do curl 8.x ou 7.x) → 68 SEM
#     chamar o codex; qualquer outro desfecho da sonda (56 sem a frase, curl quebrado, curl
#     ausente) SEGUE, mas diz REDE_NAO_MEDIDA; o host sondado segue o modo de auth (chave →
#     api.openai.com, auth.json → chatgpt.com); fora da nuvem a sonda não roda;
#   · CONNECT 403 no MEIO da consulta → 68 na 1ª tentativa, nunca transitório; e a mesma frase
#     citada no PROMPT (o codex ecoa o prompt no stderr) não decide nada.
# Suíte separada da test-codex-async.sh de propósito: lá a falsificação roda a suíte INTEIRA (~17s)
# por sabotagem × 2 locales, e o job gates-e-falsificacao já usava 16,5 dos 25 min do teto (run
# 36326777222, 2026-09-27). Aqui uma rodada custa poucos segundos.
#
# Uso: bash scripts/test-codex-async-nuvem.sh              (exit 0 = tudo verde)
#      bash scripts/test-codex-async-nuvem.sh --falsificar (sabota o wrapper; exige vermelho pela marca)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# CODEX_ASYNC_ALVO: a CÓPIA (de controle ou sabotada) que o `--falsificar` serve — nunca o versionado.
ASYNC="${CODEX_ASYNC_ALVO:-$here/codex-async.sh}"

# ── modo falsificação ───────────────────────────────────────────────────────
# Mesmo protocolo da test-codex-async.sh: CONTROLE verde na MESMA invocação, uma camada sabotada
# por vez numa CÓPIA, vermelho exigido PELA MARCA (ASCII, caixa fixa) nos DOIS locales
# (docs/historico/falsificacao-sem-linha-de-base.md).
if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (sabota o WRAPPER na nuvem; exige vermelho pela marca certa, 2 locales) ==\n'
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
  suite() { # alvo locale → $saida_suite/$rc_suite (MESMA invocação do laço; só o alvo muda)
    saida_suite="$(LC_ALL="$2" CODEX_ASYNC_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?
  }

  # CONTROLE primeiro: sem linha de base verde, um arnês sempre-vermelho aprova TODA sabotagem.
  for loc in C "$utf8"; do
    suite "$original" "$loc"
    if [ "$rc_suite" -eq 0 ]; then printf '  ok    controle verde (locale %s)\n' "$loc"
    else printf '  FAIL [controle-vermelho]  a suite ja falha SEM sabotagem (locale %s, exit %s)\n' "$loc" "$rc_suite"
         grep -m3 'FAIL' <<< "$saida_suite"; falhas=1; fi
  done
  [ "$falhas" -eq 0 ] || { echo "FALSIFICACAO ABORTADA: sem controle verde nada abaixo tem valor."; exit 1; }

  sabotar() { # id  marca-esperada  DE  PARA — troca LITERAL; o DE tem de existir exatamente 1 vez
    local id="$1" marca="$2" alvo="$fals/$1.sh"
    cp "$original" "$alvo"
    ALVO="$alvo" DE="$3" PARA="$4" python3 -c '
import io,os,sys
p=os.environ["ALVO"]; de=os.environ["DE"]; para=os.environ["PARA"]
s=io.open(p,encoding="utf-8").read()
if s.count(de)!=1: sys.exit(1)
io.open(p,"w",encoding="utf-8").write(s.replace(de,para))' \
      || { printf '  FAIL [%s]  a sabotagem nao pegou no arquivo (alvo ausente ou repetido)\n' "$id"; falhas=1; return; }
    bash -n "$alvo" 2>/dev/null || { printf '  FAIL [%s]  sabotagem quebrou a SINTAXE (vermelho por crash nao prova nada)\n' "$id"; falhas=1; return; }
    for loc in C "$utf8"; do
      suite "$alvo" "$loc"
      if [ "$rc_suite" -eq 0 ]; then
        printf '  FAIL [%s]  sabotagem passou VERDE (locale %s) — a camada nao esta coberta\n' "$id" "$loc"; falhas=1
      elif grep -qF "FAIL [$marca]" <<< "$saida_suite"; then
        printf '  ok    [%s] vermelho pela marca FAIL [%s] (locale %s)\n' "$id" "$marca" "$loc"
      else
        printf '  FAIL [%s]  vermelho pelo motivo ERRADO (locale %s): faltou FAIL [%s]. Veio:\n' "$id" "$loc" "$marca"
        grep -m3 'FAIL' <<< "$saida_suite" | sed 's/^/        /'
        falhas=1
      fi
    done
  }

  # shellcheck disable=SC2016  # DE/PARA são TEXTO do wrapper: os `$...` têm de chegar literais.
  {
  # (1) o pré-voo acha o bloqueio mas não sai: o codex roda contra a rede negada (o ~1h de volta)
  sabotar preflight_mudo rede-bloqueada-nao-detectada \
    '        exit 68' '        :  # sabotado'
  # (2) prova fraca: qualquer exit != 0 do curl vira "bloqueado" (o guard tranca sem prova)
  sabotar prova_fraca preflight-bloqueou-sem-prova \
    '[ "$1" -eq 56 ] && grep -qE' '[ "$1" -ne 0 ] || grep -qE'
  # (3) sonda inconclusiva engolida calada
  sabotar aviso_mudo rede-nao-medida-silenciosa \
    'echo "REDE_NAO_MEDIDA: a sonda de $host_rede' ': "REDE_NAO_MEDIDA: a sonda de $host_rede'
  # (4) host fixo: o login ChatGPT seria sondado no host da chave de API
  sabotar host_fixo host-errado-no-preflight \
    'else hosts_rede=(chatgpt.com auth.openai.com); fi' 'else hosts_rede=(api.openai.com); fi'
  # (5) o classificador perde o 403: vira transitório (rc≥124 do watchdog) → 3 tentativas
  sabotar sem_classificador_403 proxy403-virou-transitorio \
    "if classifica 'HTTP CONNECT failed with status 403" "if false && classifica 'HTTP CONNECT failed with status 403"
  # (6) o 403 é lido no stderr CRU: o eco do prompt passa a decidir o fluxo
  sabotar eco_decide eco-decidiu-rede \
    "if classifica 'HTTP CONNECT failed with status 403|CONNECT tunnel failed, response 403'; then" \
    "if grep -qiE 'HTTP CONNECT failed with status 403|CONNECT tunnel failed, response 403' \"\$err\"; then"
  # (7) sem a instalação: o container novo segue sem codex (o defeito de 2026-09-27)
  sabotar sem_autoinstalacao nuvem-sem-autoinstalacao \
    'if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && ! command -v codex' 'if false && ! command -v codex'
  # (8) instala em qualquer lugar: no Mac, um 2º codex por baixo do brew
  sabotar autoinstala_fora_da_nuvem instalou-fora-da-nuvem \
    'if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && ! command -v codex' 'if ! command -v codex'
  # (9) o pré-voo roda fora da nuvem (a 1ª linha do bloco, ancorada na seguinte para ser única)
  sabotar preflight_fora_da_nuvem preflight-fora-da-nuvem \
    $'if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then\n  if [ -n "${CODEX_API_KEY:-}' \
    $'if true; then\n  if [ -n "${CODEX_API_KEY:-}'
  }

  echo
  if [ "$falhas" -eq 0 ]; then echo "PASS — toda sabotagem ficou vermelha pela marca certa"; else echo "FALHOU"; fi
  exit "$falhas"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/bin_curl" "$tmp/bin_npm_ok" "$tmp/bin_npm_falha" "$tmp/instalado" \
  "$tmp/home_chave/sessions" "$tmp/home_chatgpt/sessions" "$tmp/home_vazio"
: > "$tmp/home_chatgpt/auth.json"

# stub de codex: só o que o wrapper lê do real (medido 2026-09-27, codex-cli 0.157.1)
cat > "$tmp/bin/codex" <<'STUB'
#!/bin/sh
echo x >> "$CODEX_STUB_COUNT"
for a in "$@"; do prompt="$a"; done
# o stderr real ECOA o prompt sob "user" antes de qualquer erro — é o que envenena a leitura crua
{ echo "OpenAI Codex v0.157.1"; echo "--------"; echo "user"; printf '%s\n' "$prompt"; } >&2
case "$CODEX_STUB_MODE" in
  ok) echo "parecer: aprovado"; printf 'tokens used\n1.000\n' >&2; exit 0 ;;
  # rede negada, texto LITERAL medido 2026-09-27 contra o proxy da sessão cloud. O codex real NÃO
  # sai: trava em "Reconnecting..." até o watchdog matar — 143 (TERM) é o rc que o wrapper vê.
  proxy403)
    echo "2026-09-27T15:38:40.562255Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: URL error: Proxy connection failed: HTTP CONNECT failed with status 403, url: wss://api.openai.com/v1/responses" >&2
    echo "warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion: URL error: Proxy connection failed: HTTP CONNECT failed with status 403" >&2
    echo "ERROR: Reconnecting... waiting for network" >&2
    exit 143 ;;
  # 1ª tentativa 429 (transitório DE VERDADE), a 2ª responde
  ratelimit) n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
    if [ "$n" -ge 2 ]; then echo "parecer pos-retry"; exit 0
    else echo "429 rate limit exceeded" >&2; exit 1; fi ;;
  *) echo "modo desconhecido: $CODEX_STUB_MODE" >&2; exit 1 ;;
esac
STUB

# npm que "instala": copia o stub do codex para um dir do PATH (é o efeito que o wrapper confere)
cat > "$tmp/bin_npm_ok/npm" <<'STUB'
#!/bin/sh
echo x >> "$NPM_STUB_COUNT"
printf '%s\n' "$*" >> "$NPM_STUB_ARGS"
cp "$CODEX_STUB_FONTE" "$NPM_STUB_DESTINO/codex" && chmod +x "$NPM_STUB_DESTINO/codex"
STUB
cat > "$tmp/bin_npm_falha/npm" <<'STUB'
#!/bin/sh
echo x >> "$NPM_STUB_COUNT"
printf '%s\n' "$*" >> "$NPM_STUB_ARGS"
echo "npm ERR! code E403" >&2
exit 1
STUB

cat > "$tmp/bin_curl/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$CURL_STUB_ARGS"
case "$CURL_STUB_MODE" in
  # frase LITERAL do curl 8.5.0 contra o proxy da sessão cloud (medido 2026-09-27)
  bloqueado)    echo "curl: (56) CONNECT tunnel failed, response 403" >&2; exit 56 ;;
  # a mesma negação na frase do curl 7.x
  bloqueado_7x) echo "curl: (56) Received HTTP code 403 from proxy after CONNECT" >&2; exit 56 ;;
  # exit 56 SEM a frase do proxy (conexão resetada): não é prova de bloqueio
  reset)        echo "curl: (56) Recv failure: Connection reset by peer" >&2; exit 56 ;;
  # presente-porém-quebrado: sai na hora sem medir nada
  quebrado)     echo "curl: option --max-time: is badly used here" >&2; exit 2 ;;
  # o host respondeu (qualquer status HTTP): o túnel está aberto
  livre)        exit 0 ;;
  *)            echo "modo desconhecido: $CURL_STUB_MODE" >&2; exit 99 ;;
esac
STUB
chmod +x "$tmp/bin/codex" "$tmp/bin_npm_ok/npm" "$tmp/bin_npm_falha/npm" "$tmp/bin_curl/curl"

fail=0
# Ambiente CONTROLADO: `env -i` porque esta suíte roda DENTRO de sessões cloud, onde
# CLAUDE_CODE_REMOTE=true e HTTPS_PROXY existem de verdade — nada disso pode vazar para o caso.
# O dir do curl-stub vai em TODO PATH (antes do /usr/bin): se uma sabotagem ligar o pré-voo onde
# ele não devia rodar, bate no stub, nunca na rede real.
roda() { # remoto("true"|"") PATH-extra home chave curl_modo codex_modo → args do wrapper
  local remoto="$1" pext="$2" home="$3" chave="$4" cmodo="$5" modo="$6" curl_bin=curl; shift 6
  [ "$cmodo" = ausente ] && curl_bin="$tmp/nao-existe/curl"
  : > "$tmp/count"; : > "$tmp/npm_count"; : > "$tmp/npm_args"; : > "$tmp/curl_args"
  env -i PATH="$pext:$tmp/bin_curl:/usr/bin:/bin" HOME="$tmp" TMPDIR="$tmp" LC_ALL="${LC_ALL:-C}" \
    CLAUDE_CODE_REMOTE="$remoto" CODEX_HOME="$tmp/$home" CODEX_API_KEY="$chave" \
    CODEX_ASYNC_CURL="$curl_bin" CODEX_ASYNC_BACKOFFS="0 0 0" CODEX_ASYNC_TETO_SALDO=0 \
    CODEX_STUB_MODE="$modo" CODEX_STUB_COUNT="$tmp/count" \
    CURL_STUB_MODE="$cmodo" CURL_STUB_ARGS="$tmp/curl_args" \
    NPM_STUB_COUNT="$tmp/npm_count" NPM_STUB_ARGS="$tmp/npm_args" \
    CODEX_STUB_FONTE="$tmp/bin/codex" NPM_STUB_DESTINO="$tmp/instalado" \
    bash "$ASYNC" "$@" </dev/null
}
linhas() { wc -l < "$1" | tr -d ' '; }
# Um "não alarmou" só vale se a consulta ACONTECEU (lição da 2ª opinião de 2026-09-20 na suíte
# irmã: um wrapper que aborta cedo faz todo controle de ausência imprimir ok).
consulta_ok() { # rc saida rotulo → 0 se houve parecer de verdade
  local ok=0
  [ "$1" -eq 0 ] || { echo "  FAIL [controle-sem-consulta]  $3: exit $1 — a consulta não rodou"; ok=1; }
  grep -qF '=== PARECER CODEX' <<< "$2" || { echo "  FAIL [controle-sem-consulta]  $3: sem cabeçalho PARECER CODEX"; ok=1; }
  [ "$(linhas "$tmp/count")" -ge 1 ] || { echo "  FAIL [controle-sem-consulta]  $3: 0 invocações do stub"; ok=1; }
  if [ "$ok" -eq 0 ]; then echo "  ok    $3: a consulta rodou (exit 0 · parecer · stub chamado)"; fi
  return "$ok"
}
diz_que_nao_mediu() { # saida rotulo
  if grep -qF 'REDE_NAO_MEDIDA' <<< "$1"; then echo "  ok    …e diz que não mediu ($2)"
  else echo "  FAIL [rede-nao-medida-silenciosa]  $2: sonda inconclusiva engolida calada"; fail=1; fi
}

echo "── instalação na nuvem ──"
# sanidade do fixture: sem o npm-stub, o PATH mínimo NÃO acha codex nenhum — senão "instalou"
# sairia verde por acaso, com um codex de verdade em /usr/bin fazendo o papel do instalado.
if env -i PATH="$tmp/instalado:/usr/bin:/bin" sh -c 'command -v codex' >/dev/null 2>&1; then
  echo "  FAIL [fixture-codex-real]  há um codex de verdade em /usr/bin ou /bin — a instalação não é hermética"; fail=1
fi

rm -f "$tmp/instalado/codex"
roda true "$tmp/bin_npm_ok:$tmp/instalado" home_vazio "" livre ok "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 77 ] && [ "$(linhas "$tmp/npm_count")" -eq 1 ] && [ -x "$tmp/instalado/codex" ]; then
  echo "  ok    nuvem sem codex → instalou via npm (1x) e seguiu até o auth (77)"
else echo "  FAIL [nuvem-sem-autoinstalacao]  exit $rc, npm chamado $(linhas "$tmp/npm_count")x — o container novo fica sem codex"; fail=1; fi
if grep -qF -- 'install -g @openai/codex' "$tmp/npm_args"; then echo "  ok    …e instalou o pacote certo, global"
else echo "  FAIL [pacote-errado]  o npm recebeu: $(head -c 120 "$tmp/npm_args")"; fail=1; fi

rm -f "$tmp/instalado/codex"
saida="$(roda true "$tmp/bin_npm_falha:$tmp/instalado" home_vazio "" livre ok "x" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(linhas "$tmp/npm_count")" -eq 1 ] && grep -qF 'PREFLIGHT_FAIL: codex CLI' <<< "$saida"; then
  echo "  ok    npm que falha → 69 com a instrução (quem decide é o binário no PATH)"
else echo "  FAIL [npm-falhou-sem-69]  exit $rc, npm chamado $(linhas "$tmp/npm_count")x"; fail=1; fi

rm -f "$tmp/instalado/codex"
roda "" "$tmp/bin_npm_ok:$tmp/instalado" home_vazio "" livre ok "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 69 ] && [ "$(linhas "$tmp/npm_count")" -eq 0 ]; then
  echo "  ok    FORA da nuvem nunca instala (no Mac o dono é o brew) → 69"
else echo "  FAIL [instalou-fora-da-nuvem]  exit $rc, npm chamado $(linhas "$tmp/npm_count")x"; fail=1; fi

# CONTROLE da leva: nuvem, codex presente, rede livre → a consulta roda e nada alarma
saida="$(roda true "$tmp/bin:$tmp/bin_npm_ok" home_chave chave-falsa livre ok "pergunta" 2>&1)"; rc=$?
consulta_ok "$rc" "$saida" "nuvem, codex presente, rede livre" || fail=1
if [ "$(linhas "$tmp/npm_count")" -eq 0 ]; then echo "  ok    …e com o codex no PATH não reinstala"
else echo "  FAIL [reinstalou-codex-presente]  npm chamado com o codex já no PATH"; fail=1; fi
if grep -qF 'REDE_' <<< "$saida"; then echo "  FAIL [rede-alarme-falso]  rede livre e mesmo assim alarmou"; fail=1
else echo "  ok    …e rede livre não alarma"; fi

echo "── pré-voo de rede ──"
saida="$(roda true "$tmp/bin" home_chave chave-falsa bloqueado ok "x" 2>&1)"; rc=$?
if [ "$rc" -eq 68 ] && [ "$(linhas "$tmp/count")" -eq 0 ] && grep -qF 'REDE_BLOQUEADA' <<< "$saida"; then
  echo "  ok    proxy nega o host → 68 na hora, SEM chamar o codex"
else echo "  FAIL [rede-bloqueada-nao-detectada]  exit $rc, codex chamado $(linhas "$tmp/count")x"; fail=1; fi
if grep -qF 'https://api.openai.com/' "$tmp/curl_args" && grep -qF 'api.openai.com' <<< "$saida"; then
  echo "  ok    …sondou e nomeou api.openai.com (modo chave de API)"
else echo "  FAIL [host-errado-no-preflight]  modo chave: sondou $(head -c 80 "$tmp/curl_args")"; fail=1; fi

roda true "$tmp/bin" home_chave chave-falsa bloqueado_7x ok "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 68 ]; then echo "  ok    a frase do curl 7.x também é prova → 68"
else echo "  FAIL [rede-bloqueada-curl-7x]  exit $rc com a negação na frase do curl 7.x"; fail=1; fi

saida="$(roda true "$tmp/bin" home_chatgpt "" bloqueado ok "x" 2>&1)"; rc=$?
primeira="$(head -1 "$tmp/curl_args")"
case "$primeira" in
  *https://chatgpt.com/*)
    if [ "$rc" -eq 68 ] && ! grep -qF 'api.openai.com/' "$tmp/curl_args"; then
      echo "  ok    login ChatGPT (auth.json) → sonda chatgpt.com, não api.openai.com → 68"
    else echo "  FAIL [host-errado-no-preflight]  modo auth.json: exit $rc, sondou também api.openai.com"; fail=1; fi ;;
  *) echo "  FAIL [host-errado-no-preflight]  modo auth.json sondou primeiro: $primeira"; fail=1 ;;
esac

saida="$(roda true "$tmp/bin" home_chave chave-falsa reset ok "pergunta" 2>&1)"; rc=$?
if [ "$rc" -eq 68 ]; then echo "  FAIL [preflight-bloqueou-sem-prova]  exit 56 SEM a frase do proxy virou bloqueio"; fail=1
else consulta_ok "$rc" "$saida" "curl exit 56 sem a frase do proxy" || fail=1; fi
diz_que_nao_mediu "$saida" "exit 56 sem a frase"

saida="$(roda true "$tmp/bin" home_chave chave-falsa quebrado ok "pergunta" 2>&1)"; rc=$?
if [ "$rc" -eq 68 ]; then echo "  FAIL [preflight-bloqueou-sem-prova]  curl quebrado (exit 2) virou bloqueio"; fail=1
else consulta_ok "$rc" "$saida" "curl presente-porém-quebrado" || fail=1; fi
diz_que_nao_mediu "$saida" "curl quebrado"

saida="$(roda true "$tmp/bin" home_chave chave-falsa ausente ok "pergunta" 2>&1)"; rc=$?
consulta_ok "$rc" "$saida" "sem curl" || fail=1
diz_que_nao_mediu "$saida" "sem curl"

saida="$(roda "" "$tmp/bin" home_chave chave-falsa bloqueado ok "pergunta" 2>&1)"; rc=$?
if [ "$(linhas "$tmp/curl_args")" -eq 0 ]; then consulta_ok "$rc" "$saida" "fora da nuvem a sonda não roda" || fail=1
else echo "  FAIL [preflight-fora-da-nuvem]  a sonda de rede rodou fora da nuvem (exit $rc)"; fail=1; fi

echo "── CONNECT 403 no meio da consulta ──"
saida="$(roda "" "$tmp/bin" home_chave chave-falsa livre proxy403 "pergunta" 2>&1)"; rc=$?
if [ "$rc" -eq 68 ] && [ "$(linhas "$tmp/count")" -eq 1 ] && grep -qF 'REDE_BLOQUEADA' <<< "$saida"; then
  echo "  ok    403 do proxy no meio → 68 na 1ª tentativa (não é transitório)"
else echo "  FAIL [proxy403-virou-transitorio]  exit $rc em $(linhas "$tmp/count") tentativa(s)"; fail=1; fi

saida="$(roda "" "$tmp/bin" home_chave chave-falsa livre ratelimit "diagnostique: HTTP CONNECT failed with status 403" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(linhas "$tmp/count")" -eq 2 ]; then
  echo "  ok    a frase do 403 citada no PROMPT não decide: 429 real → retry → parecer"
else echo "  FAIL [eco-decidiu-rede]  exit $rc em $(linhas "$tmp/count") tentativa(s) — o eco do prompt decidiu o fluxo"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
