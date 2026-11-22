#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de db/2026-11-22-fin-projecao-snapshots-ncg-composicao.sql ║
# ║  6 colunas ncg_* (edge fin-cashflow-engine v2.5), CHECKs de faixa e de          ║
# ║  coerência, sem DEFAULT, idempotente — com FALSIFICAÇÃO no mesmo laço.          ║
# ║      bash db/test-fin-projecao-snapshots-ncg-composicao.sh > log 2>&1; echo $?  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/db/2026-11-22-fin-projecao-snapshots-ncg-composicao.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="fin-projecao-ncg-composicao"
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

  # Stub ESPELHANDO a prod (psql-ro, 22/11/2026: 22 colunas, RLS ligada; as cp_vencido_fora_* já aplicadas).
  P <<'SQL'
CREATE TABLE public.fin_projecao_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL, snapshot_at timestamptz NOT NULL DEFAULT now(),
  cenario text NOT NULL, horizon_weeks integer NOT NULL DEFAULT 13, dados jsonb NOT NULL, ncg numeric,
  liquidez_operacional_liquida numeric, saldo_tesouraria numeric, dias_cobertura numeric, premissas jsonb,
  estoque_valor numeric, estoque_fonte text, estoque_cobertura_ok boolean, cmv_ttm numeric,
  cp_vencido_fora_qtd integer, cp_vencido_fora_total numeric, cp_vencido_fora_mais_antigo date,
  cp_vencido_fora_ate_30 numeric, cp_vencido_fora_31_60 numeric, cp_vencido_fora_61_180 numeric,
  cp_vencido_fora_acima_180 numeric);
ALTER TABLE public.fin_projecao_snapshots ENABLE ROW LEVEL SECURITY;
-- snapshot ANTIGO (anterior à v2.5, com ncg total): tem de continuar todo NULL e ser aceito.
INSERT INTO public.fin_projecao_snapshots (company, cenario, horizon_weeks, dados, ncg, snapshot_at)
VALUES ('oben', 'realista', 13, '[]', 123456.78, now() - interval '2 days');
-- Captura SÓ a SQLSTATE esperada (check_violation); qualquer outro erro propaga (sem WHEN OTHERS).
CREATE FUNCTION public.t_tenta(sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN EXECUTE sql; RETURN 'OK'; EXCEPTION WHEN check_violation THEN RETURN '23514'; END $f$;
SQL

  # O executor (db:aplicar) envolve numa transação: -1 reproduz isso.
  local saida
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A0 migration abortou: $(echo "$saida" | tail -1)" A0; return 0; }
  case "$saida" in *FIN-PROJECAO-SNAPSHOTS-NCG-COMPOSICAO-OK*) ok "A0 aplicou + postcondição";; *) bad "A0 sem marcador de fim" A0;; esac
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A1 reaplicar abortou" A1; return 0; }
  case "$saida" in *FIN-PROJECAO-SNAPSHOTS-NCG-COMPOSICAO-OK*) ok "A1 idempotente (2º apply)";; *) bad "A1 2º apply sem marcador" A1;; esac

  # Ordem: ncg, cr_aberto, estoque, adiantamentos, cp_fornecedor, folha_30d, tributos_a_pagar.
  local ins="INSERT INTO public.fin_projecao_snapshots (company, cenario, horizon_weeks, dados, ncg, ncg_cr_aberto, ncg_estoque, ncg_adiantamentos, ncg_cp_fornecedor, ncg_folha_30d, ncg_tributos_a_pagar) VALUES ('oben','realista',13,'[]',"
  eq "antigo segue todo NULL" "$(Pq -c "SELECT count(*) FROM public.fin_projecao_snapshots WHERE ncg_cr_aberto IS NULL AND ncg_estoque IS NULL AND ncg_adiantamentos IS NULL AND ncg_cp_fornecedor IS NULL AND ncg_folha_30d IS NULL AND ncg_tributos_a_pagar IS NULL")" "1" A2
  eq "completa (números do teste da edge)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 518900.44, 90435, 500000, 0, 1234.56, 70000, 300)\$\$)")" "OK" A3
  eq "parcial (estoque NULL)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 18900.44, 90435, NULL, 0, 1234.56, 70000, 300)\$\$)")" "OK" A4
  eq "recusa completa que não fecha (10 centavos)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 518900.54, 90435, 500000, 0, 1234.56, 70000, 300)\$\$)")" "23514" A5
  eq "recusa medida pela metade (CR NULL)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 18900.44, NULL, NULL, 0, 1234.56, 70000, 300)\$\$)")" "23514" A6
  eq "recusa medida sem total" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} NULL, 90435, NULL, 0, 1234.56, 70000, 300)\$\$)")" "23514" A7
  eq "recusa NaN" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 18900.44, 'NaN', NULL, 0, 1234.56, 70000, 300)\$\$)")" "23514" A8
  eq "recusa negativo" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 18900.44, 90435, NULL, 0, 1234.56, 70000, -300)\$\$)")" "23514" A9
  eq "recusa parcial que não fecha" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 518900.44, 90435, NULL, 0, 1234.56, 70000, 300)\$\$)")" "23514" A10
  # Faixa isolada (achado Codex): o total FECHA, então só o CHECK de faixa pode recusar.
  eq "recusa negativo que fecha" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 19500.44, 90435, NULL, 0, 1234.56, 70000, -300)\$\$)")" "23514" A14
  eq "recusa teto que fecha" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 9999928465.44, 10000000000, NULL, 0, 1234.56, 70000, 300)\$\$)")" "23514" A15
  eq "adiantamento não segregado (NULL)" "$(Pq -c "SELECT public.t_tenta(\$\$${ins} 18900.44, 90435, NULL, NULL, 1234.56, 70000, 300)\$\$)")" "OK" A16
  eq "nenhuma coluna com DEFAULT" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_projecao_snapshots' AND column_name LIKE 'ncg\_%' AND column_default IS NOT NULL")" "0" A11
  # Reaplicar DEPOIS de o cron já ter gravado snapshot v2.5 — o caso do --ensaio pós-deploy.
  if saida="$(P -1 -f "$mig" 2>&1)"; then
    case "$saida" in *FIN-PROJECAO-SNAPSHOTS-NCG-COMPOSICAO-OK*) ok "A12 reaplica com snapshot v2.5 gravado";; *) bad "A12 sem marcador" A12;; esac
  else
    bad "A12 reaplicar com snapshot v2.5 abortou" A12
  fi
  eq "6 colunas" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_projecao_snapshots' AND column_name LIKE 'ncg\_%'")" "6" A13
}

echo "═══ CONTROLE (migration real) ═══"
rodada "$MIG" controle
CONTROLE_PASS=$PASS; CONTROLE_FAIL=$FAIL
[ "$CONTROLE_FAIL" -eq 0 ] && [ "$CONTROLE_PASS" -eq 17 ] || { echo "CONTROLE NÃO VERDE ($CONTROLE_PASS ok, $CONTROLE_FAIL falha) — falsificação abortada"; exit 1; }

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
# S1: sem o fechamento com o total — composição que não bate passaria.
falsificar S1-SEM-FECHAMENTO " A5 A10" 's/ - ncg) <= 0.05)/ - ncg) >= 0)/'
# S2: estoque sem COALESCE — a soma da parcial vira NULL e o CHECK (NULL = passa) aceita qualquer total.
falsificar S2-SEM-COALESCE " A10" 's/COALESCE(ncg_estoque, 0)/ncg_estoque/'
# S3: sem exigir o CR na medida — linha pela metade passaria (NULL na soma).
falsificar S3-CR-OPCIONAL " A6" 's/^  OR (ncg_cr_aberto IS NOT NULL$/  OR (TRUE/'
# S4: sem exigir o total — medida sem `ncg` passaria.
falsificar S4-SEM-TOTAL " A7" '/^    AND ncg IS NOT NULL$/d'
# S5: DEFAULT 0 — fabricaria zero nos snapshots antigos; o CHECK de coerência barra no apply.
falsificar S5-DEFAULT-ZERO " A0" 's/ADD COLUMN IF NOT EXISTS ncg_cr_aberto numeric,/ADD COLUMN IF NOT EXISTS ncg_cr_aberto numeric DEFAULT 0,/'
# S6: faixa desligada — negativo e teto que fecham passariam (só a faixa os acusa).
falsificar S6-SEM-FAIXA " A14 A15" 's/ncg_composicao_faixa_ck CHECK ($/ncg_composicao_faixa_ck CHECK (true OR/'

echo "═══ RESULTADO: controle $CONTROLE_PASS/17 verde · 6 sabotagens acusadas pelo assert declarado ═══"
echo "EXECUTOU-ATE-O-FIM"
