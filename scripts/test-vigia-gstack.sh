#!/usr/bin/env bash
# test-vigia-gstack.sh — o sensor de gstack do SessionStart (.claude/hooks/vigia-gstack.sh).
#
# Por quê: o check-gstack.sh, que ele substitui, passou 136 dias (2026-05-14 → 2026-09-27)
# listado como "hook que NEGA" sem negar nada — envelope errado, e NENHUM teste o executava
# (docs/historico/gate-gstack-fail-open.md). Aqui o sensor roda de verdade, contra HOMEs
# SINTÉTICOS: nunca o ~/.claude real, onde no Mac o gstack existe e o caso "instalado" ficaria
# verde por sorte, e onde a nuvem o caso "ausente" ficaria verde por sorte.
#
# Confere o ENVELOPE que o harness honra (hookSpecificOutput.hookEventName), não o texto: foi
# exatamente um envelope incompleto que desligou o gate antigo.
#
# CLAUDE_CODE_REMOTE é fixado em TODO caso (removido nos locais): rodada numa sessão cloud, a
# variável vem herdada como "true" e os casos locais tomariam o ramo da nuvem.
#
# Uso: bash scripts/test-vigia-gstack.sh               (exit 0 = verde · 1 = asserção · 2 = infra)
#      bash scripts/test-vigia-gstack.sh --falsificar  (sabota CÓPIAS do sensor; exige vermelho)
#
# Marcadores ASCII de caixa fixa, casados com grep -F e sem -i; a falsificação roda nos DOIS
# locales (LC_ALL=C e um UTF-8 achado por sonda positiva), porque falsificar num só não prova (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="${VIGIA_GSTACK_HOOK:-$here/../.claude/hooks/vigia-gstack.sh}"

command -v jq >/dev/null 2>&1 || { echo "INFRA: jq ausente — nao da para conferir o envelope"; exit 2; }
[ -f "$HOOK" ] || { echo "INFRA: sensor nao encontrado em $HOOK"; exit 2; }

tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT

# ── falsificação ───────────────────────────────────────────────────────────────────────────────
# O CONTROLE roda a MESMA suíte (recursão com o override VIGIA_GSTACK_HOOK) sobre o sensor REAL, e
# vem antes de cada sabotagem: uma suíte sempre-vermelha aprovaria todas elas sem provar nada
# (docs/historico/falsificacao-sem-linha-de-base.md). Cada sabotagem tem de sair com exit 1 E com
# FAIL no caso que ela mira — exit 2 é infra (não conta como detecção), e um FAIL em outro caso
# qualquer não prova que o caso-alvo tem dente.
if [ "${1:-}" = "--falsificar" ]; then
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "ABORTA — nenhum locale UTF-8 neste ambiente; metade da falsificacao nao rodaria."; exit 1
  fi

  falhas=0
  controle() {
    local saida rc
    saida="$(LC_ALL="$1" VIGIA_GSTACK_HOOK="$HOOK" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\n%s\n' "$1" "$rc" "$saida"
      exit 1
    fi
  }
  # sabotar <id> <caso-alvo> <descricao> <sed-script>  (vazio = sensor inteiro trocado por '{}')
  sabotar() {
    local id="$1" alvo="$2" desc="$3" sedscr="$4" copia="$tmp/sabotado-$1.sh" saida rc
    if [ -n "$sedscr" ]; then
      sed "$sedscr" "$HOOK" > "$copia"
    else
      printf '#!/usr/bin/env bash\necho {}\n' > "$copia"
    fi
    if cmp -s "$HOOK" "$copia"; then
      printf '  ❌ %s: a sabotagem nao mudou nada (alvo do sed sumiu do sensor?) — no-op nao prova nada\n' "$id"
      falhas=$((falhas + 1)); return
    fi
    saida="$(LC_ALL="$LOC" VIGIA_GSTACK_HOOK="$copia" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then
      printf '  ✅ %s %s -> vermelho em [%s] (LC_ALL=%s)\n' "$id" "$desc" "$alvo" "$LOC"
    else
      printf '  ❌ %s %s: esperava exit 1 com FAIL [%s]; veio rc=%s\n%s\n' "$id" "$desc" "$alvo" "$rc" "$saida"
      falhas=$((falhas + 1))
    fi
  }

  # shellcheck disable=SC2016  # os `$` dos scripts de sed são TEXTO do sensor a casar, não expansão
  for LOC in C "$utf8"; do
    printf '== falsificacao (LC_ALL=%s) ==\n' "$LOC"
    controle "$LOC"
    sabotar S1 C2 'sensor mudo (sempre {})' ''
    controle "$LOC"
    sabotar S2 C1 'sempre alarma (nenhuma skill conta)' 's|\[ -r "\${HOME:-}/.claude/skills/\$s/SKILL.md" \]|false|'
    controle "$LOC"
    sabotar S3 C3 'bin/ vazio conta como instalado' 's|\[ -x "\$f" \]|true|'
    controle "$LOC"
    sabotar S4 C5 'ramo da nuvem ignorado' 's|\[ "\${CLAUDE_CODE_REMOTE:-}" = "true" \]|false|'
    controle "$LOC"
    sabotar S5 C2 'envelope sem hookEventName (a classe do incidente)' 's|"hookEventName":"SessionStart",||g'
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: cada caso-alvo reprova a sua sabotagem, nos 2 locales"; exit 0; fi
  echo "❌ falsificacao: $falhas sabotagem(ns) sem vermelho no caso-alvo"; exit 1
fi

# ── suíte ──────────────────────────────────────────────────────────────────────────────────────
fail=0
ok()   { printf '  ok   [%s] %s\n' "$1" "$2"; }
ruim() { printf '  FAIL [%s] %s\n' "$1" "$2"; fail=1; }

# HOMEs sintéticos: instalado · vazio · bin/ só com arquivo NÃO-executável · sem a skill browse.
novo_home() {
  local h="$tmp/$1" s
  mkdir -p "$h/.claude/skills/gstack/bin"
  case "$1" in
    ok|sem-browse) printf '#!/bin/sh\n' > "$h/.claude/skills/gstack/bin/gstack-config"
                   chmod +x "$h/.claude/skills/gstack/bin/gstack-config" ;;
    bin-vazio)     printf 'nao executavel\n' > "$h/.claude/skills/gstack/bin/LEIAME" ;;
    vazio)         rm -rf "$h/.claude" ;;
  esac
  for s in review investigate browse qa; do
    [ "$1" = vazio ] && continue
    [ "$1" = sem-browse ] && [ "$s" = browse ] && continue
    mkdir -p "$h/.claude/skills/$s"; printf -- '---\nname: %s\n---\n' "$s" > "$h/.claude/skills/$s/SKILL.md"
  done
  printf '%s' "$h"
}
H_OK="$(novo_home ok)"; H_VAZIO="$(novo_home vazio)"
H_BIN="$(novo_home bin-vazio)"; H_BROWSE="$(novo_home sem-browse)"

# rodar <home> <local|nuvem> → define $out e $rc
rodar() {
  if [ "$2" = nuvem ]; then
    out="$(CLAUDE_CODE_REMOTE=true HOME="$1" bash "$HOOK" </dev/null 2>/dev/null)"; rc=$?
  else
    out="$(env -u CLAUDE_CODE_REMOTE HOME="$1" bash "$HOOK" </dev/null 2>/dev/null)"; rc=$?
  fi
}
ctx() { printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null; }
sys() { printf '%s' "$out" | jq -r '.systemMessage // ""' 2>/dev/null; }
tem() { printf '%s' "$1" | grep -F -- "$2" >/dev/null; }
# Contrato comum a TODO caso: exit 0, JSON objeto, e nunca uma decisão de permissão.
contrato() {
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 \
     && ! tem "$out" 'permissionDecision' && ! tem "$out" '"decision"'; then
    return 0
  fi
  ruim "$1" "contrato quebrado (rc=$rc, JSON objeto sem decisao de permissao): $out"; return 1
}
# Envelope que o harness honra — sem hookEventName a saída é IGNORADA (o defeito do check-gstack).
envelope() { printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null 2>&1; }

echo "── vigia-gstack.sh ──"

# C1 instalado (Mac) → silêncio total.
rodar "$H_OK" local
if contrato C1; then
  if [ -z "$(sys)" ] && ! tem "$(ctx)" 'GSTACK-'; then ok C1 'instalado -> silencio'
  else ruim C1 "instalado deveria ficar em silencio: $out"; fi
fi

# C2 nada instalado (Mac) → alto: systemMessage + contexto, envelope certo, instrução de instalar.
rodar "$H_VAZIO" local
if contrato C2; then
  if envelope && tem "$(sys)" 'GSTACK-AUSENTE' && tem "$(ctx)" 'GSTACK-AUSENTE' && tem "$(ctx)" './setup --team' \
     && tem "$(ctx)" 'BIN-VAZIO' && tem "$(ctx)" 'SKILL-AUSENTE:review,investigate,browse,qa'; then
    ok C2 'ausente no Mac -> systemMessage + contexto com a instalacao'
  else ruim C2 "ausente no Mac deveria avisar alto, no envelope certo: $out"; fi
fi

# C3 bin/ existe mas sem executável → NÃO é instalação (o gate antigo aceitaria o diretório).
rodar "$H_BIN" local
if contrato C3; then
  if tem "$(sys)" 'GSTACK-AUSENTE' && tem "$(ctx)" 'BIN-VAZIO' && ! tem "$(ctx)" 'SKILL-AUSENTE'; then
    ok C3 'bin/ vazio -> ausente, e so o bin e acusado'
  else ruim C3 "bin/ sem executavel deveria contar como ausente: $out"; fi
fi

# C4 falta UMA skill canônica → acusa exatamente essa.
rodar "$H_BROWSE" local
if contrato C4; then
  if tem "$(sys)" 'GSTACK-AUSENTE' && tem "$(ctx)" '[SKILL-AUSENTE:browse]' && ! tem "$(ctx)" 'BIN-VAZIO'; then
    ok C4 'sem /browse -> acusa so browse'
  else ruim C4 "faltando so browse, deveria acusar [SKILL-AUSENTE:browse]: $out"; fi
fi

# C5 nuvem sem gstack → só contexto (ausência por desenho), substitutos, NUNCA mandar instalar.
rodar "$H_VAZIO" nuvem
if contrato C5; then
  if envelope && [ -z "$(sys)" ] && tem "$(ctx)" 'GSTACK-NUVEM' && tem "$(ctx)" '/code-review' \
     && ! tem "$(ctx)" 'GSTACK-AUSENTE' && ! tem "$(ctx)" 'setup --team'; then
    ok C5 'nuvem sem gstack -> contexto com substitutos, sem alarme nem instalacao'
  else ruim C5 "nuvem deveria mapear substitutos sem systemMessage nem instalacao: $out"; fi
fi

# C6 nuvem COM gstack (se um dia a opção A for adotada) → silêncio: o sensor mede, não presume.
rodar "$H_OK" nuvem
if contrato C6; then
  if [ -z "$(sys)" ] && ! tem "$(ctx)" 'GSTACK-'; then ok C6 'nuvem com gstack -> silencio (mede, nao presume)'
  else ruim C6 "nuvem com gstack instalado deveria ficar em silencio: $out"; fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
