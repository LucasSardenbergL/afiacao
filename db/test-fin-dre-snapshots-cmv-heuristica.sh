#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de db/2026-11-22-fin-dre-snapshots-cmv-heuristica.sql     ║
# ║  2 colunas cmv_heuristica* (edge omie-financeiro v1.14), CHECKs de faixa e de   ║
# ║  coerência, gatilho do contrato, sem DEFAULT, idempotente — com FALSIFICAÇÃO    ║
# ║  no mesmo laço (controle verde antes de qualquer sabotagem).                     ║
# ║      bash db/test-fin-dre-snapshots-cmv-heuristica.sh > log 2>&1; echo $?       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/db/2026-11-22-fin-dre-snapshots-cmv-heuristica.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="fin-dre-cmv-heuristica"
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
  # stderr no log, não no valor: erro que não é check_violation (ex.: 22012) chega vazio e o assert acusa.
  Pq() { P -tA "$@" 2>>"$TMPD/erros.log"; }

  # Stub ESPELHANDO a prod (psql-ro, 22/11/2026: 26 colunas, DEFAULTs, UNIQUE, CHECKs, RLS e o gatilho
  # `fin_dre_snapshots_contrato_fase2` com o corpo de pg_get_functiondef).
  P <<'SQL'
CREATE TABLE public.fin_dre_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  ano integer NOT NULL, mes integer NOT NULL CHECK (mes >= 1 AND mes <= 12),
  receita_bruta numeric DEFAULT 0, deducoes numeric DEFAULT 0, receita_liquida numeric DEFAULT 0, cmv numeric DEFAULT 0,
  lucro_bruto numeric DEFAULT 0, despesas_operacionais numeric DEFAULT 0, despesas_administrativas numeric DEFAULT 0,
  despesas_comerciais numeric DEFAULT 0, despesas_financeiras numeric DEFAULT 0, receitas_financeiras numeric DEFAULT 0,
  resultado_operacional numeric DEFAULT 0, outras_receitas numeric DEFAULT 0, outras_despesas numeric DEFAULT 0,
  resultado_antes_impostos numeric DEFAULT 0, impostos numeric DEFAULT 0, resultado_liquido numeric DEFAULT 0,
  detalhamento jsonb DEFAULT '{}'::jsonb, calculated_at timestamptz DEFAULT now(),
  regime text DEFAULT 'caixa' CHECK (regime = ANY (ARRAY['caixa','competencia'])),
  qtd_categorias_sem_mapeamento integer DEFAULT 0, fora_dre numeric, resultado_provisorio boolean,
  UNIQUE (company, ano, mes, regime));
ALTER TABLE public.fin_dre_snapshots ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.fin_dre_snapshots_contrato_fase2() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $f$
BEGIN
  IF NEW.detalhamento IS NULL OR NOT (NEW.detalhamento ? 'contrato') THEN
    NEW.fora_dre := NULL;
    NEW.resultado_provisorio := NULL;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_fin_dre_snapshots_contrato_fase2 BEFORE INSERT OR UPDATE ON public.fin_dre_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fin_dre_snapshots_contrato_fase2();
-- snapshot ANTIGO (anterior à v1.14): tem de continuar NULL nas colunas novas e ser aceito.
INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, cmv, detalhamento)
VALUES ('oben', 2026, 1, 'caixa', 1000, '{"contrato":{"versao":"dre-fora-dre-v1"}}');
-- Captura SÓ a SQLSTATE esperada (check_violation); qualquer outro erro propaga (sem WHEN OTHERS).
CREATE FUNCTION public.t_tenta(sql text) RETURNS text LANGUAGE plpgsql AS $f$
-- division_by_zero também é capturado (só ele): é o erro que S3 provoca, e o assert tem de nomeá-lo.
BEGIN EXECUTE sql; RETURN 'OK';
EXCEPTION WHEN check_violation THEN RETURN '23514'; WHEN division_by_zero THEN RETURN '22012'; END $f$;
SQL

  # O executor (db:aplicar) envolve numa transação: -1 reproduz isso.
  local saida
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A0 migration abortou: $(echo "$saida" | grep -m1 -o 'P[0-9] FALHOU[^"]*' || echo "$saida" | tail -1)" A0; return 0; }
  case "$saida" in *FIN-DRE-SNAPSHOTS-CMV-HEURISTICA-OK*) ok "A0 aplicou + postcondição";; *) bad "A0 sem marcador de fim" A0;; esac
  saida="$(P -1 -f "$mig" 2>&1)" || { bad "A1 reaplicar abortou" A1; return 0; }
  case "$saida" in *FIN-DRE-SNAPSHOTS-CMV-HEURISTICA-OK*) ok "A1 idempotente (2º apply)";; *) bad "A1 2º apply sem marcador" A1;; esac

  # Ordem: mes, cmv, cmv_heuristica, cmv_heuristica_pct. Contrato v1.14 (com a marca) por padrão.
  local novo='{"contrato":{"versao":"dre-fora-dre-v1","cmv_heuristica":"v1"}}'
  local ins="INSERT INTO public.fin_dre_snapshots (company, ano, mes, regime, detalhamento, cmv, cmv_heuristica, cmv_heuristica_pct) VALUES ('oben', 2026, "
  t() { Pq -c "SELECT public.t_tenta(\$q\$${ins} $1, 'caixa', '${2:-$novo}', $3)\$q\$)"; }
  eq "antigo segue NULL" "$(Pq -c "SELECT count(*) FROM public.fin_dre_snapshots WHERE cmv_heuristica IS NULL AND cmv_heuristica_pct IS NULL")" "1" A2
  eq "medido (números do teste da edge)" "$(t 2 "" "1000, 400, 0.4")" "OK" A3
  eq "medido persiste (gatilho não anula com a marca)" "$(Pq -c "SELECT cmv_heuristica || '|' || cmv_heuristica_pct FROM public.fin_dre_snapshots WHERE mes = 2")" "400|0.4" A4
  eq "CMV 0: valor medido, pct NULL" "$(t 3 "" "0, 0, NULL")" "OK" A5
  # Codex P2: o zero MEDIDO tem de sobreviver ao gatilho (virar NULL seria "não medido").
  eq "CMV 0 persiste como 0 medido" "$(Pq -c "SELECT coalesce(cmv_heuristica::text, 'N') || '|' || coalesce(cmv_heuristica_pct::text, 'N') FROM public.fin_dre_snapshots WHERE mes = 3")" "0|N" A21
  eq "recusa pct com CMV negativo (razão coerente)" "$(t 4 "" "-100, -40, 0.4")" "23514" A6
  eq "recusa pct incoerente" "$(t 5 "" "1000, 400, 0.5")" "23514" A7
  eq "recusa pct > 1 (razão coerente)" "$(t 6 "" "100, 150, 1.5")" "23514" A8
  eq "recusa valor NaN" "$(t 7 "" "1000, 'NaN', NULL")" "23514" A9
  eq "recusa pct sem valor" "$(t 8 "" "1000, NULL, 0.4")" "23514" A10
  eq "recusa teto do valor" "$(t 9 "" "1000, 10000000000, NULL")" "23514" A11
  eq "fronteira: tudo heurístico com ruído de float → pct 1" "$(t 10 "" "0.30000000000000004, 0.3, 1")" "OK" A12
  eq "recusa pct com CMV 0 como check_violation (não 22012)" "$(t 11 "" "0, 0, 0")" "23514" A13
  # Gatilho: bundle SEM a marca (anterior à v1.14) nunca deixa as colunas preenchidas.
  eq "INSERT sem a marca é aceito" "$(t 12 '{"contrato":{"versao":"dre-fora-dre-v1"}}' "1000, 400, 0.4")" "OK" A14
  eq "INSERT sem a marca → colunas NULL" "$(Pq -c "SELECT count(*) FROM public.fin_dre_snapshots WHERE mes = 12 AND cmv_heuristica IS NULL AND cmv_heuristica_pct IS NULL")" "1" A15
  # O caso que motivou o gatilho: UPDATE do upsert de um bundle velho, com cmv novo, sobre linha v1.14.
  eq "UPDATE de bundle velho sobre linha medida não derruba o upsert" "$(Pq -c "SELECT public.t_tenta(\$q\$UPDATE public.fin_dre_snapshots SET cmv = 2000, detalhamento = '{\"contrato\":{\"versao\":\"dre-fora-dre-v1\"}}' WHERE mes = 2\$q\$)")" "OK" A16
  eq "UPDATE de bundle velho → colunas NULL (nada de outra apuração)" "$(Pq -c "SELECT count(*) FROM public.fin_dre_snapshots WHERE mes = 2 AND cmv = 2000 AND cmv_heuristica IS NULL AND cmv_heuristica_pct IS NULL")" "1" A17
  eq "nenhuma coluna com DEFAULT" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_dre_snapshots' AND column_name LIKE 'cmv\_heuristica%' AND column_default IS NOT NULL")" "0" A18
  # Reaplicar DEPOIS de a edge já ter gravado snapshot v1.14 — o caso do --ensaio pós-deploy.
  if saida="$(P -1 -f "$mig" 2>&1)"; then
    case "$saida" in *FIN-DRE-SNAPSHOTS-CMV-HEURISTICA-OK*) ok "A19 reaplica com snapshot v1.14 gravado";; *) bad "A19 sem marcador" A19;; esac
  else
    bad "A19 reaplicar com snapshot v1.14 abortou" A19
  fi
  eq "2 colunas" "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='fin_dre_snapshots' AND column_name LIKE 'cmv\_heuristica%'")" "2" A20
}

echo "═══ CONTROLE (migration real) ═══"
rodada "$MIG" controle
CONTROLE_PASS=$PASS; CONTROLE_FAIL=$FAIL
[ "$CONTROLE_FAIL" -eq 0 ] && [ "$CONTROLE_PASS" -eq 22 ] || { echo "CONTROLE NÃO VERDE ($CONTROLE_PASS ok, $CONTROLE_FAIL falha) — falsificação abortada"; exit 1; }

# Falsificação: cada sabotagem DECLARA o assert que a acusa; o juiz exige exatamente esse.
# $4 (opcional): texto que a saída da rodada TEM de conter — prova a CAUSA, não só o ID (Codex P3).
falsificar() {
  local nome="$1" esperado="$2" expr="$3" causa="${4:-}" copia="$TMPD/$1.sql"
  sed "$expr" "$MIG" > "$copia"
  if cmp -s "$MIG" "$copia"; then echo "SABOTAGEM $nome NÃO APLICOU"; exit 1; fi
  PASS=0; FAIL=0; FALHOU=""
  echo "═══ SABOTAGEM $nome (espera vermelho em:$esperado) ═══"
  rodada "$copia" "$(echo "$nome" | tr 'A-Z-' 'a-z_')" > "$TMPD/rodada.out"   # redireção, não pipe: PASS/FAIL ficam neste shell
  cat "$TMPD/rodada.out"
  if [ -n "$causa" ] && ! grep -qF -- "$causa" "$TMPD/rodada.out"; then echo "SABOTAGEM $nome: causa [$causa] ausente da saída"; exit 1; fi
  if [ "$FALHOU" = "$esperado" ]; then echo "  🦷 $nome acusada só por$esperado"; else echo "SABOTAGEM $nome: vermelho em [$FALHOU], esperado [$esperado]"; exit 1; fi
}
# S1: sem a coerência pct × valor/cmv — percentual que não bate passaria.
falsificar S1-SEM-COERENCIA " A7" 's/ <= 0.0001 ELSE false END)/ >= 0 ELSE false END)/'
# S2: faixa desligada — NaN, teto e fração acima de 1 passariam.
falsificar S2-SEM-FAIXA " A8 A9 A11" 's/cmv_heuristica_faixa_ck CHECK ($/cmv_heuristica_faixa_ck CHECK (true OR/'
# S3: sem exigir CMV positivo — pct com CMV negativo passa e CMV 0 vira division_by_zero (22012, não 23514).
falsificar S3-SEM-CMV-POSITIVO " A6 A13" 's/CASE WHEN cmv > 0 THEN/CASE WHEN true THEN/' 'veio [22012]'
# S4: gatilho inerte — bundle velho deixaria valor de outra apuração (e o UPDATE seria derrubado pelo CHECK).
# (parênteses: `false AND a OR b` ainda dispara pelo `OR` — precedência, não gatilho inerte)
falsificar S4-GATILHO-INERTE " A15 A16 A17" "s/^  IF NEW.detalhamento IS NULL\$/  IF false AND (NEW.detalhamento IS NULL/;s/? 'cmv_heuristica') THEN\$/? 'cmv_heuristica')) THEN/"
# S5: DEFAULT 0 — fabricaria "CMV 100% mapeado" nos snapshots antigos; a postcondição barra no apply.
falsificar S5-DEFAULT-ZERO " A0" 's/ADD COLUMN IF NOT EXISTS cmv_heuristica numeric,/ADD COLUMN IF NOT EXISTS cmv_heuristica numeric DEFAULT 0,/' 'P3 FALHOU'

echo "═══ RESULTADO: controle $CONTROLE_PASS/22 verde · 5 sabotagens acusadas pelo assert declarado ═══"
echo "EXECUTOU-ATE-O-FIM"
