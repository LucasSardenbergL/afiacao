#!/usr/bin/env bash
# chip-duplicata-guard.sh — PreToolUse(spawn_task): AVISA (não nega) quando o chip que vai nascer
# já tem destino, ou quando ele está terceirizando ao founder uma consulta que FALHOU por mecânica.
# Irmão do `pr-duplicata-guard.sh` um andar acima: lá o duplicado é o PR, aqui é a ORDEM.
#
# POR QUE EXISTE (medido em 2026-09-08 sobre `~/.claude/projects/*afiacao*/*.jsonl`):
#   828 chips entre 13/07 e 08/09, 441 sessões criadoras. Classificados:
#     • 236 (28,5%) eram o laço das 3 camadas manuais do Lovable — CURADO no #2374, que moveu a
#       pendência de deploy pro ledger `deploy_atestacoes` e tirou o chip do `/fecho`.
#     • 35 em TRÊS DIAS (mutcheck stale 20 + CI validate 15) eram DOIS defeitos re-chipados por
#       ~30 worktrees paralelas. Cada sessão viu o mesmo estado COMPARTILHADO quebrado e abriu o
#       seu próprio chip, porque nenhuma enxerga o chip das outras.
#   Setembro rodava a 37 chips/dia contra 15,6 em agosto. O founder, em 2026-09-08:
#   *"eu quero abrir chips que de fato eu precise clicar visto que você não consegue automatizar
#   durante a sessão"*.
#
# A DOUTRINA É A DO IRMÃO: "contramedida textual reincide; gate estrutural para." A regra de não
# duplicar chip já estava escrita (CLAUDE.md §Multi-sessão, "2 chips do mesmo escopo = PR
# redundante; deduplicar antes de abrir") e mesmo assim produziu 35 duplicatas em 3 dias.
#
# TRÊS EIXOS INDEPENDENTES (cada um sozinho já justifica o aviso):
#   1. ARTEFATO — o chip nomeia um alvo COMPARTILHADO (edge de `supabase/functions/`, script do
#      `package.json`) que outra worktree já chipou dentro da janela. Vocabulário AUTORITATIVO,
#      lido do repo — não regex adivinhada, que envelhece calada.
#   2. MECÂNICA — o chip se justifica por uma consulta que NÃO RESPONDEU ("exit 2",
#      "inconsultável", "não consegui consultar", "falhou"). Ausência de dado não é pendência:
#      é uma tentativa a repetir. Caso-teste real: o chip "Destravar ledger de deploy e provar 2
#      edges sem prova" (08/09) nasceu de `pendencias:deploy` em exit 2; re-rodado no mesmo dia
#      deu exit 0 com cobertura 59/59 e 22/22 disparos atestados — a ordem já nascera morta.
#   3. TEMPLATE — as duas primeiras palavras normalizadas do título repetem uma leva conhecida
#      ("confirmar deploy" 42x · "deployar edges" 39x · "aplicar migration" 27x). Pega a família
#      mesmo quando o alvo nomeado difere.
#
# FONTE DA VERDADE = LEDGER PRÓPRIO, não as transcrições. Varrer `~/.claude/projects` custou
# 12s medidos em 260 arquivos de 3 dias — caro demais para um hook. O ledger fica FORA do repo
# (`$HOME`), de propósito: arquivo versionado seria sincronizar estado entre ~30 branches, que é
# como se fabrica conflito. O guard é o ESCRITOR e o LEITOR dele; nasce vazio e acumula.
#
# NÃO NEGA. `permissionDecision: "allow"` + `additionalContext`, como o irmão. Negar chip perde
# trabalho real, e o irmão já provou que avisar basta.
set -u

entrada="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0

nome_ferramenta="$(printf '%s' "$entrada" | jq -r '.tool_name // ""' 2>/dev/null)"
case "$nome_ferramenta" in
  *spawn_task) ;;
  *) exit 0 ;;
esac

titulo="$(printf '%s' "$entrada" | jq -r '.tool_input.title // ""' 2>/dev/null)"
tldr="$(printf '%s' "$entrada" | jq -r '.tool_input.tldr // ""' 2>/dev/null)"
[ -n "$titulo" ] || exit 0

raiz="${CLAUDE_PROJECT_DIR:-.}"
ledger="${CHIP_LEDGER:-$HOME/.claude/afiacao-chips.tsv}"
janela_dias="${CHIP_JANELA_DIAS:-7}"
agora="$(date +%s)"
corte=$((agora - janela_dias * 86400))

# Identidade da sessão = a worktree. Duas sessões na mesma worktree são a mesma linha de trabalho;
# o que interessa é chip NASCENDO em worktrees DIFERENTES para o mesmo alvo.
origem="$(basename "$(cd "$raiz" 2>/dev/null && pwd || echo desconhecida)")"

# ── normalização (LC_ALL=C: determinística, mesma função nos dois lados da comparação) ──────────
normalizar() {
  LC_ALL=C printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[^a-z0-9:_-]\{1,\}/ /g; s/^ //; s/ $//'
}

texto_norm="$(normalizar "$titulo $tldr")"

# ── EIXO 1: vocabulário AUTORITATIVO de alvos compartilhados ────────────────────────────────────
# Genéricos demais para servir de chave (casariam em quase todo chip).
GENERICOS=" dev build lint test wt "
alvos=""
if [ -d "$raiz/supabase/functions" ]; then
  for d in "$raiz"/supabase/functions/*/; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    case "$n" in _*) continue ;; esac
    [ "${#n}" -ge 7 ] || continue
    case " $texto_norm " in *" $n "*) alvos="$alvos $n" ;; esac
  done
fi
if [ -f "$raiz/package.json" ]; then
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    case "$GENERICOS" in *" $n "*) continue ;; esac
    [ "${#n}" -ge 5 ] || continue
    case " $texto_norm " in *" $n "*) alvos="$alvos $n" ;; esac
  done <<EOF
$(jq -r '.scripts // {} | keys[]' "$raiz/package.json" 2>/dev/null)
EOF
fi
alvos="$(printf '%s' "$alvos" | LC_ALL=C tr ' ' '\n' | LC_ALL=C sort -u | LC_ALL=C tr '\n' ',' | sed 's/^,//; s/,$//')"

# ── EIXO 3: template = duas primeiras palavras do título normalizado ────────────────────────────
template="$(normalizar "$titulo" | cut -d' ' -f1-2)"

# ── consulta ao ledger (antes de gravar a própria linha) ────────────────────────────────────────
achados=""
if [ -s "$ledger" ]; then
  if [ -n "$alvos" ]; then
    for alvo in $(printf '%s' "$alvos" | tr ',' ' '); do
      qtd="$(LC_ALL=C awk -F'\t' -v c="$corte" -v a="$alvo" -v o="$origem" '
        $1 ~ /^[0-9]+$/ && $1 >= c && $2 != o {
          n = split($3, xs, ",")
          for (i = 1; i <= n; i++) if (xs[i] == a) { vistos[$2] = 1; break }
        }
        END { k = 0; for (w in vistos) k++; print k }' "$ledger" 2>/dev/null)"
      case "$qtd" in ''|0) ;; *) achados="$achados
  • alvo \`$alvo\` — já virou chip em $qtd outra(s) worktree(s) nos últimos ${janela_dias}d" ;; esac
    done
  fi
  qtd_t="$(LC_ALL=C awk -F'\t' -v c="$corte" -v t="$template" -v o="$origem" '
    $1 ~ /^[0-9]+$/ && $1 >= c && $2 != o && $4 == t { vistos[$2] = 1 }
    END { k = 0; for (w in vistos) k++; print k }' "$ledger" 2>/dev/null)"
  case "$qtd_t" in ''|0|1) ;; *) achados="$achados
  • template \"$template\" — mesma leva aberta por $qtd_t outras worktrees nos últimos ${janela_dias}d" ;; esac
fi

# ── EIXO 2: a justificativa é uma consulta que não respondeu ────────────────────────────────────
# Casa em ASCII, caixa fixa (o texto já veio de `normalizar`), sem `-i`.
#
# ⚠️ Os marcadores casam a forma NORMALIZADA, não a escrita. Sob `LC_ALL=C` cada byte acentuado é
# não-ASCII e vira separador: "não pôde ser consultada" chega aqui como "n o p de ser consultada".
# Por isso os marcadores são fragmentos SEM acento — "ser consultad", não "não pôde ser consultada".
# Marcador com acento nunca casaria, e o eixo passaria a aprovar tudo em silêncio.
#
# Precisão > recall, de propósito: "falhou"/"sem resposta" foram DESCARTADOS por casarem em chip
# legítimo de consertar defeito ("corrigir o gate que falhou no CI"). O que este eixo procura é
# consulta que NÃO RESPONDEU, não coisa quebrada.
mecanica=""
for marca in "exit 2" "inconsult" "consegui consultar" "ser consultad" "sem prova" "indeterminado"; do
  case " $texto_norm " in
    *"$marca"*) mecanica="$marca"; break ;;
  esac
done

# ── grava SEMPRE (o ledger é o registro global de chips; avisar não é condição para registrar) ──
mkdir -p "$(dirname "$ledger")" 2>/dev/null || true
printf '%s\t%s\t%s\t%s\t%s\n' "$agora" "$origem" "$alvos" "$template" "$titulo" >> "$ledger" 2>/dev/null || true
# Poda: o ledger é cache, não histórico. Só quando cresce, e preservando a janela.
if [ -s "$ledger" ]; then
  linhas="$(LC_ALL=C wc -l < "$ledger" 2>/dev/null || echo 0)"
  if [ "${linhas:-0}" -gt "${CHIP_LEDGER_MAX:-5000}" ]; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/chip-ledger.XXXXXX" 2>/dev/null)" || tmp=""
    if [ -n "$tmp" ]; then
      if LC_ALL=C awk -F'\t' -v c="$corte" '$1 ~ /^[0-9]+$/ && $1 >= c' "$ledger" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$ledger" 2>/dev/null || rm -f "$tmp" 2>/dev/null
      else
        rm -f "$tmp" 2>/dev/null
      fi
    fi
  fi
fi

[ -n "$achados" ] || [ -n "$mecanica" ] || exit 0

# ── anti-alarm-fatigue: 1x por (worktree, assinatura do achado) ─────────────────────────────────
cache_dir="${CDG_CACHE_DIR:-${TMPDIR:-/tmp}/cdg-$(id -u 2>/dev/null || echo 0)}"
mkdir -p "$cache_dir" 2>/dev/null || true
assin="$(printf '%s\n%s\n%s' "$origem" "$achados" "$mecanica" | cksum 2>/dev/null | tr -cd '0-9')"
if [ -n "$assin" ]; then
  marca="$cache_dir/visto-$assin"
  if [ -f "$marca" ] && [ -z "$(find "$marca" -mmin +"${CDG_VISTO_TTL_MIN:-360}" 2>/dev/null)" ]; then
    exit 0
  fi
  : > "$marca" 2>/dev/null || true
fi

msg="⚠️ CHIP com destino provável já existente — confira ANTES de abrir (caso: 35 chips em 3 dias para 2 defeitos, 2026-09-06..08)."
if [ -n "$achados" ]; then
  msg="$msg

DUPLICATA (o ledger \`$ledger\` já viu isto):$achados
Antes de abrir: o chip das outras worktrees pode já estar clicado, ou o defeito já corrigido.
  bun run pendencias           # eixos CÓDIGO e DEPLOY, medidos
  gh issue list --search '<alvo>' --state open"
fi
if [ -n "$mecanica" ]; then
  msg="$msg

MECÂNICA, NÃO PENDÊNCIA (o texto do chip diz \"$mecanica\").
Uma consulta que não respondeu é uma TENTATIVA A REPETIR, não trabalho a delegar — 'ausente ≠ zero'
vale no tempo (docs/historico/espera-sem-desistencia.md). RODE O COMANDO DE NOVO nesta sessão antes
de virar ordem de clique: em 2026-09-08 o \`pendencias:deploy\` em exit 2 virou chip, e a re-execução
no mesmo dia deu exit 0 com 59/59 — a ordem nasceu morta.
Só vire chip se a re-execução falhar OUTRA VEZ, e aí o chip é 'consertar o sensor', não 'provar X'."
fi

jq -n --arg m "$msg" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",additionalContext:$m}}'
exit 0
