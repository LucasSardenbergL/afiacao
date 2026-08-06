#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — farmer_association_rules_substituir (substituição ATÔMICA)      ║
# ║      bash db/test-farmer-association-rules-atomica.sh > /tmp/t.log 2>&1        ║
# ║      echo "exit=$?"     (NÃO pipe pra tail — engole o exit≠0)                  ║
# ║                                                                                ║
# ║  O que está sob prova: a tabela é GLOBAL e alimenta 5 consumidores (MixGap,    ║
# ║  canal Melhorias, edge recommend, cross-sell, o próprio bundle engine). Os     ║
# ║  dois writers faziam DELETE-tudo + INSERT em chamadas SEPARADAS com o `error`  ║
# ║  descartado — falha no meio ZERAVA a tabela. Aqui provo que a RPC nova não     ║
# ║  deixa a tabela vazia em NENHUM caminho de falha.                             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="assocrules"
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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria) — fiéis à prod
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');

CREATE TABLE public.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);

-- verbatim da prod (pg_get_functiondef)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- verbatim do schema-snapshot.sql (linhas 20202-20214)
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
CREATE POLICY "Staff can manage association rules" ON public.farmer_association_rules
  USING ((public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)))
  WITH CHECK ((public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)));
SQL
echo "pré-requisitos criados"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260729120000_farmer_association_rules_substituicao_atomica.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (3 personas + o LOTE ANTIGO que precisa sobreviver a toda falha)
# ══════════════════════════════════════════════════════════════════════════════
MASTER='11111111-1111-1111-1111-111111111111'
EMPLOYEE='22222222-2222-2222-2222-222222222222'
CUSTOMER='33333333-3333-3333-3333-333333333333'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'), ('$EMPLOYEE'), ('$CUSTOMER');
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$MASTER','master'), ('$EMPLOYEE','employee'), ('$CUSTOMER','customer');

-- LOTE ANTIGO: 3 regras "em produção". A pergunta que todo assert negativo faz é
-- "elas continuam aqui?". Marcadas com sample_size=475 (o valor real da prod hoje).
INSERT INTO public.farmer_association_rules
  (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES
  (ARRAY['ANTIGA-A'], ARRAY['ANTIGA-B'], 0.0105, 0.2000,  6.33, 'association', 475),
  (ARRAY['ANTIGA-B'], ARRAY['ANTIGA-C'], 0.0211, 1.0000, 47.50, 'association', 475),
  (ARRAY['ANTIGA-C'], ARRAY['ANTIGA-A'], 0.0150, 0.5000, 12.00, 'sequential',  475);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_association_rules TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# lote novo, válido, com 2 regras (reproduz o formato que os dois writers montam)
LOTE_OK='[
  {"antecedent_product_ids":["NOVA-1"],"consequent_product_ids":["NOVA-2"],"support":0.03,"confidence":0.42,"lift":2.1,"rule_type":"association","sample_size":500},
  {"antecedent_product_ids":["NOVA-2"],"consequent_product_ids":["NOVA-3"],"support":0.04,"confidence":0.55,"lift":3.7,"rule_type":"sequential","sample_size":500}
]'

# quantas regras ANTIGAS continuam de pé (a pergunta central deste harness)
antigas() { Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE sample_size = 475;"; }
total()   { Pq -c "SELECT count(*) FROM public.farmer_association_rules;"; }

eq "S0 lote antigo semeado" "$(antigas)" "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- asserts: caminho feliz --"

# A1 — master substitui: retorno = nº inserido, e o lote ANTIGO some (é substituição, não append)
R=$(Pq -c "SET test.uid='$MASTER'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" | tail -1)
eq "A1 master substitui (retorno)" "$R" "2"
eq "A1b lote antigo foi substituído" "$(antigas)" "0"
eq "A1c total = só o lote novo" "$(total)" "2"

# A2 — os VALORES chegaram inteiros (não é só contagem: o consumidor lê confidence/lift)
V=$(Pq -c "SELECT confidence || '|' || lift || '|' || rule_type || '|' || sample_size FROM public.farmer_association_rules WHERE antecedent_product_ids = ARRAY['NOVA-2'];")
eq "A2 valores preservados" "$V" "0.55|3.7|sequential|500"

# A3 — service_role (a edge omie-analytics-sync roda com service key, auth.uid() nulo)
P -q -c "TRUNCATE public.farmer_association_rules;"
P -q <<SQL
INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES (ARRAY['ANTIGA-A'], ARRAY['ANTIGA-B'], 0.0105, 0.2, 6.33, 'association', 475),
       (ARRAY['ANTIGA-B'], ARRAY['ANTIGA-C'], 0.0211, 1.0, 47.5, 'association', 475),
       (ARRAY['ANTIGA-C'], ARRAY['ANTIGA-A'], 0.0150, 0.5, 12.0, 'sequential',  475);
SQL
R=$(Pq -c "SET test.role='service_role'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" | tail -1)
eq "A3 service_role substitui (a edge)" "$R" "2"

# restaura o lote antigo para os negativos
restaura_antigas() {
  P -q <<SQL
DELETE FROM public.farmer_association_rules;
INSERT INTO public.farmer_association_rules (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
VALUES (ARRAY['ANTIGA-A'], ARRAY['ANTIGA-B'], 0.0105, 0.2, 6.33, 'association', 475),
       (ARRAY['ANTIGA-B'], ARRAY['ANTIGA-C'], 0.0211, 1.0, 47.5, 'association', 475),
       (ARRAY['ANTIGA-C'], ARRAY['ANTIGA-A'], 0.0150, 0.5, 12.0, 'sequential',  475);
SQL
}

echo "-- asserts: a defesa morde (SQLSTATE esperada + re-raise) --"

# ── A4: customer não substitui (gate 42501) ────────────────────────────────────
restaura_antigas
R=$(P -tA 2>&1 <<SQL
SET test.uid='$CUSTOMER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;   -- 42501 = o erro ESPERADO
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A4_ABERTO'; ELSE RAISE NOTICE 'SENTINELA_A4_BARROU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A4_BARROU*) ok  "A4 customer barrado pelo gate" ;;
  *SENTINELA_A4_ABERTO*) bad "A4 gate ABERTO — customer substituiu as regras" ;;
  *)                     bad "A4 resultado inesperado: $R" ;;
esac
eq "A4b regras antigas intactas após o gate negar" "$(antigas)" "3"

# ── A5: LOTE VAZIO não apaga a tabela (TR001) — o coração do fail-closed ───────
restaura_antigas
R=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('[]'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN SQLSTATE 'TR001' THEN NULL;         -- lote vazio recusado = ESPERADO
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A5_ACEITOU'; ELSE RAISE NOTICE 'SENTINELA_A5_RECUSOU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A5_RECUSOU*) ok  "A5 lote vazio recusado (TR001)" ;;
  *SENTINELA_A5_ACEITOU*) bad "A5 lote vazio ACEITO — a tabela seria zerada" ;;
  *)                      bad "A5 resultado inesperado: $R" ;;
esac
eq "A5b regras antigas intactas após lote vazio" "$(antigas)" "3"

# ── A6: payload inválido não apaga a tabela (TR005) ───────────────────────────
# confidence 1.4 (>1) e consequent vazio: os dois tipos de lixo que a validação pega
restaura_antigas
LOTE_RUIM='[{"antecedent_product_ids":["X"],"consequent_product_ids":[],"support":0.03,"confidence":1.4,"lift":2.1,"rule_type":"association","sample_size":9}]'
R=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_RUIM'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN SQLSTATE 'TR005' THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A6_ACEITOU'; ELSE RAISE NOTICE 'SENTINELA_A6_RECUSOU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A6_RECUSOU*) ok  "A6 payload inválido recusado (TR005)" ;;
  *SENTINELA_A6_ACEITOU*) bad "A6 payload inválido ACEITO" ;;
  *)                      bad "A6 resultado inesperado: $R" ;;
esac
eq "A6b regras antigas intactas após payload inválido" "$(antigas)" "3"

# ── A7: ATOMICIDADE — INSERT falha DEPOIS do DELETE e as antigas sobrevivem ────
# É o defeito original em forma executável: injeto uma falha no meio do INSERT
# (trigger que estoura na 2ª linha) e exijo que o DELETE tenha sido desfeito.
restaura_antigas
P -q <<'SQL'
CREATE FUNCTION public.__injeta_falha_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.antecedent_product_ids = ARRAY['NOVA-2'] THEN
    RAISE EXCEPTION 'falha injetada no meio do INSERT' USING ERRCODE = '58030';  -- io_error
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_injeta_falha BEFORE INSERT ON public.farmer_association_rules
  FOR EACH ROW EXECUTE FUNCTION public.__injeta_falha_insert();
SQL
R=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN io_error THEN NULL;                 -- 58030 = a falha que injetei
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A7_NAOFALHOU'; ELSE RAISE NOTICE 'SENTINELA_A7_PROPAGOU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A7_PROPAGOU*)  ok  "A7 falha no INSERT propaga (não é engolida)" ;;
  *SENTINELA_A7_NAOFALHOU*) bad "A7 a falha injetada não chegou ao caller" ;;
  *)                        bad "A7 resultado inesperado: $R" ;;
esac
# ESTE é o assert que o parecer pediu: INSERT falhou -> as regras antigas continuam lá
eq "A7b ATOMICIDADE: as 3 antigas sobreviveram ao INSERT falho" "$(antigas)" "3"
eq "A7c tabela NÃO ficou vazia"                                 "$(total)"   "3"
P -q -c "DROP TRIGGER zz_injeta_falha ON public.farmer_association_rules; DROP FUNCTION public.__injeta_falha_insert();"

# ── A8: CONCORRÊNCIA — o 2º recálculo simultâneo é recusado (TR004), não intercala ──
restaura_antigas
# uma 2ª conexão segura o mesmo advisory lock por alguns segundos
P -q -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('farmer_association_rules_substituir')); SELECT pg_sleep(6); COMMIT;" >/dev/null 2>&1 &
LOCK_BG=$!
for _ in $(seq 1 60); do
  N=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted;")
  [ "${N:-0}" -ge 1 ] && break
  sleep 0.2
done
R=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN SQLSTATE 'TR004' THEN NULL;         -- concorrente recusado = ESPERADO
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A8_INTERCALOU'; ELSE RAISE NOTICE 'SENTINELA_A8_SERIALIZOU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A8_SERIALIZOU*) ok  "A8 recálculo concorrente recusado (TR004)" ;;
  *SENTINELA_A8_INTERCALOU*) bad "A8 dois recálculos rodaram juntos — lote pode duplicar" ;;
  *)                         bad "A8 resultado inesperado: $R" ;;
esac
eq "A8b regras antigas intactas sob concorrência" "$(antigas)" "3"
wait "$LOCK_BG" 2>/dev/null || true
# o lock é _xact_: some sozinho no commit. Prova que não vazou entre chamadas.
R=$(Pq -c "SET test.uid='$MASTER'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" | tail -1)
eq "A8c lock liberado — a chamada seguinte passa" "$R" "2"

# ── A9: teto defensivo (TR003) ────────────────────────────────────────────────
restaura_antigas
R=$(P -tA 2>&1 <<SQL
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false; v_lote jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'antecedent_product_ids', jsonb_build_array('A' || i),
    'consequent_product_ids', jsonb_build_array('B' || i),
    'support', 0.02, 'confidence', 0.5, 'lift', 2.0,
    'rule_type', 'association', 'sample_size', 10))
  INTO v_lote FROM generate_series(1, 1001) i;
  BEGIN
    PERFORM public.farmer_association_rules_substituir(v_lote);
    v_passou := true;
  EXCEPTION
    WHEN SQLSTATE 'TR003' THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A9_ACEITOU'; ELSE RAISE NOTICE 'SENTINELA_A9_RECUSOU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A9_RECUSOU*) ok  "A9 lote acima do teto recusado (TR003)" ;;
  *SENTINELA_A9_ACEITOU*) bad "A9 lote de 1001 regras aceito" ;;
  *)                      bad "A9 resultado inesperado: $R" ;;
esac
eq "A9b regras antigas intactas após lote gigante" "$(antigas)" "3"

# ── A10: anon não executa (REVOKE na porta, antes mesmo do gate) ──────────────
R=$(P -tA 2>&1 <<SQL
SET ROLE anon;
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;   -- 42501 do REVOKE
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENTINELA_A10_EXECUTOU'; ELSE RAISE NOTICE 'SENTINELA_A10_BARRADO'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_A10_BARRADO*)  ok  "A10 anon não executa a função" ;;
  *SENTINELA_A10_EXECUTOU*) bad "A10 anon EXECUTOU a função" ;;
  *)                        bad "A10 resultado inesperado: $R" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Regra: cada invariante crítico ganha UMA sabotagem apontada a ELE. Sabotagem que
# não deixa o assert vermelho = assert sem dente.
echo "-- falsificação --"

# roda um assert isolado e devolve VERDE/VERMELHO, sem mexer nos contadores globais
# $1 = SQLSTATE esperada · $2 = lote · $3 = quantas antigas devem sobreviver
sonda() {
  local estado="$1" lote="$2" esperado="$3" out
  restaura_antigas
  out=$(P -tA 2>&1 <<SQL || true
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$lote'::jsonb);
    v_passou := true;
  EXCEPTION
    WHEN SQLSTATE '$estado' THEN NULL;
    WHEN OTHERS THEN NULL;
  END;
  IF v_passou THEN RAISE NOTICE 'SONDA_PASSOU'; ELSE RAISE NOTICE 'SONDA_BARROU'; END IF;
END \$\$;
SQL
)
  # o invariante sobrevive?  barrou E as antigas continuam de pé
  case "$out" in
    *SONDA_BARROU*) [ "$(antigas)" = "$esperado" ] && echo "VERDE" || echo "VERMELHO" ;;
    *)              echo "VERMELHO" ;;
  esac
}

# sabota o arquivo da migration cirurgicamente e reaplica.
# O `cmp` NÃO é zelo: uma expressão que não casa nada aplicaria a migration VERDADEIRA e
# a falsificação inteira ficaria verde sem ter sabotado nada — o teatro que a Lei #3 existe
# pra matar. (Aconteceu aqui: `0,/re/s//../` é sintaxe do GNU sed, o macOS usa BSD.)
sabota() {
  local expr="$1" tmp
  tmp="$(mktemp /tmp/sabota-XXXXXX.sql)"
  sed -E "$expr" "$MIG" > "$tmp"
  if cmp -s "$tmp" "$MIG"; then
    bad "SABOTAGEM INERTE: [$expr] não alterou a migration — falsificação sem valor"
    rm -f "$tmp"
    return 0
  fi
  P -q -f "$tmp"; rm -f "$tmp"
}
restaura_migration() { P -q -f "$MIG"; }

# F1 — sabota o fail-closed do lote vazio → A5 tem que ficar VERMELHO
sabota "s/IF v_total = 0 THEN/IF false THEN/"
V=$(sonda "TR001" "[]" "3")
if [ "$V" = "VERMELHO" ]; then ok "F1 sabotar o fail-closed derruba A5 (assert tem dente)"
else bad "F1 A5 seguiu VERDE com o fail-closed sabotado — assert sem dente"; fi
restaura_migration

# F2 — sabota o gate → A4 tem que ficar VERMELHO
# (o 1º termo vira `true`, então `IF NOT (true OR ...)` nunca levanta o 42501)
sabota "s/coalesce\\(auth\\.role\\(\\), ''\\) = 'service_role'/true/"
restaura_antigas
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$CUSTOMER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF v_passou THEN RAISE NOTICE 'SONDA_PASSOU'; ELSE RAISE NOTICE 'SONDA_BARROU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SONDA_PASSOU*) ok  "F2 sabotar o gate derruba A4 (customer passou a substituir)" ;;
  *)              bad "F2 A4 seguiu VERDE com o gate sabotado — assert sem dente" ;;
esac
restaura_migration

# F3 — sabota a ATOMICIDADE: reproduz o bug ORIGINAL (DELETE de pé + INSERT engolido).
#      A7b tem que ficar VERMELHO — é a prova de que ele mede a atomicidade, não outra coisa.
restaura_antigas
P -q <<'SQL'
CREATE FUNCTION public.__injeta_falha_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.antecedent_product_ids = ARRAY['NOVA-2'] THEN
    RAISE EXCEPTION 'falha injetada no meio do INSERT' USING ERRCODE = '58030';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_injeta_falha BEFORE INSERT ON public.farmer_association_rules
  FOR EACH ROW EXECUTE FUNCTION public.__injeta_falha_insert();

-- versão FURADA: o bloco EXCEPTION cria um savepoint só em volta do INSERT, então o
-- DELETE fica de pé e o erro é engolido. É exatamente o defeito de 9892dd88, em SQL.
CREATE OR REPLACE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_inseridas integer := 0;
BEGIN
  DELETE FROM public.farmer_association_rules;
  BEGIN
    INSERT INTO public.farmer_association_rules
      (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size)
    SELECT r.antecedent_product_ids, r.consequent_product_ids, r.support, r.confidence, r.lift,
           r.rule_type, coalesce(r.sample_size, 0)
    FROM jsonb_to_recordset(p_regras) AS r(
      antecedent_product_ids text[], consequent_product_ids text[], support numeric,
      confidence numeric, lift numeric, rule_type text, sample_size integer);
    GET DIAGNOSTICS v_inseridas = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN v_inseridas := 0;
  END;
  RETURN v_inseridas;
END $$;
SQL
P -q -c "SET test.uid='$MASTER'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" >/dev/null 2>&1 || true
SOBRARAM="$(antigas)"
if [ "$SOBRARAM" != "3" ]; then ok "F3 sabotar a atomicidade derruba A7b (sobraram $SOBRARAM de 3 — tabela zerada, o bug original)"
else bad "F3 A7b seguiu VERDE com a atomicidade sabotada — assert sem dente"; fi
P -q -c "DROP TRIGGER zz_injeta_falha ON public.farmer_association_rules; DROP FUNCTION public.__injeta_falha_insert();"
restaura_migration

# F4 — sabota o advisory lock → A8 tem que ficar VERMELHO
sabota "s/IF NOT pg_try_advisory_xact_lock\\(hashtext\\('farmer_association_rules_substituir'\\)\\) THEN/IF false THEN/"
restaura_antigas
P -q -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('farmer_association_rules_substituir')); SELECT pg_sleep(5); COMMIT;" >/dev/null 2>&1 &
LOCK_BG2=$!
for _ in $(seq 1 60); do
  N=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted;")
  [ "${N:-0}" -ge 1 ] && break
  sleep 0.2
done
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$MASTER';
DO \$\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);
    v_passou := true;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF v_passou THEN RAISE NOTICE 'SONDA_PASSOU'; ELSE RAISE NOTICE 'SONDA_BARROU'; END IF;
END \$\$;
SQL
)
case "$R" in
  *SONDA_PASSOU*) ok  "F4 sabotar o lock derruba A8 (o concorrente entrou junto)" ;;
  *)              bad "F4 A8 seguiu VERDE com o lock sabotado — assert sem dente" ;;
esac
wait "$LOCK_BG2" 2>/dev/null || true
restaura_migration

# sanidade final: com a migration VERDADEIRA de volta, o caminho feliz volta a funcionar
restaura_antigas
R=$(Pq -c "SET test.uid='$MASTER'; SELECT public.farmer_association_rules_substituir('$LOTE_OK'::jsonb);" | tail -1)
eq "Z1 migration restaurada, caminho feliz de volta" "$R" "2"

# ── veredito ──
echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
