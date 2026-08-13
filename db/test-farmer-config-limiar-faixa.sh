#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — FU4-F fase 3b: a escrita dos limiares `margem_faixa_*` exige         ║
# ║  `private.cap_custo_ler`, matando o oráculo de custo por busca binária.       ║
# ║                                                                               ║
# ║      bash db/test-farmer-config-limiar-faixa.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                               ║
# ║  Migration sob teste: 20260813150000_farmer_config_limiar_faixa_escrita_custo ║
# ║  A RPC do #1543 é aplicada REAL (não stub) para provar o ataque ponta-a-ponta.║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="limiar-faixa"
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
# Falsificação: exige o valor EXATO que a sabotagem produz (ex.: 'amarelo'), nunca um "!= esperado".
# Um `ne` aceitaria string vazia/erro como se fosse prova, e a sabotagem passaria por acidente.
falsif() { if [ "$2" = "$3" ]; then ok "$1 (sabotagem produziu [$2], como exigido)"; else bad "$1 — a sabotagem NÃO produziu o vermelho esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'   # app_role master           → cap_custo_ler TRUE
ATACA='22222222-2222-2222-2222-222222222222'    # employee + farmer         → cap_custo_ler FALSE
ESTRAT='33333333-3333-3333-3333-333333333333'   # employee + estrategico    → cap_custo_ler TRUE
CLI='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'      # cliente alvo, margem 42%

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (definições REAIS de prod para has_role e cap_custo_ler)
# ══════════════════════════════════════════════════════════════════════════════
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

-- VERBATIM de prod (pg_get_functiondef, 2026-08-13) — é O gate sob teste, não pode ser stub
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

-- Dependências da RPC do #1543 que NÃO são o objeto sob teste → stub honesto.
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

-- A tabela real + as DUAS policies permissivas VERBATIM de prod (pg_policy, 2026-08-13).
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
CREATE POLICY "Staff can manage algorithm config" ON public.farmer_algorithm_config FOR ALL
  USING ((public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)))
  WITH CHECK ((public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role)));

-- Espelha o GRANT de prod ANTES da migration (medido: authenticated e anon têm arwdDxtm, o `D`
-- é TRUNCATE). Tem de vir antes, senão a migration revogaria e o seed reconcederia depois,
-- e o assert de TRUNCATE ficaria verde por ordem de execução, não por efeito da migration.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.farmer_algorithm_config TO authenticated, anon;
SQL

# A RPC do #1543 — REAL, para provar o ataque ponta-a-ponta (e pegar late-bound de plpgsql)
P -q -f "$REPO_ROOT/supabase/migrations/20260726170000_fu4f_fase3_carteira_margem_faixa.sql"
echo "pré-requisito aplicado: RPC real do #1543"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION SOB TESTE (Lei #1: o .sql commitado)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260813150000_farmer_config_limiar_faixa_escrita_custo.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# IDEMPOTÊNCIA — o apply é MANUAL (founder cola no SQL Editor do Lovable) e re-colar após falha
# parcial é rotina. O segundo Run TEM de passar limpo (Lei do lovable-db-operator).
if P -q -f "$MIG" >/dev/null 2>&1; then
  IDEM_OK=1
else
  IDEM_OK=0
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS (espelha o grant de prod: authenticated tem DML na tabela)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$ATACA'),('$ESTRAT'),('$CLI') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'),('$ATACA','employee'),('$ESTRAT','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$ATACA','farmer'),('$ESTRAT','estrategico');
-- margem do alvo = 42% → com piso 30 é 'verde'; se o piso subir p/ 45 vira 'amarelo'
INSERT INTO private.margem_seed VALUES ('$CLI', 42.0),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 10.0),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 80.0);
INSERT INTO public.farmer_algorithm_config(key,value) VALUES ('health_w_m', 0.20);
SQL

# helper: roda SQL como um usuário autenticado (GUC do JWT + SET ROLE).
# `-q` é obrigatório: sem ele o psql ecoa a tag de comando de cada `SET`, o ruído entra na
# comparação e um assert de desigualdade passaria por causa do ruído, não do efeito.
as_auth() { Pq -q -c "SET test.uid='$1'; SET ROLE authenticated; $2"; }
# helper: faixa que a RPC devolve para o cliente alvo, na visão de <uid>
faixa_de() { as_auth "$1" "SELECT faixa FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';"; }
piso()     { Pq -c "SELECT value::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: estado inicial ──"
eq "I0 migration é idempotente (2º apply limpo — o founder re-cola no SQL Editor)" "$IDEM_OK" "1"
eq "I1 o 2º apply não duplicou policy" \
   "$(Pq -c "SELECT count(*)::text FROM pg_policy WHERE polrelid='public.farmer_algorithm_config'::regclass AND polname LIKE 'limiar\_faixa\_%';")" "3"
eq "S0 seed criou o piso" "$(piso)" "30"
eq "S1 seed criou a meta" "$(Pq -c "SELECT value::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_meta_pct';")" "50"

echo "── asserts POSITIVOS (não quebrei quem escreve legitimamente) ──"
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET value=0.25 WHERE key='health_w_m';" >/dev/null
eq "P1 employee SEM cap ainda ajusta PESO (health_w_m)" \
   "$(Pq -c "SELECT value::text FROM public.farmer_algorithm_config WHERE key='health_w_m';")" "0.25"

as_auth "$ATACA" "INSERT INTO public.farmer_algorithm_config(key,value) VALUES ('hs_weight_recency',25);" >/dev/null
eq "P2 employee SEM cap ainda INSERE peso novo (hs_weight_recency)" \
   "$(Pq -c "SELECT value::text FROM public.farmer_algorithm_config WHERE key='hs_weight_recency';")" "25"

as_auth "$MASTER" "UPDATE public.farmer_algorithm_config SET value=31 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "P3 MASTER escreve o limiar" "$(piso)" "31"

as_auth "$ESTRAT" "UPDATE public.farmer_algorithm_config SET value=30 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "P4 employee COM cap (estrategico) escreve o limiar — o gate é cap_custo_ler, não master" \
   "$(piso)" "30"

echo "── asserts NEGATIVOS (a defesa morde) ──"
# UPDATE/DELETE negados por USING não levantam erro: a linha simplesmente não é vista.
# Por isso estes asserts leem o ESTADO, não esperam exceção.
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET value=45 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "N1 employee SEM cap NÃO altera o valor do limiar" "$(piso)" "30"

as_auth "$ATACA" "DELETE FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "N2 employee SEM cap NÃO apaga o limiar (apagar = voltar ao default 30)" \
   "$(Pq -c "SELECT count(*)::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';")" "1"

# O desvio lateral que SÓ o USING pega: renomear a key faz a linha sumir do namespace protegido,
# e a RPC volta ao COALESCE default. Com WITH CHECK sozinho isto PASSARIA.
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET key='zzz_neutralizado' WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "N3 employee SEM cap NÃO renomeia a key para fora do namespace protegido" \
   "$(Pq -c "SELECT count(*)::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';")" "1"

# INSERT negado por WITH CHECK levanta 42501 → aqui sim, padrão SQLSTATE + re-raise.
# Sentinelas ASCII, caixa fixa, sem substring comum entre si e ausentes do texto do Postgres.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$ATACA'; SET ROLE authenticated;
DO \$\$
BEGIN
  INSERT INTO public.farmer_algorithm_config(key,value) VALUES ('margem_faixa_terceiro_pct', 7);
  RAISE NOTICE 'VEREDITO_ACEITOU_A_ESCRITA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VEREDITO_RECUSOU_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
if printf '%s' "$R" | command grep -qF 'VEREDITO_RECUSOU_42501'; then
  ok "N4 employee SEM cap NÃO cria key nova no namespace (42501, prefixo cobre chave futura)"
else
  bad "N4 INSERT de key margem_faixa_* nova não foi barrado com 42501 — veio: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-200)"
fi

echo "── asserts MONEY-PATH: o oráculo de busca binária ──"
eq "M0 a RPC não projeta o número para quem não tem cap" \
   "$(as_auth "$ATACA" "SELECT coalesce(margem_pct::text,'NULL') FROM public.get_carteira_margem_faixa() WHERE customer_user_id='$CLI';")" "NULL"
eq "M1 faixa inicial do alvo (margem 42, piso 30)" "$(faixa_de "$ATACA")" "verde"

# CONTRAPROVA — sem ela, M3 passaria por vacuidade (se a RPC ignorasse o limiar, a faixa nunca
# mudaria e o teste ficaria verde mesmo com a policy ausente). Aqui o oráculo é EXERCIDO por quem
# pode: mover o piso 30→45 realmente vira a faixa do cliente de verde para amarelo.
as_auth "$MASTER" "UPDATE public.farmer_algorithm_config SET value=45 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "M2 CONTRAPROVA: com o limiar em 45, a faixa do alvo VIRA amarelo (o oráculo é real)" \
   "$(faixa_de "$MASTER")" "amarelo"
as_auth "$MASTER" "UPDATE public.farmer_algorithm_config SET value=30 WHERE key='margem_faixa_piso_pct';" >/dev/null

# O ATAQUE: o employee sem cap tenta a mesma sonda que o master acabou de exercer com sucesso.
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET value=45 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "M3 ATAQUE: employee SEM cap move o piso e a faixa NÃO se move — sonda morta" \
   "$(faixa_de "$ATACA")" "verde"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem TEM de produzir vermelho) ──"

# S1 — sem a policy de UPDATE, o ataque M3 volta a funcionar.
P -q -c 'DROP POLICY "limiar_faixa_margem_update_exige_cap_custo" ON public.farmer_algorithm_config;'
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET value=45 WHERE key='margem_faixa_piso_pct';" >/dev/null
falsif "S1 sabotagem (drop policy UPDATE) reabre o oráculo: a sonda do atacante move a faixa" \
   "$(faixa_de "$ATACA")" "amarelo"
as_auth "$MASTER" "UPDATE public.farmer_algorithm_config SET value=30 WHERE key='margem_faixa_piso_pct';" >/dev/null

# S2 — o assert do desvio lateral (N3) só tem dente por causa do USING. Recria a policy de UPDATE
# SÓ com WITH CHECK: o rename passa a ser aceito e a key protegida some.
P -q <<'SQL'
CREATE POLICY "limiar_faixa_margem_update_exige_cap_custo"
  ON public.farmer_algorithm_config AS RESTRICTIVE FOR UPDATE
  WITH CHECK (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );
SQL
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET key='zzz_neutralizado' WHERE key='margem_faixa_piso_pct';" >/dev/null
falsif "S2 sabotagem (UPDATE sem USING) deixa o rename passar — prova que o USING não é decorativo" \
   "$(Pq -c "SELECT count(*)::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';")" "0"
# restaura cirurgicamente: renomeia de volta e recria a policy verdadeira
P -q <<'SQL'
UPDATE public.farmer_algorithm_config SET key='margem_faixa_piso_pct' WHERE key='zzz_neutralizado';
DROP POLICY "limiar_faixa_margem_update_exige_cap_custo" ON public.farmer_algorithm_config;
CREATE POLICY "limiar_faixa_margem_update_exige_cap_custo"
  ON public.farmer_algorithm_config AS RESTRICTIVE FOR UPDATE
  USING (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  )
  WITH CHECK (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );
SQL

# S3 — sem a policy de INSERT, a key nova entra (o caminho VIVO hoje, já que as keys não existiam).
P -q -c 'DROP POLICY "limiar_faixa_margem_insert_exige_cap_custo" ON public.farmer_algorithm_config;'
R2=$(P -tA 2>&1 <<SQL || true
SET test.uid='$ATACA'; SET ROLE authenticated;
DO \$\$
BEGIN
  INSERT INTO public.farmer_algorithm_config(key,value) VALUES ('margem_faixa_terceiro_pct', 7);
  RAISE NOTICE 'VEREDITO_ACEITOU_A_ESCRITA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VEREDITO_RECUSOU_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
if printf '%s' "$R2" | command grep -qF 'VEREDITO_ACEITOU_A_ESCRITA'; then
  ok "S3 sabotagem (drop policy INSERT) deixa a key nova entrar — assert N4 tem dente"
else
  bad "S3 a sabotagem do INSERT não produziu vermelho: N4 passaria de qualquer jeito"
fi
P -q <<'SQL'
DELETE FROM public.farmer_algorithm_config WHERE key='margem_faixa_terceiro_pct';
CREATE POLICY "limiar_faixa_margem_insert_exige_cap_custo"
  ON public.farmer_algorithm_config AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );
SQL

# S4 — sem a policy de DELETE, apagar o limiar volta a funcionar (reseta ao default).
P -q -c 'DROP POLICY "limiar_faixa_margem_delete_exige_cap_custo" ON public.farmer_algorithm_config;'
as_auth "$ATACA" "DELETE FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';" >/dev/null
falsif "S4 sabotagem (drop policy DELETE) deixa apagar o limiar" \
   "$(Pq -c "SELECT count(*)::text FROM public.farmer_algorithm_config WHERE key='margem_faixa_piso_pct';")" "0"
P -q <<'SQL'
INSERT INTO public.farmer_algorithm_config(key,value) VALUES ('margem_faixa_piso_pct',30) ON CONFLICT DO NOTHING;
CREATE POLICY "limiar_faixa_margem_delete_exige_cap_custo"
  ON public.farmer_algorithm_config AS RESTRICTIVE FOR DELETE
  USING (
    NOT (key LIKE 'margem!_faixa!_%' ESCAPE '!')
    OR COALESCE((SELECT private.cap_custo_ler((SELECT auth.uid()))), false)
  );
SQL

echo "── re-verificação pós-restauro (a versão verdadeira voltou inteira) ──"
as_auth "$ATACA" "UPDATE public.farmer_algorithm_config SET value=45 WHERE key='margem_faixa_piso_pct';" >/dev/null
eq "R1 pós-falsificação o ataque segue morto" "$(faixa_de "$ATACA")" "verde"
eq "R2 pós-falsificação o limiar segue 30" "$(piso)" "30"

# ── TRUNCATE: a RLS NÃO o intercepta; quem barra é o REVOKE da migration ──────────────────────
# Deixado por último de propósito: se passar, a tabela esvazia e contaminaria os outros asserts.
echo "── assert TRUNCATE (fora do alcance da RLS) ──"
trunca_como_atacante() {
  P -tA 2>&1 <<SQL || true
SET test.uid='$ATACA'; SET ROLE authenticated;
DO \$\$
BEGIN
  TRUNCATE public.farmer_algorithm_config;
  RAISE NOTICE 'VEREDITO_A_TABELA_FOI_ESVAZIADA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'VEREDITO_SEM_PRIVILEGIO_DE_TRUNCATE';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
}
if printf '%s' "$(trunca_como_atacante)" | command grep -qF 'VEREDITO_SEM_PRIVILEGIO_DE_TRUNCATE'; then
  ok "T1 employee SEM cap não TRUNCA a config (o REVOKE pega o que a RLS não vê)"
else
  bad "T1 TRUNCATE não foi barrado — as 3 policies viram decoração: truncar reseta o limiar ao default"
fi

# S5 — devolve o privilégio e exige que o truncate volte a passar (senão T1 passaria de graça,
# por a role nunca ter tido TRUNCATE, e não por causa do REVOKE da migration).
P -q -c 'GRANT TRUNCATE ON public.farmer_algorithm_config TO authenticated;'
if printf '%s' "$(trunca_como_atacante)" | command grep -qF 'VEREDITO_A_TABELA_FOI_ESVAZIADA'; then
  ok "S5 sabotagem (re-GRANT de TRUNCATE) esvazia a tabela — T1 tem dente"
else
  bad "S5 re-conceder TRUNCATE não permitiu truncar: T1 passaria mesmo sem o REVOKE"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
