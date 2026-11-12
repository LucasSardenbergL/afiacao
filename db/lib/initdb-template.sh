#!/usr/bin/env bash
# initdb-template.sh — `initdb` do job `provas-sql` com TEMPLATE DE CLUSTER.
# ============================================================================
# O shim do `ci.yml` ("Cluster de prova sem fsync") instala este arquivo como
# `$PGBIN_OVERRIDE/initdb`. Cada prova faz o próprio `initdb` (e o `--falsificar`,
# um por sabotagem): ~3.200 por run, todos com os MESMOS argumentos, salvo o -D.
#
# Na 1ª chamada com um dado conjunto de argumentos ele roda o initdb REAL, e
# guarda uma cópia do cluster recém-criado (parado). Nas seguintes, copia o
# template (`cp -a`) para o -D pedido e repete a saída gravada da 1ª.
#
# É template de CLUSTER, não de database: roles são globais ao cluster, e um
# `CREATE DATABASE … TEMPLATE` não isolaria o que uma prova cria fora do banco
# (docs/historico/ci-provas-sql-medicao-preparacao.md).
#
# ## Fail-safe: na dúvida, initdb real
#
# A CHAVE do template são os argumentos normalizados (sem o -D) + o ambiente que
# o initdb lê (LANG/LC_*/TZ/PGTZ) + a versão do binário. Qualquer argumento fora
# da lista reconhecida, -D ausente, -D já existente e não-vazio (o initdb real
# recusa — e a mensagem dele é a que a prova deve ver), pai ausente, ou falha
# na cópia → `exec` do initdb real, com os argumentos intactos.
#
# Diferença conhecida e aceita: o `system_identifier` do pg_control é o mesmo em
# todos os clusters de uma chave. Nenhuma prova do núcleo replica entre clusters.
#
# ## Ambiente
#   INITDB_REAL            diretório do initdb real (obrigatório)
#   INITDB_TEMPLATE_DIR    onde guardar os templates (sem ele: sempre real)
#   INITDB_TEMPLATE=0      desliga o template (sempre real)
#   INITDB_TEMPLATE_LOG    se definido, 1 linha por chamada: modo e ms (medição)
#   INITDB_TEMPLATE_SABOTA=locale  falsificação: a chave ignora o --locale
set -u

real="${INITDB_REAL:?INITDB_REAL ausente}/initdb"

# EPOCHREALTIME é do bash 5 (o do runner); sem ele, a medição sai 0 e nada mais muda.
_ms() { local s="${EPOCHREALTIME:-0}"; s="${s/[.,]/}"; printf '%s' "$(( 10#$s / 1000 ))"; }
t0="$(_ms)"

_log() { # modo
  [ -n "${INITDB_TEMPLATE_LOG:-}" ] || return 0
  printf '%s\t%s\t%s\n' "$1" "$(( $(_ms) - t0 ))" "${NUCLEO_UNIDADE:-?}" >> "$INITDB_TEMPLATE_LOG" 2>/dev/null || true
}

_real() { # modo; executa o initdb real e devolve o exit dele
  local rc=0
  "$real" "$@" || rc=$?
  _log "$modo_real"
  exit "$rc"
}
modo_real="real"

if [ "${INITDB_TEMPLATE:-1}" = 0 ] || [ -z "${INITDB_TEMPLATE_DIR:-}" ]; then _real "$@"; fi

# ---- reconhecimento estrito dos argumentos --------------------------------
dir=""; chave=()
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  a="${args[$i]}"
  case "$a" in
    -D) i=$((i + 1)); [ "$i" -lt "${#args[@]}" ] || _real "$@"; [ -z "$dir" ] || _real "$@"; dir="${args[$i]}" ;;
    -U|-E|-A|-c)
      i=$((i + 1)); [ "$i" -lt "${#args[@]}" ] || _real "$@"
      chave+=("$a" "${args[$i]}") ;;
    --locale=*)
      if [ "${INITDB_TEMPLATE_SABOTA:-}" = locale ]; then :; else chave+=("$a"); fi ;;
    --encoding=*|--auth=*|--no-sync) chave+=("$a") ;;
    *) _real "$@" ;;
  esac
  i=$((i + 1))
done

[ -n "$dir" ] || _real "$@"
dir_arg="$dir"   # como o initdb o imprime
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
if [ -e "$dir" ]; then
  [ -d "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ] || _real "$@"
  vazio_existe=1
else
  [ -d "$(dirname "$dir")" ] || _real "$@"
  vazio_existe=0
fi
# "creating directory" × "fixing permissions on existing directory": saídas distintas
chave+=("vazio_existe=$vazio_existe")

amb="$(env | LC_ALL=C grep -E '^(LANG|LC_[A-Z_]+|TZ|PGTZ)=' | LC_ALL=C sort)"
versao="$("$real" --version 2>/dev/null)" || _real "$@"
id="$(printf '%s\n' "$versao" "$amb" "${chave[@]}" | sha256sum | cut -c1-24)"
tpl="$INITDB_TEMPLATE_DIR/$id"
marca='@@INITDB_PGDATA@@'

_copia() { # copia o template para "$dir"; 0 se ok
  if [ "$vazio_existe" = 1 ]; then
    cp -a "$tpl/data/." "$dir/" && chmod 700 "$dir"
  else
    cp -a "$tpl/data" "$dir"
  fi
}

if [ -f "$tpl/ok" ]; then
  if _copia; then
    out="$(cat "$tpl/stdout")"; err="$(cat "$tpl/stderr")"
    [ -z "$out" ] || printf '%s\n' "${out//"$marca"/$dir_arg}"
    [ -z "$err" ] || printf '%s\n' "${err//"$marca"/$dir_arg}" >&2
    _log copia
    exit 0
  fi
  # cópia falhou: limpa o que sobrou e cai no real (que reporta do jeito dele)
  if [ "$vazio_existe" = 1 ]; then find "$dir" -mindepth 1 -delete 2>/dev/null; else rm -rf "$dir"; fi
  _real "$@"
fi

# ---- 1ª chamada da chave: initdb real no -D pedido + template ---------------
modo_real="real-gera"
mkdir -p "$INITDB_TEMPLATE_DIR" 2>/dev/null || _real "$@"
tmp="$(mktemp -d "$INITDB_TEMPLATE_DIR/.gera.XXXXXX")" || _real "$@"
rc=0
"$real" "$@" > "$tmp/stdout" 2> "$tmp/stderr" || rc=$?
cat "$tmp/stdout"; cat "$tmp/stderr" >&2
if [ "$rc" -eq 0 ]; then
  # A saída cita o -D; grava com marcador para repetir com o -D de cada chamada.
  for f in stdout stderr; do
    v="$(cat "$tmp/$f")"; [ -z "$v" ] || printf '%s\n' "${v//"$dir_arg"/$marca}" > "$tmp/$f.m"
    mv -f "$tmp/$f.m" "$tmp/$f" 2>/dev/null || : > "$tmp/$f"
  done
  if cp -a "$dir" "$tmp/data" && : > "$tmp/ok"; then
    # rename atômico; se outro worker já publicou a chave, o dele vale e o nosso some
    mvt="mv"; command -v gmv >/dev/null 2>&1 && mvt="gmv"   # macOS: -T é do GNU
    "$mvt" -T "$tmp" "$tpl" 2>/dev/null || rm -rf "$tmp"
  else
    rm -rf "$tmp"
  fi
else
  rm -rf "$tmp"
fi
_log "$modo_real"
exit "$rc"
