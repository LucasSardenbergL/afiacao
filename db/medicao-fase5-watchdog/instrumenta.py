#!/usr/bin/env python3
"""TEMPORÁRIO — sai do branch antes do PR.

Gera uma cópia INSTRUMENTADA de db/test-tint-fase5-watchdog.sh que registra, num log de
eventos, a duração de: cada chamada psql, cada `roda` (o watchdog), o bloco do B14 (sleep 2 +
wait do pg_sleep(6)), cada suíte e cada falsificação, mais as fases do setup/seed.

Cada troca exige âncora ÚNICA: se a prova mudar e uma âncora sumir, o gerador ABORTA — uma
instrumentação que não aplicou mediria a prova errada em silêncio.

A cópia tem de morar em db/ (a prova resolve REPO_ROOT pelo próprio caminho).
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
COM_ANALYZE = "--analyze" in sys.argv[3:]   # variante: ANALYZE logo após o seed
s = open(src).read()


def troca(busca, novo):
    global s
    n = s.count(busca)
    if n != 1:
        sys.exit("ANCORA com %d ocorrencias (esperado 1): %r" % (n, busca[:90]))
    s = s.replace(busca, novo)


HELPERS = r'''set -euo pipefail
# ── INSTRUMENTAÇÃO (medição temporária) ──────────────────────────────────────────
TLOG="${TLOG:-/tmp/_f5wd_tempos.log}"; : > "$TLOG"
if [ -n "${EPOCHREALTIME:-}" ]; then
  _agora() { _T=$EPOCHREALTIME; }
else
  _agora() { _T="$(perl -MTime::HiRes=time -e 'printf "%.6f", time')"; }
fi
_marca() { _agora; printf 'fase %s %s\n' "$1" "$_T" >> "$TLOG"; }
_marca t0
'''
troca("set -euo pipefail\n", HELPERS)

troca(
    'P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }',
    'P()  { local _s _rc=0; _agora; _s=$_T; "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove '
    '-v ON_ERROR_STOP=1 "$@" || _rc=$?; _agora; printf \'psql %s %s\\n\' "$_s" "$_T" >> "$TLOG"; '
    'return "$_rc"; }',
)

troca(
    'roda()         { Pq -c "SELECT public.tint_watchdog_fase5_check();" >/dev/null; }',
    'roda()         { local _s; _agora; _s=$_T; Pq -c "SELECT public.tint_watchdog_fase5_check();" '
    '>/dev/null; _agora; printf \'roda %s %s\\n\' "$_s" "$_T" >> "$TLOG"; }',
)

troca('echo "=== setup PG17 :$PORT ==="\n', 'echo "=== setup PG17 :$PORT ==="\n_marca setup_fim\n')
troca("# ── a VIEW REAL", "_marca zona1_fim\n# ── a VIEW REAL")
troca('echo "=== view real aplicada ==="\n', 'echo "=== view real aplicada ==="\n_marca view_fim\n')
troca('echo "=== migration aplicada ==="\n', 'echo "=== migration aplicada ==="\n_marca mig_fim\n')
troca("# ══ ZONA 3 — seeds ══", "_marca seed_ini\n# ══ ZONA 3 — seeds ══")
troca("# ── alavancas de estado ──",
      ("P -q -c \"ANALYZE;\"\n" if COM_ANALYZE else "") + "_marca seed_fim\n# ── alavancas de estado ──")

# B14 — a versão ORIGINAL (sleep 2 + wait do pg_sleep(6)) ou a NOVA (espera positiva pelo lock)
if "  local lockpid=$!\n  sleep 2\n" in s:
    troca(
        "  local lockpid=$!\n  sleep 2\n",
        "  local lockpid=$!\n  local _b14s; _agora; _b14s=$_T\n  sleep 2\n"
        "  _agora; printf 'sleep2 %s %s\\n' \"$_b14s\" \"$_T\" >> \"$TLOG\"\n",
    )
    troca(
        '  wait "$lockpid" 2>/dev/null || true\n\n  # ══ asserts dos FIXES',
        '  local _w; _agora; _w=$_T\n  wait "$lockpid" 2>/dev/null || true\n'
        "  _agora; printf 'wait %s %s\\n' \"$_w\" \"$_T\" >> \"$TLOG\"\n"
        "  printf 'b14 %s %s\\n' \"$_b14s\" \"$_T\" >> \"$TLOG\"\n\n  # ══ asserts dos FIXES",
    )
else:
    troca("  local lockpid=$!\n  if espera_lock 1; then\n",
          "  local lockpid=$!\n  local _b14s; _agora; _b14s=$_T\n  if espera_lock 1; then\n")
    ancora = '  espera_lock 0 || bad "B14 pos-condicao: o lock segue tomado depois de encerrar a sessao que o segurava"\n'
    troca(ancora, ancora + "  _agora; printf 'b14 %s %s\\n' \"$_b14s\" \"$_T\" >> \"$TLOG\"\n")

# suíte e falsificação: renomeia a real e embrulha
troca("roda_suite() {\n  PASS=0; FAIL=0; FALHAS=()", "_roda_suite_real() {\n  PASS=0; FAIL=0; FALHAS=()")
troca(
    '\n}\n\necho "=== BASELINE (migration real) ==="',
    "\n}\nroda_suite() { local _s; _agora; _s=$_T; _roda_suite_real; _agora; "
    "printf 'suite %s %s\\n' \"$_s\" \"$_T\" >> \"$TLOG\"; }\n\n"
    '_marca baseline_ini\necho "=== BASELINE (migration real) ==="',
)
troca("sabota_e_mede() {   # $1=rotulo", "_sabota_real() {   # $1=rotulo")
troca(
    '  restaura\n}\n\necho "=== FALSIFICACOES ==="',
    "  restaura\n}\nsabota_e_mede() { local _s; _agora; _s=$_T; _sabota_real \"$@\"; _agora; "
    "printf 'falsif_%s %s %s\\n' \"$1\" \"$_s\" \"$_T\" >> \"$TLOG\"; }\n\n"
    '_marca falsif_ini\necho "=== FALSIFICACOES ==="',
)
troca(
    'echo "=== VERIFICACAO FINAL (migration real restaurada) ==="',
    '_marca final_ini\necho "=== VERIFICACAO FINAL (migration real restaurada) ==="',
)

RESUMO = r'''_marca fim
# ── resumo da instrumentação ──
awk '
  $1 == "fase" { nf++; fn[nf] = $2; ft[nf] = $3; next }
  $1 == "suite" { ns++; ss[ns] = $2; se[ns] = $3 }
  $1 == "roda"  { nr++; rs[nr] = $2; rd[nr] = $3 - $2 }
  $1 == "psql"  { np++; ps[np] = $2; pd[np] = $3 - $2 }
  { d = $3 - $2; n[$1]++; tot[$1] += d
    if (!($1 in mx) || d > mx[$1]) mx[$1] = d
    if (!($1 in mn) || d < mn[$1]) mn[$1] = d }
  END {
    for (k in n) if (k != "fase")
      printf "MEDIDA_EVT|%s|n=%d|total=%.2fs|media=%.3fs|min=%.3fs|max=%.3fs\n", k, n[k], tot[k], tot[k]/n[k], mn[k], mx[k]
    for (i = 2; i <= nf; i++)
      printf "MEDIDA_FASE|%02d|%s->%s|%.2fs\n", i, fn[i-1], fn[i], ft[i] - ft[i-1]
    for (j = 1; j <= ns; j++) {
      c = 0; t = 0; mxr = 0; mnr = 1e9; lista = ""; cp = 0; tp = 0
      for (i = 1; i <= nr; i++) if (rs[i] >= ss[j] && rs[i] <= se[j]) {
        c++; t += rd[i]; if (rd[i] > mxr) mxr = rd[i]; if (rd[i] < mnr) mnr = rd[i]
        lista = lista sprintf("%.2f ", rd[i]) }
      for (i = 1; i <= np; i++) if (ps[i] >= ss[j] && ps[i] <= se[j]) { cp++; tp += pd[i] }
      printf "MEDIDA_SUITE|%d|dur=%.2fs|rodas=%d|rodas_total=%.2fs|roda_min=%.3fs|roda_max=%.3fs|psql=%d|psql_total=%.2fs|seq=%s\n", j, se[j]-ss[j], c, t, mnr, mxr, cp, tp, lista
    }
  }' "$TLOG" | sort
echo "--- final: $PASS ok'''
troca('echo "--- final: $PASS ok', RESUMO)

open(dst, "w").write(s)
sys.stderr.write("instrumentada: %s\n" % dst)
