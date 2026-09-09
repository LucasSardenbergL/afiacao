#!/usr/bin/env bash
# test-medir-footprint.sh — falsificação do INSTRUMENTO `scripts/medir-footprint.sh`.
#
# Uso: bash scripts/test-medir-footprint.sh              (exit 0 = os 4 controles verdes)
#      bash scripts/test-medir-footprint.sh --falsificar (controle + sabotagem; exige vermelho)
#
# Por que existe: as tarefas 7-11 do plano `2026-09-07-vitest-workers-e-ambiente` decidem
# `minWorkers`/`maxWorkers` a partir do `pico_mb` que este coletor devolve. Número de instrumento
# não-falsificado é opinião com casas decimais — e um instrumento que erra para BAIXO enviesa a
# favor de APROVAR a configuração medida. Então cada asserção aqui roda o CONTROLE VERDE primeiro
# e só então sabota a chave correspondente do coletor, exigindo VERMELHO.
#
# As sabotagens mexem numa CÓPIA do coletor em $TMPDIR — o arquivo do repo nunca é tocado, então
# não há o risco clássico de `restaurar()` ser `git checkout --` sobre trabalho não commitado.
#
# ── As quatro provas e a chave que cada uma sabota ────────────────────────────────────────────
#  PROVA 1 · sensibilidade em DESCENDENTE  → sabota `ANDAR_ARVORE` (lê só o PID direto)
#  PROVA 2 · a coluna lida é phys_footprint→ sabota `CAMPO_LIDO`   (troca por resident_size/RSS)
#  PROVA 3 · erro de leitura != 0 MB       → sabota `GATE_VIVO`    (acredita no rusage do zumbi)
#  PROVA 4 · pico = MÁX DA SOMA, não soma dos MÁX → sabota `PICO_DA_SOMA`
#
# ── Por que a PROVA 4 precisa de uma fixture PRÓPRIA (e por que ela FALTAVA) ───────────────────
# As três primeiras fixtures têm UM só descendente alocador. Com um só alocador as duas fórmulas
# — "máximo ao longo do tempo da soma" e "soma dos máximos por pid" — dão o MESMO número, então
# nenhuma delas distingue a fórmula certa da errada: uma mutação para `sum(max por pid)` passava o
# arnês inteiro em verde (constatado em 2026-09-07). A fixture da PROVA 4 põe DOIS descendentes
# com picos DESENCONTRADOS no tempo — o 1º aloca, segura, e SAI; só então o 2º aloca. A soma viva
# nunca passa de 1x, e a soma dos máximos dá 2x, porque guarda o pico de um processo que já morreu.
#
# ── Por que a PROVA 2 precisa de uma fixture PRÓPRIA ──────────────────────────────────────────
# Numa alocação anônima tocada, RSS e phys_footprint sobem JUNTOS — a PROVA 1 fica verde com a
# coluna trocada, e sozinha ela não prova nada sobre QUAL campo é lido. A fixture divergente soma
# 128 MiB de páginas de ARQUIVO LIMPAS (mmap read-only, tocadas): elas contam em RSS e NÃO contam
# em phys_footprint. Medido nesta máquina: mesmo processo, delta_footprint=+64 MiB estável e
# delta_RSS de +124 a +192 MiB. A prova reprova o RSS por ele ficar ALTO demais — a divergência é a
# mesma família do motivo de o coletor não usar RSS (§Métrica de scripts/medir-footprint.sh).
# O RSS é instável nos DOIS sentidos, e é por isso que a asserção complementar dessa prova compara
# contra o TETO e não contra a janela — ver o comentário dela, na §falsificação.
#
# ── Por que o zumbi (PROVA 3) é determinístico ────────────────────────────────────────────────
# Um filho morto e NÃO reapeado continua em `proc_listchildpids` e o `proc_pid_rusage` dele
# responde SUCESSO com footprint 0. É o `ausente != zero` na forma mais traiçoeira: o código de
# retorno diz "li", e o número diz "0 MB". Não é uma corrida a ser torcida — o zumbi fica de pé
# por toda a janela, então o erro aparece em TODA amostra.
#
# ── Plataforma ────────────────────────────────────────────────────────────────────────────────
# O sujeito (phys_footprint via libproc) só existe no macOS, e o CI roda ubuntu. Fora do Darwin o
# teste PULA em voz alta. DENTRO do Darwin, via ausente é VERMELHO (exit 2), nunca skip — senão
# uma libproc quebrada na M2 compraria verde por cegueira.
set -u
cd "$(dirname "$0")/.." || exit 2

COLETOR="scripts/medir-footprint.sh"
MIB=64          # alocação da fixture
JANELA_MIN=48   # a leitura tem de subir ao menos isto…
JANELA_MAX=96   # …e no máximo isto
SEG=1.0         # quanto a fixture segura a memória (≈10 amostras a 100 ms)
# O zumbi da PROVA 3 fica de pé a janela INTEIRA, então aparece em quase toda amostra. Já um alvo
# sem zumbi tem UM instante de corrida legítima: entre o filho sair e o `sh` reapeá-lo ele é um
# zumbi de verdade, e o coletor está CERTO em contá-lo. Essa corrida cabe em no máximo uma amostra
# por execução. Os dois limites abaixo separam o sinal (≈10) desse ruído estrutural (≤1) sem
# exigir um zero que a corrida quebraria — e sem afrouxar a ponto de deixar de discriminar.
ZUMBI_MIN=5     # erros_leitura mínimos no alvo COM zumbi
RUIDO_MAX=2     # erros_leitura máximos tolerados num alvo SEM zumbi

# ── PROVA 4: a janela tem de SEPARAR 1x de 2x, não caber os dois ───────────────────────────────
# Dois descendentes de 200 MiB com picos desencontrados. Medido nesta máquina em 2026-09-07:
# fórmula certa (máx da soma) → delta 200 MB; fórmula errada (soma dos máx) → delta 406 MB. A
# janela abaixo tem 40 MB de folga abaixo do sinal, 60 MB acima dele, e deixa a mutação 146 MB
# FORA do teto. Alargá-la para "caber a medição" destruiria a única coisa que ela faz.
MIB_SEQ=200     # alocação de CADA UM dos dois descendentes sequenciais
SEQ_MIN=160     # 1x: a leitura tem de subir ao menos isto…
SEQ_MAX=260     # …e no máximo isto — 2x (≈400) cai FORA

if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP — instrumento macOS-only (phys_footprint via libproc): uname=$(uname -s)"
  exit 0
fi
[ -f "$COLETOR" ] || { echo "❌ VIA_NAO_OBSERVAVEL: $COLETOR nao existe."; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "❌ VIA_NAO_OBSERVAVEL: python3 ausente."; exit 2; }

TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT

falhas=0
ok()   { printf '  ✅ %s\n' "$1"; }
ruim() { printf '  ❌ %s\n' "$1"; falhas=$((falhas+1)); }

# ── fixture: aloca e TOCA <mib> MiB; `nenhum` | `arquivo` (divergência) | `zumbi` ──────────────
cat > "$TMP/fixture.py" <<'PY'
"""uso: fixture.py <mib> <modo> <segundos> [arquivo_limpo]"""
import ctypes
import os
import subprocess
import sys
import time

mib, modo, seg = int(sys.argv[1]), sys.argv[2], float(sys.argv[3])
libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int,
                      ctypes.c_int, ctypes.c_int, ctypes.c_longlong]
MAP_ANON, MAP_PRIVATE, PROT_READ, PROT_RW = 0x1000, 0x0002, 0x1, 0x3

if mib:
    n = mib * 1024 * 1024
    p = libc.mmap(None, n, PROT_RW, MAP_ANON | MAP_PRIVATE, -1, 0)
    if not p or p == (1 << 64) - 1:
        sys.stderr.write('fixture: mmap anonimo falhou\n')
        sys.exit(3)
    ctypes.memset(ctypes.c_void_p(p), 0xAB, n)   # TOCA: alocar sem escrever não move o footprint

if modo == 'arquivo':
    # páginas de arquivo LIMPAS: entram no RSS e NÃO entram no phys_footprint
    fd = os.open(sys.argv[4], os.O_RDONLY)
    tam = os.fstat(fd).st_size
    q = libc.mmap(None, tam, PROT_READ, MAP_PRIVATE, fd, 0)
    if not q or q == (1 << 64) - 1:
        sys.stderr.write('fixture: mmap do arquivo falhou\n')
        sys.exit(3)
    vista = (ctypes.c_ubyte * tam).from_address(q)
    soma = 0
    for i in range(0, tam, 16384):
        soma += vista[i]
    with open(os.devnull, 'w') as nulo:        # impede o otimizador/GC de descartar a leitura
        nulo.write(str(soma % 7))

if modo == 'zumbi':
    filho = subprocess.Popen(['/bin/sleep', '30'])
    time.sleep(0.2)
    os.kill(filho.pid, 9)   # e NUNCA reapeia: fica zumbi na árvore até este processo sair

time.sleep(seg)
PY

# arquivo de 128 MiB para as páginas limpas da fixture divergente
ARQ_LIMPO="$TMP/limpo.bin"
dd if=/dev/urandom of="$ARQ_LIMPO" bs=1m count=128 status=none 2>/dev/null \
  || { echo "❌ VIA_NAO_OBSERVAVEL: nao consegui criar o arquivo de 128 MiB."; exit 2; }

# Os alvos. O `& wait` obriga o `sh` a FORKAR: o python3 fica DESCENDENTE, nunca a raiz
# (com um único comando o sh faria exec e a fixture viraria o próprio PID direto).
ALVO_LEVE="python3 $TMP/fixture.py 0 nenhum $SEG & wait"
ALVO_PESADO="python3 $TMP/fixture.py $MIB nenhum $SEG & wait"
ALVO_DIVERGENTE="python3 $TMP/fixture.py $MIB arquivo $SEG $ARQ_LIMPO & wait"
ALVO_ZUMBI="python3 $TMP/fixture.py $MIB zumbi $SEG & wait"
# Os dois DESENCONTRADOS da PROVA 4: o `;` garante que o 1º já SAIU quando o 2º aloca — nunca há
# 400 MiB vivos ao mesmo tempo. O `& wait` no 2º impede o `sh` de fazer exec no último comando.
ALVO_SEQUENCIAL="python3 $TMP/fixture.py $MIB_SEQ nenhum $SEG; python3 $TMP/fixture.py $MIB_SEQ nenhum $SEG & wait"

R_PICO=''; R_AMOSTRAS=''; R_ERROS=''; R_EXIT=''
# medir <coletor> <alvo> — preenche R_*. Devolve 1 se a MEDIÇÃO falhou (≠ o alvo ter falhado).
medir() {
  local rc campo
  bash "$1" sh -c "$2" > "$TMP/saida.txt" 2>"$TMP/erro.txt"
  rc=$?
  R_PICO="$(sed -n 's/^pico_mb=//p' "$TMP/saida.txt")"
  R_AMOSTRAS="$(sed -n 's/^amostras=//p' "$TMP/saida.txt")"
  R_ERROS="$(sed -n 's/^erros_leitura=//p' "$TMP/saida.txt")"
  R_EXIT="$(sed -n 's/^exit_comando=//p' "$TMP/saida.txt")"
  [ "$rc" -eq 0 ] || return 1
  for campo in "$R_PICO" "$R_AMOSTRAS" "$R_ERROS" "$R_EXIT"; do
    case "$campo" in ''|*[!0-9]*) return 1 ;; esac
  done
  [ "$R_AMOSTRAS" -gt 0 ] || return 1   # 0 amostras é ausência de dado, não medição
  [ "$R_EXIT" -eq 0 ] || return 1       # fixture que morreu não mediu o que se pensa
  return 0
}

# sabota <trecho_antigo> <trecho_novo> — cópia do coletor com UMA linha trocada; ecoa o caminho
# da cópia. Sem âncora `$` porque as chaves levam comentário na mesma linha. Os três controles
# abaixo existem para que uma sabotagem que NÃO PEGOU não possa se disfarçar de sabotagem inócua:
# aplicada, completa, e exatamente uma linha.
sabota() {
  local nome copia n
  nome="$(printf '%s' "$1" | tr -cd 'A-Z_')"
  copia="$TMP/sab-$nome.sh"
  cp "$COLETOR" "$copia"
  sed -i '' "s/^$1/$2/" "$copia"
  grep -qF -- "$2" "$copia" || {
    printf '❌ SABOTAGEM NAO APLICADA: "%s" nao casou em %s\n' "$1" "$COLETOR" >&2; exit 2; }
  if grep -qF -- "$1" "$copia"; then
    printf '❌ SABOTAGEM PARCIAL: "%s" continua no arquivo\n' "$1" >&2; exit 2
  fi
  n="$(diff "$COLETOR" "$copia" | grep -c '^< ')"
  [ "$n" -eq 1 ] || {
    printf '❌ SABOTAGEM MEXEU EM %s LINHAS (esperado 1) — alvo ambiguo\n' "$n" >&2; exit 2; }
  printf '%s\n' "$copia"
}

# ── controles: medidos UMA vez e reusados pelos dois modos ────────────────────────────────────
echo "▶ medindo os controles com o coletor REAL (5 alvos; o sequencial custa 2x ~${SEG}s)"
medir "$COLETOR" "$ALVO_LEVE"       || { echo "❌ VIA_NAO_OBSERVAVEL: medicao do alvo leve falhou."; exit 2; }
C_LEVE="$R_PICO"; C_LEVE_ERR="$R_ERROS"
medir "$COLETOR" "$ALVO_PESADO"     || { echo "❌ VIA_NAO_OBSERVAVEL: medicao do alvo pesado falhou."; exit 2; }
C_PESADO="$R_PICO"; C_PESADO_ERR="$R_ERROS"
medir "$COLETOR" "$ALVO_DIVERGENTE" || { echo "❌ VIA_NAO_OBSERVAVEL: medicao do alvo divergente falhou."; exit 2; }
C_DIVERG="$R_PICO"
medir "$COLETOR" "$ALVO_ZUMBI"      || { echo "❌ VIA_NAO_OBSERVAVEL: medicao do alvo zumbi falhou."; exit 2; }
C_ZUMBI="$R_PICO"; C_ZUMBI_ERR="$R_ERROS"
medir "$COLETOR" "$ALVO_SEQUENCIAL" || { echo "❌ VIA_NAO_OBSERVAVEL: medicao do alvo sequencial falhou."; exit 2; }
C_SEQ="$R_PICO"

D_PESADO=$(( C_PESADO - C_LEVE ))
D_DIVERG=$(( C_DIVERG - C_LEVE ))
D_SEQ=$(( C_SEQ - C_LEVE ))

na_janela()     { [ "$1" -ge "$JANELA_MIN" ] && [ "$1" -le "$JANELA_MAX" ]; }
na_janela_seq() { [ "$1" -ge "$SEQ_MIN" ]    && [ "$1" -le "$SEQ_MAX" ]; }

echo
echo "▶ PROVA 1 — ${MIB} MiB TOCADOS num DESCENDENTE elevam a leitura (janela ${JANELA_MIN}..${JANELA_MAX} MiB)"
if na_janela "$D_PESADO"; then
  ok "controle: leve=${C_LEVE}MB pesado=${C_PESADO}MB delta=${D_PESADO}MB"
else
  ruim "controle FORA da janela: leve=${C_LEVE}MB pesado=${C_PESADO}MB delta=${D_PESADO}MB"
fi

echo "▶ PROVA 2 — a coluna lida e phys_footprint (fixture com os campos DIVERGENTES)"
if na_janela "$D_DIVERG"; then
  ok "controle: divergente=${C_DIVERG}MB delta=${D_DIVERG}MB (o +128 MiB de arquivo limpo NAO entrou)"
else
  ruim "controle FORA da janela: divergente=${C_DIVERG}MB delta=${D_DIVERG}MB"
fi

echo "▶ PROVA 3 — erro de leitura nao vira zero (alvo com filho morto e nao reapeado)"
if [ "$C_ZUMBI_ERR" -ge "$ZUMBI_MIN" ]; then
  ok "controle: erros_leitura=${C_ZUMBI_ERR} no alvo com zumbi (minimo ${ZUMBI_MIN})"
else
  ruim "controle: erros_leitura=${C_ZUMBI_ERR} com um zumbi de pe a janela inteira — o contador nao esta vendo o morto"
fi
if [ "$C_ZUMBI" -ge "$JANELA_MIN" ]; then
  ok "controle: pico_mb=${C_ZUMBI}MB NAO caiu para 0 apesar do erro de leitura"
else
  ruim "controle: pico_mb=${C_ZUMBI}MB — o erro de leitura derrubou o pico"
fi
# Contador sempre-ligado aprovaria a prova por vacuidade: os alvos SEM zumbi têm de ficar no ruído.
if [ "$C_LEVE_ERR" -le "$RUIDO_MAX" ] && [ "$C_PESADO_ERR" -le "$RUIDO_MAX" ]; then
  ok "controle: erros_leitura=${C_LEVE_ERR}/${C_PESADO_ERR} nos alvos SEM zumbi (<= ${RUIDO_MAX}: o contador nao e ruido constante)"
else
  ruim "erros_leitura=${C_LEVE_ERR}/${C_PESADO_ERR} sem zumbi algum — contador sempre-ligado nao discrimina"
fi

echo "▶ PROVA 4 — pico = MAXIMO DA SOMA viva, nao soma dos MAXIMOS (2 descendentes DESENCONTRADOS)"
if na_janela_seq "$D_SEQ"; then
  ok "controle: sequencial=${C_SEQ}MB delta=${D_SEQ}MB ~= 1x ${MIB_SEQ} MiB (janela ${SEQ_MIN}..${SEQ_MAX}); os 2x${MIB_SEQ} MiB nunca viveram juntos"
else
  ruim "controle FORA da janela: sequencial=${C_SEQ}MB delta=${D_SEQ}MB — esperado ~1x ${MIB_SEQ} MiB (janela ${SEQ_MIN}..${SEQ_MAX})"
fi

if [ "${1:-}" = "--falsificar" ]; then
# ══ FALSIFICAÇÃO ══ só passa daqui com TODOS os controles verdes: sabotar sobre vermelho
# aprovaria qualquer coisa, e uma prova sempre-vermelha não distingue nada.
echo
if [ "$falhas" -ne 0 ]; then
  echo "❌ falsificacao ABORTADA: $falhas controle(s) ja vermelho(s) — conserte antes de sabotar."
  exit 1
fi
echo "== falsificacao: cada chave sabotada numa COPIA; o coletor do repo nao e tocado =="

# ── SABOTAGEM 1: lê só o PID direto ───────────────────────────────────────────────────────────
SAB1="$(sabota 'ANDAR_ARVORE = True' 'ANDAR_ARVORE = False')" || exit 2
if medir "$SAB1" "$ALVO_LEVE"; then S1_LEVE="$R_PICO"; else S1_LEVE=''; fi
if medir "$SAB1" "$ALVO_PESADO"; then S1_PESADO="$R_PICO"; else S1_PESADO=''; fi
if [ -z "$S1_LEVE" ] || [ -z "$S1_PESADO" ]; then
  ruim "SAB1: a medicao sabotada nao completou — nao da para dizer se a prova pegou"
elif na_janela "$(( S1_PESADO - S1_LEVE ))"; then
  ruim "SAB1 PASSOU VERDE: so-a-raiz deu delta=$(( S1_PESADO - S1_LEVE ))MB, dentro da janela — a PROVA 1 nao ve a arvore"
else
  ok "SAB1 (ANDAR_ARVORE=False): delta caiu para $(( S1_PESADO - S1_LEVE ))MB -> PROVA 1 VERMELHA"
fi

# ── SABOTAGEM 2: troca a coluna lida por RSS ──────────────────────────────────────────────────
SAB2="$(sabota 'CAMPO_LIDO = "phys_footprint"' 'CAMPO_LIDO = "resident_size"')" || exit 2
if medir "$SAB2" "$ALVO_LEVE"; then S2_LEVE="$R_PICO"; else S2_LEVE=''; fi
if medir "$SAB2" "$ALVO_DIVERGENTE"; then S2_DIV="$R_PICO"; else S2_DIV=''; fi
if medir "$SAB2" "$ALVO_PESADO"; then S2_PESADO="$R_PICO"; else S2_PESADO=''; fi
if [ -z "$S2_LEVE" ] || [ -z "$S2_DIV" ]; then
  ruim "SAB2: a medicao sabotada nao completou — nao da para dizer se a prova pegou"
elif na_janela "$(( S2_DIV - S2_LEVE ))"; then
  ruim "SAB2 PASSOU VERDE: com RSS o delta divergente deu $(( S2_DIV - S2_LEVE ))MB, dentro da janela.
       Ou a coluna nao esta sendo lida de fato, ou a fixture parou de divergir — NAO ajuste a janela."
else
  ok "SAB2 (CAMPO_LIDO=resident_size): delta divergente virou $(( S2_DIV - S2_LEVE ))MB -> PROVA 2 VERMELHA"
fi
# Complementar da PROVA 2 — e repare no `-le`, que NÃO é a janela: sob pressão de memória o macOS
# COMPRIME as páginas anônimas tocadas, e o RSS, que não conta o compressor, DESPENCA. Medido em
# 2026-09-07 na mesma fixture, 8 repetições: delta_RSS oscilou de **-1 a 65 MB** (uma leitura pegou
# os 64 MiB inteiramente comprimidos) enquanto o delta_footprint ficou cravado em 63-64. Exigir que
# o RSS COINCIDA com o footprint aqui seria exigir do instrumento REJEITADO a estabilidade que ele
# não tem — e reprovava ~1 execução em 3 nesta máquina. O que a PROVA 2 isola é o SENTIDO do erro:
# só a fixture de ARQUIVO faz o RSS ficar ALTO DEMAIS. A anônima erra para baixo, ou acerta.
if [ -z "$S2_PESADO" ] || [ -z "$S2_LEVE" ]; then
  ruim "a medicao da fixture NAO divergente sob RSS nao completou — complementar da PROVA 2 sem dado (ausente != verde)"
elif [ "$(( S2_PESADO - S2_LEVE ))" -le "$JANELA_MAX" ]; then
  ok "…e a fixture NAO divergente NAO estoura o teto sob RSS ($(( S2_PESADO - S2_LEVE ))MB <= ${JANELA_MAX}) — o EXCESSO de RSS e exclusivo da fixture de arquivo, e e por isso que a PROVA 2 tem fixture propria"
else
  ruim "a fixture NAO divergente tambem estourou o teto sob RSS ($(( S2_PESADO - S2_LEVE ))MB > ${JANELA_MAX}) — entao a PROVA 2 nao esta isolando o que diz isolar"
fi

# ── SABOTAGEM 3: acredita no rusage do zumbi ──────────────────────────────────────────────────
SAB3="$(sabota 'GATE_VIVO = True' 'GATE_VIVO = False')" || exit 2
if medir "$SAB3" "$ALVO_ZUMBI"; then
  if [ "$R_ERROS" -ge "$ZUMBI_MIN" ]; then
    ruim "SAB3 PASSOU VERDE: sem o gate de vida ainda houve erros_leitura=$R_ERROS — o gate nao e o que conta o morto"
  else
    ok "SAB3 (GATE_VIVO=False): erros_leitura ${C_ZUMBI_ERR} -> ${R_ERROS}, com o zumbi lendo 0 MB em silencio -> PROVA 3 VERMELHA"
  fi
else
  ruim "SAB3: a medicao sabotada nao completou — nao da para dizer se a prova pegou"
fi

# ── SABOTAGEM 4: troca a formula do pico por "soma dos maximos por pid" ────────────────────────
SAB4="$(sabota 'PICO_DA_SOMA = True' 'PICO_DA_SOMA = False')" || exit 2
if medir "$SAB4" "$ALVO_LEVE";       then S4_LEVE="$R_PICO";   else S4_LEVE=''; fi
if medir "$SAB4" "$ALVO_SEQUENCIAL"; then S4_SEQ="$R_PICO";    else S4_SEQ=''; fi
if medir "$SAB4" "$ALVO_PESADO";     then S4_PESADO="$R_PICO"; else S4_PESADO=''; fi
if [ -z "$S4_LEVE" ] || [ -z "$S4_SEQ" ]; then
  ruim "SAB4: a medicao sabotada nao completou — nao da para dizer se a prova pegou"
elif na_janela_seq "$(( S4_SEQ - S4_LEVE ))"; then
  ruim "SAB4 PASSOU VERDE: a soma dos maximos deu delta=$(( S4_SEQ - S4_LEVE ))MB, dentro da janela.
       Ou a formula nao esta sendo aplicada, ou os dois descendentes deixaram de se DESENCONTRAR
       no tempo (o 1o tem de SAIR antes de o 2o alocar) — NAO ajuste a janela."
else
  ok "SAB4 (PICO_DA_SOMA=False): delta virou $(( S4_SEQ - S4_LEVE ))MB (~2x de ${MIB_SEQ}) -> PROVA 4 VERMELHA"
fi
if [ -n "$S4_PESADO" ] && [ -n "$S4_LEVE" ] && na_janela "$(( S4_PESADO - S4_LEVE ))"; then
  ok "…e sobre a fixture de UM SO alocador a mesma troca fica VERDE ($(( S4_PESADO - S4_LEVE ))MB) — e por isso que a PROVA 4 tem fixture propria: com um alocador as duas formulas coincidem"
else
  ruim "a fixture de um so alocador reagiu a troca de formula — entao a PROVA 4 nao esta isolando o que diz isolar"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "✅ falsificacao: as 4 provas reagem a sabotagem da chave que cada uma vigia"; exit 0
else
  echo "❌ falsificacao: $falhas problema(s) — uma prova que nao pega a sabotagem NAO aprova o coletor"; exit 1
fi
fi

echo
echo "   (contrato: bash scripts/test-medir-footprint.sh --falsificar sabota as 4 chaves)"
if [ "$falhas" -eq 0 ]; then echo "✅ medir-footprint: os 4 controles verdes"; exit 0
else echo "❌ medir-footprint: $falhas controle(s) vermelho(s)"; exit 1; fi
