#!/usr/bin/env bash
# test-initdb-template.sh — prova do `initdb` com template de cluster (db/lib/initdb-template.sh).
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║   bash db/test-initdb-template.sh                                                            ║
# ║   bash db/test-initdb-template.sh --falsificar   # sabota uma CÓPIA do shim, exige vermelho  ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
# O shim do job `provas-sql` troca ~3.200 `initdb` por run por `cp -a` de um cluster recém-criado.
# A troca só vale se o cluster copiado for o MESMO que o initdb real daria para AQUELES argumentos.
# Esta prova chama o shim direto (com o initdb real por baixo, nunca o shim do PGBIN) e confere,
# subindo o cluster, o que cada argumento da chave decide: locale, superusuário, a saída repetida,
# e os caminhos em que ele TEM de cair no initdb real (diretório não-vazio, argumento desconhecido,
# template desligado). docs/historico/ci-provas-sql-initdb-template.md
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM_FONTE="$REPO_ROOT/db/lib/initdb-template.sh"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="locale_fora_da_chave:A4 usuario_fora_da_chave:A5 saida_sem_trocar_o_D:A6 aceita_dir_nao_vazio:A7 ignora_argumento_desconhecido:A8 desligado_ignorado:A10"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-initdb-template.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); tail -5 "$LOGDIR/$s.log"; continue
    fi
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1)); tail -8 "$LOGDIR/$s.log"
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
# No CI o PGBIN é o PRÓPRIO shim: o initdb real é o do diretório verdadeiro do pg_ctl.
_resolve() { local f="$1" d; while [ -L "$f" ]; do d="$(dirname "$f")"; f="$(readlink "$f")"; case "$f" in /*) ;; *) f="$d/$f" ;; esac; done; printf '%s' "$f"; }
REAL_DIR="$(dirname "$(_resolve "$PGBIN/pg_ctl")")"
if ! [ -x "$REAL_DIR/initdb" ] || grep -q initdb-template "$REAL_DIR/initdb" 2>/dev/null; then
  echo "ERRO: initdb real não encontrado ao lado de $(_resolve "$PGBIN/pg_ctl")"; exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/initdb-template.XXXXXX")"
PORT="${PGPORT_TEST:-55891}"
SOCK="$(mktemp -d /tmp/itpl.XXXXXX)"   # curto: o socket Unix tem teto de ~100 bytes
SHIM="$TMP/initdb-template.sh"
cp "$SHIM_FONTE" "$SHIM"
cleanup() {
  for d in "$TMP"/c/*; do [ -f "$d/postmaster.pid" ] && "$REAL_DIR/pg_ctl" -D "$d" stop -m immediate >/dev/null 2>&1; done
  rm -rf "$TMP" "$SOCK"
}
trap cleanup EXIT

# ---- sabotagem: sempre numa CÓPIA, e a cópia TEM de ter mudado -----------------------------
_sabota() { # perl-regex
  perl -0pi -e "$1" "$SHIM"
  if cmp -s "$SHIM" "$SHIM_FONTE"; then echo "ERRO: a sabotagem $SABOTAGEM não mudou o shim (regex podre)"; exit 2; fi
}
# shellcheck disable=SC2016  # as regex casam o TEXTO do shim: o `$` é literal de propósito
case "${SABOTAGEM:-}" in
  "") ;;
  locale_fora_da_chave)          _sabota 's/--locale=\*\) chave\+=\("\$a"\) ;;/--locale=*) ;;/' ;;
  usuario_fora_da_chave)         _sabota 's/-U\|-E\|-A\|-c\)/-U) i=\$((i + 1)) ;;\n    -E|-A|-c)/' ;;
  saida_sem_trocar_o_D)          _sabota 's/"\$\{out\/\/"\$marca"\/\$dir_arg\}"/"\$out"/' ;;
  aceita_dir_nao_vazio)          _sabota 's/\[ -d "\$dir" \] && \[ -z "\$\(ls -A "\$dir" 2>\/dev\/null\)" \] \|\| _real "\$@"/:/' ;;
  ignora_argumento_desconhecido) _sabota 's/\*\) _real "\$@" ;;/*) ;;/' ;;
  desligado_ignorado)            _sabota 's/if \[ "\$\{INITDB_TEMPLATE:-1\}" = 0 \] \|\| /if /' ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

PASS=0; FAIL=0
eq() { # id descrição obtido esperado
  if [ "$3" = "$4" ]; then PASS=$((PASS+1)); echo "  ✅ $1 $2";
  else FAIL=$((FAIL+1)); echo "FAIL $1 $2 — obtido [$3] esperado [$4]"; fi
}

export INITDB_TEMPLATE_DIR="$TMP/tpl" INITDB_TEMPLATE_LOG="$TMP/log.tsv" INITDB_REAL="$REAL_DIR"
unset INITDB_TEMPLATE
mkdir -p "$TMP/c"
FLAGS=(--no-sync -c fsync=off -c full_page_writes=off)   # as mesmas que o shim do ci.yml acrescenta
ini() { bash "$SHIM" "$@" "${FLAGS[@]}"; }
modo() { sed -n "${1}p" "$INITDB_TEMPLATE_LOG" | cut -f1; }
# sobe o cluster, roda uma consulta, derruba
q() { # dir sql [usuario]
  # LC_ALL=C no postmaster: no macOS, sem locale válido no ambiente ele morre no start
  LC_ALL=C "$REAL_DIR/pg_ctl" -D "$1" -l "$1.log" -w start -o "-p $PORT -k $SOCK -c listen_addresses=''" >/dev/null 2>&1 \
    || { echo "(cluster $1 não subiu: $(tail -c 300 "$1.log" 2>/dev/null))"; return 0; }
  "$REAL_DIR/psql" -X -A -t -h "$SOCK" -p "$PORT" -U "${3:-postgres}" -d postgres -c "$2" 2>&1 | tr -d '\r'
  "$REAL_DIR/pg_ctl" -D "$1" -m immediate stop >/dev/null 2>&1
}

echo "── A1-A3 mesma chave: 1ª gera o template, 2ª copia, o cluster copiado é o pedido"
ini -D "$TMP/c/a" -U postgres -E UTF8 --locale=C > "$TMP/a.out" 2>&1
ini -D "$TMP/c/b" -U postgres -E UTF8 --locale=C > "$TMP/b.out" 2>&1; rc_b=$?
eq A1 "1ª chamada roda o initdb real e grava o template" "$(modo 1)" "real-gera"
eq A2 "2ª chamada com a mesma chave é cópia, exit 0" "$(modo 2)/$rc_b" "copia/0"
eq A3 "cluster copiado sobe: locale, superusuário e fsync" \
  "$(q "$TMP/c/b" "SELECT datcollate||'/'||(SELECT rolname FROM pg_roles WHERE oid=10)||'/'||current_setting('fsync') FROM pg_database WHERE datname='postgres'")" "C/postgres/off"

echo "── A4 o --locale é chave: pt_BR depois de C NÃO reaproveita o C"
ini -D "$TMP/c/p" -U postgres -E UTF8 --locale=pt_BR.UTF-8 > /dev/null 2>&1
ini -D "$TMP/c/p2" -U postgres -E UTF8 --locale=pt_BR.UTF-8 > /dev/null 2>&1
eq A4 "2º cluster pt_BR (cópia) tem collate e lc_messages pt_BR" \
  "$(q "$TMP/c/p2" "SELECT datcollate||'/'||current_setting('lc_messages') FROM pg_database WHERE datname='postgres'")" "pt_BR.UTF-8/pt_BR.UTF-8"

echo "── A5 o -U é chave: outro superusuário não herda o 'postgres' do template"
ini -D "$TMP/c/u" -U dono_admin -E UTF8 --locale=C > /dev/null 2>&1
ini -D "$TMP/c/u2" -U dono_admin -E UTF8 --locale=C > /dev/null 2>&1
eq A5 "superusuário bootstrap do 2º cluster é dono_admin" \
  "$(q "$TMP/c/u2" "SELECT rolname FROM pg_roles WHERE oid=10" dono_admin)" "dono_admin"

echo "── A6 a saída repetida cita o -D DESTA chamada (como o initdb real faria)"
d6=0; grep -qF "$TMP/c/b" "$TMP/b.out" && d6=$((d6+1)); grep -qF "$TMP/c/a" "$TMP/b.out" && d6=$((d6+10))
eq A6 "saída da cópia cita c/b e não c/a" "$d6" "1"

echo "── A7 -D não-vazio: o initdb REAL recusa, e a cópia não pode atropelar"
mkdir -p "$TMP/c/cheio"; echo x > "$TMP/c/cheio/arquivo"
ini -D "$TMP/c/cheio" -U postgres -E UTF8 --locale=C > "$TMP/cheio.out" 2>&1; rc7=$?
eq A7 "exit ≠ 0 e o diretório segue sem cluster" "$([ "$rc7" -ne 0 ] && echo nz)/$([ -f "$TMP/c/cheio/PG_VERSION" ] && echo tem || echo sem)" "nz/sem"

echo "── A8 argumento fora da lista → initdb real com ele (aqui --data-checksums)"
ini -D "$TMP/c/k" -U postgres -E UTF8 --locale=C --data-checksums > /dev/null 2>&1
eq A8 "data_checksums do cluster é on" "$(q "$TMP/c/k" "SHOW data_checksums")" "on"

echo "── A9 corrida: 3 primeiras chamadas simultâneas numa chave virgem"
for n in 1 2 3; do ini -D "$TMP/c/r$n" -U postgres -E UTF8 --locale=en_US.UTF-8 > /dev/null 2>&1 & done
wait
ok9=0; for n in 1 2 3; do [ -f "$TMP/c/r$n/PG_VERSION" ] && ok9=$((ok9+1)); done
eq A9 "3 clusters criados e nenhum .gera órfão" "$ok9/$(find "$INITDB_TEMPLATE_DIR" -maxdepth 1 -name '.gera.*' | wc -l | tr -d ' ')" "3/0"

echo "── A10 INITDB_TEMPLATE=0 desliga: initdb real mesmo com template pronto"
INITDB_TEMPLATE=0 ini -D "$TMP/c/z" -U postgres -E UTF8 --locale=C > /dev/null 2>&1
eq A10 "modo da última chamada" "$(tail -n 1 "$INITDB_TEMPLATE_LOG" | cut -f1)" "desligado"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-initdb-template: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
