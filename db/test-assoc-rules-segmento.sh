#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — farmer_association_rules_substituir COM cluster_segment (TR006) ║
# ║      bash db/test-assoc-rules-segmento.sh > /tmp/t.log 2>&1                    ║
# ║      echo "exit=$?"     (NÃO pipe pra tail — engole o exit≠0)                  ║
# ║                                                                                ║
# ║  CASCATA COMPLETA, de propósito. O harness irmão                              ║
# ║  (db/test-farmer-association-rules-atomica.sh) aplica SÓ a 20260729120000 e    ║
# ║  prova a função DAQUELA fase — que não é mais a que roda em prod (#1515: "o    ║
# ║  HARNESS mente… os cenários de cada fase validam a versão daquela fase"). Aqui ║
# ║  as quatro migrations entram na ordem e os asserts medem a versão FINAL.       ║
# ║                                                                                ║
# ║  Sob prova: (a) o segmento é GRAVADO; (b) dois segmentos convivem no MESMO     ║
# ║  lote com sample_size próprio; (c) regra SEM proveniência é RECUSADA nas duas  ║
# ║  fronteiras — TR006 na RPC e CHECK na tabela (a via service_role/PostgREST não ║
# ║  passa pela RPC); (d) NADA do que já existia afrouxou — inclusive o REVOKE de  ║
# ║  `authenticated`, que um DROP+CREATE teria resetado em silêncio.               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="assocseg"
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
-- Quem chama a RPC em produção é a EDGE, sob `service_role` — então é essa a identidade
-- default das sessões deste harness. `ALTER DATABASE` e não `SET`: cada invocação do psql é
-- uma sessão NOVA em autocommit, e um `SET`/`SET LOCAL` avulso não atravessaria (a armadilha
-- do `SET LOCAL` fora de transação, #1434/E2-FU4). Os asserts que precisam de OUTRA identidade
-- (o gate negando customer) sobrescrevem a GUC dentro do próprio bloco.
ALTER DATABASE prove SET test.role = 'service_role';
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que as migrations LEEM mas não criam) — fiéis à prod
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

-- verbatim do schema-snapshot.sql
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

-- O ACL de prod ANTES do fence: `authenticated` tinha privilégio TOTAL de tabela e EXECUTE na
-- RPC. Semear o estado PERMISSIVO é o que dá sentido ao assert do REVOKE — num banco onde o
-- grant nunca existiu, "authenticated não executa" passaria por omissão (§ corolário meta do
-- #1488: ao endurecer um gate, o assert que dependia do gate antigo vira suspeito).
GRANT ALL ON TABLE public.farmer_association_rules TO authenticated;

-- Stub de `omie_products` só com o par de identidade que importa aqui — a UNIQUE
-- `(omie_codigo_produto, account)` é o que permite o mesmo código existir nas duas contas, e é
-- exatamente essa possibilidade que o sensor da §1b da migration mede. Espelha a PROD
-- (conferido via psql-ro em `pg_indexes`), não o desenho que eu gostaria que existisse.
CREATE TABLE public.omie_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    omie_codigo_produto text,
    account text,
    CONSTRAINT omie_products_omie_codigo_produto_account_key UNIQUE (omie_codigo_produto, account)
);
SQL
echo "pré-requisitos criados"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — CASCATA REAL DE MIGRATIONS (Lei #1) — a ORDEM é a de produção
# ══════════════════════════════════════════════════════════════════════════════
for MIG in \
  20260729120000_farmer_association_rules_substituicao_atomica.sql \
  20260731120000_farmer_assoc_rules_delete_qualificado.sql \
  20260820225840_farmer_assoc_rules_escritor_unico.sql
do
  P -q -f "$REPO_ROOT/supabase/migrations/$MIG"
  echo "migration aplicada: $MIG"
done

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED **ANTES** DA MIGRATION NOVA — a ordem é o que reproduz a prod
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ Esta ordem NÃO é estética. As 24 linhas de prod (todas com cluster_segment NULL) já existem
# quando o founder cola a migration no SQL Editor. Semear DEPOIS do CHECK dava
# `check_violation` no próprio seed — o harness abortava em `set -e` com exit 3 e ZERO assert
# rodado, o que se lê como "não rodou", não como "reprovou". Semear ANTES prova de quebra uma
# coisa que a outra ordem não provaria: que a migration APLICA LIMPO sobre a tabela como ela
# está hoje. É o `NOT VALID` cumprindo exatamente o que foi escrito para cumprir.
MASTER='11111111-1111-1111-1111-111111111111'
CUSTOMER='33333333-3333-3333-3333-333333333333'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'), ('$CUSTOMER');
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master'), ('$CUSTOMER','customer');

-- LOTE ANTIGO, como as 24 linhas de prod: cluster_segment NULL (anteriores ao conceito).
-- A pergunta que todo assert negativo faz é "estas duas continuam aqui?".
INSERT INTO public.farmer_association_rules
  (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size, cluster_segment)
VALUES
  (ARRAY['VELHA-1'], ARRAY['VELHA-2'], 0.02, 0.30, 2.0, 'association', 479, NULL),
  (ARRAY['VELHA-2'], ARRAY['VELHA-3'], 0.02, 0.31, 2.1, 'association', 479, NULL);
SQL
echo "seed pronto (2 regras 'vigentes' com segmento NULL, como prod)"

MIG_NOVA="20260821200000_farmer_assoc_rules_segmento.sql"
P -q -f "$REPO_ROOT/supabase/migrations/$MIG_NOVA"
echo "migration aplicada: $MIG_NOVA  (sobre a tabela JÁ POVOADA com segmento NULL)"

V=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE cluster_segment IS NULL;")
[ "$V" = "2" ] && echo "  (NOT VALID confirmado: as 2 linhas legadas sobreviveram ao ALTER)" || {
  echo "  ABORTA: a migration não aplicou sobre a tabela povoada"; exit 1; }

# Lote com os DOIS segmentos, cada um com o sample_size do SEU universo (como a edge monta).
LOTE_2SEG='[
  {"antecedent_product_ids":["C-1"],"consequent_product_ids":["C-2"],"support":0.019,"confidence":0.44,"lift":5.41,"rule_type":"association","sample_size":19030,"cluster_segment":"colacor"},
  {"antecedent_product_ids":["C-2"],"consequent_product_ids":["C-1"],"support":0.019,"confidence":0.38,"lift":5.41,"rule_type":"association","sample_size":19030,"cluster_segment":"colacor"},
  {"antecedent_product_ids":["O-1"],"consequent_product_ids":["O-2"],"support":0.0114,"confidence":0.61,"lift":53.21,"rule_type":"association","sample_size":11227,"cluster_segment":"oben"}
]'

echo; echo "=== POSITIVOS — o segmento é gravado e os dois convivem ==="

N=$(Pq -c "SELECT public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);")
eq "P1 a RPC insere o lote inteiro" "$N" "3"

V=$(Pq -c "SELECT string_agg(DISTINCT cluster_segment, ',' ORDER BY cluster_segment) FROM public.farmer_association_rules;")
eq "P2 os DOIS segmentos convivem na tabela" "$V" "colacor,oben"

V=$(Pq -c "SELECT sample_size FROM public.farmer_association_rules WHERE cluster_segment='oben';")
eq "P3 sample_size é o universo DO SEGMENTO (não a soma)" "$V" "11227"

V=$(Pq -c "SELECT count(DISTINCT sample_size) FROM public.farmer_association_rules;")
eq "P4 denominadores DIFERENTES coexistem — é esse o ponto da fatia" "$V" "2"

V=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE antecedent_product_ids = ARRAY['VELHA-1'];")
eq "P5 o lote novo SUBSTITUIU o antigo (DELETE+INSERT)" "$V" "0"

# btrim: o segmento entra limpo, senão 'oben' e 'oben ' seriam dois universos distintos para o
# mesmo catálogo — e nenhuma tela mostraria a diferença. (Um lote SÓ com oben aqui bateria no
# TR007, que já está de pé: o fixture traz os dois segmentos, um deles sujo. Foi o próprio
# TR007 que reprovou a primeira versão deste assert.)
L_BTRIM='[{"antecedent_product_ids":["T-1"],"consequent_product_ids":["T-2"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":"  oben  "},
          {"antecedent_product_ids":["T-3"],"consequent_product_ids":["T-4"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":"colacor"}]'
N=$(Pq -c "SELECT public.farmer_association_rules_substituir('$L_BTRIM'::jsonb);")
V=$(Pq -c "SELECT string_agg('['||cluster_segment||']', ',' ORDER BY cluster_segment) FROM public.farmer_association_rules;")
eq "P6 o segmento é gravado com btrim" "$V" "[colacor],[oben]"

# Restaura o estado de 2 segmentos para os negativos.
Pq -c "SELECT public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);" >/dev/null

echo; echo "=== NEGATIVOS — regra sem proveniência é recusada, e NADA é apagado ==="

# Helper: roda um lote esperando a SQLSTATE dada; re-lança o resto (Lei #2).
espera_sqlstate() {
  local rotulo="$1" sqlstate="$2" lote="$3"
  local saida
  # ⚠️ O `2>&1` mora na LINHA DO COMANDO, não depois do terminador do heredoc. Escrito lá
  # embaixo ele vira um comando SOLTO, o stderr do psql escapa da captura, e as sentinelas —
  # que são NOTICE, portanto stderr — somem: os 6 asserts negativos reprovavam com "erro
  # inesperado: DO", o eco do bloco que rodou certinho. Vermelho de encanamento tem exatamente
  # a mesma cara de vermelho de asserção.
  saida=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_association_rules_substituir('$lote'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN SQLSTATE '$sqlstate' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;   -- qualquer outro erro sobe: não é o que eu queria provar
END \$\$;
SQL
)
  case "$saida" in
    *SENTINELA_BARROU_CERTO*) ok "$rotulo (SQLSTATE $sqlstate)" ;;
    *SENTINELA_NAO_BARROU*)   bad "$rotulo -- NÃO barrou (esperava $sqlstate)" ;;
    *)                        bad "$rotulo -- erro inesperado: $(printf '%s' "$saida" | head -c 200)" ;;
  esac
}

L_NULL='[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":null}]'
L_SEM='[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10}]'
L_VAZIO='[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":""}]'
L_ESPACO='[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":"   "}]'
L_MISTO='[{"antecedent_product_ids":["A"],"consequent_product_ids":["B"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":"oben"},
          {"antecedent_product_ids":["C"],"consequent_product_ids":["D"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10}]'

espera_sqlstate "N1 cluster_segment NULL explícito"      "TR006" "$L_NULL"
espera_sqlstate "N2 campo cluster_segment AUSENTE"       "TR006" "$L_SEM"
espera_sqlstate "N3 cluster_segment string vazia"        "TR006" "$L_VAZIO"
espera_sqlstate "N4 cluster_segment só espaços"          "TR006" "$L_ESPACO"
espera_sqlstate "N5 lote MISTO (1 boa + 1 sem segmento)" "TR006" "$L_MISTO"

# A recusa acontece ANTES do DELETE — este é o invariante que o #1840 comprou.
V=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules;")
eq "N6 após as 5 recusas as regras vigentes seguem INTACTAS" "$V" "3"

# A INVARIANTE NA TABELA: service_role bypassa RLS e escreve direto, sem passar pela RPC.
S=$(P -tA <<'SQL' 2>&1 || true
DO $$
BEGIN
  INSERT INTO public.farmer_association_rules
    (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size, cluster_segment)
  VALUES (ARRAY['Z'], ARRAY['W'], 0.5, 0.5, 2, 'association', 10, NULL);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$S" in
  *SENTINELA_BARROU_CERTO*) ok "N7 CHECK barra INSERT direto sem segmento (via que não passa pela RPC)" ;;
  *SENTINELA_NAO_BARROU*)   bad "N7 -- o INSERT direto passou: a invariante não está na TABELA" ;;
  *)                        bad "N7 -- erro inesperado: $(printf '%s' "$S" | head -c 200)" ;;
esac

echo; echo "=== TR007 — o lote PARCIAL não apaga o segmento que ele esqueceu ==="
# O buraco que o LOTE ÚNICO abre e que o TR001 não cobre: 12 regras de oben e ZERO de colacor
# formam um lote NÃO-vazio, que passaria em tudo e apagaria colacor sem que nada denunciasse.
# Estado atual da tabela: {colacor, oben} (o LOTE_2SEG está publicado).
L_SO_OBEN='[{"antecedent_product_ids":["O-9"],"consequent_product_ids":["O-8"],"support":0.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":11227,"cluster_segment":"oben"}]'
espera_sqlstate "N8 lote que PERDE o segmento colacor" "TR007" "$L_SO_OBEN"

V=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE cluster_segment='colacor';")
eq "N9 colacor continua publicado após a recusa" "$V" "2"

# E o caminho legítimo continua aberto: um lote que traz os DOIS segmentos passa.
N=$(Pq -c "SELECT public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);")
eq "N10 o lote COMPLETO segue passando — o TR007 não virou trava permanente" "$N" "3"

echo; echo "=== INTACTOS — endurecer não pode ter afrouxado nem quebrado o que já valia ==="

espera_sqlstate "I1 TR001 lote vazio segue recusando"  "TR001" '[]'
espera_sqlstate "I2 TR002 formato inválido segue recusando" "TR002" '{"a":1}'
espera_sqlstate "I3 TR005 valor fora de faixa segue recusando" "TR005" \
  '[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":1.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10,"cluster_segment":"oben"}]'

# TR005 (faixa) vem ANTES de TR006 (proveniência): uma regra com os dois defeitos tem de
# reportar o de faixa. Sem esta ordem, o operador conserta o segmento e volta a bater no
# mesmo erro por outro motivo.
espera_sqlstate "I4 defeito de FAIXA tem precedência sobre o de PROVENIÊNCIA" "TR005" \
  '[{"antecedent_product_ids":["X"],"consequent_product_ids":["Y"],"support":1.5,"confidence":0.5,"lift":2,"rule_type":"association","sample_size":10}]'

# O gate, sob o role de verdade.
G=$(P -tA <<SQL 2>&1 || true
-- `SET`, não `SET LOCAL`: autocommit. E `test.role` tem de sair do default 'service_role',
-- senão o gate passaria pelo PRIMEIRO ramo e o assert provaria o oposto do que diz provar
-- (§"o ASSERT DE AUTORIZAÇÃO mente quando a MESMA condição tem dois emissores").
SET test.role = '';
SET test.uid  = '$CUSTOMER';
DO \$\$
BEGIN
  PERFORM public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$G" in
  *SENTINELA_BARROU_CERTO*) ok "I5 gate 42501 segue negando customer" ;;
  *SENTINELA_NAO_BARROU*)   bad "I5 -- customer executou a RPC" ;;
  *)                        bad "I5 -- erro inesperado: $(printf '%s' "$G" | head -c 200)" ;;
esac

# ⚠️ O ASSERT MAIS IMPORTANTE DESTE ARQUIVO. `CREATE OR REPLACE` preserva o ACL; `DROP`+`CREATE`
# o RESETARIA e devolveria o EXECUTE a `authenticated` — desfazendo o fence de escritor único da
# 20260820225840 em SILÊNCIO, sem erro nenhum e sem nada na tela. É a regressão mais barata de
# cometer nesta função e a mais cara de descobrir.
V=$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_association_rules_substituir(jsonb)','EXECUTE');")
eq "I6 o REVOKE de authenticated SOBREVIVEU ao CREATE OR REPLACE" "$V" "f"

V=$(Pq -c "SELECT has_function_privilege('service_role','public.farmer_association_rules_substituir(jsonb)','EXECUTE');")
eq "I7 service_role (a edge/cron) continua executando" "$V" "t"

V=$(Pq -c "SELECT string_agg(DISTINCT polcmd::text,',') FROM pg_policy WHERE polrelid='public.farmer_association_rules'::regclass;")
eq "I8 a policy segue restrita a SELECT" "$V" "r"

echo; echo "=== SENSOR de código repetido entre contas (o fallback do MixGap) ==="
# Prod tem 0 hoje. O que precisa ser provado é que o sensor ACHA quando existe — um sensor que
# devolve 0 tanto no mundo limpo quanto no sujo não é sensor (§"o DETECTOR mente").
P -q <<'SQL'
INSERT INTO public.omie_products (id, omie_codigo_produto, account) VALUES
  (gen_random_uuid(), 'SO-COLACOR', 'colacor'),
  (gen_random_uuid(), 'SO-OBEN',    'oben');
SQL
V=$(Pq -c "SELECT count(*) FROM public.omie_products_codigos_multi_conta();")
eq "S1 catálogo disjunto (como prod hoje) ⇒ sensor devolve 0" "$V" "0"

P -q <<'SQL'
INSERT INTO public.omie_products (id, omie_codigo_produto, account) VALUES
  (gen_random_uuid(), 'AMBIGUO-1', 'colacor'),
  (gen_random_uuid(), 'AMBIGUO-1', 'oben');
SQL
V=$(Pq -c "SELECT omie_codigo_produto||'/'||contas FROM public.omie_products_codigos_multi_conta();")
eq "S2 o MESMO código nas duas contas é DETECTADO" "$V" "AMBIGUO-1/2"

# Restaura o catálogo limpo para não contaminar asserts posteriores.
P -q -c "DELETE FROM public.omie_products WHERE omie_codigo_produto = 'AMBIGUO-1';"
V=$(Pq -c "SELECT count(*) FROM public.omie_products_codigos_multi_conta();")
eq "S3 removida a ambiguidade, o sensor volta a 0" "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3): sabota, exige VERMELHO, restaura.
# A sabotagem é no BANCO (recria o objeto furado), não no arquivo — o .sql do repo
# nunca é tocado, então não há janela em que `git status` mostre código sabotado.
# ══════════════════════════════════════════════════════════════════════════════
echo; echo "=== FALSIFICAÇÃO — os asserts têm dente? ==="
FALS_OK=0; FALS_BAD=0
fals_ok()  { FALS_OK=$((FALS_OK+1));  echo "  OK   $1"; }
fals_bad() { FALS_BAD=$((FALS_BAD+1)); echo "  FAIL $1"; }

# ── F1: TR006 vira `IF false` ⇒ N1 (lote com segmento NULL) tem de PASSAR onde deveria barrar.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_inseridas integer;
BEGIN
  DELETE FROM public.farmer_association_rules WHERE true;
  INSERT INTO public.farmer_association_rules
    (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size, cluster_segment)
  SELECT r.antecedent_product_ids, r.consequent_product_ids, r.support, r.confidence, r.lift,
         r.rule_type, coalesce(r.sample_size,0), r.cluster_segment
  FROM jsonb_to_recordset(p_regras) AS r(
    antecedent_product_ids text[], consequent_product_ids text[], support numeric,
    confidence numeric, lift numeric, rule_type text, sample_size integer, cluster_segment text);
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;
  RETURN v_inseridas;
END; $function$;
ALTER TABLE public.farmer_association_rules DROP CONSTRAINT farmer_association_rules_cluster_segment_check;
SQL
SAB=$(P -tA <<SQL 2>&1 || true
DO \$\$
BEGIN
  PERFORM public.farmer_association_rules_substituir('$L_NULL'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN SQLSTATE 'TR006' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$SAB" in
  *SENTINELA_NAO_BARROU*) fals_ok  "F1 sem TR006 o lote sem segmento PASSA — o assert N1 tem dente" ;;
  *)                      fals_bad "F1 -- sabotei o TR006 e N1 seguiu barrando: o assert mede outra coisa" ;;
esac

# ── F2: com o CHECK dropado (ainda sabotado), o INSERT direto sem segmento tem de PASSAR.
SAB=$(P -tA <<'SQL' 2>&1 || true
DO $$
BEGIN
  INSERT INTO public.farmer_association_rules
    (antecedent_product_ids, consequent_product_ids, support, confidence, lift, rule_type, sample_size, cluster_segment)
  VALUES (ARRAY['Z'], ARRAY['W'], 0.5, 0.5, 2, 'association', 10, NULL);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$SAB" in
  *SENTINELA_NAO_BARROU*) fals_ok  "F2 sem o CHECK o INSERT direto PASSA — o assert N7 tem dente" ;;
  *)                      fals_bad "F2 -- dropei o CHECK e N7 seguiu barrando: o assert mede outra coisa" ;;
esac

# ── F4: TR007 removido (a função sabotada acima não o tem) ⇒ o lote parcial tem de APAGAR o
# segmento esquecido. Este é o assert cuja ausência de dente custaria as regras de uma conta
# inteira em silêncio — e o único jeito de saber que ele morde é ver a perda acontecer.
Pq -c "SELECT public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);" >/dev/null 2>&1 || true
Pq -c "SELECT public.farmer_association_rules_substituir('$L_SO_OBEN'::jsonb);" >/dev/null 2>&1 || true
V=$(Pq -c "SELECT count(*) FROM public.farmer_association_rules WHERE cluster_segment='colacor';")
if [ "$V" = "0" ]; then
  fals_ok "F4 sem TR007 o lote parcial APAGA colacor — o assert N8 tem dente"
else
  fals_bad "F4 -- sabotei o TR007 e colacor sobreviveu ($V linhas): o assert N8 mede outra coisa"
fi

# ── RESTAURA: reaplica a migration real (idempotente) e confere que voltou.
P -q -f "$REPO_ROOT/supabase/migrations/20260821200000_farmer_assoc_rules_segmento.sql"
V=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public.farmer_association_rules'::regclass AND conname='farmer_association_rules_cluster_segment_check';")
eq "R1 o CHECK voltou após a restauração" "$V" "1"
V=$(Pq -c "SELECT pg_get_functiondef(p.oid) ~ 'TR006' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='farmer_association_rules_substituir';")
eq "R2 o TR006 voltou após a restauração" "$V" "t"

# ── F3: DROP+CREATE (em vez de REPLACE) devolve o EXECUTE a `authenticated`.
# Prova que o I6 mede o ACL de verdade, e não um estado que nunca existiu.
P -q <<'SQL'
DROP FUNCTION public.farmer_association_rules_substituir(jsonb);
CREATE FUNCTION public.farmer_association_rules_substituir(p_regras jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$ BEGIN RETURN 0; END; $function$;
SQL
V=$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_association_rules_substituir(jsonb)','EXECUTE');")
if [ "$V" = "t" ]; then
  fals_ok "F3 DROP+CREATE devolve o EXECUTE a authenticated — o assert I6 tem dente"
else
  fals_bad "F3 -- fiz DROP+CREATE e o EXECUTE não voltou: I6 não mede o ACL"
fi

# ── RESTAURA a versão verdadeira (a migration reemite o REVOKE nomeando as roles).
P -q -f "$REPO_ROOT/supabase/migrations/20260821200000_farmer_assoc_rules_segmento.sql"
V=$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_association_rules_substituir(jsonb)','EXECUTE');")
eq "R3 o REVOKE voltou após a restauração" "$V" "f"

N=$(Pq -c "SELECT public.farmer_association_rules_substituir('$LOTE_2SEG'::jsonb);")
eq "R4 a função restaurada volta a funcionar de ponta a ponta" "$N" "3"

echo
echo "════════════════════════════════════════════════════════════"
echo "  asserts:       $PASS OK / $FAIL FAIL"
echo "  falsificações: $FALS_OK com dente / $FALS_BAD sem dente"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && [ "$FALS_BAD" -eq 0 ]
