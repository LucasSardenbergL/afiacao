# Prime Colacor PR-1 — Fundação de Dados — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a fundação de dados do programa Prime Colacor: catálogo de planos, assinaturas com grandfathering, registro de uso de benefício com contrafactual real, e a view do extrato mensal honesto — provado em PG17 com falsificação, pronto para apply manual no Lovable.

**Architecture:** 3 tabelas + 1 view em migration transacional única (`supabase/migrations/`), RLS staff-ALL/cliente-lê-só-o-seu, honestidade money-path ENFORÇADA por CHECK no banco (tipo monetizável exige `valor_tabela > 0`; não-monetizável exige `NULL` — ausente ≠ zero). View `security_invoker` gera 1 linha por assinatura×mês (uso zero é fato transacional, nunca R$ fabricado). Nenhum frontend neste PR.

**Tech Stack:** PostgreSQL (Supabase/Lovable Cloud, apply manual no SQL Editor), harness de prova PG17 local (`db/test-*.sh`, padrão do repo), bash.

## Global Constraints

- Idioma: código/comentários/commits em **pt-BR** (convenção do repo).
- Migration custom em `supabase/migrations/YYYYMMDDHHMMSS_slug.sql` **NÃO auto-aplica** no Lovable → PR precisa da nota "⚠️ migration manual" + bloco pro SQL Editor + query de validação (ritual `lovable-db-operator`).
- Migration commitada é **imutável** — correção pós-review = arquivo NOVO com timestamp novo.
- Transação única (`BEGIN`/`COMMIT`) — o SQL Editor roda como script; erro no meio não pode deixar estado parcial.
- Money-path: **ausente ≠ zero** (nunca fabricar número); prova PG17 com asserts negativos por SQLSTATE + **falsificação** (sabotar → exigir vermelho) — ritual `prove-sql-money-path`.
- Tabela nova **sempre** com RLS; policies usam `public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)` (padrão do repo).
- Sem `GRANT` explícito na migration (o projeto Supabase já provê grants default a `authenticated`/`anon`; RLS é o gate).
- Comandos pesados prefixados com `heavy`; `cmd | tail` engole exit code → `> log 2>&1; echo $?`.
- Timestamp da migration deve ordenar DEPOIS da última da main (última vista: `20260710012337`).

## Não-objetivos do PR-1 (do spec §7 — ficam pros PRs seguintes)

- Seed de plano piloto (preço final pendente de calibragem — staff cria via admin no PR-2 ou SQL manual).
- Telas (`/prime`, `/admin/prime`) — PR-2/PR-3.
- Sync colacor_sc — PR-4. Matcher automático de afiação, cobrança/pagamentos — v2.
- Bloqueio de registro de uso em assinatura suspensa/cancelada: gate do ADMIN (PR-2), não do banco — o writer é staff e o volume do piloto é auditável no painel; trigger de banco só se o piloto mostrar necessidade (YAGNI).

---

### Task 1: Migration `20260711090000_prime_fundacao.sql`

**Files:**
- Create: `supabase/migrations/20260711090000_prime_fundacao.sql`

**Interfaces:**
- Produces: tabelas `public.prime_planos`, `public.prime_assinaturas`, `public.prime_beneficio_uso`; view `public.v_prime_extrato_mensal`; índice único parcial `uq_prime_assinatura_viva`; constraint `prime_uso_valor_por_tipo`. Nomes e colunas exatamente como no SQL abaixo — o harness (Task 2), a validação pós-apply (Task 4) e os PRs 2/3/5 referenciam esses nomes.

- [ ] **Step 1: Criar o arquivo da migration com o conteúdo integral**

```sql
-- Prime Colacor — PR-1: fundação de dados (planos, assinaturas, uso de benefício, extrato)
-- Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7
-- Money-path: valor_tabela é o CONTRAFACTUAL em R$ do benefício concedido (preço de
-- tabela real da época do registro — ex.: dentes × R$1,20 vigente). A honestidade é
-- enforçada NO BANCO (constraint prime_uso_valor_por_tipo): tipo monetizável EXIGE
-- valor_tabela > 0; tipo operacional EXIGE NULL (ausente ≠ zero — nunca fabricar R$).
-- Writer único: staff (employee/master). Cliente só LÊ o que é seu.
-- Transação única: o SQL Editor do Lovable roda o bloco como script — erro no meio
-- não pode deixar estado parcial (ex.: tabela sem policy).

BEGIN;

-- ── 1. Catálogo de planos ──
CREATE TABLE public.prime_planos (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text NOT NULL,
  preco_mensal numeric NOT NULL CHECK (preco_mensal > 0),
  franquia_dentes integer NOT NULL CHECK (franquia_dentes >= 0),
  -- Descritivo/copy dos benefícios do plano (lista de strings). Staff é o único writer;
  -- NÃO é sinal money-path (o sinal fica em prime_beneficio_uso, coluna dedicada).
  beneficios jsonb NOT NULL DEFAULT '[]'::jsonb,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Assinaturas — 1 viva por cliente; preço e franquia CONGELADOS na adesão ──
-- (grandfathering do spec §5: mudar o plano no catálogo NUNCA muda o contratado de
--  quem já assinou; mudança de condição = nova assinatura em novo ciclo)
CREATE TABLE public.prime_assinaturas (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  plano_id uuid NOT NULL REFERENCES public.prime_planos(id),
  preco_contratado numeric NOT NULL CHECK (preco_contratado > 0),
  franquia_dentes_contratada integer NOT NULL CHECK (franquia_dentes_contratada >= 0),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','suspensa','cancelada')),
  data_inicio date NOT NULL DEFAULT current_date,
  data_fim date CHECK (data_fim IS NULL OR data_fim >= data_inicio),
  observacao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_prime_assinatura_viva
  ON public.prime_assinaturas (customer_user_id) WHERE status <> 'cancelada';

-- ── 3. Uso de benefício — writer único staff; contrafactual explícito por linha ──
-- Registro = CONCESSÃO dentro do programa (o excedente de franquia é faturado normal
-- no Omie e NÃO entra aqui). bonus_dentes é CRÉDITO de franquia (expande o teto do
-- mês), não benefício monetizado — monetiza só quando consumido como afiacao_dentes.
CREATE TABLE public.prime_beneficio_uso (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assinatura_id uuid NOT NULL REFERENCES public.prime_assinaturas(id),
  tipo text NOT NULL CHECK (tipo IN
    ('afiacao_dentes','bonus_dentes','desconto_abrasivo','atendimento_tecnico',
     'prioridade_entrega','prioridade_separacao','coleta_rota')),
  -- dentes para afiacao_dentes/bonus_dentes; 1 para eventos operacionais
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  valor_tabela numeric,
  -- competência = 1º dia do mês (extrato agrupa por mês civil)
  competencia date NOT NULL CHECK (competencia = (date_trunc('month', competencia))::date),
  referencia text,   -- nº do pedido/NF Omie que lastreia o registro
  descricao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Honestidade money-path NO BANCO (ausente ≠ zero):
  CONSTRAINT prime_uso_valor_por_tipo CHECK (
    CASE WHEN tipo IN ('afiacao_dentes','desconto_abrasivo')
         THEN valor_tabela IS NOT NULL AND valor_tabela > 0
         ELSE valor_tabela IS NULL END
  )
);
CREATE INDEX idx_prime_uso_assinatura_mes
  ON public.prime_beneficio_uso (assinatura_id, competencia);

-- ── updated_at (lição S250: tabela mutável SEM trigger enfraquece diagnóstico) ──
CREATE TRIGGER trg_prime_planos_updated_at BEFORE UPDATE ON public.prime_planos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_prime_assinaturas_updated_at BEFORE UPDATE ON public.prime_assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──
ALTER TABLE public.prime_planos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prime_assinaturas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prime_beneficio_uso ENABLE ROW LEVEL SECURITY;

CREATE POLICY prime_planos_staff_all ON public.prime_planos FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
-- Catálogo: qualquer LOGADO lê plano ATIVO (preço do plano é público pro cliente; anon fora)
CREATE POLICY prime_planos_auth_read ON public.prime_planos FOR SELECT
  USING (auth.uid() IS NOT NULL AND ativo);

CREATE POLICY prime_assinaturas_staff_all ON public.prime_assinaturas FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_assinaturas_cliente_read ON public.prime_assinaturas FOR SELECT
  USING (customer_user_id = auth.uid());

CREATE POLICY prime_uso_staff_all ON public.prime_beneficio_uso FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_uso_cliente_read ON public.prime_beneficio_uso FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.prime_assinaturas a
                 WHERE a.id = assinatura_id AND a.customer_user_id = auth.uid()));

-- ── 4. Extrato mensal (security_invoker → herda a RLS das tabelas) ──
-- 1 linha por assinatura × mês desde data_inicio até o mês corrente SP (ou data_fim).
-- monetizado_total fica NULL quando não há registro monetizável no mês (≠ 0 fabricado);
-- contagens (usos, dentes) com 0 são FATO transacional (zero usos registrados).
CREATE VIEW public.v_prime_extrato_mensal
WITH (security_invoker = true) AS
WITH meses AS (
  SELECT a.id AS assinatura_id, a.customer_user_id, a.status,
         a.preco_contratado, a.franquia_dentes_contratada,
         generate_series(
           date_trunc('month', a.data_inicio::timestamp),
           date_trunc('month', COALESCE(a.data_fim,
             (now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp),
           interval '1 month'
         )::date AS competencia
  FROM public.prime_assinaturas a
), uso AS (
  SELECT assinatura_id, competencia,
         sum(valor_tabela) FILTER (WHERE tipo IN ('afiacao_dentes','desconto_abrasivo')) AS monetizado_total,
         sum(quantidade)   FILTER (WHERE tipo = 'afiacao_dentes')  AS dentes_usados,
         sum(quantidade)   FILTER (WHERE tipo = 'bonus_dentes')    AS dentes_bonus,
         -- bônus é CRÉDITO de franquia, não uso — fica fora da contagem operacional
         count(*)          FILTER (WHERE tipo NOT IN ('afiacao_dentes','desconto_abrasivo','bonus_dentes')) AS usos_operacionais,
         count(*) AS n_registros
  FROM public.prime_beneficio_uso
  GROUP BY assinatura_id, competencia
)
SELECT m.assinatura_id, m.customer_user_id, m.status, m.competencia,
       m.preco_contratado,
       u.monetizado_total,
       u.dentes_usados,
       u.dentes_bonus,
       m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0) AS franquia_total,
       GREATEST(0::numeric,
         m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0)
         - COALESCE(u.dentes_usados, 0)) AS dentes_restantes,
       COALESCE(u.usos_operacionais, 0) AS usos_operacionais,
       COALESCE(u.n_registros, 0) AS n_registros
FROM meses m
LEFT JOIN uso u USING (assinatura_id, competencia);

COMMIT;
```

- [ ] **Step 2: Conferir que o timestamp ordena depois da última migration da main**

Run: `ls supabase/migrations/ | sort | tail -3`
Expected: `20260711090000_prime_fundacao.sql` é a última da lista.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260711090000_prime_fundacao.sql
git commit -m "feat(prime): migration da fundação de dados — planos, assinaturas, uso de benefício, extrato (PR-1)"
```

---

### Task 2: Harness de prova PG17 `db/test-prime-fundacao.sh`

**Files:**
- Create: `db/test-prime-fundacao.sh`

**Interfaces:**
- Consumes: `supabase/migrations/20260711090000_prime_fundacao.sql` (Task 1 — aplicada verbatim no PG17 efêmero); `db/stubs-supabase.sql` (existente no repo).
- Produces: prova executável `bash db/test-prime-fundacao.sh` com saída `PASS=N FAIL=0` — referenciada no corpo do PR (Task 5).

- [ ] **Step 1: Criar o harness com o conteúdo integral**

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da 20260711090000_prime_fundacao (money-path)           ║
# ║  bash db/test-prime-fundacao.sh > /tmp/prime-sql.log 2>&1; echo "exit=$?"     ║
# ║  3 tabelas (RLS staff/cliente/anon) + view extrato + honestidade por CHECK.   ║
# ║  Falsificações embutidas: F1 (constraint de honestidade) e F2 (RLS cliente).  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="prime-fundacao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

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
Pq() { P -qtA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT ALL ON SCHEMA public TO authenticated, anon;
-- Emula o default do Supabase (grants de tabela p/ authenticated/anon) ANTES da
-- migration — RLS é o único gate, como em prod.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ════════ ZONA 1 — pré-requisitos que a migration referencia (prod já tem) ════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
GRANT SELECT ON public.user_roles TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
SQL
ok "zona 1: pré-requisitos criados (app_role, has_role, update_updated_at_column)"

# ════════ ZONA 2 — aplica a migration REAL (verbatim) ════════
P -q -f "$REPO_ROOT/supabase/migrations/20260711090000_prime_fundacao.sql"
eq "tabelas+view existem" \
   "$(Pq -c "SELECT count(*) FROM (VALUES (to_regclass('public.prime_planos')), (to_regclass('public.prime_assinaturas')), (to_regclass('public.prime_beneficio_uso')), (to_regclass('public.v_prime_extrato_mensal'))) t(r) WHERE r IS NOT NULL")" "4"
eq "RLS ligada nas 3 tabelas" \
   "$(Pq -c "SELECT count(*) FROM pg_class WHERE relname IN ('prime_planos','prime_assinaturas','prime_beneficio_uso') AND relrowsecurity")" "3"
eq "6 policies criadas" \
   "$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%'")" "6"

# ════════ ZONA 3 — seed: staff, 2 clientes, plano, assinaturas ════════
P -q <<'SQL'
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000aaaa','employee'),
  ('00000000-0000-0000-0000-00000000bbbb','customer'),
  ('00000000-0000-0000-0000-00000000cccc','customer');
SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
INSERT INTO public.prime_planos (id, nome, preco_mensal, franquia_dentes, beneficios)
  VALUES ('11111111-1111-1111-1111-111111111111','Prime Piloto', 99, 200,
          '["Franquia 200 dentes/mês","Coleta na rota","Prioridade"]'::jsonb);
INSERT INTO public.prime_planos (id, nome, preco_mensal, franquia_dentes, ativo)
  VALUES ('11111111-1111-1111-1111-222222222222','Plano Desativado', 59, 100, false);
INSERT INTO public.prime_assinaturas
  (id, customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by)
  VALUES ('22222222-2222-2222-2222-111111111111','00000000-0000-0000-0000-00000000bbbb',
          '11111111-1111-1111-1111-111111111111', 99, 200, date_trunc('month', now())::date - interval '1 month',
          '00000000-0000-0000-0000-00000000aaaa');
SQL
ok "zona 3: seed (staff + plano ativo/inativo + assinatura do cliente B iniciando mês passado)"

# ════════ ZONA 4 — CHECKs de honestidade e integridade (negativos por SQLSTATE) ════════
# helper: espera SQLSTATE exata; qualquer outro erro RE-LANÇA (nada de WHEN OTHERS 'OK')
expect_sqlstate() { # $1=nome $2=sqlstate esperada $3=sql
  local got
  got="$(P -qtA -c "DO \$\$ BEGIN $3; RAISE EXCEPTION 'NAO_FALHOU'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE = '$2' THEN RAISE NOTICE 'SQLSTATE_OK'; ELSE RAISE; END IF; END \$\$;" 2>&1 | grep -c 'SQLSTATE_OK' || true)"
  eq "$1 (SQLSTATE $2)" "$got" "1"
}

P -q -c "SET test.uid = '00000000-0000-0000-0000-00000000aaaa'" || true
expect_sqlstate "afiacao_dentes SEM valor_tabela é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','afiacao_dentes', 96, NULL, date_trunc('month', now())::date, '00000000-0000-0000-0000-00000000aaaa')"
expect_sqlstate "afiacao_dentes com valor 0 é barrada (ausente ≠ zero)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','afiacao_dentes', 96, 0, date_trunc('month', now())::date, '00000000-0000-0000-0000-00000000aaaa')"
expect_sqlstate "tipo operacional COM valor_tabela é barrado (não monetiza prioridade)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','prioridade_entrega', 1, 10, date_trunc('month', now())::date, '00000000-0000-0000-0000-00000000aaaa')"
expect_sqlstate "bonus_dentes COM valor_tabela é barrado (crédito não monetiza)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','bonus_dentes', 50, 60, date_trunc('month', now())::date, '00000000-0000-0000-0000-00000000aaaa')"
expect_sqlstate "competencia fora do dia 1 é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','afiacao_dentes', 96, 115.20, (date_trunc('month', now())::date + 5), '00000000-0000-0000-0000-00000000aaaa')"
expect_sqlstate "preco_mensal <= 0 é barrado" "23514" \
  "INSERT INTO public.prime_planos (nome, preco_mensal, franquia_dentes) VALUES ('x', 0, 100)"
expect_sqlstate "status inválido é barrado" "23514" \
  "UPDATE public.prime_assinaturas SET status='pausada' WHERE id='22222222-2222-2222-2222-111111111111'"
expect_sqlstate "2ª assinatura VIVA do mesmo cliente é barrada (UNIQUE parcial)" "23505" \
  "INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, created_by) VALUES ('00000000-0000-0000-0000-00000000bbbb','11111111-1111-1111-1111-111111111111', 99, 200, '00000000-0000-0000-0000-00000000aaaa')"

# ════════ ZONA 5 — uso real do mês (staff registra) + view ════════
P -q <<'SQL'
SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
-- mês corrente: serra 96 dentes (R$115,20), bônus cross-sell +50, 1 coleta na rota
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, referencia, created_by) VALUES
  ('22222222-2222-2222-2222-111111111111','afiacao_dentes', 96, 115.20, date_trunc('month', now())::date, 'PV-TESTE-1', '00000000-0000-0000-0000-00000000aaaa'),
  ('22222222-2222-2222-2222-111111111111','bonus_dentes',   50, NULL,   date_trunc('month', now())::date, NULL, '00000000-0000-0000-0000-00000000aaaa'),
  ('22222222-2222-2222-2222-111111111111','coleta_rota',     1, NULL,   date_trunc('month', now())::date, NULL, '00000000-0000-0000-0000-00000000aaaa');
SQL
ok "zona 5: uso do mês registrado (96 dentes + bônus 50 + coleta)"

MES_ATUAL="$(Pq -c "SELECT date_trunc('month', now())::date")"
MES_PASSADO="$(Pq -c "SELECT (date_trunc('month', now()) - interval '1 month')::date")"

eq "extrato tem 2 meses (início mês passado → corrente)" \
   "$(Pq -c "SELECT count(*) FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111'")" "2"
eq "mês corrente: monetizado = 115.20" \
   "$(Pq -c "SELECT monetizado_total FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_ATUAL}'")" "115.20"
eq "mês corrente: franquia_total = 250 (200 contratada + 50 bônus)" \
   "$(Pq -c "SELECT franquia_total FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_ATUAL}'")" "250"
eq "mês corrente: dentes_restantes = 154 (250 − 96)" \
   "$(Pq -c "SELECT dentes_restantes FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_ATUAL}'")" "154"
eq "mês corrente: 1 uso operacional (só a coleta; bônus NÃO conta como uso op.)" \
   "$(Pq -c "SELECT usos_operacionais FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_ATUAL}'")" "1"
eq "mês passado (sem uso): monetizado é NULL (nunca 0 fabricado)" \
   "$(Pq -c "SELECT monetizado_total IS NULL FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_PASSADO}'")" "t"
eq "mês passado: n_registros = 0 (UI mostra 'sem uso registrado')" \
   "$(Pq -c "SELECT n_registros FROM public.v_prime_extrato_mensal WHERE assinatura_id='22222222-2222-2222-2222-111111111111' AND competencia='${MES_PASSADO}'")" "0"

# ════════ ZONA 6 — RLS matriz (SET ROLE + GUC; psql superuser bypassaria) ════════
rls() { # $1=uid (vazio = anon) $2=sql
  if [ -z "$1" ]; then
    P -qtA -c "SET ROLE anon; SET test.uid=''; $2" 2>&1; P -q -c "RESET ROLE" >/dev/null
  else
    P -qtA -c "SET ROLE authenticated; SET test.uid='$1'; $2" 2>&1; P -q -c "RESET ROLE" >/dev/null
  fi
}
UB='00000000-0000-0000-0000-00000000bbbb'  # cliente dono
UC='00000000-0000-0000-0000-00000000cccc'  # cliente alheio
UA='00000000-0000-0000-0000-00000000aaaa'  # staff

eq "staff lê a assinatura" "$(rls $UA "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente dono lê a própria assinatura" "$(rls $UB "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente ALHEIO não vê assinatura de outro" "$(rls $UC "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "anon não vê assinaturas" "$(rls '' "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "cliente dono lê o próprio uso" "$(rls $UB "SELECT count(*) FROM public.prime_beneficio_uso")" "3"
eq "cliente ALHEIO não vê uso de outro" "$(rls $UC "SELECT count(*) FROM public.prime_beneficio_uso")" "0"
eq "cliente vê o catálogo ATIVO (1 plano)" "$(rls $UB "SELECT count(*) FROM public.prime_planos")" "1"
eq "anon não vê catálogo" "$(rls '' "SELECT count(*) FROM public.prime_planos")" "0"
eq "cliente dono vê o próprio extrato (2 meses)" "$(rls $UB "SELECT count(*) FROM public.v_prime_extrato_mensal")" "2"
eq "cliente ALHEIO vê extrato vazio" "$(rls $UC "SELECT count(*) FROM public.v_prime_extrato_mensal")" "0"
CLIENTE_INSERT="$(rls $UB "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('22222222-2222-2222-2222-111111111111','afiacao_dentes', 10, 12, date_trunc('month', now())::date, '$UB') RETURNING 1" | grep -c '42501\|violates row-level security' || true)"
eq "cliente NÃO consegue registrar uso (writer único staff)" "$CLIENTE_INSERT" "1"

# ════════ ZONA 7 — ciclo de vida: cancelar libera o UNIQUE parcial ════════
P -q <<'SQL'
SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
UPDATE public.prime_assinaturas
   SET status='cancelada', data_fim = current_date
 WHERE id='22222222-2222-2222-2222-111111111111';
INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, created_by)
  VALUES ('00000000-0000-0000-0000-00000000bbbb','11111111-1111-1111-1111-111111111111', 119, 200,
          '00000000-0000-0000-0000-00000000aaaa');
SQL
eq "após cancelar, nova assinatura do mesmo cliente passa (preço novo = ciclo novo)" \
   "$(Pq -c "SELECT count(*) FROM public.prime_assinaturas WHERE customer_user_id='00000000-0000-0000-0000-00000000bbbb'")" "2"
eq "updated_at avançou no UPDATE (trigger vivo)" \
   "$(Pq -c "SELECT updated_at > created_at FROM public.prime_assinaturas WHERE id='22222222-2222-2222-2222-111111111111'")" "t"

# ════════ ZONA 8 — FALSIFICAÇÕES EMBUTIDAS (provar que o teste TEM DENTE) ════════
# F1: sem a constraint de honestidade, o INSERT desonesto PASSARIA (o assert da zona 4
#     ficaria vermelho). Sabota num SAVEPOINT e prova que o mundo sabotado aceita lixo.
F1="$(P -qtA <<'SQL'
BEGIN;
SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
ALTER TABLE public.prime_beneficio_uso DROP CONSTRAINT prime_uso_valor_por_tipo;
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by)
  VALUES ('22222222-2222-2222-2222-111111111111','prioridade_entrega', 1, 999, date_trunc('month', now())::date,
          '00000000-0000-0000-0000-00000000aaaa') RETURNING 'ACEITOU_LIXO';
ROLLBACK;
SQL
)"
eq "F1: SEM a constraint, R\$ fabricado em prioridade PASSARIA (dente provado)" \
   "$(echo "$F1" | grep -c 'ACEITOU_LIXO' || true)" "1"

# F2: sem a policy do cliente, o isolamento morre — dropa num SAVEPOINT e o alheio vê tudo.
F2="$(P -qtA <<'SQL'
BEGIN;
DROP POLICY prime_assinaturas_cliente_read ON public.prime_assinaturas;
SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-00000000bbbb';
SELECT count(*) FROM public.prime_assinaturas;
RESET ROLE;
ROLLBACK;
SQL
)"
eq "F2: SEM a policy cliente_read, o dono deixa de ver a própria assinatura (dente provado)" \
   "$(echo "$F2" | tail -1)" "0"

echo
echo "═══════════════════════════════════"
echo " PASS=$PASS FAIL=$FAIL"
echo "═══════════════════════════════════"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Dar permissão de execução e rodar (exit code SEM pipe)**

```bash
chmod +x db/test-prime-fundacao.sh
heavy bash db/test-prime-fundacao.sh > /tmp/prime-sql.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`. Conferir o log: `rg "PASS=|FAIL=|❌" /tmp/prime-sql.log` → `FAIL=0`, nenhum `❌`.

- [ ] **Step 3: Se algum assert falhar** — corrigir a MIGRATION (Task 1 ainda não foi aplicada em nenhum ambiente e o arquivo ainda não saiu do branch → pode ser emendada ANTES do push; depois do PR aberto, correção = arquivo novo). Repetir Step 2 até `FAIL=0`.

- [ ] **Step 4: Commit**

```bash
git add db/test-prime-fundacao.sh
git commit -m "test(prime): prova PG17 da fundação — RLS matriz, honestidade por CHECK, extrato, F1/F2 embutidas"
```

---

### Task 3: Falsificação externa (sabotar → vermelho → restaurar → verde)

**Files:**
- Modify (temporariamente, SEM commitar): `supabase/migrations/20260711090000_prime_fundacao.sql`

**Interfaces:**
- Consumes: harness da Task 2 (verde) e migration da Task 1.
- Produces: evidência textual (saída vermelha) para o corpo do PR — prova de que o harness morde a migration real, não um mundo paralelo.

- [ ] **Step 1: Commitar tudo ANTES de sabotar** (lição do repo: falsificação externa sem commit quase engoliu fix)

Run: `git status --porcelain` → Expected: vazio (working tree limpo).

- [ ] **Step 2: Sabotagem A — inverter a regra de honestidade**

```bash
sed -i '' "s/THEN valor_tabela IS NOT NULL AND valor_tabela > 0/THEN true/" supabase/migrations/20260711090000_prime_fundacao.sql
bash db/test-prime-fundacao.sh > /tmp/prime-falsif-a.log 2>&1; echo "exit=$?"
```
Expected: `exit=1` e `rg "❌" /tmp/prime-falsif-a.log` mostra os asserts de honestidade da zona 4 vermelhos ("afiacao_dentes SEM valor_tabela"). Se ficar VERDE, o harness não tem dente — pare e conserte o teste.

- [ ] **Step 3: Restaurar**

```bash
git checkout -- supabase/migrations/20260711090000_prime_fundacao.sql
```

- [ ] **Step 4: Sabotagem B — trocar o isolamento do cliente por `true`**

```bash
sed -i '' "s/USING (customer_user_id = auth.uid())/USING (true)/" supabase/migrations/20260711090000_prime_fundacao.sql
bash db/test-prime-fundacao.sh > /tmp/prime-falsif-b.log 2>&1; echo "exit=$?"
```
Expected: `exit=1` e o assert "cliente ALHEIO não vê assinatura de outro" vermelho no log.

- [ ] **Step 5: Restaurar e re-provar o verde final**

```bash
git checkout -- supabase/migrations/20260711090000_prime_fundacao.sql
heavy bash db/test-prime-fundacao.sh > /tmp/prime-sql-final.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`, `FAIL=0`. Guardar `PASS=N` para citar no PR. `git status --porcelain` vazio.

---

### Task 4: Artefatos do ritual lovable-db-operator

**Files:**
- Modify: `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` (regenerados por `bun run audit:migrations`)

**Interfaces:**
- Consumes: migration da Task 1.
- Produces: bloco de apply + query de validação pós-apply (vão no corpo do PR da Task 5, seção "Deploy manual").

- [ ] **Step 1: Regenerar o audit de migrations**

```bash
bun run audit:migrations
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(db): regenera audit de migrations (prime_fundacao)"
```
Nota: se este PR reconflitar no audit com outros merges da main (ímã de conflito conhecido), tomar a versão de `main` (`git checkout origin/main -- docs/migrations-audit.md scripts/audit-custom-migrations.sql`) em vez de regenerar de novo.

- [ ] **Step 2: Montar a query de validação pós-apply** (staff cola no SQL Editor DEPOIS do apply; deve retornar `4 | 3 | 6 | 2`)

```sql
SELECT
  (SELECT count(*) FROM (VALUES (to_regclass('public.prime_planos')), (to_regclass('public.prime_assinaturas')), (to_regclass('public.prime_beneficio_uso')), (to_regclass('public.v_prime_extrato_mensal'))) t(r) WHERE r IS NOT NULL) AS objetos,
  (SELECT count(*) FROM pg_class WHERE relname IN ('prime_planos','prime_assinaturas','prime_beneficio_uso') AND relrowsecurity) AS rls_ligada,
  (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%') AS policies,
  (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_prime_%' AND NOT tgisinternal) AS triggers;
```

Este bloco vai verbatim no corpo do PR (Step 2 da Task 5).

---

### Task 5: PR com nota de deploy manual + watch

**Files:**
- Nenhum novo (push + PR).

**Interfaces:**
- Consumes: commits das Tasks 1–4; contagem `PASS=N` da Task 3 Step 5.
- Produces: PR aberto no repo (auto-merge quando CI `validate` passar) + `scripts/pr-watch.sh` armado.

- [ ] **Step 1: Push do branch**

```bash
git push -u origin claude/amazon-prime-loyalty-brainstorm-43f604
```

- [ ] **Step 2: Criar o PR (título e corpo exatos; substituir N pelo PASS real)**

```bash
gh pr create --title "feat(prime): PR-1 fundação de dados — planos, assinaturas, uso de benefício, extrato honesto" --body "$(cat <<'EOF'
Fundação de dados do Prime Colacor (spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7; plano: docs/superpowers/plans/2026-07-11-prime-colacor-pr1-fundacao.md).

- 3 tabelas (`prime_planos`, `prime_assinaturas`, `prime_beneficio_uso`) + view `v_prime_extrato_mensal` (security_invoker), transação única.
- Honestidade money-path NO BANCO: `prime_uso_valor_por_tipo` — monetizável exige `valor_tabela > 0`; operacional/bônus exige `NULL` (ausente ≠ zero).
- Grandfathering: preço e franquia CONGELADOS na assinatura; 1 assinatura viva por cliente (UNIQUE parcial).
- RLS: staff ALL · cliente lê só o seu (inclusive na view) · anon nada.
- **Provado PG17** `db/test-prime-fundacao.sh`: N/0 asserts (matriz RLS staff/cliente/anon, SQLSTATE 23514/23505, extrato com bônus/franquia/mês-sem-uso) + falsificações F1/F2 embutidas + 2 falsificações externas executadas (constraint de honestidade e isolamento do cliente → vermelho com dente; logs `/tmp/prime-falsif-{a,b}.log`).

⚠️ **Migration manual** (Lovable não auto-aplica nome custom): colar `supabase/migrations/20260711090000_prime_fundacao.sql` no SQL Editor → Run. Validação pós-apply (deve retornar `4 | 3 | 6 | 2`):

```sql
SELECT
  (SELECT count(*) FROM (VALUES (to_regclass('public.prime_planos')), (to_regclass('public.prime_assinaturas')), (to_regclass('public.prime_beneficio_uso')), (to_regclass('public.v_prime_extrato_mensal'))) t(r) WHERE r IS NOT NULL) AS objetos,
  (SELECT count(*) FROM pg_class WHERE relname IN ('prime_planos','prime_assinaturas','prime_beneficio_uso') AND relrowsecurity) AS rls_ligada,
  (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%') AS policies,
  (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_prime_%' AND NOT tgisinternal) AS triggers;
```

Sem frontend/edge neste PR (PR-2: admin mínimo · PR-3: /prime extrato · PR-4: sync colacor_sc · PR-5: painel do piloto).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Armar o watch em background** (Bash `run_in_background: true`)

```bash
scripts/pr-watch.sh <número-do-PR>
```
No desfecho, avisar via PushNotification (mergeado/conflito/CI vermelho).

- [ ] **Step 4: Registrar a pendência de deploy** — o merge NÃO aplica a migration. Deixar explícito na mensagem final ao founder: apply manual no SQL Editor + validação (`4 | 3 | 6 | 2`) ANTES de qualquer PR seguinte depender das tabelas.
