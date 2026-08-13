#!/usr/bin/env bash
# test-read-contexto-nudge.sh — TDD do hook .claude/hooks/read-contexto-nudge.sh
#
# Regra sob teste (duas, independentes):
#   (a) VOLUME    — a leitura vai injetar >= 10k tokens estimados → avisa (marcador READ-GRANDE)
#   (b) RELEITURA — mesmo arquivo, MESMO range, arquivo NÃO alterado, na mesma
#                   sessão → avisa (marcador READ-RELEITURA)
# Silêncio (exit 0, zero stdout) em tudo o mais. NUNCA emite permissionDecision:
# o hook não bloqueia nem auto-aprova — só anexa contexto.
#
# Os marcadores casados aqui são ASCII puro, caixa fixa e EXCLUSIVOS de um ramo —
# de propósito. `grep -i` sobre texto pt-BR acentuado casa o ramo errado sob
# pt_BR.UTF-8 (o `grep` do shell é shim p/ ugrep, que dobra Ã↔ã) e não sob LC_ALL=C:
# a asserção passaria a falsificar por acidente de locale, não por desenho (#1483).
# Por isso: `command grep`, sem -i, string ASCII. NÃO troque os marcadores por
# trechos da prosa em português — o hook os declara como contrato de teste.
#
# Uso:
#   bash scripts/test-read-contexto-nudge.sh              # suíte (exit 0 = verde)
#   bash scripts/test-read-contexto-nudge.sh --falsificar # sabota o hook e EXIGE vermelho
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="${HOOK_SOB_TESTE:-$here/../.claude/hooks/read-contexto-nudge.sh}"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }
[ -f "$HOOK" ] || { echo "VERMELHO — hook não encontrado: $HOOK"; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp"          # isola as marcas de sessão deste teste

# ------------------------------------------------------------ falsificação ---
# Suíte verde não prova nada se ela não souber ficar vermelha. Aqui cada
# sabotagem quebra UMA regra do hook e a suíte precisa acusar; se passar, é a
# ASSERÇÃO que está frouxa, não o hook que está bom.
#
# Roda nos DOIS locales de propósito: uma asserção pode falsificar por acidente
# de ambiente e não por desenho — `grep -qi` sobre pt-BR casa "NÃO"/"não" sob
# pt_BR.UTF-8 (ugrep dobra Ã↔ã) e não sob LC_ALL=C, ficando vermelha só no shell
# de quem escreveu (#1483). Se um locale acusa e o outro não, a suíte mente.
# shellcheck disable=SC2016  # os padrões de sed abaixo usam aspas simples de
# propósito: `${mtime}`/`${tokens}` são o TEXTO que o sed procura dentro do hook,
# e precisam chegar até ele sem serem expandidos por este shell.
if [ "${1:-}" = "--falsificar" ]; then
  falhou=0
  printf '== falsificacao (sabota o hook e EXIGE vermelho) ==\n'

  # sabota <descricao> <regra-que-deve-quebrar> <expressao-sed>
  # O delimitador do sed é `%` porque os padrões contêm `|` (o `||` do shell) —
  # reusar `|` como delimitador produziria um sed INVÁLIDO, que escreveria uma
  # cópia vazia. Cópia vazia também fica vermelha, e a falsificação passaria
  # parecendo boa sem ter sabotado regra nenhuma. Daí as 3 travas abaixo.
  sabota() {
    local desc="$1" regra="$2" expr="$3" copia="$tmp/sabotado.sh" erro
    erro="$(sed "$expr" "$HOOK" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:50}"; falhou=1; return
    fi
    if cmp -s "$HOOK" "$copia"; then
      printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, hook intacto — falsificacao vazia\n' "$desc"; falhou=1; return
    fi
    if ! bash -n "$copia" 2>/dev/null; then
      printf '  \033[31mFALHA\033[0m "%s": quebrou a SINTAXE — vermelho pelo motivo errado\n' "$desc"; falhou=1; return
    fi
    for loc in C pt_BR.UTF-8; do
      if LC_ALL="$loc" HOOK_SOB_TESTE="$copia" bash "$0" >/dev/null 2>&1; then
        printf '  \033[31mFALHA\033[0m [%s] "%s" passou VERDE — a suite nao cobre: %s\n' "$loc" "$desc" "$regra"
        falhou=1
      else
        printf '  \033[32mok\033[0m   [%-11s] "%s" -> vermelho\n' "$loc" "$desc"
      fi
    done
  }

  sabota "sempre silencia"      "avisar quando a leitura e cara" \
         's%^jq -n --arg m%exit 0 # SABOTADO%'
  sabota "sem corte de 10k"     "silenciar leitura barata" \
         's%\[ "\$tokens" -ge 10000 \] || exit 0%:%'
  sabota "mtime fora da chave"  "reler arquivo ALTERADO e legitimo" \
         's%chave="\${mtime}|%chave="%'
  sabota "range fora da chave"  "ler OUTRO trecho nao e releitura" \
         's%\${inicio}|\${limite}|%%'
  sabota "decide permissao"     "nunca emitir permissionDecision" \
         's%hookEventName:"PreToolUse"%hookEventName:"PreToolUse", permissionDecision:"deny"%'

  printf '\n'
  if [ "$falhou" -eq 0 ]; then echo "VERDE — toda sabotagem foi detectada, nos 2 locales"; exit 0; fi
  echo "VERMELHO — ha sabotagem passando despercebida"; exit 1
fi

# ---------------------------------------------------------------- fixtures ---
# grande: 400 linhas de ~1KB = ~400KB → ~111k tokens. Espelha o formato que mais
# dói de verdade (docs/historico/bugs-resolvidos.md: 376 linhas, 486KB) — poucas
# linhas MUITO longas, que estouram mesmo dentro do teto de 2000 linhas do Read.
linha="$(printf 'x%.0s' $(seq 1 1000))"
grande="$tmp/grande.md";  : > "$grande"
for _ in $(seq 1 400); do printf '%s\n' "$linha" >> "$grande"; done
pequeno="$tmp/pequeno.ts"; printf 'export const a = 1;\n%.0s' $(seq 1 50) > "$pequeno"
imagem="$tmp/diagrama.png"; printf 'PNG%s' "$linha" > "$imagem"

run() {  # $1=file_path $2=session $3=limit(0=ausente) $4=offset(0=ausente)
  jq -nc --arg f "$1" --arg s "$2" --argjson l "${3:-0}" --argjson o "${4:-0}" \
    '{hook_event_name:"PreToolUse", tool_name:"Read", session_id:$s,
      tool_input:({file_path:$f}
                  + (if $l > 0 then {limit:$l} else {} end)
                  + (if $o > 0 then {offset:$o} else {} end))}' \
  | bash "$HOOK" 2>/dev/null
}

fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }
# marcador ASCII exclusivo, sem -i, via `command grep` (o grep do shell é shim p/ ugrep)
tem() { printf '%s' "$2" | command grep -q "$1"; }
check(){ # $1=descrição $2=esperado(READ-GRANDE|READ-RELEITURA|silencio) $3=saída
  local desc="$1" esp="$2" out="$3"
  if [ "$esp" = "silencio" ]; then
    if [ -z "$out" ]; then ok "$desc"; else bad "$desc (esperava silêncio, veio: '${out:0:70}')"; fi
  else
    if tem "$esp" "$out"; then ok "$desc"; else bad "$desc (esperava $esp, veio: '${out:0:70}')"; fi
  fi
}

echo "== read-contexto-nudge =="

# --- (a) volume --------------------------------------------------------------
# 1. arquivo pequeno → silêncio
check "arquivo pequeno → silêncio" silencio "$(run "$pequeno" s1)"

# 2. arquivo grande → avisa volume
out2="$(run "$grande" s2)"
check "arquivo grande (~111k tok) → avisa volume" READ-GRANDE "$out2"

# 3. JSON bem-formado com os dois canais (founder + agente).
#    printf, não echo: echo interpreta o \n escapado e corrompe o JSON (CLAUDE.md).
if printf '%s' "$out2" | jq -e '.systemMessage and .hookSpecificOutput.additionalContext' >/dev/null 2>&1
then ok "JSON válido com systemMessage + additionalContext"
else bad "JSON inválido ou incompleto"; fi

# 4. hookEventName correto
if printf '%s' "$out2" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"' >/dev/null 2>&1
then ok "hookEventName = PreToolUse"
else bad "hookEventName errado"; fi

# 5. NÃO decide permissão. Emitir permissionDecision:"allow" pularia o prompt de
#    permissão de TODA leitura — auto-aprovaria ler ~/.ssh/id_rsa. E "deny"/"ask"
#    quebraria investigação legítima. O hook só anexa contexto.
if printf '%s' "$out2" | command grep -q 'permissionDecision'
then bad "emitiu permissionDecision (não pode decidir permissão)"
else ok "não decide permissão (nem allow, nem deny, nem ask)"; fi

# 6. o que conta é o VOLUME lido, não a presença de `limit`. Com linhas de ~1KB,
#    limit=10 lê ~10KB (~2,8k tok) → silêncio...
check "grande + limit=10 (~2,8k tok) → silêncio" silencio "$(run "$grande" s6 10)"

# 6b. ...mas limit=50 nas MESMAS linhas lê ~50KB (~13k tok) e ainda dói: `limit`
#     não é garantia de leitura barata. Este caso já pegou uma premissa errada
#     minha ("usou limit → não avisa") — o corte é por tokens, não por flag.
check "grande + limit=50 (~13k tok) → avisa mesmo com limit" READ-GRANDE "$(run "$grande" s6b 50)"

# 6c. O CONSELHO muda de lado no break-even medido (2026-08-06): um subagente
#     custa US$ 1,06 na mediana, então delegar só compensa a partir de ~40k
#     tokens — abaixo disso o certo é recortar (rg + offset/limit), de graça.
#     A 1ª versão do hook mandava delegar já a partir de 10k, conselho que PERDIA
#     dinheiro na maioria dos disparos. Marcadores ASCII em CAIXA FIXA ("SE PAGA"
#     / "PERDE"), sem -i: prosa acentuada casaria o ramo errado sob pt_BR (#1483).
grande_out="$(run "$grande" s6c)"          # ~111k tok → faixa do subagente
peq_out="$(run "$grande" s6d 50)"          # ~13k tok  → faixa do recorte
if tem "SE PAGA" "$grande_out" && ! tem "PERDE" "$grande_out"
then ok "leitura >=40k: conselho é DELEGAR (o subagente se paga)"
else bad "leitura de 111k deveria recomendar subagente (veio: '${grande_out:0:80}')"; fi

if tem "PERDE" "$peq_out" && ! tem "SE PAGA" "$peq_out"
then ok "leitura 10-40k: conselho é RECORTAR (delegar perderia dinheiro)"
else bad "leitura de 13k deveria desaconselhar subagente (veio: '${peq_out:0:80}')"; fi

# 7. o teto de 2000 linhas do Read entra na conta: arquivo de linhas CURTAS cujo
#    total passa de 10k tok, mas cujas 2000 primeiras linhas não → silêncio.
curto="$tmp/muitas-linhas-curtas.ts"; : > "$curto"
for _ in $(seq 1 12000); do printf 'const x = 1;\n' >> "$curto"; done
check "60k linhas curtas (teto de 2000 linhas) → silêncio" silencio "$(run "$curto" s7)"

# --- (b) releitura -----------------------------------------------------------
# 8. mesmo arquivo, mesma sessão, sem alteração → avisa releitura
_=$(run "$pequeno" s8)
check "2ª leitura idêntica → avisa releitura" READ-RELEITURA "$(run "$pequeno" s8)"

# 9. ranges diferentes NÃO são releitura — é leitura complementar do arquivo.
#    Os dois ranges são pequenos E existem dentro do arquivo (400 linhas), senão
#    o caso passaria por acidente: offset além do fim lê 0 byte e silenciaria
#    sozinho, sem provar nada sobre a regra de releitura.
_=$(run "$grande" s9 10 1)
check "mesmo arquivo, range diferente → silêncio" silencio "$(run "$grande" s9 10 200)"

# 10. arquivo alterado entre as leituras → releitura legítima, silêncio
mudou="$tmp/mudou.ts"; printf 'a\n' > "$mudou"
_=$(run "$mudou" s10)
sleep 1; printf 'b\n' >> "$mudou"          # mtime muda
check "arquivo alterado entre leituras → silêncio" silencio "$(run "$mudou" s10)"

# 11. a marca é POR SESSÃO — outra sessão relendo o mesmo arquivo não herda
_=$(run "$pequeno" s11)
check "outra sessão, 1ª leitura → silêncio" silencio "$(run "$pequeno" s11b)"

# --- fail-safes --------------------------------------------------------------
# 12. arquivo inexistente → silêncio (o próprio Read reporta o erro)
check "arquivo inexistente → silêncio" silencio "$(run "$tmp/nao-existe.ts" s12)"

# 13. binário/imagem → silêncio (a heurística de bytes não vale; não dar conselho errado)
check "imagem → silêncio" silencio "$(run "$imagem" s13)"

# 14. outra ferramenta no payload → silêncio (defesa se o matcher mudar)
check "tool_name != Read → silêncio" silencio \
  "$(jq -nc --arg f "$grande" '{hook_event_name:"PreToolUse",tool_name:"Grep",session_id:"s14",tool_input:{file_path:$f}}' | bash "$HOOK" 2>/dev/null)"

# 15. o aviso de volume sai UMA VEZ por arquivo/sessão — na 2ª vez quem fala é a
#     releitura, senão o mesmo arquivo grande gritaria volume a cada leitura.
_=$(run "$grande" s15)
out15="$(run "$grande" s15)"
if tem READ-RELEITURA "$out15" && ! tem READ-GRANDE "$out15"
then ok "2ª leitura de arquivo grande → só releitura, sem repetir volume"
else bad "2ª leitura de grande: esperava só READ-RELEITURA (veio: '${out15:0:70}')"; fi

# 16. o payload real do Claude Code traz file_path relativo em alguns clientes;
#     caminho não resolvível → silêncio, nunca erro.
check "caminho relativo não resolvível → silêncio" silencio "$(run "src/nao/existe.ts" s16)"

echo
if [ "$fail" -eq 0 ]; then echo "VERDE — todos os casos passaram"; exit 0; fi
echo "VERMELHO — ha casos falhando"; exit 1
