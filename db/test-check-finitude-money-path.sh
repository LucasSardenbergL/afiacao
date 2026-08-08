#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — CHECK de finitude money-path                                    ║
# ║  migration: supabase/migrations/20260807223000_check_finitude_money_path.sql   ║
# ║                                                                                ║
# ║  Generalização do PR #1678: guard no WRITER protege o writer, não a TABELA.    ║
# ║  O que se prova aqui é a defesa NO BANCO, que vale para qualquer writer futuro.║
# ║                                                                                ║
# ║  O ponto central, e o motivo de o CHECK "óbvio" estar errado:                  ║
# ║      em `numeric`, ('NaN' > 0) é TRUE  ⇒ CHECK (x > 0) ACEITA NaN              ║
# ║      e ('NaN' > 'Infinity') é TRUE     ⇒ `<> NaN` sozinho não pega Infinity    ║
# ║  A falsificação F1/F2 exige VERMELHO em cada uma dessas duas formas fracas.    ║
# ║                                                                                ║
# ║  rodar:  bash db/test-check-finitude-money-path.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="finitude"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# aceita: o INSERT tem de PASSAR
ace() {
  if P -q -c "$2" >/dev/null 2>&1; then ok "$1 (aceito)"; else bad "$1 -- REJEITOU e devia aceitar"; fi
}

# rejeita: o INSERT tem de falhar com a SQLSTATE ESPERADA (Lei #2 -- re-lanca o resto).
# Sentinela ASCII, caixa fixa, exclusiva do ramo: o PG emite "violates check constraint",
# que nao contem nenhuma das duas sentinelas -> nao ha como o grep casar o texto do proprio PG.
rej() {
  local desc="$1" ins="$2" want="${3:-23514}" out
  out=$(P -tA 2>&1 <<SQL || true
DO \$do\$
BEGIN
  $ins
  RAISE NOTICE 'VEREDITO_ACEITOU';
EXCEPTION
  WHEN OTHERS THEN
    IF SQLSTATE = '$want' THEN
      RAISE NOTICE 'VEREDITO_REJEITOU_%', SQLSTATE;
    ELSE
      RAISE;
    END IF;
END
\$do\$;
SQL
)
  if printf '%s' "$out" | command grep -q "VEREDITO_REJEITOU_${want}"; then
    ok "$desc (rejeitado $want)"
  elif printf '%s' "$out" | command grep -q 'VEREDITO_ACEITOU'; then
    bad "$desc -- ACEITOU e devia rejeitar com $want"
  else
    bad "$desc -- erro inesperado: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-180)"
  fi
}

echo "=== setup PG17 :$PORT ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRE-REQUISITOS (as tabelas que a migration ALTERA mas nao cria)
# `cmc_snapshot` nasce aqui com o CHECK **ANTIGO** de producao, verbatim, para que
# a migration tenha o que endurecer e para que a caracterizacao do defeito (C1/C2)
# meca a forma REAL que esta em prod hoje.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.tint_formula_itens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid NOT NULL,
  corante_id uuid NOT NULL,
  ordem      integer NOT NULL,
  qtd_ml     numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.cmc_snapshot (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid,
  cmc        numeric NOT NULL,
  CONSTRAINT cmc_snapshot_cmc_check CHECK ((cmc > (0)::numeric))   -- <<< forma de PROD hoje
);

-- gemea de controle: fica com o CHECK ANTIGO o teste inteiro, para caracterizar o defeito
CREATE TABLE public.cmc_snapshot_controle_antigo (
  id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cmc numeric NOT NULL,
  CONSTRAINT controle_cmc_check CHECK ((cmc > (0)::numeric))
);

-- linhas preexistentes (o VALIDATE tem de passar sobre dado real ja gravado)
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml)
SELECT gen_random_uuid(), gen_random_uuid(), g, (g * 1.5)::numeric
FROM generate_series(1, 500) g;
INSERT INTO public.cmc_snapshot (cmc) SELECT (g * 0.75)::numeric FROM generate_series(1, 200) g;
SQL
echo "pre-requisitos criados (500 itens + 200 cmc preexistentes)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260807223000_check_finitude_money_path.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

echo "-- asserts --"

# ── CATALOGO ──────────────────────────────────────────────────────────────────
V=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';")
eq "A1 constraint do tint existe" "$V" "1"

V=$(Pq -c "SELECT convalidated FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';")
eq "A2 constraint do tint foi VALIDADA (nao ficou NOT VALID)" "$V" "t"

V=$(Pq -c "SELECT (pg_get_constraintdef(oid) LIKE '%Infinity%') FROM pg_constraint WHERE conname='cmc_snapshot_cmc_check';")
eq "A3 cmc_snapshot_cmc_check foi ENDURECIDA" "$V" "t"

# ── POSITIVOS (o caminho feliz continua passando) ─────────────────────────────
ace "A4 tint aceita dose normal (12.5)" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),1,12.5);"
ace "A5 tint aceita dose fracionaria minima (0.001)" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),2,0.001);"
ace "A6 cmc aceita custo normal (40.25)" \
    "INSERT INTO public.cmc_snapshot (cmc) VALUES (40.25);"

# ── NEGATIVOS: tint_formula_itens.qtd_ml ──────────────────────────────────────
rej "A7 tint rejeita zero" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),3,0);"
rej "A8 tint rejeita negativo" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),4,-1);"
rej "A9 tint rejeita NaN  [o lado que o guard de sinal NAO pega]" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),5,'NaN'::numeric);"
rej "A10 tint rejeita Infinity  [o lado que <> NaN NAO pega]" \
    "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),6,'Infinity'::numeric);"

# ── NEGATIVOS: cmc_snapshot.cmc ───────────────────────────────────────────────
rej "A11 cmc rejeita NaN  [o CHECK antigo ACEITAVA]" \
    "INSERT INTO public.cmc_snapshot (cmc) VALUES ('NaN'::numeric);"
rej "A12 cmc rejeita Infinity  [o CHECK antigo ACEITAVA]" \
    "INSERT INTO public.cmc_snapshot (cmc) VALUES ('Infinity'::numeric);"
rej "A13 cmc segue rejeitando zero (nao-regressao do CHECK antigo)" \
    "INSERT INTO public.cmc_snapshot (cmc) VALUES (0);"

# ── CARACTERIZACAO DO DEFEITO (prova que o endurecimento NAO e cosmetico) ─────
# Na gemea de controle, que ficou com `CHECK (cmc > 0)`, os dois venenos ENTRAM.
# Se estes dois asserts virarem "rejeitado", a premissa da migration caiu e o
# BLOCO 2 dela deixa de ter motivo -- por isso sao asserts, nao comentario.
ace "C1 [defeito] CHECK antigo (cmc>0) ACEITA NaN" \
    "INSERT INTO public.cmc_snapshot_controle_antigo (cmc) VALUES ('NaN'::numeric);"
ace "C2 [defeito] CHECK antigo (cmc>0) ACEITA Infinity" \
    "INSERT INTO public.cmc_snapshot_controle_antigo (cmc) VALUES ('Infinity'::numeric);"

V=$(Pq -c "SELECT count(*) FROM public.cmc_snapshot_controle_antigo WHERE cmc='NaN'::numeric OR cmc='Infinity'::numeric;")
eq "C3 [defeito] os 2 venenos ficaram GRAVADOS sob o CHECK antigo" "$V" "2"

# ── IDEMPOTENCIA (a migration e colada a mao; re-rodar tem de ser inocuo) ─────
P -q -f "$MIG"
V=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';")
eq "A14 re-aplicar a migration nao duplica a constraint" "$V" "1"
V=$(Pq -c "SELECT convalidated FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';")
eq "A15 re-aplicar mantem a constraint validada" "$V" "t"
V=$(Pq -c "SELECT (pg_get_constraintdef(oid) LIKE '%Infinity%') FROM pg_constraint WHERE conname='cmc_snapshot_cmc_check';")
eq "A16 re-aplicar mantem o cmc endurecido" "$V" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO (Lei #3)
# Baseline VERDE explicito ANTES de sabotar: sem ele, um vermelho pode vir de o
# comando nao ter rodado, e nao de o assert ter dente (money-path, "Provar antes
# de aplicar"). Fixo o total esperado e comparo.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"
BASE_PASS=$PASS; BASE_FAIL=$FAIL
if [ "$BASE_FAIL" != "0" ]; then
  echo "  ABORTA: baseline ja vermelho ($BASE_FAIL falhas) -- falsificar aqui nao prova nada"
  exit 1
fi
echo "  baseline VERDE: $BASE_PASS asserts, 0 falhas"

# helper: roda um assert isolado e devolve 0 se PASSOU, 1 se FALHOU (sem mexer nos contadores)
probe_rej() {  # probe_rej <ins> ; 0 = rejeitou (assert passaria), 1 = aceitou (assert falharia)
  local ins="$1" out
  out=$(P -tA 2>&1 <<SQL || true
DO \$do\$
BEGIN
  $ins
  RAISE NOTICE 'VEREDITO_ACEITOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'VEREDITO_REJEITOU_%', SQLSTATE;
END
\$do\$;
SQL
)
  printf '%s' "$out" | command grep -q 'VEREDITO_REJEITOU_23514'
}

INS_NAN="INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),90,'NaN'::numeric);"
INS_INF="INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),91,'Infinity'::numeric);"

sabota_tint() {  # $1 = expressao do CHECK furado
  P -q -c "ALTER TABLE public.tint_formula_itens DROP CONSTRAINT tint_formula_itens_qtd_ml_finita;" >/dev/null
  P -q -c "ALTER TABLE public.tint_formula_itens ADD CONSTRAINT tint_formula_itens_qtd_ml_finita CHECK ($1);" >/dev/null
  # prova que a sabotagem REALMENTE entrou (senao um vermelho/verde nao significa nada)
  P -tA -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';"
}
# A sabotagem GRAVA a linha envenenada (e o proposito dela e justamente esse). Restaurar exige
# EXPURGAR o veneno antes de re-aplicar -- senao o VALIDATE da migration aborta, e com razao.
# Esse aborto e a prova F5 la embaixo; aqui ele seria so ruido.
restaura_tint() {
  P -q -c "ALTER TABLE public.tint_formula_itens DROP CONSTRAINT tint_formula_itens_qtd_ml_finita;" >/dev/null
  P -q -c "DELETE FROM public.tint_formula_itens WHERE NOT (qtd_ml > 0 AND qtd_ml <> 'NaN'::numeric AND qtd_ml < 'Infinity'::numeric);" >/dev/null
  P -q -f "$MIG" >/dev/null
}

# F1 — guard so de SINAL (o CHECK "obvio"): NaN tem de PASSAR pelo guard => A9 VERMELHO
DEF=$(sabota_tint "qtd_ml > 0")
echo "  F1 sabotado para: $DEF"
if probe_rej "$INS_NAN"; then
  bad "F1 -- com CHECK (qtd_ml > 0) o NaN foi rejeitado; A9 nao tem dente"
else
  ok "F1 com CHECK (qtd_ml > 0) o NaN ENTRA => A9 tem dente"
fi
restaura_tint

# F2 — a variante '> 0 AND <> NaN' (a forma INTUITIVA, e a que quase entrou nesta
#      migration): Infinity tem de PASSAR => A10 VERMELHO. Este e o assert que
#      justifica o terceiro predicado.
DEF=$(sabota_tint "qtd_ml > 0 AND qtd_ml <> 'NaN'::numeric")
echo "  F2 sabotado para: $DEF"
if probe_rej "$INS_INF"; then
  bad "F2 -- com CHECK (>0 AND <>NaN) o Infinity foi rejeitado; A10 nao tem dente"
else
  ok "F2 com CHECK (>0 AND <>NaN) o Infinity ENTRA => A10 tem dente"
fi
# e, na MESMA sabotagem, o NaN tem de seguir barrado (a sabotagem e cirurgica: so um lado cai)
if probe_rej "$INS_NAN"; then
  ok "F2b sob a mesma sabotagem o NaN segue barrado (so o lado do Infinity caiu)"
else
  bad "F2b -- a sabotagem F2 derrubou os DOIS lados; nao isola o predicado testado"
fi
restaura_tint

# F3 — restauracao conferida: depois de restaurar, os dois venenos voltam a ser barrados
if probe_rej "$INS_NAN" && probe_rej "$INS_INF"; then
  ok "F3 restauracao OK -- NaN e Infinity barrados de novo pela migration real"
else
  bad "F3 -- a restauracao nao devolveu o CHECK forte"
fi

# F4 — sabota o cmc de volta para a forma antiga => A11 (NaN) VERMELHO
P -q -c "ALTER TABLE public.cmc_snapshot DROP CONSTRAINT cmc_snapshot_cmc_check;" >/dev/null
P -q -c "ALTER TABLE public.cmc_snapshot ADD CONSTRAINT cmc_snapshot_cmc_check CHECK ((cmc > (0)::numeric));" >/dev/null
OUT=$(P -tA 2>&1 <<'SQL' || true
DO $do$
BEGIN
  INSERT INTO public.cmc_snapshot (cmc) VALUES ('NaN'::numeric);
  RAISE NOTICE 'VEREDITO_ACEITOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'VEREDITO_REJEITOU_%', SQLSTATE;
END
$do$;
SQL
)
if printf '%s' "$OUT" | command grep -q 'VEREDITO_ACEITOU'; then
  ok "F4 com o CHECK antigo do cmc o NaN ENTRA => A11 tem dente"
else
  bad "F4 -- o CHECK antigo do cmc rejeitou NaN; A11 nao tem dente"
fi
P -q -c "DELETE FROM public.cmc_snapshot WHERE cmc='NaN'::numeric;" >/dev/null
P -q -f "$MIG" >/dev/null

# F5 — A MIGRATION ABORTA SOBRE DADO SUJO (fail-closed no apply).
# Descoberto ao rodar o proprio harness: a sabotagem F1 deixou uma linha NaN gravada e o
# VALIDATE recusou-se a validar. E o comportamento CERTO, e e o unico que impede um
# falso-verde: sem ele a constraint ficaria NOT VALID para sempre -- valendo so para escrita
# nova, com o passivo sujo invisivel e a migration reportando sucesso.
# Prod foi pre-medido em 0 violacoes, entao o apply real nao encosta neste caminho; o assert
# existe para garantir que, se ISSO mudar entre a medicao e o apply, o founder VE o vermelho.
P -q -c "ALTER TABLE public.tint_formula_itens DROP CONSTRAINT tint_formula_itens_qtd_ml_finita;" >/dev/null
P -q -c "INSERT INTO public.tint_formula_itens (formula_id,corante_id,ordem,qtd_ml) VALUES (gen_random_uuid(),gen_random_uuid(),99,'NaN'::numeric);" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F5 -- a migration APLICOU com linha NaN preexistente (falso-verde: constraint ficaria NOT VALID)"
else
  ok "F5 migration ABORTA com dado sujo preexistente (sem falso-verde silencioso)"
fi
# e, tendo abortado, a constraint NAO pode ter ficado meio-aplicada como NOT VALID
V=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita' AND convalidated;")
eq "F5b nenhuma constraint VALIDADA sobreviveu ao aborto" "$V" "0"
P -q -c "DELETE FROM public.tint_formula_itens WHERE qtd_ml='NaN'::numeric;" >/dev/null
P -q -f "$MIG" >/dev/null
V=$(Pq -c "SELECT convalidated FROM pg_constraint WHERE conname='tint_formula_itens_qtd_ml_finita';")
eq "F5c apos expurgar o dado sujo a migration aplica e VALIDA" "$V" "t"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
