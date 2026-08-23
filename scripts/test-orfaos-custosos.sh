#!/usr/bin/env bash
# test-orfaos-custosos.sh — TDD do scripts/orfaos-custosos.sh com `ps` STUBADO.
#
# Contrato testado — o sensor existe porque em 2026-08-23 a M2 8GB ficou 16h55min
# com load 83,92 e 83MB livres por causa de 8 `zsh` ÓRFÃOS (PPID=1) queimando ~5,5
# dos 8 cores, restos de um `eval` de carga sintética cuja sessão Claude morreu sem
# matá-los. Os dois vigias da casa eram CEGOS a isso: contavam SESSÕES e worktrees
# (o que o founder já vê), nunca ppid/pcpu/loadavg. Levou 17h e foi por acidente.
#
# O eixo (medido nesta máquina em 2026-08-23, não suposto):
#
#   TIME acumulado SOZINHO é o eixo errado — é a classe do roteirizador-corte-
#   cidades.md ("o teto é o EIXO, não o tamanho"). Medido: o worker do plugin
#   claude-mem é PPID=1, tem 9:32 de CPU e mora em /Users/... — passa por
#   "TIME>5min fora de /System//usr/*//Applications/" e viraria FALSO POSITIVO
#   justo no processo que já se sabia legítimo. E `/bin/zsh -c source
#   .../shell-snapshots/...` com PPID=1 é ROTINA aqui (0,6%, 14s): órfão não é
#   anomalia nesta máquina, órfão CARO é.
#
#   Por isso são DOIS eixos, ambos obrigatórios: pcpu ≥ teto (queima AGORA — no
#   macOS o %CPU do ps é média decaída de ~1min) E cputime ≥ teto (queima
#   SUSTENTADA, não spike). Medido: maior órfão não-sistema = 3,5% · os 8 zsh do
#   incidente = ~68% cada. A folga é de uma ordem de grandeza; precisão > recall,
#   porque sensor que grita todo boot o founder aprende a ignorar — e aí deixa de
#   existir (é como se perdem 17 horas de novo).
#
# Uso: bash scripts/test-orfaos-custosos.sh              (exit 0 = tudo verde)
#      bash scripts/test-orfaos-custosos.sh --falsificar (sabota e EXIGE vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${ORFAOS_ALVO:-$here/orfaos-custosos.sh}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

falhas=0
ok()    { printf '  \033[32mok\033[0m    %s\n' "$1"; }
falha() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; falhas=$((falhas + 1)); }

# ── stub do `ps` ─────────────────────────────────────────────────────────────
# Emite o fixture apontado por PS_FIXTURE, ignorando as flags. PS_RC=1 simula o
# `ps` falhando (o caminho "não consegui varrer", que NÃO pode virar "nenhum").
#
# O stub RESPEITA LC_ALL de propósito, imitando o ps real MEDIDO nesta máquina:
#   LC_ALL=C           → 0.0
#   LC_ALL=pt_BR.UTF-8 → 0,0     (vírgula decimal)
# Sem isso, a suíte rodaria só no locale de quem a escreveu e o relato sairia
# "68,4%" pro founder e "68.4%" no CI — a asserção falsificaria por acidente de
# ambiente e não por desenho (#1483).
cat > "$tmp/ps" <<'STUB'
#!/bin/sh
# Ruído de AMBIENTE no stderr, sob demanda. Imita o que o ubuntu do CI faz de
# verdade: lá `pt_BR.UTF-8` não existe e o bash cospe "warning: setlocale: ..."
# no stderr. O bash do macOS é silencioso nesse caso, então sem este gerador a
# regressão não teria como ser reproduzida na máquina de quem escreve.
[ -z "${PS_RUIDO_STDERR:-}" ] || echo "warning: setlocale: LC_ALL: cannot change locale (pt_BR.UTF-8)" >&2
[ "${PS_RC:-0}" = "0" ] || exit "$PS_RC"
case "${LC_ALL:-C}" in
  pt_BR*|*pt_BR*) sed 's/\([0-9]\)\.\([0-9]\)/\1,\2/g' "$PS_FIXTURE" ;;
  *)              cat "$PS_FIXTURE" ;;
esac
STUB
chmod +x "$tmp/ps"

# ── fixture principal: 1 culpado + 5 inocentes que já foram observados ───────
# Colunas na ordem do contrato: pid ppid time pcpu command
cat > "$tmp/fix-real.txt" <<'FIX'
91234     1  1015:22.33  68.4 /bin/zsh -c while :; do :; done
91235     1     9:32.85   3.5 /Users/lucassardenberg/.bun/bin/bun /Users/lucassardenberg/.claude/plugins/cache/thedotmack/claude-mem/13.15.3/scripts/worker-service
  596     1     3:28.74   0.0 /usr/local/bin/warsaw/core
  101     1    89:29.96  90.1 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  102     1     0:03.10  99.0 /Users/lucassardenberg/pico-curto
  103  4321  1200:00.00  99.0 /Users/lucassardenberg/filho-com-dono
FIX

: > "$tmp/fix-vazio.txt"

# ------------------------------------------------------------ falsificação ---
# Suíte verde não prova nada se ela não souber ficar vermelha. Cada sabotagem
# quebra UMA regra do detector; se a suíte passar mesmo assim, é a ASSERÇÃO que
# está frouxa, não o detector que está bom.
#
# Roda nos DOIS locales de propósito (#1483): a asserção que casa o número do
# pcpu pode falsificar por acidente de ambiente — o `ps` real emite "68,4" sob
# pt_BR.UTF-8 e "68.4" sob C. Se um locale acusa e o outro não, a suíte mente.
# shellcheck disable=SC2016  # as aspas simples abaixo são de propósito: `$4`,
# `$2` e `$n` são o TEXTO que o sed procura DENTRO do alvo, e expandir aqui
# escreveria um padrão que não casa — falsificação vazia, que a trava (2) pega
# mas só depois de custar uma rodada.
if [ "${1:-}" = "--falsificar" ]; then
  falhou=0
  printf '== falsificacao (sabota o detector e EXIGE vermelho) ==\n'

  # sabota <descricao> <regra-que-deve-quebrar> <expressao-sed>
  # 4 travas contra "falsificação vazia" — vermelho pelo motivo errado conta
  # como verde mentiroso: (1) sed inválido escreve cópia vazia, que fica
  # vermelha sem ter sabotado nada; (2) padrão que não casa deixa o alvo
  # intacto; (3) sintaxe de shell quebrada; (4) o miolo é um programa AWK dentro
  # de string — `bash -n` não o vê, então um awk inválido passaria pelas 3
  # primeiras travas e pintaria TUDO de vermelho por erro de sintaxe do awk.
  sabota() {
    local desc="$1" regra="$2" expr="$3" copia="$tmp/sabotado.sh" erro fumaca
    erro="$(sed "$expr" "$ALVO" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      falha "\"$desc\": sed invalido (${erro:0:60}) — falsificacao vazia"; falhou=1; return
    fi
    if cmp -s "$ALVO" "$copia"; then
      falha "\"$desc\": padrao nao casou, alvo intacto — falsificacao vazia"; falhou=1; return
    fi
    if ! bash -n "$copia" 2>/dev/null; then
      falha "\"$desc\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; falhou=1; return
    fi
    fumaca="$(PATH="$tmp:$PATH" PS_FIXTURE="$tmp/fix-real.txt" bash "$copia" 2>&1 >/dev/null)"
    if printf '%s' "$fumaca" | grep -qiE 'awk|syntax error'; then
      falha "\"$desc\": quebrou o programa AWK (${fumaca:0:60}) — vermelho pelo motivo errado"; falhou=1; return
    fi
    for loc in C pt_BR.UTF-8; do
      if LC_ALL="$loc" ORFAOS_ALVO="$copia" bash "$0" >/dev/null 2>&1; then
        falha "[$loc] \"$desc\" passou VERDE — a suite nao cobre: $regra"; falhou=1
      else
        printf '  \033[32mok\033[0m    [%-11s] "%s" -> vermelho\n' "$loc" "$desc"
      fi
    done
  }

  sabota "sem o eixo pcpu"        "orfao BARATO (claude-mem 3,5%, warsaw 0%) nao e alarme" \
         's%if ((\$4 + 0) < (pcpu_min + 0)) next%%'
  sabota "sem o eixo cputime"     "spike curto de 3s nao e alarme" \
         's%if (s < (t_min + 0)) next%%'
  sabota "sem o filtro de orfao"  "processo COM dono nao e orfao" \
         's%\$2 == 1 {%1 {%'
  sabota "sem prefixos de SO"     "daemon do sistema nao e do founder matar" \
         's%if (cmd ~ /\^%if (cmd ~ /NUNCACASA%'
  sabota "sem truncagem"          "hook nao pode despejar linha de 400 chars" \
         's%if (length(cmd) > 110)%if (length(cmd) > 99999)%'
  sabota "ps falho vira sucesso"  "ausencia de dado nao pode virar 'esta limpo'" \
         's%^  exit 3$%  exit 0%'
  sabota "resumo fala a toa"      "hook silencia quando nao ha nada" \
         's%\[ "\$n" -gt 0 \] || exit 0%:%'
  # Delimitador `#` e nao `%`: o padrao contem os `%d`/`%02d` do printf, e
  # reusar `%` produziria um sed INVALIDO — que a trava (1) pega, mas so depois
  # de custar uma rodada.
  sabota "tempo em segundos crus" "founder le 16h55m, nao 60922" \
         's#printf "%dh%02dm", h, m#printf "%d", s#'
  # A regressao de locale: sem o LC_ALL=C o ps emite "68,4" pro founder e "68.4"
  # no CI. So a assercao de estabilidade entre locales deixa isto vermelho.
  sabota "sem LC_ALL=C no ps"     "relato estavel entre C e pt_BR (#1483)" \
         's%LC_ALL=C ps -axo%ps -axo%'

  printf '\n'
  if [ "$falhou" -eq 0 ]; then echo "VERDE — toda sabotagem foi detectada, nos 2 locales"; exit 0; fi
  echo "VERMELHO — ha sabotagem passando despercebida"; exit 1
fi

# roda o alvo com o ps stubado; ecoa a saída e "EXIT=<rc>" na última linha
run() {
  local fixture="$1"; shift
  PATH="$tmp:$PATH" PS_FIXTURE="$fixture" bash "$ALVO" "$@" 2>&1
  printf 'EXIT=%s\n' "$?"
}

quero() {   # quero <descricao> <saida> <padrao-grep-F>
  if printf '%s' "$2" | grep -qF "$3"; then ok "$1"; else falha "$1 — não achei '$3' em: $(printf '%s' "$2" | tr '\n' '|' | cut -c1-220)"; fi
}
nao_quero() {
  if printf '%s' "$2" | grep -qF "$3"; then falha "$1 — '$3' apareceu (falso positivo) em: $(printf '%s' "$2" | tr '\n' '|' | cut -c1-220)"; else ok "$1"; fi
}

echo "── relatório: pega o órfão caro e SÓ ele ──"
saida="$(run "$tmp/fix-real.txt")"
quero     "reporta o pid do órfão caro"            "$saida" "91234"
quero     "reporta a linha de comando"             "$saida" "/bin/zsh"
quero     "sai 0 (varreu)"                         "$saida" "EXIT=0"
nao_quero "NÃO reporta o worker do claude-mem"     "$saida" "91235"
nao_quero "NÃO reporta o warsaw (banco)"           "$saida" "596"
nao_quero "NÃO reporta processo de /System/"       "$saida" "90.1"
nao_quero "NÃO reporta spike curto (0:03)"         "$saida" "102"
nao_quero "NÃO reporta processo COM dono (ppid≠1)" "$saida" "103"

echo "── o tempo acumulado sai LEGÍVEL (não em segundos crus) ──"
# 1015:22 no formato do macOS = 16h55min — o número que fecha com o incidente.
quero "tempo acumulado em h/min" "$saida" "16h55"

echo "── a linha de comando é TRUNCADA (hook não pode despejar contexto) ──"
cat > "$tmp/fix-longo.txt" <<FIX
77777     1  600:00.00  99.0 /Users/x/$(printf 'a%.0s' $(seq 1 400))
FIX
saida_longo="$(run "$tmp/fix-longo.txt")"
maior="$(printf '%s' "$saida_longo" | awk '{ print length }' | sort -rn | awk 'NR==1')"
if [ "${maior:-999}" -le 200 ]; then ok "nenhuma linha passa de 200 chars (maior: $maior)"
else falha "linha de $maior chars — comando não foi truncado"; fi
quero "mesmo truncado, reporta o pid" "$saida_longo" "77777"

echo "── formatos de TIME portáveis (macOS MM:SS · Linux/CI [DD-]HH:MM:SS) ──"
# O CI é ubuntu e roda este script: lá o mesmo processo aparece como HH:MM:SS.
cat > "$tmp/fix-linux.txt" <<'FIX'
55501     1    16:55:22  68.4 /home/runner/queimador-hhmmss
55502     1  3-11:00:00  68.4 /home/runner/queimador-ddhhmmss
55503     1       04:59  99.0 /home/runner/quase-la-mmss
FIX
saida_l="$(run "$tmp/fix-linux.txt")"
quero     "HH:MM:SS cruza o teto"        "$saida_l" "55501"
quero     "DD-HH:MM:SS cruza o teto"     "$saida_l" "55502"
nao_quero "MM:SS abaixo do teto silencia" "$saida_l" "55503"

echo "── ausência de dado ≠ ausência de órfão ──"
saida_vazio="$(run "$tmp/fix-vazio.txt")"
quero "sem órfão caro → diz que varreu e sai 0" "$saida_vazio" "EXIT=0"
saida_rc="$(PATH="$tmp:$PATH" PS_FIXTURE="$tmp/fix-real.txt" PS_RC=1 bash "$ALVO" 2>&1; printf 'EXIT=%s\n' "$?")"
quero     "ps falhou -> exit 3 (falta de dado, nao 'nenhum')" "$saida_rc" "EXIT=3"
# Âncoras ASCII de caixa fixa, nunca a frase acentuada: `grep` daqui é shim e
# dobra acento entre locales — casar "não consegui" ficaria vermelho só no shell
# de quem escreveu (#1483). Por isso o script emite os marcadores SEM-MEDIDA e
# "nenhum orfao caro", que sobrevivem a C e a pt_BR.UTF-8 iguais.
quero     "ps falhou -> marcador SEM-MEDIDA"                 "$saida_rc" "SEM-MEDIDA"
nao_quero "ps falhou -> NAO afirma 'nenhum orfao'"           "$saida_rc" "nenhum orfao"

echo "── --resumo: 1 linha pro hook, SILÊNCIO quando não há nada ──"
# 2>/dev/null e não 2>&1 pelo mesmo motivo da asserção de locale mais abaixo:
# estas duas MEDEM (contam linhas, exigem vazio) em vez de procurar um padrão,
# então qualquer ruído de ambiente no stderr as reprova sozinho. `grep -qF` é
# imune a isso; contagem e igualdade não são. Descartar o stderr não cega o
# teste: script quebrado devolve stdout vazio, que reprova em ambas.
r_com="$(PATH="$tmp:$PATH" PS_FIXTURE="$tmp/fix-real.txt" bash "$ALVO" --resumo 2>/dev/null)"
r_sem="$(PATH="$tmp:$PATH" PS_FIXTURE="$tmp/fix-vazio.txt" bash "$ALVO" --resumo 2>/dev/null)"
quero "resumo cita o pid culpado" "$r_com" "91234"
if [ "$(printf '%s' "$r_com" | grep -c .)" -eq 1 ]; then ok "resumo tem exatamente 1 linha"
else falha "resumo tem $(printf '%s' "$r_com" | grep -c .) linhas — o hook vira parede de texto"; fi
if [ -z "$r_sem" ]; then ok "sem órfão caro → resumo SILENCIA (hook não vira ruído)"
else falha "resumo falou sem ter o que falar: $r_sem"; fi

echo "── o relato é ESTÁVEL entre locales (o ps emite 68,4 sob pt_BR) ──"
# STDOUT, nunca 2>&1: o contrato é o relato que o hook captura (ele lê a sonda
# com 2>/dev/null), e stderr aqui é ambiente, não contrato. Medir 2>&1 já custou
# um CI vermelho — no ubuntu o locale pt_BR.UTF-8 não existe e o bash cospe
# "warning: setlocale" no stderr de UM dos dois lados, e só dele: a asserção
# reprovava por ruído de ambiente, com o relato idêntico. Ironia do #1483: a
# asserção que existe pra não variar com o ambiente variava com o ambiente.
# `-n` é a trava que impede o par vazio=vazio de passar por "estável".
relato() { LC_ALL="$1" PATH="$tmp:$PATH" PS_FIXTURE="$tmp/fix-real.txt" bash "$ALVO" --resumo 2>/dev/null; }
n_c="$(relato C)"
n_br="$(relato pt_BR.UTF-8)"
if [ -n "$n_c" ] && [ "$n_c" = "$n_br" ]; then ok "mesma linha sob C e pt_BR.UTF-8"
else falha "relato muda com o locale (#1483): C='$n_c' vs pt_BR='$n_br'"; fi

# Trava da regressão acima, e portável: com ruído no stderr do alvo, o relato
# tem de continuar idêntico. É o ambiente do CI reproduzido em qualquer SO.
n_cr="$(PS_RUIDO_STDERR=1 relato C)"
n_brr="$(PS_RUIDO_STDERR=1 relato pt_BR.UTF-8)"
if [ -n "$n_cr" ] && [ "$n_cr" = "$n_brr" ] && [ "$n_cr" = "$n_c" ]; then
  ok "ruido de ambiente no stderr nao contamina o relato"
else
  falha "ruido no stderr mudou o relato: '$n_cr' vs '$n_brr' (limpo: '$n_c')"
fi

printf '\n'
if [ "$falhas" -eq 0 ]; then echo "VERDE — orfaos-custosos.sh cumpre o contrato"; exit 0; fi
echo "VERMELHO — $falhas asserção(ões) falhando"; exit 1
