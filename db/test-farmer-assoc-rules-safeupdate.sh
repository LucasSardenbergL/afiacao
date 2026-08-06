#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — farmer_association_rules_substituir SOB `safeupdate`            ║
# ║      bash db/test-farmer-assoc-rules-safeupdate.sh > logs/x.log 2>&1          ║
# ║      echo "exit=$?"     (NÃO pipe pra tail — engole o exit≠0)                 ║
# ║                                                                               ║
# ║  POR QUE ESTE HARNESS EXISTE, tendo o test-farmer-association-rules-atomica   ║
# ║  26 asserts VERDES: ele roda a RPC como SUPERUSER num psql limpo, que NÃO é   ║
# ║  como o PostgREST chama. Em prod o role `authenticator` tem                   ║
# ║  `session_preload_libraries=safeupdate`, cujo post_parse_analyze_hook recusa  ║
# ║  DELETE/UPDATE com `jointree->quals == NULL` — inclusive DENTRO de plpgsql    ║
# ║  SECURITY DEFINER (o DEFINER troca o ROLE, não o hook, que é de SESSÃO).      ║
# ║  Resultado: harness VERDE + produção 100% quebrada por 2 dias. Este arquivo   ║
# ║  fecha exatamente essa lacuna — carrega o módulo REAL e chama pela sessão     ║
# ║  certa, com grupo de CONTROLE (mesma chamada sem o módulo) pra isolar a causa.║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5477}"
SLUG="assocsafeupd"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
BUILD="$(mktemp -d "/tmp/safeupd-build.XXXXXX")"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$BUILD"; }
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 0 — o módulo `safeupdate` (o ambiente que o harness antigo não tinha)
#
# Reprodução MÍNIMA e FIEL do pg-safeupdate (ISC, eradman/pg-safeupdate): o
# original instala um post_parse_analyze_hook e levanta ERRCODE 21000 quando
# `query->jointree->quals == NULL` em CMD_DELETE/CMD_UPDATE. É essa a regra
# inteira — e é ela que a prod aplica. Compilar aqui (em vez de vendorizar o
# .c de terceiro) mantém o repo livre de dependência externa e prova a MESMA
# propriedade: o que decide é a árvore de PARSE, não o plano.
# ══════════════════════════════════════════════════════════════════════════════
# Quem tiver o módulo ORIGINAL compilado aponta pra ele e a prova roda contra o
# artefato de verdade:  SAFEUPDATE_SO=/caminho/safeupdate.so bash db/test-...sh
cat > "$BUILD/safeupdate_repro.c" <<'CCODE'
#include "postgres.h"
#include "fmgr.h"
#include "parser/analyze.h"
#include "utils/guc.h"

PG_MODULE_MAGIC;
void _PG_init(void);
static post_parse_analyze_hook_type prev_hook = NULL;

static void
check_quals(ParseState *pstate, Query *query, JumbleState *jstate)
{
	if (prev_hook != NULL)
		(*prev_hook)(pstate, query, jstate);

	switch (query->commandType)
	{
		case CMD_DELETE:
			if (query->jointree->quals == NULL)
				ereport(ERROR,
						(errcode(ERRCODE_CARDINALITY_VIOLATION),
						 errmsg("DELETE requires a WHERE clause")));
			break;
		case CMD_UPDATE:
			if (query->jointree->quals == NULL)
				ereport(ERROR,
						(errcode(ERRCODE_CARDINALITY_VIOLATION),
						 errmsg("UPDATE requires a WHERE clause")));
			break;
		default:
			break;
	}
}

void
_PG_init(void)
{
	prev_hook = post_parse_analyze_hook;
	post_parse_analyze_hook = check_quals;
}
CCODE

if [ -n "${SAFEUPDATE_SO:-}" ]; then
  [ -f "$SAFEUPDATE_SO" ] || { echo "SAFEUPDATE_SO=$SAFEUPDATE_SO não existe"; exit 1; }
  cp "$SAFEUPDATE_SO" "$BUILD/safeupdate.so"
  echo "=== módulo safeupdate ORIGINAL em uso ($SAFEUPDATE_SO) ==="
else
  INC="/opt/homebrew/opt/postgresql@${PGVER}/include/postgresql/server"
  GT="$(brew --prefix gettext 2>/dev/null || echo /opt/homebrew/opt/gettext)"
  clang -O2 -fPIC -bundle -bundle_loader "$PGBIN/postgres" \
        -I"$INC" -I"$GT/include" -o "$BUILD/safeupdate.so" "$BUILD/safeupdate_repro.c" 2>"$BUILD/cc.log" || {
    echo "FALHA ao compilar o módulo — sem ele este harness NÃO mede nada (ausência de sinal != aprovação)."
    cat "$BUILD/cc.log"; exit 1; }
  [ -f "$BUILD/safeupdate.so" ] || { echo "safeupdate.so não foi produzido"; exit 1; }
  echo "=== módulo safeupdate (reprodução) compilado ==="
fi

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove

# P  = sessão SUPERUSER SEM o módulo  (o ambiente do harness antigo / do SQL Editor)
# PA = sessão do role com o módulo pré-carregado (o ambiente do PostgREST)
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
PA() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres_rest -d prove -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (fiéis à prod)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.farmer_association_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    antecedent_product_ids text[] NOT NULL,
    consequent_product_ids text[] NOT NULL,
    support numeric DEFAULT 0 NOT NULL,
    confidence numeric DEFAULT 0 NOT NULL,
    lift numeric DEFAULT 0 NOT NULL,
    rule_type text DEFAULT 'association'::text NOT NULL,
    cluster_segment text,
    sample_size integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT farmer_association_rules_rule_type_check CHECK ((rule_type = ANY (ARRAY['association'::text, 'sequential'::text])))
);
ALTER TABLE ONLY public.farmer_association_rules ADD CONSTRAINT farmer_association_rules_pkey PRIMARY KEY (id);
ALTER TABLE public.farmer_association_rules ENABLE ROW LEVEL SECURITY;
SQL

# O role que ESPELHA o `authenticator` da prod: NOSUPERUSER + o módulo pré-carregado
# na SESSÃO. É o único jeito de reproduzir o que o PostgREST faz.
P -q <<SQL
CREATE ROLE postgres_rest LOGIN NOSUPERUSER;
GRANT service_role TO postgres_rest;
ALTER ROLE postgres_rest SET session_preload_libraries = '$BUILD/safeupdate.so';
ALTER ROLE postgres_rest SET test.role = 'service_role';
SQL
echo "pré-requisitos criados (role postgres_rest espelha o authenticator)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (Lei #1: a função sob teste é a real)
# ══════════════════════════════════════════════════════════════════════════════
MIG_BASE="$REPO_ROOT/supabase/migrations/20260729120000_farmer_association_rules_substituicao_atomica.sql"
MIG_FIX="$REPO_ROOT/supabase/migrations/20260731120000_farmer_assoc_rules_delete_qualificado.sql"
P -q -f "$MIG_BASE"
echo "migration base aplicada: $(basename "$MIG_BASE")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.farmer_association_rules
  (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES
  (ARRAY['ANTIGA-A'], ARRAY['ANTIGA-B'], 0.0105, 0.2000,  6.33, 'association', 475),
  (ARRAY['ANTIGA-B'], ARRAY['ANTIGA-C'], 0.0211, 1.0000, 47.50, 'association', 475),
  (ARRAY['ANTIGA-C'], ARRAY['ANTIGA-A'], 0.0150, 0.5000, 12.00, 'sequential',  475);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_association_rules TO service_role;
SQL

LOTE_OK='[
  {"antecedent_product_ids":["NOVA-1"],"consequent_product_ids":["NOVA-2"],"support":0.03,"confidence":0.42,"lift":2.1,"rule_type":"association","sample_size":500},
  {"antecedent_product_ids":["NOVA-2"],"consequent_product_ids":["NOVA-3"],"support":0.04,"confidence":0.55,"lift":3.7,"rule_type":"sequential","sample_size":500}
]'
antigas() { Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE sample_size = 475;"; }
restaura_antigas() {
  P -q <<'SQL'
DELETE FROM public.farmer_association_rules WHERE true;
INSERT INTO public.farmer_association_rules
  (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES
  (ARRAY['ANTIGA-A'], ARRAY['ANTIGA-B'], 0.0105, 0.2000,  6.33, 'association', 475),
  (ARRAY['ANTIGA-B'], ARRAY['ANTIGA-C'], 0.0211, 1.0000, 47.50, 'association', 475),
  (ARRAY['ANTIGA-C'], ARRAY['ANTIGA-A'], 0.0150, 0.5000, 12.00, 'sequential',  475);
SQL
}
eq "S0 lote antigo semeado" "$(antigas)" "3"

# chama a RPC pela sessão COM o módulo e devolve 'OK:<n>' ou 'ERRO:<sqlstate>:<msg>'
chama_rest() {
  PA -c "DO \$\$
DECLARE n integer;
BEGIN
  n := public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
  RAISE NOTICE 'OK:%', n;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ERRO:%:%', SQLSTATE, SQLERRM;
END \$\$;" 2>&1 | tr -d '\r' | sed -n 's/^NOTICE:[[:space:]]*//p' | tail -1
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- CONTROLE: o módulo é a única variável --"

# C1 — o harness FUNCIONA: a mesma chamada, na sessão SEM o módulo, passa.
#      Sem este controle, um RED em C2 seria indistinguível de harness quebrado.
R=$(Pq -c "SET test.role='service_role'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" | tail -1)
eq "C1 sessão SEM safeupdate: a RPC pré-fix FUNCIONA (harness sadio)" "$R" "2"

echo "-- RED: reproduzir o incidente de produção --"
restaura_antigas

# C2 — a MESMA chamada, na sessão COM o módulo: é o 500 da produção, verbatim.
R=$(chama_rest)
case "$R" in
  "ERRO:21000:DELETE requires a WHERE clause") ok "C2 sessão COM safeupdate: reproduz o erro da prod ($R)" ;;
  *) bad "C2 esperado [ERRO:21000:DELETE requires a WHERE clause], veio [$R]" ;;
esac
eq "C2b e o lote antigo sobreviveu (nada foi apagado)" "$(antigas)" "3"

echo "-- GREEN: aplicar o fix --"
P -q -f "$MIG_FIX"
echo "migration fix aplicada: $(basename "$MIG_FIX")"

# C3 — mesma sessão, mesma chamada: agora passa.
R=$(chama_rest)
case "$R" in
  "OK:2") ok "C3 pós-fix, sessão COM safeupdate: a RPC substitui (retorno 2)" ;;
  *)      bad "C3 esperado [OK:2], veio [$R]" ;;
esac
eq "C3b a substituição REALMENTE trocou o lote (antigas=0)" "$(antigas)" "0"
eq "C3c e o lote novo está lá" "$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE sample_size=500;")" "2"

# C4 — o WHERE não afrouxou a semântica: DELETE WHERE true apaga TUDO, inclusive
#      linha que o lote novo não substitui (a função é "substitua tudo", não upsert).
restaura_antigas
P -q -c "INSERT INTO public.farmer_association_rules(antecedent_product_ids,consequent_product_ids,support,confidence,lift,rule_type,sample_size) VALUES (ARRAY['ORFA'],ARRAY['X'],0.01,0.1,1.0,'association',999);"
R=$(chama_rest)
eq "C4 pré-condição: a chamada passou" "$R" "OK:2"
eq "C4b nenhuma linha órfã sobrou (WHERE true = tudo)" "$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE sample_size IN (475,999);")" "0"

# C5 — idempotência: re-aplicar o fix não erra nem duplica nada
P -q -f "$MIG_FIX"
ok "C5 re-aplicar a migration do fix é no-op (não levantou erro)"
R=$(chama_rest)
eq "C5b e a RPC continua funcionando após re-aplicar" "$R" "OK:2"

# C6 — o gate de autorização continua de pé (o fix não mexeu nele)
R=$(PA -c "SET test.role='customer'; DO \$\$
BEGIN
  PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
  RAISE NOTICE 'PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BARROU';
          WHEN OTHERS THEN RAISE;
END \$\$;" 2>&1 | sed -n 's/^NOTICE:[[:space:]]*//p' | tail -1)
eq "C6 gate de staff intacto pós-fix (customer barrado)" "$R" "BARROU"

# C7 — lote vazio continua RECUSADO (TR001), não "apaga tudo"
restaura_antigas
R=$(PA -c "DO \$\$
BEGIN
  PERFORM public.farmer_association_rules_substituir('[]'::jsonb);
  RAISE NOTICE 'PASSOU';
EXCEPTION WHEN SQLSTATE 'TR001' THEN RAISE NOTICE 'BARROU';
          WHEN OTHERS THEN RAISE;
END \$\$;" 2>&1 | sed -n 's/^NOTICE:[[:space:]]*//p' | tail -1)
eq "C7 lote vazio segue recusado (TR001)" "$R" "BARROU"
eq "C7b e as antigas sobreviveram" "$(antigas)" "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabotar o fix tem que deixar C3 VERMELHO
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificação --"

# F1 — desfaz o WHERE no corpo vivo. Se C3 seguisse verde, o assert não teria dente.
restaura_antigas
P -q <<'SQL'
DO $sab$
DECLARE v_oid oid; v_def text;
BEGIN
  v_oid := to_regprocedure('public.farmer_association_rules_substituir(jsonb)')::oid;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(v_def,
                   'DELETE FROM public.farmer_association_rules WHERE true;',
                   'DELETE FROM public.farmer_association_rules;');
  EXECUTE v_def;
END $sab$;
SQL
R=$(chama_rest)
case "$R" in
  "ERRO:21000:DELETE requires a WHERE clause") ok "F1 tirar o WHERE derruba C3 (volta o erro da prod) — o assert tem dente" ;;
  *) bad "F1 C3 seguiu VERDE com o WHERE removido — assert sem dente (veio [$R])" ;;
esac
eq "F1b e nada foi apagado sob a sabotagem" "$(antigas)" "3"

# F2 — GUARD 2 da migration: corpo divergente tem que ABORTAR, não "aplicar" calado.
P -q <<'SQL'
DO $sab$
DECLARE v_oid oid; v_def text;
BEGIN
  v_oid := to_regprocedure('public.farmer_association_rules_substituir(jsonb)')::oid;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(v_def,
                   'DELETE FROM public.farmer_association_rules;',
                   'DELETE FROM public.farmer_association_rules AS x USING (SELECT 1) s;');
  EXECUTE v_def;
END $sab$;
SQL
if P -q -f "$MIG_FIX" >/dev/null 2>&1; then
  bad "F2 a migration passou com o corpo divergente — GUARD 2 sem dente"
else
  ok "F2 corpo divergente faz a migration ABORTAR (GUARD 2 tem dente)"
fi

# restaura o mundo verdadeiro e confirma que o caminho feliz volta
P -q -f "$MIG_BASE"
P -q -f "$MIG_FIX"
restaura_antigas
R=$(chama_rest)
eq "Z1 migrations restauradas, caminho feliz de volta" "$R" "OK:2"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
