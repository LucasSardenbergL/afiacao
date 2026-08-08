#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — criar_plano_tatico: idempotência por JANELA da fila (PTPL fase 2)║
# ║      bash db/test-tactical-idempotencia-janela.sh > /tmp/t.log 2>&1; echo $?   ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O QUE ESTÁ SOB PROVA: a trava deixou de perguntar "já gerei HOJE?" e passou a ║
# ║  perguntar "este cliente já está na FILA?". Medido em prod (2026-08-08): a     ║
# ║  trava por dia deixava o cliente voltar a ser candidato toda madrugada — 533   ║
# ║  planos para 80 clientes, fila viva com 169 planos para 35 clientes (14 deles  ║
# ║  com 7 cópias), e 23 dos 25 planos de 07/08 eram regeração.                    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="ptpl-janela"
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

# Assert negativo (Lei #2): captura a SQLSTATE ESPERADA e RE-LANÇA qualquer outra.
# As sentinelas são ASCII, caixa fixa, e NÃO aparecem em lugar nenhum da migration nem
# das mensagens que a RPC emite — senão o `case` casaria o próprio texto do código e o
# assert mentiria (a armadilha do #1483, registrada no CLAUDE.md).
espera_sqlstate() {
  local desc="$1" chamada="$2" estado="$3" R
  R=$(P -tA 2>&1 <<EOF || true
SET test.role='service_role';
DO \$do\$
BEGIN
  PERFORM $chamada;
  RAISE NOTICE 'SENTINELA_NAO_LEVANTOU_NADA';
EXCEPTION
  WHEN SQLSTATE '$estado' THEN RAISE NOTICE 'SENTINELA_PEGOU_O_ESPERADO';
  WHEN OTHERS THEN RAISE;
END
\$do\$;
EOF
)
  case "$R" in
    *SENTINELA_PEGOU_O_ESPERADO*) ok "$desc" ;;
    *) bad "$desc — saida: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-220)" ;;
  esac
}

# Cria o plano e devolve 't' se veio um uuid. Falha do psql vira 'ERRO' (não mata o script).
# `-q` é obrigatório: sem ele o psql ecoa o "SET" do primeiro comando junto com a tupla, e a
# comparação vira "SET\nt" != "t" — um vermelho que não é do código sob teste.
cria() {
  P -tAq -c "SET test.role='service_role'; SELECT public.criar_plano_tatico('$1'::uuid,'$2'::uuid,'${3:-{\}}'::jsonb) IS NOT NULL;" 2>/dev/null || echo "ERRO"
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Stub FIEL ao DDL de prod (information_schema lido via psql-ro em 2026-08-08): a RPC faz
# `jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload)`, que é sensível ao
# TIPO de cada coluna — um stub com o tipo errado (ex.: ltv_projection text em vez de jsonb)
# provaria uma função diferente da que vai rodar.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.farmer_tactical_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid,
  customer_user_id uuid,
  bundle_recommendation_id uuid,
  health_score numeric DEFAULT 0,
  churn_risk numeric DEFAULT 0,
  mix_gap integer DEFAULT 0,
  current_margin_pct numeric DEFAULT 0,
  cluster_avg_margin_pct numeric DEFAULT 0,
  expansion_potential numeric DEFAULT 0,
  strategic_objective text DEFAULT 'expansao_mix',
  customer_profile text DEFAULT 'misto',
  top_bundle jsonb DEFAULT '{}'::jsonb,
  bundle_lie numeric,
  bundle_probability numeric,
  bundle_incremental_margin numeric,
  best_individual_lie numeric,
  diagnostic_questions jsonb DEFAULT '[]'::jsonb,
  implication_question text,
  offer_transition text,
  probable_objections jsonb DEFAULT '[]'::jsonb,
  approach_strategy text,
  plan_followed boolean,
  call_result text,
  actual_margin numeric,
  call_duration_seconds integer,
  objection_type text,
  notes text,
  effectiveness_score numeric,
  status text DEFAULT 'gerado',
  generated_at timestamptz DEFAULT now(),
  used_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  plan_type text DEFAULT 'essencial',
  approach_strategy_b text,
  second_bundle jsonb DEFAULT '{}'::jsonb,
  ltv_projection jsonb,
  expected_result jsonb,
  operational_risks jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE public.carteira_assignments (
  customer_user_id uuid PRIMARY KEY,
  owner_user_id uuid,
  eligible boolean DEFAULT true
);

-- Índice único parcial COMO EM PROD (pg_indexes lido via psql-ro). Existe aqui porque a
-- fase 2 muda a relação entre ele e a RPC: a janela CONTÉM o dia, então a RPC passa a ser
-- estritamente mais restritiva. O teste A9 prova que essa direção se manteve.
CREATE UNIQUE INDEX ux_farmer_tactical_plans_dia_operacional
  ON public.farmer_tactical_plans
  USING btree (farmer_id, customer_user_id,
    ((((created_at AT TIME ZONE 'UTC'::text) - '03:00:00'::interval))::date),
    COALESCE(plan_type, 'essencial'::text))
  WHERE ((status = 'gerado'::text)
    AND ((((created_at AT TIME ZONE 'UTC'::text) - '03:00:00'::interval))::date >= '2026-07-22'::date));

-- Gate de posse do ramo AUTENTICADO. Stub honesto: devolve true só quando o uid é o dono.
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (SELECT 1 FROM public.carteira_assignments a
                  WHERE a.customer_user_id = _customer AND a.owner_user_id = _uid);
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260808020000_tactical_plan_idempotencia_janela.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ══════════════════════════════════════════════════════════════════════════════
FA='aaaaaaaa-0000-0000-0000-00000000000a'   # farmer A
FB='bbbbbbbb-0000-0000-0000-00000000000b'   # farmer B
C1='cccccccc-0000-0000-0000-000000000001'   # sem plano nenhum
C2='cccccccc-0000-0000-0000-000000000002'   # plano gerado 3 dias atrás  → DENTRO da janela
C3='cccccccc-0000-0000-0000-000000000003'   # plano gerado 8 dias atrás  → FORA da janela
C4='cccccccc-0000-0000-0000-000000000004'   # plano EXPIRADO 3 dias atrás
C5='cccccccc-0000-0000-0000-000000000005'   # plano CONCLUIDO 3 dias atrás
C6='cccccccc-0000-0000-0000-000000000006'   # plano do OUTRO farmer, 3 dias atrás
C7='cccccccc-0000-0000-0000-000000000007'   # plano 3 dias atrás com plan_type 'essencial'
C8='cccccccc-0000-0000-0000-000000000008'   # plano 3 dias atrás com generated_at NULL
C9='cccccccc-0000-0000-0000-000000000009'   # MASCARADO (eligible=false)

P -q <<SQL
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES
  ('$C1','$FA',true), ('$C2','$FA',true), ('$C3','$FA',true), ('$C4','$FA',true),
  ('$C5','$FA',true), ('$C6','$FA',true), ('$C7','$FA',true), ('$C8','$FA',true),
  ('$C9','$FA',false);

-- created_at acompanha generated_at: em prod as duas são idênticas nas 533 linhas, e o
-- índice único parcial indexa created_at. Divergir aqui testaria um mundo que não existe.
INSERT INTO public.farmer_tactical_plans
  (farmer_id, customer_user_id, status, plan_type, generated_at, created_at) VALUES
  ('$FA','$C2','gerado',    'estrategico', now() - interval '3 days',  now() - interval '3 days'),
  ('$FA','$C3','gerado',    'estrategico', now() - interval '8 days',  now() - interval '8 days'),
  ('$FA','$C4','expirado',  'estrategico', now() - interval '3 days',  now() - interval '3 days'),
  ('$FA','$C5','concluido', 'estrategico', now() - interval '3 days',  now() - interval '3 days'),
  ('$FB','$C6','gerado',    'estrategico', now() - interval '3 days',  now() - interval '3 days'),
  ('$FA','$C7','gerado',    'essencial',   now() - interval '3 days',  now() - interval '3 days'),
  ('$FA','$C8','gerado',    'estrategico', NULL,                       now() - interval '3 days');
SQL

PL='{"plan_type":"estrategico"}'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# A1 — caminho feliz: cliente sem plano nenhum recebe o seu.
eq "A1 cliente sem plano → gera" "$(cria "$C1" "$FA" "$PL")" "t"

# A2 — O CORAÇÃO DA FASE 2. Plano de 3 dias atrás ainda está na fila ⇒ RECUSA.
#      Com a trava velha (dia operacional) isto PASSARIA e viraria a 4ª cópia do cliente.
espera_sqlstate "A2 plano aberto de 3 dias atras BLOQUEIA (janela)" \
  "public.criar_plano_tatico('$C2'::uuid,'$FA'::uuid,'$PL'::jsonb)" "23505"

# A3 — O OUTRO LADO da mesma régua: fora da janela, o cliente VOLTA a ser candidato.
#      É isto que faz a fila circular; sem ele a fase 2 só trocaria "entope" por "congela".
eq "A3 plano de 8 dias atras (fora da janela) → gera de novo" "$(cria "$C3" "$FA" "$PL")" "t"

# A4 — `expirado` não é fila. O cron da fase 1 devolve o cliente para o pool.
eq "A4 plano EXPIRADO nao bloqueia" "$(cria "$C4" "$FA" "$PL")" "t"

# A5 — `concluido` não bloqueia: desfecho registrado é o fim daquele ciclo, não uma trava.
eq "A5 plano CONCLUIDO nao bloqueia" "$(cria "$C5" "$FA" "$PL")" "t"

# A6 — chave (farmer, customer): plano do farmer B não pode bloquear o farmer A. Cliente
#      reatribuído precisa de plano sob o dono NOVO — senão a reatribuição o deixaria órfão.
eq "A6 plano de OUTRO farmer nao bloqueia" "$(cria "$C6" "$FA" "$PL")" "t"

# A7 — plan_type faz parte da chave (mesma do índice único): 'essencial' aberto não impede
#      um 'estrategico'. São planos com propósitos diferentes.
eq "A7 plan_type diferente nao bloqueia" "$(cria "$C7" "$FA" "$PL")" "t"

# A8 — FAIL-CLOSED do COALESCE. `generated_at` é nullable, e `coluna >= x` com NULL é NULL:
#      sem o COALESCE este plano não bloquearia (fail-OPEN) e a duplicata voltaria em
#      silêncio justamente na linha de dado defeituoso. Indecidível RECUSA.
espera_sqlstate "A8 plano com generated_at NULL BLOQUEIA (fail-closed)" \
  "public.criar_plano_tatico('$C8'::uuid,'$FA'::uuid,'$PL'::jsonb)" "23505"

# A9 — direção da divergência RPC × índice único: a RPC recusa ANTES, então o 23505 cru do
#      índice nunca vaza. Reinserir hoje o que A1 acabou de criar tem de dar a mensagem da
#      RPC (23505 tratado), não uma violação de constraint sem tratamento.
espera_sqlstate "A9 RPC recusa antes do indice unico (mesma SQLSTATE, mensagem tratada)" \
  "public.criar_plano_tatico('$C1'::uuid,'$FA'::uuid,'$PL'::jsonb)" "23505"

# A10 — a mensagem que a edge casa (`ehJaNaFilaDaRpc` → PADROES_JA_NA_FILA). Se a redação
#       mudar sem atualizar o predicado, a trava volta como http_500 e o lote a conta como
#       ERRO. Este assert é o que trava a redação.
MSG=$(P -tA 2>&1 <<EOF || true
SET test.role='service_role';
DO \$do\$
BEGIN
  PERFORM public.criar_plano_tatico('$C2'::uuid,'$FA'::uuid,'$PL'::jsonb);
EXCEPTION WHEN SQLSTATE '23505' THEN RAISE NOTICE 'CAPTUREI:%', SQLERRM;
END
\$do\$;
EOF
)
case "$MSG" in
  *"aberto na fila para este cliente"*) ok "A10 mensagem casa o predicado da edge" ;;
  *) bad "A10 mensagem NAO casa — veio: $(printf '%s' "$MSG" | tr '\n' ' ' | cut -c1-200)" ;;
esac

# ── regressões das fases anteriores (não quebrei o que já existia) ───────────
# A11 — máscara `eligible` continua fail-closed inclusive para service_role (#1422).
espera_sqlstate "A11 cliente MASCARADO recusado (42501)" \
  "public.criar_plano_tatico('$C9'::uuid,'$FA'::uuid,'$PL'::jsonb)" "42501"

# A12 — race de posse: dono atual diverge do esperado.
espera_sqlstate "A12 race de posse recusado" \
  "public.criar_plano_tatico('$C2'::uuid,'$FB'::uuid,'$PL'::jsonb)" "P0001"

# A13 — ramo AUTENTICADO: quem não é dono não passa no gate de carteira.
R13=$(P -tA 2>&1 <<EOF || true
SET test.role='authenticated';
SET test.uid='$FB';
DO \$do\$
BEGIN
  PERFORM public.criar_plano_tatico('$C1'::uuid,'$FB'::uuid,'$PL'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_LEVANTOU_NADA';
EXCEPTION
  WHEN SQLSTATE '42501' THEN RAISE NOTICE 'SENTINELA_PEGOU_O_ESPERADO';
  WHEN OTHERS THEN RAISE;
END
\$do\$;
EOF
)
case "$R13" in
  *SENTINELA_PEGOU_O_ESPERADO*) ok "A13 autenticado fora da carteira recusado (42501)" ;;
  *) bad "A13 — saida: $(printf '%s' "$R13" | tr '\n' ' ' | cut -c1-200)" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificacao (sabota → exige VERMELHO → restaura) ──"

# Roda um assert isolado e diz se ele PASSOU, sem mexer nos contadores globais.
# Usado só pelas sabotagens: aqui "passou" é o resultado RUIM.
passou_23505() {
  local R
  R=$(P -tA 2>&1 <<EOF || true
SET test.role='service_role';
DO \$do\$
BEGIN
  PERFORM public.criar_plano_tatico('$1'::uuid,'$FA'::uuid,'$PL'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_LEVANTOU_NADA';
EXCEPTION
  WHEN SQLSTATE '23505' THEN RAISE NOTICE 'SENTINELA_PEGOU_O_ESPERADO';
  WHEN OTHERS THEN RAISE;
END
\$do\$;
EOF
)
  case "$R" in
    *SENTINELA_PEGOU_O_ESPERADO*) echo "sim" ;;
    *) echo "nao" ;;
  esac
}

# F1 — SABOTAGEM: volta a trava da FASE 1 (chave = dia operacional). O A2 tem de ficar
#      VERMELHO: é exatamente esta versão que produzia uma cópia por dia em prod. Se o A2
#      continuasse verde, ele não estaria provando a janela — estaria provando outra coisa.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid, _expected_owner uuid, _payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _owner uuid; _eligible boolean; _rec public.farmer_tactical_plans; _new_id uuid; _dia_hoje date;
BEGIN
  SELECT a.owner_user_id, a.eligible INTO _owner, _eligible FROM public.carteira_assignments a
   WHERE a.customer_user_id = _customer_user_id FOR UPDATE;
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload);
  _dia_hoje := ((now() AT TIME ZONE 'UTC') - interval '3 hours')::date;
  IF EXISTS (SELECT 1 FROM public.farmer_tactical_plans p
              WHERE p.farmer_id = _owner AND p.customer_user_id = _customer_user_id
                AND p.status = 'gerado'
                AND COALESCE(p.plan_type,'essencial') = COALESCE(_rec.plan_type,'essencial')
                AND (((p.created_at AT TIME ZONE 'UTC') - interval '3 hours')::date) = _dia_hoje)
  THEN RAISE EXCEPTION 'trava da fase 1' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type)
  VALUES (_owner, _customer_user_id, 'gerado', COALESCE(_rec.plan_type,'essencial')) RETURNING id INTO _new_id;
  RETURN _new_id;
END $function$;
SQL
if [ "$(passou_23505 "$C2")" = "nao" ]; then
  ok "F1 sabotagem (trava por DIA) deixou A2 VERMELHO — o assert tem dente"
else
  bad "F1 A2 continuou verde com a trava da fase 1 — o assert NAO prova a janela"
fi

# F2 — SABOTAGEM: remove o COALESCE do generated_at. O A8 tem de ficar VERMELHO — sem ele,
#      `NULL >= x` é NULL, o EXISTS não casa, e a linha de dado defeituoso passa batido.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid, _expected_owner uuid, _payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _owner uuid; _eligible boolean; _rec public.farmer_tactical_plans; _new_id uuid;
BEGIN
  SELECT a.owner_user_id, a.eligible INTO _owner, _eligible FROM public.carteira_assignments a
   WHERE a.customer_user_id = _customer_user_id FOR UPDATE;
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload);
  IF EXISTS (SELECT 1 FROM public.farmer_tactical_plans p
              WHERE p.farmer_id = _owner AND p.customer_user_id = _customer_user_id
                AND p.status = 'gerado'
                AND COALESCE(p.plan_type,'essencial') = COALESCE(_rec.plan_type,'essencial')
                AND p.generated_at >= now() - make_interval(days => 7))
  THEN RAISE EXCEPTION 'sem coalesce' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type)
  VALUES (_owner, _customer_user_id, 'gerado', COALESCE(_rec.plan_type,'essencial')) RETURNING id INTO _new_id;
  RETURN _new_id;
END $function$;
SQL
if [ "$(passou_23505 "$C8")" = "nao" ]; then
  ok "F2 sabotagem (sem COALESCE) deixou A8 VERMELHO — o guard fail-closed tem dente"
else
  bad "F2 A8 continuou verde sem o COALESCE — o assert NAO prova o fail-closed"
fi

# F3 — SABOTAGEM: janela absurda (365 dias). O A3 tem de ficar VERMELHO — o cliente de 8
#      dias atrás voltaria a ser bloqueado, e a fila deixaria de circular. Prova que o A3
#      mede a JANELA e não só "existe algum plano".
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid, _expected_owner uuid, _payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _owner uuid; _eligible boolean; _rec public.farmer_tactical_plans; _new_id uuid;
BEGIN
  SELECT a.owner_user_id, a.eligible INTO _owner, _eligible FROM public.carteira_assignments a
   WHERE a.customer_user_id = _customer_user_id FOR UPDATE;
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans, _payload);
  IF EXISTS (SELECT 1 FROM public.farmer_tactical_plans p
              WHERE p.farmer_id = _owner AND p.customer_user_id = _customer_user_id
                AND p.status = 'gerado'
                AND COALESCE(p.plan_type,'essencial') = COALESCE(_rec.plan_type,'essencial')
                AND COALESCE(p.generated_at, p.created_at, now()) >= now() - make_interval(days => 365))
  THEN RAISE EXCEPTION 'janela absurda' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type)
  VALUES (_owner, _customer_user_id, 'gerado', COALESCE(_rec.plan_type,'essencial')) RETURNING id INTO _new_id;
  RETURN _new_id;
END $function$;
SQL
# C3 já recebeu um plano novo em A3, então uso um cliente virgem com plano ANTIGO para
# medir só o efeito da janela esticada.
CX='cccccccc-0000-0000-0000-00000000000f'
P -q <<SQL
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES ('$CX','$FA',true);
INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type, generated_at, created_at)
VALUES ('$FA','$CX','gerado','estrategico', now() - interval '8 days', now() - interval '8 days');
SQL
if [ "$(passou_23505 "$CX")" = "sim" ]; then
  ok "F3 sabotagem (janela 365d) bloqueou o plano de 8 dias — A3 mede a JANELA de verdade"
else
  bad "F3 janela de 365 dias NAO bloqueou — o A3 nao esta medindo a janela"
fi

# RESTAURA a versão verdadeira e re-roda os dois asserts centrais (a restauração tem de
# devolver o comportamento; sem isto, um erro no restore passaria despercebido).
P -q -f "$MIG"
eq "R1 restaurada: plano de 8 dias volta a gerar" "$(cria "$CX" "$FA" "$PL")" "t"
if [ "$(passou_23505 "$C2")" = "sim" ]; then
  ok "R2 restaurada: plano dentro da janela volta a bloquear"
else
  bad "R2 restauracao NAO devolveu a trava da janela"
fi

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
