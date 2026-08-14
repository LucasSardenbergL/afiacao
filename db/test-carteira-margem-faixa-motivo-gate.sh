#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — FU4-F fase 3c: `motivo` entra no gate de custo.                      ║
# ║  As ÂNCORAS ABSOLUTAS (piso/meta) somem para quem não tem cap_custo_ler,      ║
# ║  matando a inversão da transformação afim margem_pct = A + B*g.               ║
# ║                                                                               ║
# ║      bash db/test-carteira-margem-faixa-motivo-gate.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  Migration sob teste: 20260813234112_carteira_margem_faixa_motivo_gate_custo  ║
# ║  A RPC do #1543 é aplicada REAL antes (não stub): é o corpo que a nova        ║
# ║  substitui, e só assim o CREATE OR REPLACE é exercido como em prod.           ║
# ╚═══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="motivo-gate"
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
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# Falsificação: exige o valor EXATO que a sabotagem produz. Um "!= esperado" aceitaria string
# vazia ou erro de conexão como se fosse prova, e a sabotagem passaria por acidente.
falsif() { if [ "$2" = "$3" ]; then ok "$1 (sabotagem produziu [$2], como exigido)"; else bad "$1 — a sabotagem NAO produziu o vermelho esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'   # app_role master        → cap_custo_ler TRUE
ATACA='22222222-2222-2222-2222-222222222222'    # employee + farmer      → cap_custo_ler FALSE
ESTRAT='33333333-3333-3333-3333-333333333333'   # employee + estrategico → cap_custo_ler TRUE
CLI='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'      # cliente alvo, margem 42% → verde / abaixo_da_meta

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (definições REAIS de prod; o gate sob teste não é stub)
# ═══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TYPE public.commercial_role AS ENUM
  ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);

-- VERBATIM de prod (pg_get_functiondef, 2026-08-13)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- VERBATIM de prod — É o gate sob teste, não pode ser stub
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('estrategico','super_admin')
        )
      )
    ), false);
$function$;

-- Dependências que NÃO são o objeto sob teste → stub honesto.
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT public.has_role(_uid,'master'::public.app_role)
                  OR public.has_role(_uid,'employee'::public.app_role) $function$;

CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_cliente uuid, _uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $function$ SELECT true $function$;

CREATE TABLE private.margem_seed (customer_user_id uuid, margem_pct numeric);
CREATE OR REPLACE FUNCTION private.margem_cliente_agregada()
 RETURNS TABLE(customer_user_id uuid, margem_pct numeric) LANGUAGE sql STABLE SECURITY DEFINER
AS $function$ SELECT s.customer_user_id, s.margem_pct FROM private.margem_seed s $function$;

CREATE TABLE public.farmer_algorithm_config (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value numeric NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.farmer_algorithm_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view algorithm config" ON public.farmer_algorithm_config FOR SELECT
  USING ((public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)));
SQL

# A RPC do #1543 — REAL. É o corpo que a migration nova substitui via CREATE OR REPLACE.
P -q -f "$REPO_ROOT/supabase/migrations/20260726170000_fu4f_fase3_carteira_margem_faixa.sql"
echo "pré-requisito aplicado: RPC real do #1543 (corpo ANTERIOR)"

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION SOB TESTE (Lei #1: o .sql commitado, não um stub da lógica)
# ═══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260813234112_carteira_margem_faixa_motivo_gate_custo.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# IDEMPOTÊNCIA — o apply é MANUAL (founder cola no SQL Editor) e re-colar após falha parcial é
# rotina. O segundo Run TEM de passar limpo.
if P -q -f "$MIG" >/dev/null 2>&1; then IDEM_OK=1; else IDEM_OK=0; fi

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ═══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$ATACA'),('$ESTRAT'),('$CLI') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'),('$ATACA','employee'),('$ESTRAT','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$ATACA','farmer'),('$ESTRAT','estrategico');
-- Um cliente por MOTIVO: é isso que dá ao atacante as âncoras que este PR remove.
INSERT INTO private.margem_seed VALUES
  ('$CLI', 42.0),                                          -- verde    / abaixo_da_meta
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 10.0),          -- amarelo  / abaixo_do_piso
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 80.0),          -- verde    / saudavel
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', -5.0),          -- vermelho / abaixo_do_custo
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL);          -- neutro   / sem_custo
SQL

# helper: roda SQL como um usuário autenticado (GUC do JWT + SET ROLE).
# `-q` é obrigatório: sem ele o psql ecoa a tag de comando de cada SET e o ruído entra na comparação.
as_auth()   { Pq -q -c "SET test.uid='$1'; SET ROLE authenticated; $2"; }
motivo_de() { as_auth "$1" "SELECT coalesce(motivo,'NULO') FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';"; }
faixa_de()  { as_auth "$1" "SELECT faixa FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';"; }
pct_de()    { as_auth "$1" "SELECT coalesce(margem_pct::text,'NULO') FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';"; }
g_de()      { as_auth "$1" "SELECT CASE WHEN g IS NULL THEN 'NULO' ELSE 'PRESENTE' END FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';"; }
# ÂNCORAS observáveis: quantos motivos DISTINTOS não-nulos a persona enxerga.
ancoras_de() { as_auth "$1" "SELECT count(DISTINCT motivo)::text FROM public.get_carteira_margem_faixa() WHERE motivo IS NOT NULL;"; }

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── A. POSITIVO — com cap_custo_ler nada regride ──"
eq "A1 master vê o motivo do alvo"            "$(motivo_de $MASTER)" "abaixo_da_meta"
eq "A2 estrategico vê o motivo do alvo"       "$(motivo_de $ESTRAT)" "abaixo_da_meta"
eq "A3 master vê margem_pct (gate anterior)"  "$(pct_de   $MASTER)"  "42.0"
eq "A4 master vê as 5 âncoras de motivo"      "$(ancoras_de $MASTER)" "5"

echo ""
echo "── B. NEGATIVO — sem cap_custo_ler, a ÂNCORA some ──"
eq "B1 atacante vê motivo NULO"                    "$(motivo_de $ATACA)" "NULO"
eq "B2 atacante segue sem margem_pct (não regrediu)" "$(pct_de  $ATACA)" "NULO"
eq "B3 ZERO âncoras observáveis pelo atacante"     "$(ancoras_de $ATACA)" "0"

echo ""
echo "── C. PRODUTO PRESERVADO — o sinal fica, o health score não muda ──"
eq "C1 atacante ainda vê a FAIXA"        "$(faixa_de $ATACA)" "verde"
eq "C2 atacante ainda recebe o \`g\`"     "$(g_de     $ATACA)" "PRESENTE"
eq "C3 o \`g\` do atacante == o do master" \
   "$(as_auth $ATACA "SELECT round(g,6)::text FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';")" \
   "$(as_auth $MASTER "SELECT round(g,6)::text FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';")"

echo ""
echo "── D. NÃO-REGRESSÃO de escopo/ACL/idempotência ──"
eq "D1 fail-closed sem auth.uid()" \
   "$(P -tA -q -c "SET test.uid=''; SELECT count(*)::text FROM public.get_carteira_margem_faixa();")" "0"
eq "D2 anon NÃO executa"          "$(Pq -q -c "SELECT has_function_privilege('anon','public.get_carteira_margem_faixa()','EXECUTE')::text;")" "false"
eq "D3 authenticated executa"     "$(Pq -q -c "SELECT has_function_privilege('authenticated','public.get_carteira_margem_faixa()','EXECUTE')::text;")" "true"
eq "D4 função segue SECURITY DEFINER" \
   "$(Pq -q -c "SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")" "true"
eq "D5 migration é idempotente (2º Run limpo)" "$IDEM_OK" "1"

echo ""
echo "── E. O ATAQUE — a calibração afim não fecha mais ──"
# O atacante calibra B = (meta-piso)/(g_meta - g_piso). Sem motivo, ele não sabe QUAL g é qual,
# então o par nem se forma: as duas pontas vêm NULAS.
eq "E1 atacante não obtém o g da âncora do piso" \
   "$(as_auth $ATACA "SELECT coalesce(max(g)::text,'NULO') FROM public.get_carteira_margem_faixa() WHERE motivo='abaixo_do_piso';")" "NULO"
eq "E2 atacante não obtém o g da âncora da meta" \
   "$(as_auth $ATACA "SELECT coalesce(max(g)::text,'NULO') FROM public.get_carteira_margem_faixa() WHERE motivo='abaixo_da_meta';")" "NULO"
eq "E3 o master (legítimo) AINDA calibra — a capacidade não foi destruída para quem pode" \
   "$(as_auth $MASTER "SELECT CASE WHEN max(g) FILTER (WHERE motivo='abaixo_da_meta') IS NOT NULL
                                    AND max(g) FILTER (WHERE motivo='abaixo_do_piso') IS NOT NULL
                                   THEN 'CALIBRA' ELSE 'NAO' END FROM public.get_carteira_margem_faixa();")" "CALIBRA"

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota a migration e EXIGE o vermelho
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── F. FALSIFICAÇÃO — os asserts têm dente? ──"
SAB="/tmp/sab-${SLUG}.sql"

# K1 — remove o gate do motivo (volta ao corpo do #1543). B1/B3 têm de ficar VERMELHOS.
# O `.*?` com /s atravessa as 5 linhas do CASE interno; o wrapper some e o CASE interno vira a
# projeção direta — exatamente o corpo anterior a este PR.
perl -0pe "s/    CASE WHEN v_pode_num THEN\n(      CASE WHEN b\.pct IS NULL.*?'saudavel' END)\n    END,/\$1,/s" "$MIG" > "$SAB"
# A sabotagem tem de PROVAR que aplicou: um padrão que não casa deixaria o teste medindo o
# código ÍNTEGRO e reportando "sem dente" quando o assert está ótimo (§ money-path).
# ⚠️ A âncora é `CASE WHEN v_pode_num THEN` NO FIM DA LINHA — só o gate do MOTIVO tem essa forma;
# o de margem_pct é `CASE WHEN v_pode_num THEN b.pct END`, na mesma linha. Um `grep -F` com padrão
# multilinha NÃO serve aqui: o grep trata cada linha do padrão como alternativa (OR), então a 1ª
# linha casaria o gate de margem_pct e a checagem acusaria "não aplicou" com a sabotagem correta.
if [ "$(command grep -c 'CASE WHEN v_pode_num THEN$' "$SAB")" != "0" ]; then
  bad "K1 INVALIDA: a sabotagem NAO removeu o gate do motivo (padrao nao casou)"
elif ! P -q -f "$SAB" >/dev/null 2>&1; then
  bad "K1 INVALIDA: migration sabotada nao aplica (build quebrado != 'sem dente')"
else
  falsif "K1 sem o gate, o motivo VAZA (B1 fica vermelho)" "$(motivo_de $ATACA)" "abaixo_da_meta"
  falsif "K1 sem o gate, as 5 âncoras VOLTAM (B3 fica vermelho)" "$(ancoras_de $ATACA)" "5"
  P -q -f "$MIG" >/dev/null 2>&1   # restaura o corpo verdadeiro
fi

# K2 — gateia o `g` também. C2 tem de ficar VERMELHO: é o assert que prova que este PR
#      NÃO mudou produto. Sem dente aqui, um gate acidental de `g` passaria despercebido.
perl -0pe "s/    CASE WHEN b\.pct IS NULL THEN NULL\n         ELSE greatest\(0::numeric,/    CASE WHEN b.pct IS NULL OR NOT v_pode_num THEN NULL\n         ELSE greatest(0::numeric,/s" "$MIG" > "$SAB"
if ! command grep -qF "b.pct IS NULL OR NOT v_pode_num" "$SAB"; then
  bad "K2 INVALIDA: a sabotagem do \`g\` nao aplicou"
else
  P -q -f "$SAB" >/dev/null 2>&1 || bad "K2 INVALIDA: migration sabotada nao aplica"
  falsif "K2 com \`g\` gateado, C2 fica vermelho" "$(g_de $ATACA)" "NULO"
  P -q -f "$MIG" >/dev/null 2>&1
fi

# K3 — remove o gate de margem_pct. B2 tem de ficar VERMELHO (não-regressão do #1543).
perl -0pe "s/    CASE WHEN v_pode_num THEN b\.pct END/    b.pct/s" "$MIG" > "$SAB"
if command grep -qF "CASE WHEN v_pode_num THEN b.pct END" "$SAB"; then
  bad "K3 INVALIDA: a sabotagem de margem_pct nao aplicou (padrao nao casou)"
elif ! P -q -f "$SAB" >/dev/null 2>&1; then
  bad "K3 INVALIDA: migration sabotada nao aplica (build quebrado != 'sem dente')"
else
  falsif "K3 sem o gate de margem_pct, B2 fica vermelho" "$(pct_de $ATACA)" "42.0"
  P -q -f "$MIG" >/dev/null 2>&1
fi

# K4 — CANÁRIO: a migration íntegra voltou? Sem isto, um restore falho deixaria os asserts
#      acima medindo uma função sabotada e ninguém saberia.
eq "K4 canário: migration íntegra restaurada (motivo volta a ser NULO p/ o atacante)" \
   "$(motivo_de $ATACA)" "NULO"
eq "K4b canário: o master volta a ver o motivo" "$(motivo_de $MASTER)" "abaixo_da_meta"

rm -f "$SAB"

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — IMPRESSÃO DIGITAL (herdada do #1543): esta migration MUDA o `prosrc`
# ═══════════════════════════════════════════════════════════════════════════════
# O #1543 gravou o md5 do corpo normalizado em db/valida-fu4f-fase3-carteira-margem-faixa.sql
# (check c10) e o #1728 pôde afirmar "o corpo NÃO mudou" porque COMMENT não toca `prosrc`.
# Esta migration é a PRIMEIRA a mudar o corpo desde então — logo a digital VENCE, e uma digital
# vencida devolve `f` num banco CORRETO: falso alarme que pararia um deploy na mão do founder.
# Este assert é o que impede a digital de envelhecer em silêncio.
# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 6b — O COMMENT do #1728 SOBREVIVEU? (união, não substituição)
# ═══════════════════════════════════════════════════════════════════════════════
# Esta migration roda DEPOIS da 20260813225057 e reescreve o COMMENT — "a última a escrever
# vence". O #1728 tinha acabado de trocar uma promessa FALSA de equivalência de score pelo delta
# medido; um COMMENT novo escrito do zero apagaria isso EM SILÊNCIO (nenhum gate de CI olha o
# catálogo, e o harness dele aplica só a migration dele, então ficaria verde).
# Estes asserts são a rede: eles falham se alguém (eu inclusive) voltar a substituir em vez de unir.
echo ""
echo "── G0. o COMMENT do #1728 sobreviveu à minha reescrita? ──"
P -q -f "$REPO_ROOT/supabase/migrations/20260813225057_fu4f_fase3_comment_honesto_margem_faixa.sql" >/dev/null 2>&1
P -q -f "$MIG" >/dev/null 2>&1   # ordem REAL de prod: a 3c por último
com() { Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%$1%')::text;"; }
eq "G0a a promessa falsa NÃO voltou (ausência de 'byte a byte')" "$(com 'byte a byte')" "false"
eq "G0b a medição do #1728 sobreviveu (30.833 x 20.597)"        "$(com '30.833 pedidos contra 20.597')" "true"
eq "G0c 'health score MUDA' sobreviveu"                          "$(com 'health score MUDA')" "true"
eq "G0d o delta do #1721 sobreviveu (59,5%)"                     "$(com '59,5')" "true"
eq "G0e 'AGENDA NAO muda' sobreviveu"                            "$(com 'AGENDA NAO muda')" "true"
eq "G0f e a fase 3c foi ACRESCENTADA"                            "$(com 'FASE 3c')" "true"

echo ""
echo "── G. IMPRESSÃO DIGITAL do corpo (o #1543 amarrou o validador ao corpo testado) ──"
MD5_APLICADO="$(Pq -q -c "SELECT md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")"
# `|| true`: sob pipefail, `sed` em arquivo ausente derrubaria o harness inteiro em silêncio.
MD5_DOC="$(sed -n 's/.*IMPRESSAO_DIGITAL=\([0-9a-f]\{32\}\).*/\1/p' "$REPO_ROOT/db/valida-fu4f-fase3-carteira-margem-faixa.sql" 2>/dev/null | head -1 || true)"
echo "  (md5 do corpo com o gate do motivo: $MD5_APLICADO)"
eq "G1 a digital em db/valida-*.sql casa o corpo desta cadeia de migrations" "$MD5_DOC" "$MD5_APLICADO"

echo ""
echo "═══════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
