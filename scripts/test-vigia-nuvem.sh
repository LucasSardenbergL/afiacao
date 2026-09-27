#!/usr/bin/env bash
# test-vigia-nuvem.sh — o aviso de sessão na NUVEM do SessionStart (.claude/hooks/vigia-nuvem.sh).
#
# Por quê: em 2026-09-27, "o Codex parou de funcionar" era troca de máquina. Sessões abertas como
# Cloud no app desktop rodavam num container sem codex, psql-ro, heavy e gstack, e o founder não
# percebeu (docs/historico/codex-em-sessao-cloud.md). O único sensor de boot na nuvem era o
# vigia-gstack.sh, que lá fala SÓ com o modelo — de propósito, para o gstack. Este sensor fala com
# o FOUNDER (systemMessage). A suíte prova que ele fala na nuvem e cala no Mac
# (docs/historico/aviso-sessao-nuvem.md).
#
# Três defeitos que uma suíte só de SAÍDA deixaria passar, e por isso têm caso próprio:
#   • o REGISTRO no .claude/settings.json — sensor que existe e ninguém liga nunca roda;
#   • o bit de EXECUÇÃO — o settings.json chama o hook direto, sem `bash`, e o Write cria 100644;
#   • o ENVELOPE (hookSpecificOutput.hookEventName) — sem ele o harness descarta a saída inteira,
#     systemMessage junto (medido no harness do app; docs/historico/aviso-sessao-nuvem.md).
# Pelo mesmo motivo a suíte executa o sensor DIRETO, como o harness, e não com `bash "$HOOK"`.
#
# CLAUDE_CODE_REMOTE é fixado em TODO caso (removido no do Mac): rodada numa sessão cloud, a
# variável vem herdada como "true" e o caso do Mac tomaria o ramo da nuvem.
#
# Uso: bash scripts/test-vigia-nuvem.sh               (exit 0 = verde · 1 = asserção · 2 = infra)
#      bash scripts/test-vigia-nuvem.sh --falsificar  (sabota CÓPIAS do sensor e do settings.json; exige vermelho)
#
# Marcadores ASCII de caixa fixa, casados com grep -F e sem -i; a falsificação roda nos DOIS
# locales (LC_ALL=C e um UTF-8 achado por sonda positiva), porque falsificar num só não prova (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="${VIGIA_NUVEM_HOOK:-$here/../.claude/hooks/vigia-nuvem.sh}"
SETTINGS="${VIGIA_NUVEM_SETTINGS:-$here/../.claude/settings.json}"

command -v jq >/dev/null 2>&1 || { echo "INFRA: jq ausente — nao da para conferir o envelope"; exit 2; }
[ -f "$HOOK" ] || { echo "INFRA: sensor nao encontrado em $HOOK"; exit 2; }
[ -f "$SETTINGS" ] || { echo "INFRA: settings.json nao encontrado em $SETTINGS"; exit 2; }

tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT

# ── falsificação ───────────────────────────────────────────────────────────────────────────────
# O CONTROLE é a MESMA invocação da sabotagem — cópias em $tmp, chmod +x, os dois overrides, o mesmo
# LC_ALL — com a sabotagem trocada por NADA, e roda antes de cada uma: uma suíte vermelha pelo
# mecanismo da cópia aprovaria todas as sabotagens sem provar nada
# (docs/historico/falsificacao-sem-linha-de-base.md). Cada sabotagem tem de sair com exit 1 E com
# FAIL no caso que ela mira — exit 2 é infra (não conta como detecção), e um FAIL em outro caso
# qualquer não prova que o caso-alvo tem dente. Nada aqui toca o repo: só cópias em $tmp.
if [ "${1:-}" = "--falsificar" ]; then
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "ABORTA — nenhum locale UTF-8 neste ambiente; metade da falsificacao nao rodaria."; exit 1
  fi

  falhas=0
  # preparar <dir> <onde> <sed-script> → $tmp/<dir>/{hook.sh,settings.json}.
  #   onde: nada (o controle) · hook · settings · mudo (sensor inteiro trocado por '{}') · sem-x.
  # Sai 1 quando a sabotagem não mudou nada: no-op não prova nada.
  preparar() {
    local d="$tmp/$1"
    mkdir -p "$d" || exit 2
    cp "$HOOK" "$d/hook.sh" && cp "$SETTINGS" "$d/settings.json" || exit 2
    case "$2" in
      hook)     sed "$3" "$HOOK" > "$d/hook.sh" ;;
      settings) sed "$3" "$SETTINGS" > "$d/settings.json" ;;
      mudo)     printf '#!/usr/bin/env bash\necho {}\n' > "$d/hook.sh" ;;
    esac
    chmod +x "$d/hook.sh"
    case "$2" in
      nada)     return 0 ;;
      sem-x)    chmod -x "$d/hook.sh"; [ ! -x "$d/hook.sh" ] ;;
      settings) ! cmp -s "$SETTINGS" "$d/settings.json" ;;
      *)        ! cmp -s "$HOOK" "$d/hook.sh" ;;
    esac
  }
  rodar_suite() {  # rodar_suite <dir> → define $saida e $rc
    saida="$(LC_ALL="$LOC" VIGIA_NUVEM_HOOK="$tmp/$1/hook.sh" VIGIA_NUVEM_SETTINGS="$tmp/$1/settings.json" \
      bash "$0" 2>&1)"; rc=$?
  }
  controle() {
    preparar "controle-$LOC" nada ''
    rodar_suite "controle-$LOC"
    if [ "$rc" -ne 0 ]; then
      printf 'ABORTA — controle SEM sabotagem ja esta VERMELHO (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\n%s\n' \
        "$LOC" "$rc" "$saida"
      exit 1
    fi
  }
  # sabotar <id> <caso-alvo> <descricao> <onde> <sed-script>
  sabotar() {
    if ! preparar "$1-$LOC" "$4" "$5"; then
      printf '  ❌ %s: a sabotagem nao mudou nada (alvo do sed sumiu do arquivo?) — no-op nao prova nada\n' "$1"
      falhas=$((falhas + 1)); return
    fi
    rodar_suite "$1-$LOC"
    if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$2]" >/dev/null; then
      printf '  ✅ %s %s -> vermelho em [%s] (LC_ALL=%s)\n' "$1" "$3" "$2" "$LOC"
    else
      printf '  ❌ %s %s: esperava exit 1 com FAIL [%s]; veio rc=%s\n%s\n' "$1" "$3" "$2" "$rc" "$saida"
      falhas=$((falhas + 1))
    fi
  }

  # shellcheck disable=SC2016  # o `$` é TEXTO do sensor que o sed casa, não expansão
  PREDICADO='\[ "\${CLAUDE_CODE_REMOTE:-}" != "true" \]'
  INCHADO='O container nasce do zero a cada sessao, sem o login do codex, sem a credencial do banco, sem o semaforo de RAM da M2 e sem as skills do gstack; o historico completo mora em docs/historico.'
  # shellcheck disable=SC2016  # os `$` dos scripts de sed são TEXTO do sensor a casar, não expansão
  for LOC in C "$utf8"; do
    printf '== falsificacao (LC_ALL=%s) ==\n' "$LOC"
    controle; sabotar S1  C5 'sensor mudo (sempre {})' mudo ''
    controle; sabotar S2  C3 'avisa em qualquer maquina' hook "s|$PREDICADO|false|"
    controle; sabotar S3  C3 'Mac vaza contexto (nao e mais {} exato)' hook \
      "s|echo '{}'|echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"vazou\"}}'|"
    controle; sabotar S4  C4 'envelope sem hookEventName (o harness descarta tudo, aviso junto)' hook 's|"hookEventName":"SessionStart",||g'
    controle; sabotar S5  C4 'stdout com um JSON a mais (o harness nao parseia dois)' hook 's|^printf |echo {}; printf |'
    controle; sabotar S6  C5 'aviso so para o modelo (o desenho do gstack na nuvem)' hook \
      's|"systemMessage":"%s",||; s|"\$msg" "\$ctx"|"$ctx"|'
    controle; sabotar S7  C5 'aviso sem a saida (abra como Local)' hook 's|abra como Local no app desktop|reabra a sessao|'
    controle; sabotar S8  C6 'contexto sem a marca SESSAO-NUVEM' hook 's|SESSAO-NUVEM|SESSAO|'
    controle; sabotar S9  C8 'predicado frouxo (qualquer valor conta como nuvem)' hook \
      "s|$PREDICADO|[ -z \"\${CLAUDE_CODE_REMOTE:-}\" ]|"
    controle; sabotar S10 C7 'aviso inchado' hook "s|abra como Local no app desktop\.|abra como Local no app desktop. $INCHADO|"
    controle; sabotar S11 C1 'settings.json sem o sensor' settings '/vigia-nuvem\.sh/d'
    controle; sabotar S12 C1 'sensor ligado no matcher errado' settings 's|"matcher": "startup"|"matcher": "resume"|'
    controle; sabotar S13 C2 'sensor sem bit de execucao' sem-x ''
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: cada caso-alvo reprova a sua sabotagem, nos 2 locales"; exit 0; fi
  echo "❌ falsificacao: $falhas sabotagem(ns) sem vermelho no caso-alvo"; exit 1
fi

# ── suíte ──────────────────────────────────────────────────────────────────────────────────────
fail=0
ok()   { printf '  ok   [%s] %s\n' "$1" "$2"; }
ruim() { printf '  FAIL [%s] %s\n' "$1" "$2"; fail=1; }

# O que o harness manda no stdin do SessionStart. O sensor não precisa, mas roda com ela.
ENTRADA='{"session_id":"teste","hook_event_name":"SessionStart","source":"startup"}'
# rodar <mac|valor de CLAUDE_CODE_REMOTE> → define $out e $rc. Executa DIRETO, como o harness.
rodar() {
  if [ "$1" = mac ]; then
    out="$(printf '%s' "$ENTRADA" | env -u CLAUDE_CODE_REMOTE "$HOOK" 2>/dev/null)"; rc=$?
  else
    out="$(printf '%s' "$ENTRADA" | CLAUDE_CODE_REMOTE="$1" "$HOOK" 2>/dev/null)"; rc=$?
  fi
}
sys() { printf '%s' "$out" | jq -r '.systemMessage // ""' 2>/dev/null; }
ctx() { printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null; }
tem() { printf '%s' "$1" | grep -F -- "$2" >/dev/null; }
vazio() { printf '%s' "$out" | jq -e '. == {}' >/dev/null 2>&1; }
# Contrato comum a TODA execução: exit 0, UM único valor JSON e objeto (dois JSONs no stdout o
# harness não parseia), e nunca uma decisão de permissão.
contrato() {
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -s -e 'length == 1 and (.[0] | type == "object")' >/dev/null 2>&1 \
     && ! tem "$out" 'permissionDecision' && ! tem "$out" '"decision"'; then
    return 0
  fi
  ruim "$1" "contrato quebrado (rc=$rc; esperava UM objeto JSON sem decisao de permissao): $out"; return 1
}

echo "── vigia-nuvem.sh ──"

# C1 ligado: o settings.json registra o sensor no SessionStart com matcher "startup".
if jq -e 'any(.hooks.SessionStart[]? | select(.matcher == "startup") | .hooks[]?;
              (.command // "") | contains("/.claude/hooks/vigia-nuvem.sh"))' "$SETTINGS" >/dev/null 2>&1; then
  ok C1 'ligado no SessionStart(startup) do settings.json'
else ruim C1 "o settings.json nao liga .claude/hooks/vigia-nuvem.sh no SessionStart com matcher startup"; fi

# C2 executável: o settings.json chama o sensor sem `bash` na frente — sem o bit, 126 no boot.
if [ -x "$HOOK" ]; then ok C2 'executavel (o settings.json o chama direto)'
else ruim C2 "sem bit de execucao: o harness nao consegue rodar $HOOK"; fi

# C3 Mac (sem CLAUDE_CODE_REMOTE) → '{}' EXATO: nem aviso, nem contexto. Silêncio é metade do
# valor — sensor que fala a cada boot o founder aprende a ignorar.
rodar mac
if contrato C3; then
  if vazio; then ok C3 'Mac -> {} exato (nada muda)'
  else ruim C3 "no Mac a saida deveria ser exatamente {}: $out"; fi
fi

# A nuvem roda UMA vez; C4..C7 leem a mesma saída.
rodar true

# C4 nuvem → o envelope que o harness honra. Sem hookEventName a saída é ignorada.
if contrato C4; then
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null 2>&1; then
    ok C4 'nuvem -> envelope SessionStart'
  else ruim C4 "nuvem sem o envelope que o harness honra (hookSpecificOutput.hookEventName): $out"; fi
fi

# C5 nuvem → o founder VÊ (systemMessage): a máquina, o que falta nela, e a saída.
if contrato C5; then
  s="$(sys)"
  if tem "$s" 'NUVEM' && tem "$s" 'Codex' && tem "$s" 'psql-ro' && tem "$s" 'heavy' \
     && tem "$s" 'gstack' && tem "$s" 'Local'; then
    ok C5 'nuvem -> systemMessage com a maquina, o que falta e a saida'
  else ruim C5 "nuvem deveria avisar o founder (systemMessage com NUVEM, Codex, psql-ro, heavy, gstack e Local): $out"; fi
fi

# C6 nuvem → o modelo também sabe (additionalContext com a marca e a instrução).
if contrato C6; then
  c="$(ctx)"
  if tem "$c" 'SESSAO-NUVEM' && tem "$c" 'money-path' && tem "$c" 'Local'; then
    ok C6 'nuvem -> contexto do modelo com SESSAO-NUVEM e a instrucao'
  else ruim C6 "nuvem deveria contar ao modelo (additionalContext com SESSAO-NUVEM, money-path e Local): $out"; fi
fi

# C7 curto: aviso que vira parágrafo o founder deixa de ler. jq conta caracteres, não bytes,
# então o limite vale igual nos dois locales.
if contrato C7; then
  n="$(printf '%s' "$out" | jq -r '.systemMessage // "" | length' 2>/dev/null)"
  case "$n" in ''|*[!0-9]*) n=-1 ;; esac
  if [ "$n" -gt 0 ] && [ "$n" -le 200 ]; then ok C7 "aviso curto ($n caracteres, teto 200)"
  else ruim C7 "o aviso deveria ter de 1 a 200 caracteres; tem $n: $out"; fi
fi

# C8 só o valor "true" é nuvem — o MESMO predicado do vigia-gstack.sh e do codex-async.sh, senão
# o aviso e o wrapper discordam sobre em que máquina a sessão está.
rodar false
if contrato C8; then
  if vazio; then ok C8 'CLAUDE_CODE_REMOTE=false -> {} (so "true" e nuvem)'
  else ruim C8 "CLAUDE_CODE_REMOTE=false deveria ser tratado como Mac: $out"; fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
