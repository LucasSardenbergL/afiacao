#!/usr/bin/env bash
# test-claude-mem-saude.sh — suite do scripts/claude-mem-saude.sh (o sensor "o claude-mem esta
# GRAVANDO?") e da fiacao dele no SessionStart (bloco 6 do .claude/hooks/vigia-worktree.sh).
#
# Hermetica: CLAUDE_MEM_DATA_DIR aponta para um temporario com banco e contador FABRICADOS (nunca
# o ~/.claude-mem real), e os tempos das fixtures sao relativos ao `date +%s` desta execucao.
# Cada caso tem ROTULO; a falsificacao exige que cada sabotagem derrube o caso que a vigia — nao
# "algum" caso (vermelho pelo motivo errado conta como verde mentiroso).
#
# Uso: bash scripts/test-claude-mem-saude.sh              (exit 0 = tudo verde)
#      bash scripts/test-claude-mem-saude.sh --falsificar (sabota sensor e hook; EXIGE vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${CLAUDE_MEM_SAUDE_ALVO:-$here/claude-mem-saude.sh}"
VIGIA="${VIGIA_ALVO:-$here/../.claude/hooks/vigia-worktree.sh}"
BASH_BIN="$(command -v bash)"

# ---------------------------------------------------------------------------- falsificacao
# shellcheck disable=SC2016  # aspas simples de proposito nas expressoes sed: os `$` sao o TEXTO que
# elas procuram DENTRO do alvo; expandir escreveria um padrao que nao casa (a trava 2 pega).
if [ "${1:-}" = "--falsificar" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  LOCALES="C"
  if locale -a 2>/dev/null | grep -qiE '^pt_BR\.utf-?8$'; then
    LOCALES="C pt_BR.UTF-8"
  else
    echo "(pt_BR.UTF-8 nao existe neste sistema: so o locale C roda aqui — o 2o locale NAO foi provado nesta maquina)"
  fi
  falhou=0
  printf '== falsificacao do claude-mem-saude (sabota sensor e hook; EXIGE vermelho no caso certo) ==\n'

  # (0) CONTROLE antes do 1o sed: a MESMA invocacao (copias dos DOIS alvos, os overrides, LC_ALL)
  # sem sabotagem tem de ficar VERDE — senao todo "vermelho" abaixo e vermelho por tabela.
  cp "$ALVO" "$tmp/controle-sensor.sh"
  cp "$VIGIA" "$tmp/controle-vigia.sh"
  for loc in $LOCALES; do
    if LC_ALL="$loc" CLAUDE_MEM_SAUDE_ALVO="$tmp/controle-sensor.sh" VIGIA_ALVO="$tmp/controle-vigia.sh" \
      "$BASH_BIN" "$0" >"$tmp/controle-$loc.txt" 2>&1; then
      printf '  ok    [%-11s] controle (sem sabotagem) -> VERDE\n' "$loc"
    else
      printf '  FALHA [%-11s] controle SEM sabotagem ja esta VERMELHO — sem linha de base, falsificar nao prova nada\n' "$loc"
      grep 'FALHA' "$tmp/controle-$loc.txt" | head -5
      falhou=1
    fi
  done
  if [ "$falhou" -ne 0 ]; then
    echo "== falsificacao ABORTADA: sem verde de partida =="
    exit 1
  fi

  N=0
  sabota() { # alvo (sensor|vigia) · nome · rotulo do caso que TEM de ficar vermelho · expressao sed
    SALVO[N]="$1"; SNOME[N]="$2"; SCASO[N]="$3"; SEXPR[N]="$4"; N=$((N + 1))
  }
  sabota sensor "contador nunca acusa" "C contador-ativo" \
    's/^  elif \[ "\$n" -eq 0 \]; then$/  elif true; then/'
  sabota sensor "contador ausente vira limpo" "F contador-ausente" \
    's/cont=NAO_MEDI; cont_txt="NAO MEDI o contador (sem state/cont=LIMPO; cont_txt="x (sem state/'
  sabota sensor "contador ilegivel vira limpo" "G contador-ilegivel" \
    's/cont=NAO_MEDI; cont_txt="NAO MEDI o contador (hook-failures.json/cont=LIMPO; cont_txt="x (hook-failures.json/'
  sabota sensor "sem portao fora-de-uso no contador" "D contador-fora-de-uso" \
    's/if \[ "\$idade" -gt "\$EM_USO_S" \]; then/if false; then/'
  sabota sensor "contador sem hora silencia" "E contador-sem-hora" \
    's/cont=ACHADO; cont_txt="\$n FALHAS DE HOOK seguidas (hora/cont=LIMPO; cont_txt="x (hora/'
  sabota sensor "limiar de prompts frouxo" "I1 limiar-29-silencia" 's/^PROMPTS_MIN=30$/PROMPTS_MIN=1/'
  sabota sensor "limiar de prompts surdo" "H memoria-morta" 's/^PROMPTS_MIN=30$/PROMPTS_MIN=99999/'
  sabota sensor "sem janela minima" "J rajada-silencia" 's/^JANELA_S=3600$/JANELA_S=0/'
  sabota sensor "sem portao em-uso na gravacao" "K parada-silencia" \
    's/ \] \&\& \[ "\$parado" -le "\$EM_USO_S" \]; then/ ]; then/'
  sabota sensor "sqlite3 ausente vira limpo" "L sqlite-ausente" \
    's/grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (sqlite3 fora do PATH)"/grav=LIMPO; grav_txt=x/'
  sabota sensor "sqlite3 com erro vira limpo" "M sqlite-quebrado" \
    's/grav=NAO_MEDI; grav_txt="NAO MEDI a gravacao (sqlite3 falhou/grav=LIMPO; grav_txt="x (/'
  sabota sensor "resposta inesperada aceita" "T resposta-inesperada" \
    's/if ! inteiro "\$total" || ! inteiro "\$obs" || ! inteiro "\$ult" || ! inteiro "\$depois" || ! inteiro "\$prim"; then/if false; then/'
  sabota sensor "contador NAO MEDI sai 0" "F contador-ausente" 's/^\[ "\$cont" = NAO_MEDI \] \&\& rc=3$/:/'
  sabota sensor "gravacao NAO MEDI sai 0" "L sqlite-ausente" 's/^\[ "\$grav" = NAO_MEDI \] \&\& rc=3$/:/'
  sabota sensor "resumo fala a toa" "B saudavel-silencia" \
    's/^  \[ -z "\$saida" \] || echo "claude-mem: \$saida"$/  echo "claude-mem: $saida"/'
  sabota sensor "achado em duas linhas" "Q uma-linha" \
    's/^  \[ -z "\$saida" \] || echo "claude-mem: \$saida"$/  [ -z "$saida" ] || printf "claude-mem: %s\\n" "$cont_txt" "$grav_txt"/'
  # a fiacao no SessionStart (so dentro do bloco 6: o bloco 5 tem linhas iguais)
  sabota vigia "hook sem o bloco 6" "U vigia-achado" \
    's/^if \[ -f scripts\/claude-mem-saude.sh \]; then$/if false; then/'
  sabota vigia "hook descarta o achado" "U vigia-achado" \
    '/^# --- 6)/,/^# --- saída/s/^    avisos="\${avisos}\${mem} "$/    :/'
  sabota vigia "hook cala a sonda que nao mediu" "W vigia-sonda-muda" \
    '/^# --- 6)/,/^# --- saída/s/^  elif \[ "\$rc" -ne 0 \]; then$/  elif false; then/'

  # travas: (1) sed invalido (2) nao casou (3) sintaxe quebrada — antes de rodar
  PRONTAS=""
  i=0
  while [ "$i" -lt "$N" ]; do
    if [ "${SALVO[i]}" = vigia ]; then orig="$VIGIA"; else orig="$ALVO"; fi
    copia="$tmp/sabotado-$i.sh"
    erro="$(sed "${SEXPR[i]}" "$orig" 2>&1 >"$copia")"
    if [ -n "$erro" ]; then
      printf '  FALHA "%s": sed invalido (%s) — falsificacao vazia\n' "${SNOME[i]}" "${erro:0:60}"; falhou=1
    elif cmp -s "$orig" "$copia"; then
      printf '  FALHA "%s": padrao nao casou, alvo intacto — falsificacao vazia\n' "${SNOME[i]}"; falhou=1
    elif ! bash -n "$copia" 2>/dev/null; then
      printf '  FALHA "%s": quebrou a SINTAXE do shell — vermelho pelo motivo errado\n' "${SNOME[i]}"; falhou=1
    else
      PRONTAS="$PRONTAS $i"
    fi
    i=$((i + 1))
  done
  # (4) cada sabotagem, em cada locale, em paralelo (a suite e hermetica: um mktemp por execucao);
  # o alvo NAO sabotado roda a partir da copia de controle, igual ao controle
  for i in $PRONTAS; do
    if [ "${SALVO[i]}" = vigia ]; then
      sensor="$tmp/controle-sensor.sh"; vigia="$tmp/sabotado-$i.sh"
    else
      sensor="$tmp/sabotado-$i.sh"; vigia="$tmp/controle-vigia.sh"
    fi
    for loc in $LOCALES; do
      while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge 4 ]; do sleep 0.2; done
      (
        LC_ALL="$loc" CLAUDE_MEM_SAUDE_ALVO="$sensor" VIGIA_ALVO="$vigia" "$BASH_BIN" "$0" >"$tmp/res-$i-$loc.txt" 2>&1
        echo "RC=$?" >>"$tmp/res-$i-$loc.txt"
      ) &
    done
  done
  wait
  for i in $PRONTAS; do
    for loc in $LOCALES; do
      r="$tmp/res-$i-$loc.txt"
      if grep -qx 'RC=0' "$r"; then
        printf '  FALHA [%-11s] "%s" passou VERDE — a suite nao cobre esta regra\n' "$loc" "${SNOME[i]}"; falhou=1
      elif ! grep -qF -- "FALHA ${SCASO[i]}:" "$r"; then
        printf '  FALHA [%-11s] "%s" ficou vermelho pelo MOTIVO ERRADO (esperava o caso "%s"): %s\n' "$loc" "${SNOME[i]}" "${SCASO[i]}" \
          "$(grep -m1 'FALHA' "$r" | sed 's/^ *//' | cut -c1-80)"
        falhou=1
      else
        printf '  ok    [%-11s] "%s" -> vermelho em "%s"\n' "$loc" "${SNOME[i]}" "${SCASO[i]}"
      fi
    done
  done
  if [ "$falhou" -ne 0 ]; then
    echo "== falsificacao VERMELHA: alguma regra do sensor/hook nao e coberta pela suite =="
    exit 1
  fi
  echo "== falsificacao VERDE: $N sabotagens, todas pegas pelo caso certo (locales: $LOCALES) =="
  exit 0
fi

# ---------------------------------------------------------------------------- fixtures
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
AGORA="$(date +%s)"
falhas=0
ok() { printf '  ok    %s\n' "$1"; }
falha() { printf '  FALHA %s\n' "$1"; falhas=$((falhas + 1)); }

ms() { echo $(((AGORA - $1) * 1000)); } # ms <segundos atras> -> epoch em ms
novo() { rm -rf "${T:?}/${1:?}"; mkdir -p "$T/$1/state"; D="$T/$1"; }
contador() { printf '{"consecutiveFailures":%s,"lastFailureAt":%s}' "$1" "$2" >"$D/state/hook-failures.json"; }
# banco <obs: segundos atras | nenhuma> <n prompts> <1o prompt: s atras> <ultimo: s atras>
banco() {
  local obs="$1" n="$2" ini="$3" fim="$4" i=0 t
  {
    echo "create table observations(id integer primary key, created_at_epoch integer not null);"
    echo "create table user_prompts(id integer primary key, created_at_epoch integer not null);"
    [ "$obs" = nenhuma ] || echo "insert into observations(created_at_epoch) values ($(ms "$obs"));"
    while [ "$i" -lt "$n" ]; do
      if [ "$n" -gt 1 ]; then t=$((ini - (ini - fim) * i / (n - 1))); else t=$ini; fi
      echo "insert into user_prompts(created_at_epoch) values ($(ms "$t"));"
      i=$((i + 1))
    done
  } | sqlite3 "$D/claude-mem.db"
}
saudavel() { banco 600 5 540 300; } # observacao ha 10 min, 5 prompts depois dela
# roda [PATH] -> OUT (stdout) e RC; o stderr nao entra (o hook o descarta)
roda() {
  if [ -n "${1:-}" ]; then
    OUT="$(PATH="$1" CLAUDE_MEM_DATA_DIR="$D" "$BASH_BIN" "$ALVO" --resumo 2>/dev/null)"
  else
    OUT="$(CLAUDE_MEM_DATA_DIR="$D" "$BASH_BIN" "$ALVO" --resumo 2>/dev/null)"
  fi
  RC=$?
}
# confere <rotulo> <rc esperado> <texto que TEM de aparecer | - para exigir SILENCIO> [texto proibido]
confere() {
  local rot="$1" rce="$2" tem="$3" nao="${4:-}" bom=1 esp
  [ "$RC" = "$rce" ] || bom=0
  if [ "$tem" = - ]; then [ -z "$OUT" ] || bom=0; esp="SILENCIO"
  else printf '%s' "$OUT" | grep -qF -- "$tem" || bom=0; esp="[$tem]"; fi
  if [ -n "$nao" ] && printf '%s' "$OUT" | grep -qF -- "$nao"; then bom=0; fi
  if [ "$bom" = 1 ]; then ok "$rot"; else falha "$rot: esperava rc=$rce e $esp; veio rc=$RC saida=[$(printf '%s' "$OUT" | head -c 160)]"; fi
}

echo "== claude-mem-saude ($(basename "$ALVO")) =="
D="$T/nao-existe"; roda
confere "A sem-diretorio" 0 -

novo b; contador 0 0; saudavel; roda
confere "B saudavel-silencia" 0 -

novo c; contador 4 "$(ms 720)"; saudavel; roda
confere "C contador-ativo" 0 "4 FALHAS DE HOOK seguidas, a ultima ha 12min" "NAO GRAVA"

novo d; contador 4 "$(ms 432000)"; saudavel; roda
confere "D contador-fora-de-uso" 0 -

novo e; printf '{"consecutiveFailures":4}' >"$D/state/hook-failures.json"; saudavel; roda
confere "E contador-sem-hora" 0 "4 FALHAS DE HOOK seguidas (hora da ultima ilegivel)"

novo f; saudavel; roda
confere "F contador-ausente" 3 "NAO MEDI o contador" "NAO MEDI a gravacao"

novo g; printf '{"consecutiveFailures":"x","lastFailureAt":1}' >"$D/state/hook-failures.json"; saudavel; roda
confere "G contador-ilegivel" 3 "NAO MEDI o contador"

# o incidente medido em 2026-09-25: observacao de 60 dias atras e prompts sendo gravados
novo h; contador 0 0; banco 5184000 40 7200 600; roda
confere "H memoria-morta" 0 "a memoria NAO GRAVA ha 60d: 40 prompts desde a ultima observacao" "FALHAS DE HOOK"

# o limiar e 30 (o maior trecho normal medido teve 11): 29 cala, 30 acusa
novo i1; contador 0 0; banco 5184000 29 7800 600; roda
confere "I1 limiar-29-silencia" 0 -
novo i2; contador 0 0; banco 5184000 30 7800 600; roda
confere "I2 limiar-30-acusa" 0 "NAO GRAVA"

# 40 prompts em 20 min: ainda podem estar na fila do gerador — nao e alarme
novo j; contador 0 0; banco 5184000 40 1500 300; roda
confere "J rajada-silencia" 0 -

# 40 prompts espalhados, mas o ultimo ha 4 dias: fora de uso (plugin desligado / maquina parada)
novo k; contador 0 0; banco 5184000 40 352800 345600; roda
confere "K parada-silencia" 0 -

# sonda ausente: PATH so com o que o sensor usa, MENOS o sqlite3
novo l; contador 0 0; saudavel
mkdir -p "$T/sem-sqlite"
for t in date sed awk head cut; do ln -sf "$(command -v "$t")" "$T/sem-sqlite/$t"; done
roda "$T/sem-sqlite"
confere "L sqlite-ausente" 3 "NAO MEDI a gravacao (sqlite3 fora do PATH)"

# sonda presente-porem-quebrada (banco travado): o erro NAO pode virar "gravando"
novo m; contador 0 0; saudavel
mkdir -p "$T/sqlite-quebrado"
printf '#!/bin/sh\necho "Error: database is locked" >&2\nexit 1\n' >"$T/sqlite-quebrado/sqlite3"; chmod +x "$T/sqlite-quebrado/sqlite3"
roda "$T/sqlite-quebrado:$PATH"
confere "M sqlite-quebrado" 3 "NAO MEDI a gravacao (sqlite3 falhou: Error: database is locked)"

novo n; contador 0 0; roda
confere "N banco-ausente" 3 "NAO MEDI a gravacao (sem claude-mem.db"

# esquema de outra versao do plugin (sem user_prompts): consulta falha -> NAO MEDI, nunca "ok"
novo o; contador 0 0
sqlite3 "$D/claude-mem.db" "create table observations(id integer primary key, created_at_epoch integer);"
roda
confere "O esquema-outro" 3 "NAO MEDI a gravacao (sqlite3 falhou"

novo p; contador 4 "$(ms 720)"; banco 5184000 40 7200 600; roda
confere "P dois-achados" 0 "FALHAS DE HOOK"
confere "P2 dois-achados-gravacao" 0 "NAO GRAVA"
# a linha do hook e UMA: duas linhas no additionalContext viram dois avisos soltos
if [ -n "$OUT" ] && [ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 1 ]; then ok "Q uma-linha"
else falha "Q uma-linha: a saida do --resumo tem $(printf '%s\n' "$OUT" | wc -l | tr -d ' ') linhas"; fi

novo r; contador 0 0; banco nenhuma 40 7200 600; roda
confere "R nunca-gravou" 0 "40 prompts e nenhuma observacao jamais gravada"

novo s; contador 0 0; banco 5184000 40 7200 600
OUT="$(CLAUDE_MEM_DATA_DIR="$D" "$BASH_BIN" "$ALVO" 2>/dev/null)"; RC=$?
confere "S relatorio" 0 "gravacao: [ACHADO] a memoria NAO GRAVA"

# sqlite3 que responde lixo com exit 0: so a validacao dos inteiros separa isto de "gravando"
novo t; contador 0 0; saudavel
mkdir -p "$T/sqlite-lixo"
printf '#!/bin/sh\necho "abc|def"\nexit 0\n' >"$T/sqlite-lixo/sqlite3"; chmod +x "$T/sqlite-lixo/sqlite3"
roda "$T/sqlite-lixo:$PATH"
confere "T resposta-inesperada" 3 "NAO MEDI a gravacao (resposta inesperada do sqlite3"

# ---------------------------------------------------------------------------- fiacao no hook
# O bloco 6 do vigia-worktree.sh roda a sonda do diretorio corrente, como os blocos 4 e 5. Sandbox:
# package.json + node_modules calam o bloco 1; sem heavy-install.sh nem orfaos-custosos.sh, os
# blocos 4 e 5 ficam de fora. Ancoras ASCII de caixa fixa (#1483).
SB="$T/sandbox"
mkdir -p "$SB/scripts" "$SB/node_modules"
echo '{}' >"$SB/package.json"
cp "$ALVO" "$SB/scripts/claude-mem-saude.sh"
vigia() { # vigia <DATA> -> OUT (o JSON do hook) e CTX (o additionalContext)
  OUT="$(cd "$SB" && CLAUDE_MEM_DATA_DIR="$1" "$BASH_BIN" "$VIGIA" 2>/dev/null)"
  CTX="$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
}
json_ok() { printf '%s' "$OUT" | jq -e 'type == "object"' >/dev/null 2>&1; }

novo u; contador 4 "$(ms 600)"; saudavel; vigia "$D"
if printf '%s' "$CTX" | grep -qF "claude-mem: 4 FALHAS DE HOOK"; then ok "U vigia-achado"
else falha "U vigia-achado: o aviso do sensor NAO chegou ao SessionStart: [$(printf '%s' "$OUT" | head -c 200)]"; fi

novo v; contador 0 0; saudavel; vigia "$D"
if json_ok && ! printf '%s' "$CTX" | grep -qF "claude-mem"; then ok "V vigia-limpo"
else falha "V vigia-limpo: falou do claude-mem sem achado (ou JSON invalido): [$(printf '%s' "$OUT" | head -c 200)]"; fi

# sonda que saiu != 0 SEM texto = a medicao nem rodou: o hook tem de dizer FALTA DE DADO
printf '#!/usr/bin/env bash\nexit 7\n' >"$SB/scripts/claude-mem-saude.sh"
vigia "$D"
if printf '%s' "$CTX" | grep -qF "medir o claude-mem" && printf '%s' "$CTX" | grep -qF "FALTA DE DADO"; then ok "W vigia-sonda-muda"
else falha "W vigia-sonda-muda: sonda que nao mediu virou silencio: [$(printf '%s' "$OUT" | head -c 200)]"; fi

# worktree anterior a sonda: o hook degrada (JSON valido), nao quebra
rm -f "$SB/scripts/claude-mem-saude.sh"
vigia "$D"
if json_ok && ! printf '%s' "$CTX" | grep -qF "claude-mem"; then ok "X vigia-sem-sonda"
else falha "X vigia-sem-sonda: sem a sonda o hook quebrou ou inventou aviso: [$(printf '%s' "$OUT" | head -c 200)]"; fi

echo
if [ "$falhas" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU — $falhas caso(s)"; fi
exit "$falhas"
