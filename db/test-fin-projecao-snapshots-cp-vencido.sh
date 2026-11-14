#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de db/2026-11-14-fin-projecao-snapshots-cp-vencido.sql   ║
# ║  7 colunas cp_vencido_fora_* (edge fin-cashflow-engine v2.4), CHECKs de faixa  ║
# ║  e de coerência, sem DEFAULT, idempotente — com FALSIFICAÇÃO no mesmo laço.    ║
# ║      bash db/test-fin-projecao-snapshots-cp-vencido.sh > log 2>&1; echo $?     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/db/2026-11-14-fin-projecao-snapshots-cp-vencido.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="fin-projecao-cp-vencido"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

PASS=0; FAIL=0; FALHOU=""
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); FALHOU="$FALHOU $2"; echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$4 $1 (=$2)" ; else bad "$4 $1 — esperado [$3], veio [$2]" "$4"; fi; }

# Uma rodada completa num banco novo, com a migration $1. Imprime os asserts; FALHOU acumula os IDs.
rodada() {
  local mig="$1" db="prove_$2"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
  Pq() { P -tA "$@"; }

  # Stub ESPELHANDO a prod (psql-ro, 14/11/2026: 15 colunas, RLS ligada, 1.469 linhas).
  P <<'SQL'
CREATE TABLE public.fin_projecao_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL, snapshot_at timestamptz NOT NULL DEFAULT now(),
  cenario text NOT NULL, horizon_weeks integer NOT NULL, dados jsonb NOT NULL, ncg numeric,
  liquidez_operacional_liquida numeric, saldo_tesouraria numeric, dias_cobertura numeric, premissas jsonb,
  estoque_valor numeric, estoque_fonte text, estoque_cobertura_ok boolean, cmv_ttm numeric);
ALTER TABLE public.fin_projecao_snapshots ENABLE ROW LEVEL SECURITY;
-- snapshot ANTIGO (anterior à v2.4): tem de continuar todo NULL e ser aceito.
INSERT INTO public.fin_projecao_snapshots (company, cenario, horizon_weeks, dados, snapshot_at)
VALUES ('oben', 'realista', 13, '[]', now() - interval '2 days');
-- Captura SÓ a SQLSTATE esperada (check_violation); qualquer outro erro propaga (sem WHEN OTHERS).
CREATE FUNCTION public.t_tenta(sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN EXECUTE sql; RETURN 'OK'; EXCEPTION WHEN check_violation THEN RETURN '23514'; END $f$;
SQL

  # O executor (db:aplicar) envolve numa transação: -1 reproduz isso.
  local saida
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A0 migration abortou: $(echo "$saida" | tail -1)" A0; return 0; }
  case "$saida" in *FIN-PROJECAO-SNAPSHOTS-CP-VENCIDO-OK*) ok "A0 aplicou + postcondição";; *) bad "A0 sem marcador de fim" A0;; esac
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A1 reaplicar abortou" A1; return 0; }
  case "$saida" in *FIN-PROJECAO-SNAPSHOTS-CP-VENCIDO-OK*) ok "A1 idempotente (2º apply)";; *) bad "A1 2º apply sem marcador" A1;; esac

  local ins="INSERT INTO public.fin_projecao_snapshots (company, cenario, horizon_weeks, dados, cp_vencido_fora_qtd, cp_vencido_fora_total, cp_vencido_fora_mais_antigo, cp_vencido_fora_ate_30, cp_vencido_fora_31_60, cp_vencido_fora_61_180, cp_vencido_fora_acima_180) VALUES ('oben','realista',13,'[]',"
  eq "antigo segue todo NULL" "$(Pq -c "SELECT count(*) FROM public.fin_projecao_snapshots WHERE cp_vencido_fora_qtd IS NULL AND cp_vencido_fora_total IS NULL AND cp_vencido_fora_mais_antigo IS NULL")" "1" A2
  eq "medida positiva (números do teste da edge)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 4, 10000.43, '2025-10-10', 1000.1, 2000, 3000.33, 4000)\$\$)")" "OK" A3
  eq "medida vazia (0/0/NULL)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 0, 0, NULL, 0, 0, 0, 0)\$\$)")" "OK" A4
  eq "recusa Σ faixas ≠ total" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 4, 10000.44, '2025-10-10', 1000.1, 2000, 3000.33, 4000)\$\$)")" "23514" A5
  eq "recusa qtd 0 com valor" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 0, 5, NULL, 5, 0, 0, 0)\$\$)")" "23514" A6
  eq "recusa valor sem data" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 1, 5, NULL, 5, 0, 0, 0)\$\$)")" "23514" A7
  eq "recusa medida pela metade" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 1, 5, '2025-10-10', NULL, 0, 0, 0)\$\$)")" "23514" A8
  eq "recusa NaN" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 1, 'NaN', '2025-10-10', 5, 0, 0, 0)\$\$)")" "23514" A9
  eq "recusa negativo" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 1, 5, '2025-10-10', 6, -1, 0, 0)\$\$)")" "23514" A10
  eq "nenhuma coluna com DEFAULT" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_projecao_snapshots' AND column_name LIKE 'cp\_vencido\_fora\_%' AND column_default IS NOT NULL")" "0" A11
  # Reaplicar DEPOIS de o cron gravar snapshot v2.4 antigo (2 h) — o caso do --ensaio pós-deploy.
  P -c "INSERT INTO public.fin_projecao_snapshots (company, cenario, horizon_weeks, dados, snapshot_at, cp_vencido_fora_qtd, cp_vencido_fora_total, cp_vencido_fora_mais_antigo, cp_vencido_fora_ate_30, cp_vencido_fora_31_60, cp_vencido_fora_61_180, cp_vencido_fora_acima_180) VALUES ('oben','realista',13,'[]', now() - interval '2 hours', 1, 5, '2025-10-10', 5, 0, 0, 0)"
  if saida="$(P -1 -f "$mig" 2>&1)"; then
    case "$saida" in *FIN-PROJECAO-SNAPSHOTS-CP-VENCIDO-OK*) ok "A13 reaplica com snapshot v2.4 de 2 h";; *) bad "A13 sem marcador" A13;; esac
  else
    bad "A13 reaplicar com snapshot v2.4 antigo abortou" A13
  fi
  eq "7 colunas" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_projecao_snapshots' AND column_name LIKE 'cp\_vencido\_fora\_%'")" "7" A12
}

echo "═══ CONTROLE (migration real) ═══"
rodada "$MIG" controle
CONTROLE_PASS=$PASS; CONTROLE_FAIL=$FAIL
[ "$CONTROLE_FAIL" -eq 0 ] && [ "$CONTROLE_PASS" -eq 14 ] || { echo "CONTROLE NÃO VERDE ($CONTROLE_PASS ok, $CONTROLE_FAIL falha) — falsificação abortada"; exit 1; }

# Falsificação: cada sabotagem DECLARA o assert que a acusa; o juiz exige exatamente esse.
falsificar() {
  local nome="$1" esperado="$2" expr="$3" copia="$TMPD/$1.sql"
  sed "$expr" "$MIG" > "$copia"
  if cmp -s "$MIG" "$copia"; then echo "SABOTAGEM $nome NÃO APLICOU"; exit 1; fi
  PASS=0; FAIL=0; FALHOU=""
  echo "═══ SABOTAGEM $nome (espera vermelho em:$esperado) ═══"
  rodada "$copia" "$(echo "$nome" | tr 'A-Z-' 'a-z_')"
  if [ "$FALHOU" = "$esperado" ]; then echo "  🦷 $nome acusada só por$esperado"; else echo "SABOTAGEM $nome: vermelho em [$FALHOU], esperado [$esperado]"; exit 1; fi
}
falsificar S1-SEM-SOMA " A5" '/= cp_vencido_fora_total$/d'
falsificar S2-SEM-DATA " A7" 's/AND cp_vencido_fora_mais_antigo IS NOT NULL)))/)))/'
# S4: o assert com corte de tempo que o Codex derrubou (reaplicar depois do cron abortava).
falsificar S4-CORTE-DE-TEMPO " A13" "s/^  IF NOT EXISTS (SELECT 1 FROM pg_class/  IF EXISTS (SELECT 1 FROM public.fin_projecao_snapshots WHERE cp_vencido_fora_qtd IS NOT NULL AND snapshot_at < now() - interval '1 hour') THEN RAISE EXCEPTION 'P9'; END IF;\\
  IF NOT EXISTS (SELECT 1 FROM pg_class/"
falsificar S3-DEFAULT-ZERO " A0" 's/ADD COLUMN IF NOT EXISTS cp_vencido_fora_qtd integer,/ADD COLUMN IF NOT EXISTS cp_vencido_fora_qtd integer DEFAULT 0,/'

echo "═══ RESULTADO: controle $CONTROLE_PASS/14 verde · 4 sabotagens acusadas pelo assert declarado ═══"
echo "EXECUTOU-ATE-O-FIM"
