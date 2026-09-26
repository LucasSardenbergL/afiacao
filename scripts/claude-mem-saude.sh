#!/usr/bin/env bash
# claude-mem-saude.sh — o claude-mem esta GRAVANDO? Sensor do SessionStart (bloco 6 do
# .claude/hooks/vigia-worktree.sh). So LE (1 arquivo de estado + sqlite3 -readonly); nunca toca
# no plugin nem no worker.
#
# Por que existe (2026-09-25): o plugin claude-mem >= 13.24.18 bloqueia 1 prompt quando o worker
# cai e depois falha em SILENCIO — e a memoria pode morrer com o worker saudavel. Medido no banco
# real nesse dia: a ultima observacao era de 2026-07-27, com 3.249 prompts gravados depois dela,
# contador de falhas em 0 e /api/health em 200. Nenhum sensor da casa via isso: o vigia so anota
# o worker quando ele QUEIMA CPU (orfaos-custosos.sh), e o health mede o worker, nao a memoria.
#
# Dois eixos, cada um com veredito ACHADO · LIMPO · NAO MEDI:
#  1. contador — $CLAUDE_MEM_DATA_DIR/state/hook-failures.json. Lido no fonte 13.15.3: cada hook
#     que nao alcanca o worker soma +1 e grava lastFailureAt; o proximo contato zera; o arquivo
#     nasce na 1a falha. > 0 = ACHADO — salvo se a ultima falha tem mais de 72 h: entao nenhum
#     hook rodou desde ela (plugin desligado, maquina parada) e o aviso viraria eterno.
#  2. gravacao — prompts gravados DEPOIS da ultima observacao (user_prompts x observations no
#     claude-mem.db). ACHADO com >= 30 prompts, espalhados por >= 60 min, o ultimo ha <= 72 h.
#     Calibrado no banco real (07/07-26/07, 5.250 intervalos entre observacoes consecutivas): o
#     maior trecho normal teve 11 prompts; os apagoes, 232 (11-14/07), 285 (21-27/07) e 3.249
#     (desde 27/07). 30 fica ~3x acima do normal e ~8x abaixo do menor apagao. "Ultima observacao
#     velha" em RELOGIO daria alarme falso a cada fim de semana; medida contra os prompts, nao.
#     Os 60 min impedem que uma rajada de prompts ainda na fila do gerador vire alarme.
#
# Sonda ausente = NAO MEDI, nunca "ok": sqlite3 fora do PATH, banco ou contador ausente, consulta
# que falha, valor nao-inteiro. Sem o diretorio de dados, o claude-mem nao existe nesta maquina
# (sessao na nuvem, por exemplo): nada a medir, silencio.
# Parse do JSON com sed, nao jq: o PATH do hook e herdado do app e pode nao ter /opt/homebrew/bin.
#
# Uso: bash scripts/claude-mem-saude.sh            # relatorio
#      bash scripts/claude-mem-saude.sh --resumo   # 1 linha p/ o hook, ou NADA
# Env: CLAUDE_MEM_DATA_DIR (~/.claude-mem — o MESMO nome que o plugin honra)
# Exit: 0 = mediu os dois eixos (achando ou nao) · 3 = algum eixo NAO MEDIDO (a saida diz qual)
set -u

resumo=0
[ "${1:-}" = "--resumo" ] && resumo=1
DATA="${CLAUDE_MEM_DATA_DIR:-${HOME:-}/.claude-mem}"
PROMPTS_MIN=30
JANELA_S=3600
EM_USO_S=259200
agora="$(date +%s)"

inteiro() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; }
json_num() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | awk 'NR == 1'; }
humano() { # segundos -> "60d" / "5h" / "12min"
  if [ "$1" -ge 86400 ]; then echo "$(($1 / 86400))d"
  elif [ "$1" -ge 3600 ]; then echo "$(($1 / 3600))h"
  else echo "$(($1 / 60))min"; fi
}

if [ ! -d "$DATA" ]; then
  [ "$resumo" -eq 1 ] || echo "claude-mem: sem $DATA — o plugin nao roda nesta maquina; nada a medir."
  exit 0
fi

# ------------------------------------------------------------------ 1. contador de falhas de hook
f="$DATA/state/hook-failures.json"
if ! inteiro "$agora"; then
  cont=NAO_MEDI; cont_txt="NAO MEDI o contador (o relogio nao respondeu: date +%s)"
elif [ ! -f "$f" ]; then
  cont=NAO_MEDI; cont_txt="NAO MEDI o contador (sem state/hook-failures.json — o plugin so o cria na 1a falha; ausente nao prova zero)"
else
  n="$(json_num "$f" consecutiveFailures)"
  if ! inteiro "$n"; then
    cont=NAO_MEDI; cont_txt="NAO MEDI o contador (hook-failures.json sem consecutiveFailures inteiro)"
  elif [ "$n" -eq 0 ]; then
    cont=LIMPO; cont_txt="contador de falhas de hook em 0"
  else
    lf="$(json_num "$f" lastFailureAt)"
    if inteiro "$lf" && [ "$lf" -gt 0 ]; then
      idade=$((agora - lf / 1000))
      [ "$idade" -ge 0 ] || idade=0
      if [ "$idade" -gt "$EM_USO_S" ]; then
        cont=FORA_DE_USO; cont_txt="contador em $n, mas a ultima falha tem $(humano "$idade"): nenhum hook rodou desde entao (plugin desligado ou maquina parada)"
      else
        cont=ACHADO; cont_txt="$n FALHAS DE HOOK seguidas, a ultima ha $(humano "$idade") -> o worker nao atende (bloqueia prompts ou falha em silencio, conforme a versao); diagnostico que nao toca em nada: 'bun run claude-mem:reanimar -- --so-olhar'"
      fi
    else
      cont=ACHADO; cont_txt="$n FALHAS DE HOOK seguidas (hora da ultima ilegivel) -> o worker nao atende; diagnostico que nao toca em nada: 'bun run claude-mem:reanimar -- --so-olhar'"
    fi
  fi
fi

# ------------------------------------------------------------------ 2. a memoria esta gravando?
db="$DATA/claude-mem.db"
Q="select (select count(*) from user_prompts),
  coalesce((select max(created_at_epoch) from observations), 0),
  coalesce((select max(created_at_epoch) from user_prompts), 0),
  (select count(*) from user_prompts where created_at_epoch > coalesce((select max(created_at_epoch) from observations), 0)),
  coalesce((select min(created_at_epoch) from user_prompts where created_at_epoch > coalesce((select max(created_at_epoch) from observations), 0)), 0),
  coalesce((select strftime('%Y-%m-%d', max(created_at_epoch) / 1000, 'unixepoch') from observations), 'nunca');"
if ! command -v sqlite3 >/dev/null 2>&1; then
  grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (sqlite3 fora do PATH)"
elif [ ! -f "$db" ]; then
  grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (sem claude-mem.db em $DATA)"
elif ! linha="$(sqlite3 -readonly -cmd '.timeout 1000' "$db" "$Q" 2>&1)"; then
  grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (sqlite3 falhou: $(printf '%s' "$linha" | head -1 | cut -c1-90))"
else
  IFS='|' read -r total obs ult depois prim data_obs <<<"$linha"
  if ! inteiro "$total" || ! inteiro "$obs" || ! inteiro "$ult" || ! inteiro "$depois" || ! inteiro "$prim"; then
    grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (resposta inesperada do sqlite3: $(printf '%s' "$linha" | head -1 | cut -c1-60))"
  elif [ "$total" -eq 0 ]; then
    grav=LIMPO; grav_txt="nenhum prompt gravado ainda: nada a comparar"
  else
    espalhados=$(((ult - prim) / 1000))
    parado=$((agora - ult / 1000))
    if [ "$depois" -ge "$PROMPTS_MIN" ] && [ "$espalhados" -ge "$JANELA_S" ] && [ "$parado" -le "$EM_USO_S" ]; then
      if [ "$obs" -eq 0 ]; then quando="NAO GRAVA: $depois prompts e nenhuma observacao jamais gravada"
      else quando="NAO GRAVA ha $(humano $((agora - obs / 1000))): $depois prompts desde a ultima observacao ($data_obs)"; fi
      grav=ACHADO; grav_txt="a memoria $quando -> o worker atende, mas o gerador de observacoes falha em silencio (login do CLI expirado?); ver docs/agent/skills.md (claude-mem) e ~/.claude-mem/logs"
    else
      grav=LIMPO; grav_txt="gravando: $depois prompt(s) desde a ultima observacao ($data_obs)"
    fi
  fi
fi

rc=0
[ "$cont" = NAO_MEDI ] && rc=3
[ "$grav" = NAO_MEDI ] && rc=3
if [ "$resumo" -eq 1 ]; then
  saida=""
  case "$cont" in ACHADO | NAO_MEDI) saida="$cont_txt" ;; esac
  case "$grav" in ACHADO | NAO_MEDI) saida="${saida:+$saida; }$grav_txt" ;; esac
  [ -z "$saida" ] || echo "claude-mem: $saida"
  exit "$rc"
fi
echo "=== claude-mem: esta gravando? ($DATA) ==="
echo "  contador: [$cont] $cont_txt"
echo "  gravacao: [$grav] $grav_txt"
exit "$rc"
