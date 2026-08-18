#!/usr/bin/env bash
# heavy-guard.sh — PreToolUse(Bash): cadência de RAM na M2 8GB.
#
# Comando PESADO (test/build/typecheck/vitest/tsc) sem `heavy` é REESCRITO
# via updatedInput (permissionDecision=allow) pra passar pelo semáforo `heavy`
# (scripts/heavy.sh), que serializa os pesados entre worktrees/sessões — sem
# round-trip de negação e sem consultar o classificador remoto de permissões.
# Se a reescrita não fechar (caso exótico), NEGA com instrução (comportamento
# antigo, rede de segurança).
#
# Fail-safe (não interfere → exit 0): `heavy` ausente, comando já usa `heavy`,
# comando leve (lint/dev/…), ou linha de leitura/menção (echo/cat/grep/git/…) —
# inclusive o padrão pesado que aparece SÓ dentro de heredoc/aspas, isto é, texto
# que o comando GRAVA e não executa (#1770: o `heavy` foi parar no ci.yml).
# Sem `jq` não há como montar updatedInput com escaping confiável → deny
# instrutivo no caso pesado (nunca allow às cegas). Testes em
# scripts/test-heavy-guard.sh.
set -u

input="$(cat)"

# --- extrai o comando Bash do payload do hook --------------------------------
if command -v jq >/dev/null 2>&1; then
  has_jq=1
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  has_jq=0
  cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
fi
[ -n "$cmd" ] || exit 0

# --- fail-safes que NÃO interferem (exit 0) ----------------------------------
# 1) `heavy` indisponível → não força o que não existe.
# São DUAS perguntas distintas, e confundi-las era um ponto cego: (a) o heavy
# EXISTE? (b) por que NOME ele é invocável no shell que vai rodar o comando?
# O PATH deste hook vem do processo do app, não do perfil de shell (mesma causa
# do fallback de caminho absoluto do `timeout` no vigia-worktree.sh) — então
# `~/.local/bin` pode faltar AQUI e existir LÁ. Medido em 2026-07-20: nesta
# máquina o PATH do app TEM ~/.local/bin, então hoje isto é proteção LATENTE e
# o comportamento não muda (o nome nu resolve → reescrita idêntica à de antes).
# O que fecha é o modo de falha: numa máquina/versão do app sem esse diretório,
# a reescrita antiga entregava um comando que não roda. Antes bastava o arquivo existir
# pra reescrever, mas a reescrita saía com o nome NU: quando o nome não
# resolvia, o comando pesado morria com 127 ("command not found") em vez de
# rodar — e a mensagem não apontava pra causa. Agora entra na reescrita o nome
# que PROVADAMENTE invoca: `heavy` quando resolve, senão o caminho absoluto,
# que resolve em qualquer PATH. O fail-open segue: sem nenhum dos dois, exit 0.
if command -v heavy >/dev/null 2>&1; then
  heavy_cmd="heavy"
elif [ -x "$HOME/.local/bin/heavy" ]; then
  heavy_cmd="$HOME/.local/bin/heavy"
else
  exit 0
fi

# Caminho com espaço/aspa exigiria quoting no shell E casar com o regex do
# check 2 — em vez de uma segunda forma de reescrita, fail-open: não interferir
# é sempre seguro; reescrever um comando que não roda, não.
case "$heavy_cmd" in
  *[!A-Za-z0-9_./-]*) exit 0 ;;
esac

# 2) menção ≠ execução: sanitiza heredoc e aspas ANTES de decidir qualquer coisa.
# Medido 2026-08-18 (PR #1770): uma sessão gravou um step de CI com
# `python3 - <<'PY' … run: bun run test:hooks … PY`. O guard casou o padrão DENTRO
# do heredoc e `.github/workflows/ci.yml` foi gravado com `run: heavy bun run
# test:hooks` — no runner ubuntu o `heavy` não existe (é o semáforo da M2 local)
# → 127 e `validate` VERMELHO. O erro só apareceu no CI: local passava.
# O texto que um comando GRAVA não é comando; as decisões abaixo (já-tem-heavy,
# é-pesado) leem `scan`. Mesmo bloco do pr-collision-guard.sh e do
# pr-duplicata-guard.sh — problema de classe, remédio idêntico.
# shellcheck disable=SC2016  # \x27/\x22 são literais do regex do perl, não expansão de shell
if command -v perl >/dev/null 2>&1; then
  tem_perl=1
  scan="$(printf '%s' "$cmd" | perl -0777 -pe "s/<<-?\s*([\x27\x22]?)(\w+)\1.*?^\2[ \t]*\$//gms; s/\x27[^\x27]*\x27//g; s/\x22[^\x22]*\x22//g" 2>/dev/null)"
else
  # sem perl só dá pra tirar as aspas; heredoc sobra (degradação, não garantia)
  tem_perl=0
  scan="$(printf '%s' "$cmd" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g" 2>/dev/null)"
fi
# Aqui NÃO vale o `scan="$cmd"` de fallback dos pr-guards: lá o pior caso de uma
# sanitização que falhou é AVISAR demais; aqui é REESCREVER dentro do heredoc —
# exatamente o bug acima. Sem resultado utilizável → não interferir.
[ -n "$scan" ] || exit 0

# 3) comando já passa pelo heavy — nu OU por caminho (`~/.local/bin/heavy …`),
# senão a própria reescrita absoluta seria re-prefixada num segundo passe.
# Lê `scan`: `heavy` citado dentro de heredoc/aspas é menção, e silenciar o
# guard por causa dela deixaria o comando pesado REAL da mesma linha passar nu.
re_ja_heavy='(^|[[:space:];&|()])([^[:space:]]*/)?heavy[[:space:]]'
printf '%s' "$scan" | grep -qE "$re_ja_heavy" && exit 0

# 4) linha de leitura/menção — nunca é execução pesada de verdade.
# Lê `cmd`: aqui a pergunta é qual programa ABRE a linha, e o `scan` pode ter
# comido justamente o começo dela.
case "$cmd" in
  echo\ * | printf\ * | cat\ * | grep\ * | rg\ * | ls\ * | head\ * | tail\ * | sed\ * | awk\ * | git\ * | \#*)
    exit 0 ;;
esac

# --- detecta comando pesado (test/build/typecheck/vitest/tsc) ----------------
# Sobre `scan`: só conta ocorrência FORA de heredoc/aspas — é o gate que fecha o
# caso do #1770 (o `bun run test:hooks` gravado no ci.yml sai daqui com exit 0).
heavy_re='(bun run (test|build|typecheck)|bunx? +vitest|vitest +run|vite +build|bun +build|tsc +[^|]*--noEmit)'
printf '%s' "$scan" | grep -qE "$heavy_re" || exit 0

deny() {
  # Usa $heavy_cmd, não 'heavy' fixo: quando o nome nu não resolve no PATH, a
  # instrução literal 'heavy bun run test' devolveria 127 a quem a seguisse.
  reason="RAM na M2 8GB: rode test/build/typecheck pelo semáforo. Prefixe o comando pesado com '$heavy_cmd' — ex.: '$heavy_cmd bun run test'; em comando composto, 'cd x && $heavy_cmd bun run test'. O heavy (scripts/heavy.sh) serializa os pesados entre worktrees e não atrasa quando há slot livre. Ver §2 do CLAUDE.md."
  if [ "$has_jq" -eq 1 ]; then
    jq -n --arg r "$reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  else
    esc="$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  fi
  exit 0
}

[ "$has_jq" -eq 1 ] || deny

# --- reescreve: prefixa `heavy ` em cada trecho pesado REAL -------------------
# Boundary: início da linha, espaço ou ; & | ( — cobre `cd x && bun run test`,
# `VAR=1 bun run test`, `bun run test > log 2>&1`. O check nº 3 garante que o
# comando ainda não contém `heavy`, então não há risco de prefixo duplo.
# DETECTAR fora do heredoc não basta — a reescrita também tem de PULÁ-LO: num
# comando MISTO (grava o step do CI *e* roda o teste de verdade) o gate manda
# reescrever, e um s/// cego enfia o `heavy ` no texto gravado. Idioma do perl
# "consome primeiro o que NÃO quero casar": a alternância protegida vem antes na
# regex e volta intacta pelo replacement; só o resto recebe o prefixo.
if [ "$tem_perl" -eq 1 ]; then
  rewritten="$(printf '%s' "$cmd" | HG_RE="$heavy_re" HG_HEAVY="$heavy_cmd" perl -0777 -pe '
    my $re = $ENV{HG_RE}; my $h = $ENV{HG_HEAVY};
    s{(?<prot><<-?\s*(?<q>[\x27\x22]?)(?<tag>\w+)\k<q>[\s\S]*?^\k<tag>[ \t]*$|\x27[^\x27]*\x27|\x22[^\x22]*\x22)|(?<pre>^|[ \t;&|(])(?<pes>$re)}
     {defined $+{prot} ? $+{prot} : "$+{pre}$h $+{pes}"}gem' 2>/dev/null)"
elif [ "$scan" = "$cmd" ]; then
  # Sem perl, mas nada foi sanitizado ⇒ não há região protegida e o s/// antigo é
  # seguro. `heavy_cmd` entra no LADO DIREITO: escapar \ & e a própria barra — o
  # caminho absoluto é cheio delas e partiria o s/// no meio.
  heavy_esc="$(printf '%s' "$heavy_cmd" | sed 's/[\\&/]/\\&/g')"
  rewritten="$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:];&|(])($heavy_re)/\\1$heavy_esc \\2/g")"
else
  # Sem perl E com heredoc/aspas: não há como prefixar SÓ o trecho real. Cai no
  # deny instrutivo abaixo (o agente prefixa à mão) — reescrever às cegas aqui é
  # justamente o #1770, e um comando pesado nu escapando é o que o guard existe
  # pra impedir.
  rewritten="$cmd"
fi

if [ "$rewritten" != "$cmd" ] && printf '%s' "$rewritten" | grep -qE "$re_ja_heavy"; then
  printf '%s' "$input" | jq --arg c "$rewritten" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:("heavy-guard: comando pesado reescrito pro semáforo de RAM → " + $c),updatedInput:(.tool_input | .command = $c)}}'
  exit 0
fi

# --- fallback: reescrita não fechou → nega instruindo ------------------------
deny
