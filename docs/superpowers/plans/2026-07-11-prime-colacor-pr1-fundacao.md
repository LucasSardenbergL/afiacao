# Prime Colacor PR-1 — Fundação de Dados — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a fundação de dados do programa Prime Colacor: catálogo de planos, assinaturas com grandfathering, registro de uso de benefício **append-only com contrafactual auditável**, e a view do extrato mensal honesto — provado em PG17 com falsificação, pronto para apply manual no Lovable.

**Architecture:** 3 tabelas + 1 view em migration transacional única (`supabase/migrations/`), RLS staff/cliente/anon, honestidade money-path ENFORÇADA no banco: monetizável exige `valor_tabela > 0` + `referencia` (lastro Omie); afiação amarra `valor_tabela = quantidade × preco_unitario_snapshot` (contrafactual auditável, não número solto); registro monetário é **append-only** (UPDATE só para estorno, DELETE sem policy); uso só em assinatura **ativa e dentro da vigência** (suspensa congela); ciclos por cliente **não sobrepõem competência**. View `security_invoker` expõe `mensalidade_contratada` (nunca "pagou" — não há fato de pagamento na v1), exclui estornados e expõe `dentes_excedentes`. Nenhum frontend neste PR.

**Tech Stack:** PostgreSQL (Supabase/Lovable Cloud, apply manual no SQL Editor), harness de prova PG17 local (`db/test-*.sh`, padrão do repo), bash.

## Global Constraints

- Idioma: código/comentários/commits em **pt-BR** (convenção do repo).
- Migration custom em `supabase/migrations/YYYYMMDDHHMMSS_slug.sql` **NÃO auto-aplica** no Lovable → PR precisa da nota "⚠️ migration manual" + bloco pro SQL Editor + query de validação (ritual `lovable-db-operator`).
- Migration commitada é **imutável** — correção pós-review = arquivo NOVO com timestamp novo. (Antes do push/PR, emendas no branch são permitidas.)
- Transação única (`BEGIN`/`COMMIT`) — o SQL Editor roda como script; erro no meio não pode deixar estado parcial.
- Money-path: **ausente ≠ zero** (nunca fabricar número); prova PG17 com asserts negativos por SQLSTATE + **falsificação** (sabotar → exigir vermelho) — ritual `prove-sql-money-path`.
- Tabela nova **sempre** com RLS; policies usam `public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)` (padrão do repo).
- Sem `GRANT` explícito na migration (o projeto Supabase já provê grants default a `authenticated`/`anon`; RLS é o gate).
- Comandos pesados prefixados com `heavy`; `cmd | tail` engole exit code → `> log 2>&1; echo $?`.
- Timestamp da migration deve ordenar DEPOIS da última da main (última vista: `20260710012337`).
- Datas de competência SEMPRE derivadas com `America/Sao_Paulo` (view, triggers E harness usam a MESMA expressão — virada de mês UTC≠SP é armadilha conhecida do repo).

## Fold do challenge Codex (xhigh, 2026-07-11) — registro de triagem

**Dobrados (mudaram este plano):** P1.1 contrafactual amarrado (`referencia` obrigatória em monetizável + `preco_unitario_snapshot` com CHECK `valor = quantidade × snapshot` na afiação) · P1.2 append-only (INSERT com `created_by = auth.uid()` no WITH CHECK; UPDATE só-estorno via trigger; DELETE sem policy) · P1.3 view expõe `mensalidade_contratada` (nunca "pagou" sem fato de pagamento; `prime_cobrancas` fica pro PR da cobrança) · P1.4 `suspensa_em` + trigger de vigência (uso só em assinatura ativa, competência dentro da vigência; view para de gerar mês após suspensão) · P1.5 trigger anti-sobreposição de ciclo (nova assinatura só em mês estritamente posterior ao fim da anterior) · P1.6 `dentes_excedentes` exposto na view · P1.7 UNIQUE parcial de bônus 1/mês + teto de 50 · P2.10 harness ganha negativos (cliente UPDATE/DELETE, staff sem role, anon na view, estorno, overfranchise) · P2.11 F2 refeita (prova que alheio VÊ com policy sabotada, não que dono perde) · P2.12 preflight `DO $$` de dependências · P3.13 CHECK de quantidade por tipo (dentes inteiros; evento = 1) · P3.14 asserts numéricos via comparação SQL + competência calculada em SP.

**Refutado com razão:** UNIQUE de `referencia` monetizável — um PV de afiação com N ferramentas legitimamente gera N linhas com a mesma referência; dedupe de concessão é responsabilidade do admin (PR-2) + painel.

**Deferidos documentados:** P2.8 chave por CNPJ (hoje `customer_user_id` É a identidade cliente no app; não existe vínculo multi-login por CNPJ na base — se surgir, migra a chave) · P2.9 `status_registro` pendente/confirmado (registro manual do staff JÁ É confirmado por definição na v1; entra junto do matcher automático v2 — o estorno cobre correção).

## Não-objetivos do PR-1 (do spec §7 — ficam pros PRs seguintes)

- Seed de plano piloto (preço final pendente de calibragem — staff cria via admin no PR-2 ou SQL manual).
- Telas (`/prime`, `/admin/prime`) — PR-2/PR-3.
- Sync colacor_sc — PR-4. Matcher automático de afiação (+ `status_registro`), cobrança real (`prime_cobrancas`) — v2/PRs posteriores.
- Chave canônica por CNPJ multi-login — deferida (ver Fold).

---

### Task 1: Migration `20260711090000_prime_fundacao.sql`

**Files:**
- Create: `supabase/migrations/20260711090000_prime_fundacao.sql`

**Interfaces:**
- Produces: tabelas `public.prime_planos`, `public.prime_assinaturas`, `public.prime_beneficio_uso`; view `public.v_prime_extrato_mensal` (coluna `mensalidade_contratada`, `dentes_excedentes`); funções-trigger `public.prime_assinatura_sem_sobreposicao()`, `public.prime_uso_vigencia()`, `public.prime_uso_so_estorno()`; índices `uq_prime_assinatura_viva`, `uq_prime_bonus_mes`. Nomes exatamente como no SQL abaixo — o harness (Task 2), a validação pós-apply (Task 4) e os PRs 2/3/5 referenciam esses nomes.

- [ ] **Step 1: Criar o arquivo da migration com o conteúdo integral**

```sql
-- Prime Colacor — PR-1: fundação de dados (planos, assinaturas, uso de benefício, extrato)
-- Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7
-- Plano (com fold do challenge Codex): docs/superpowers/plans/2026-07-11-prime-colacor-pr1-fundacao.md
--
-- Honestidade money-path ENFORÇADA no banco:
--  · monetizável exige valor_tabela > 0 E referencia (lastro Omie);
--  · afiação amarra valor_tabela = round(quantidade × preco_unitario_snapshot, 2)
--    (contrafactual auditável da época — nunca número solto);
--  · registro monetário é APPEND-ONLY: UPDATE só para estorno (trigger), DELETE sem policy;
--  · uso só em assinatura ATIVA e competência dentro da vigência (suspensa congela);
--  · ciclos do mesmo cliente não sobrepõem competência (extrato nunca duplica mês);
--  · a view fala "mensalidade_contratada" — NUNCA "pagou" (não há fato de pagamento na v1).
-- Transação única: o SQL Editor do Lovable roda como script — erro no meio não pode
-- deixar estado parcial.

BEGIN;

-- ── 0. Preflight: dependências que PROD precisa ter (falha CLARA, não erro ruim no meio) ──
DO $$
BEGIN
  IF to_regtype('public.app_role') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: tipo public.app_role não existe neste banco';
  END IF;
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: função public.has_role(uuid, app_role) não existe';
  END IF;
  IF to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: função public.update_updated_at_column() não existe';
  END IF;
END $$;

-- ── 1. Catálogo de planos ──
CREATE TABLE public.prime_planos (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text NOT NULL,
  preco_mensal numeric NOT NULL CHECK (preco_mensal > 0),
  franquia_dentes integer NOT NULL CHECK (franquia_dentes >= 0),
  -- Descritivo/copy dos benefícios (lista de strings). Staff é o único writer;
  -- NÃO é sinal money-path (o sinal vive em prime_beneficio_uso, coluna dedicada).
  beneficios jsonb NOT NULL DEFAULT '[]'::jsonb,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Assinaturas — 1 viva por cliente; preço e franquia CONGELADOS na adesão ──
-- (grandfathering do spec §5: mudar o catálogo NUNCA muda o contratado de quem já
--  assinou; mudança de condição = nova assinatura em novo ciclo)
CREATE TABLE public.prime_assinaturas (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  plano_id uuid NOT NULL REFERENCES public.prime_planos(id),
  preco_contratado numeric NOT NULL CHECK (preco_contratado > 0),
  franquia_dentes_contratada integer NOT NULL CHECK (franquia_dentes_contratada >= 0),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','suspensa','cancelada')),
  data_inicio date NOT NULL DEFAULT current_date,
  data_fim date CHECK (data_fim IS NULL OR data_fim >= data_inicio),
  -- Suspensão congela o extrato: a view para de gerar competências após este mês.
  -- Reativar = limpar suspensa_em (staff via admin, PR-2).
  suspensa_em date CHECK (suspensa_em IS NULL OR suspensa_em >= data_inicio),
  observacao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Estado amarrado às datas (review da Task 1): sem isto, 'cancelada' com data_fim
  -- NULL viraria 'infinity' na anti-sobreposição e bloquearia o cliente PARA SEMPRE;
  -- e suspensa_em solto (status ainda 'ativa') não congelaria nada.
  CONSTRAINT prime_assinatura_status_datas CHECK (
    CASE status
      WHEN 'ativa'     THEN data_fim IS NULL AND suspensa_em IS NULL
      WHEN 'suspensa'  THEN data_fim IS NULL AND suspensa_em IS NOT NULL
      WHEN 'cancelada' THEN data_fim IS NOT NULL
    END
  )
);
CREATE UNIQUE INDEX uq_prime_assinatura_viva
  ON public.prime_assinaturas (customer_user_id) WHERE status <> 'cancelada';

-- Ciclos do MESMO cliente nunca sobrepõem competência (senão o extrato mensal
-- duplicaria o mês). Nova assinatura só em mês estritamente posterior ao mês de
-- encerramento de QUALQUER assinatura anterior do cliente.
CREATE FUNCTION public.prime_assinatura_sem_sobreposicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.prime_assinaturas a
    WHERE a.customer_user_id = NEW.customer_user_id
      AND a.id <> NEW.id
      AND date_trunc('month', COALESCE(a.data_fim::timestamp, 'infinity'::timestamp))
          >= date_trunc('month', NEW.data_inicio::timestamp)
  ) THEN
    RAISE EXCEPTION 'cliente já tem assinatura cobrindo o mês de início (competência não pode duplicar no extrato)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
-- INSERT E UPDATE (review da Task 1): sem o UPDATE, staff editaria data_inicio/cliente
-- e furaria a garantia por fora do caminho de criação.
CREATE TRIGGER trg_prime_assinatura_sem_sobreposicao
  BEFORE INSERT OR UPDATE OF customer_user_id, data_inicio, data_fim, status
  ON public.prime_assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.prime_assinatura_sem_sobreposicao();

-- ── 3. Uso de benefício — APPEND-ONLY; contrafactual auditável por linha ──
-- Registro = CONCESSÃO dentro do programa (excedente de franquia é faturado normal no
-- Omie e não entra aqui — mas se registrado, a view EXPÕE o excedente, nunca esconde).
-- bonus_dentes é CRÉDITO de franquia (valor_tabela NULL) — monetiza só quando consumido
-- como afiacao_dentes. Correção de erro = ESTORNO (estornado_em/por), nunca edição.
CREATE TABLE public.prime_beneficio_uso (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assinatura_id uuid NOT NULL REFERENCES public.prime_assinaturas(id),
  tipo text NOT NULL CHECK (tipo IN
    ('afiacao_dentes','bonus_dentes','desconto_abrasivo','atendimento_tecnico',
     'prioridade_entrega','prioridade_separacao','coleta_rota')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  valor_tabela numeric,
  -- R$/dente vigente NA CONCESSÃO (só afiacao_dentes) — o contrafactual é auditável:
  -- valor_tabela = round(quantidade × preco_unitario_snapshot, 2), enforçado abaixo.
  preco_unitario_snapshot numeric,
  competencia date NOT NULL CHECK (competencia = (date_trunc('month', competencia))::date),
  referencia text,   -- nº do pedido/NF Omie que lastreia (OBRIGATÓRIO em monetizável)
  descricao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  estornado_em timestamptz,
  estornado_por uuid,
  -- Honestidade money-path NO BANCO (ausente ≠ zero):
  CONSTRAINT prime_uso_valor_por_tipo CHECK (
    CASE WHEN tipo IN ('afiacao_dentes','desconto_abrasivo')
         THEN valor_tabela IS NOT NULL AND valor_tabela > 0 AND referencia IS NOT NULL
         ELSE valor_tabela IS NULL END
  ),
  CONSTRAINT prime_uso_afiacao_consistente CHECK (
    tipo <> 'afiacao_dentes' OR (
      preco_unitario_snapshot IS NOT NULL AND preco_unitario_snapshot > 0
      AND valor_tabela = round(quantidade * preco_unitario_snapshot, 2)
    )
  ),
  CONSTRAINT prime_uso_snapshot_so_afiacao CHECK (
    tipo = 'afiacao_dentes' OR preco_unitario_snapshot IS NULL
  ),
  -- dentes são inteiros; evento operacional é unitário
  CONSTRAINT prime_uso_quantidade_por_tipo CHECK (
    CASE WHEN tipo IN ('afiacao_dentes','bonus_dentes') THEN quantidade = floor(quantidade)
         ELSE quantidade = 1 END
  ),
  -- bônus cross-sell: teto de 50 dentes por concessão (spec §5)
  CONSTRAINT prime_uso_bonus_teto CHECK (tipo <> 'bonus_dentes' OR quantidade <= 50),
  CONSTRAINT prime_uso_estorno_par CHECK ((estornado_em IS NULL) = (estornado_por IS NULL))
);
CREATE INDEX idx_prime_uso_assinatura_mes
  ON public.prime_beneficio_uso (assinatura_id, competencia);
-- bônus: no máximo 1 concessão VIVA por assinatura×mês (estornado libera re-conceder)
CREATE UNIQUE INDEX uq_prime_bonus_mes
  ON public.prime_beneficio_uso (assinatura_id, competencia)
  WHERE tipo = 'bonus_dentes' AND estornado_em IS NULL;

-- Vigência: uso só em assinatura ATIVA, competência entre o mês de início e o mês
-- corrente SP ("suspensa congela franquia" do spec §7 vira regra de banco).
CREATE FUNCTION public.prime_uso_vigencia() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT status, data_inicio, data_fim INTO a
    FROM public.prime_assinaturas WHERE id = NEW.assinatura_id;
  IF a.status IS NULL THEN
    RAISE EXCEPTION 'assinatura inexistente' USING ERRCODE = 'P0001';
  END IF;
  IF a.status <> 'ativa' THEN
    RAISE EXCEPTION 'assinatura % — uso bloqueado (suspensa/cancelada congela franquia)', a.status
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.competencia < date_trunc('month', a.data_inicio::timestamp)::date
     OR NEW.competencia > date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date
  THEN
    RAISE EXCEPTION 'competência fora da vigência da assinatura' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prime_uso_vigencia
  BEFORE INSERT ON public.prime_beneficio_uso
  FOR EACH ROW EXECUTE FUNCTION public.prime_uso_vigencia();

-- Append-only: UPDATE existe SÓ para estornar (nenhum outro campo pode mudar);
-- registro estornado é imutável; estornado_por = quem estorna (auth.uid()).
CREATE FUNCTION public.prime_uso_so_estorno() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.assinatura_id IS DISTINCT FROM OLD.assinatura_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.quantidade IS DISTINCT FROM OLD.quantidade
     OR NEW.valor_tabela IS DISTINCT FROM OLD.valor_tabela
     OR NEW.preco_unitario_snapshot IS DISTINCT FROM OLD.preco_unitario_snapshot
     OR NEW.competencia IS DISTINCT FROM OLD.competencia
     OR NEW.referencia IS DISTINCT FROM OLD.referencia
     OR NEW.descricao IS DISTINCT FROM OLD.descricao
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'registro monetário é append-only — correção é ESTORNO, nunca edição'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.estornado_em IS NOT NULL THEN
    RAISE EXCEPTION 'registro já estornado é imutável' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.estornado_em IS NULL OR NEW.estornado_por IS NULL
     OR NEW.estornado_por IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'estorno exige estornado_em e estornado_por = usuário autenticado'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prime_uso_so_estorno
  BEFORE UPDATE ON public.prime_beneficio_uso
  FOR EACH ROW EXECUTE FUNCTION public.prime_uso_so_estorno();

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

-- Uso: SEM policy de DELETE (RLS nega por default → append-only de verdade).
-- INSERT exige created_by = auth.uid() (staff não forja autor).
CREATE POLICY prime_uso_staff_select ON public.prime_beneficio_uso FOR SELECT
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_uso_staff_insert ON public.prime_beneficio_uso FOR INSERT
  WITH CHECK ((public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
              AND created_by = auth.uid());
CREATE POLICY prime_uso_staff_update ON public.prime_beneficio_uso FOR UPDATE
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_uso_cliente_read ON public.prime_beneficio_uso FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.prime_assinaturas a
                 WHERE a.id = assinatura_id AND a.customer_user_id = auth.uid()));

-- ── 4. Extrato mensal (security_invoker → herda a RLS das tabelas) ──
-- 1 linha por assinatura × mês desde data_inicio até LEAST(mês corrente SP, mês de
-- data_fim, mês de suspensa_em) — suspensão CONGELA o extrato. Estornados ficam FORA.
-- mensalidade_contratada é o contrato — NUNCA "pago" (não há fato de pagamento na v1).
-- monetizado_total NULL quando não há registro monetizável (≠ 0 fabricado); contagens
-- 0 são fato transacional. dentes_excedentes expõe estouro de franquia (nunca esconde).
CREATE VIEW public.v_prime_extrato_mensal
WITH (security_invoker = true) AS
WITH meses AS (
  SELECT a.id AS assinatura_id, a.customer_user_id, a.status,
         a.preco_contratado, a.franquia_dentes_contratada,
         generate_series(
           date_trunc('month', a.data_inicio::timestamp),
           LEAST(
             date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')),
             date_trunc('month', COALESCE(a.data_fim::timestamp,     'infinity'::timestamp)),
             date_trunc('month', COALESCE(a.suspensa_em::timestamp,  'infinity'::timestamp))
           ),
           interval '1 month'
         )::date AS competencia
  FROM public.prime_assinaturas a
), uso AS (
  SELECT assinatura_id, competencia,
         sum(valor_tabela) FILTER (WHERE tipo IN ('afiacao_dentes','desconto_abrasivo')) AS monetizado_total,
         sum(quantidade)   FILTER (WHERE tipo = 'afiacao_dentes')  AS dentes_usados,
         sum(quantidade)   FILTER (WHERE tipo = 'bonus_dentes')    AS dentes_bonus,
         -- bônus é CRÉDITO de franquia, não uso — fora da contagem operacional
         count(*)          FILTER (WHERE tipo NOT IN ('afiacao_dentes','desconto_abrasivo','bonus_dentes')) AS usos_operacionais,
         count(*) AS n_registros
  FROM public.prime_beneficio_uso
  WHERE estornado_em IS NULL
  GROUP BY assinatura_id, competencia
)
SELECT m.assinatura_id, m.customer_user_id, m.status, m.competencia,
       m.preco_contratado AS mensalidade_contratada,
       u.monetizado_total,
       u.dentes_usados,
       u.dentes_bonus,
       m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0) AS franquia_total,
       GREATEST(0::numeric,
         m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0)
         - COALESCE(u.dentes_usados, 0)) AS dentes_restantes,
       GREATEST(0::numeric,
         COALESCE(u.dentes_usados, 0)
         - (m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0))) AS dentes_excedentes,
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
git commit -m "feat(prime): migration da fundação — planos, assinaturas, uso append-only, extrato honesto (PR-1)"
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
# ║  3 tabelas (RLS staff/cliente/anon) + view extrato + honestidade por CHECK +  ║
# ║  append-only/estorno + vigência + anti-sobreposição. F1/F2 embutidas.         ║
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
eq "8 policies criadas (uso SEM policy de DELETE = append-only)" \
   "$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%'")" "8"
eq "5 triggers trg_prime_*" \
   "$(Pq -c "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_prime_%' AND NOT tgisinternal")" "5"

# Competências na MESMA TZ da view/triggers (virada de mês UTC≠SP é armadilha do repo)
MES_ATUAL="$(Pq -c "SELECT date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date")"
MES_PASSADO="$(Pq -c "SELECT (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) - interval '1 month')::date")"
MES_QUE_VEM="$(Pq -c "SELECT (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date")"

# ════════ ZONA 3 — seed: staff, 2 clientes, plano, assinatura ════════
P -q <<SQL
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
          '11111111-1111-1111-1111-111111111111', 99, 200, '${MES_PASSADO}',
          '00000000-0000-0000-0000-00000000aaaa');
SQL
ok "zona 3: seed (staff + plano ativo/inativo + assinatura do cliente B desde ${MES_PASSADO})"

# ════════ ZONA 4 — CHECKs/triggers de honestidade (negativos por SQLSTATE) ════════
expect_sqlstate() { # $1=nome $2=sqlstate esperada $3=sql
  # Sentinela com ERRCODE PRÓPRIO ('99999'): o default de RAISE EXCEPTION é P0001 —
  # o MESMO dos triggers da migration — e colidiria: guarda quebrada (SQL passa) →
  # sentinela P0001 → casaria com expectativa P0001 = PASS FALSO (achado do review T2).
  local got
  got="$(P -qtA -c "SET test.uid='00000000-0000-0000-0000-00000000aaaa'; DO \$\$ BEGIN $3; RAISE EXCEPTION 'NAO_FALHOU' USING ERRCODE = '99999'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE = '$2' THEN RAISE NOTICE 'SQLSTATE_OK'; ELSE RAISE; END IF; END \$\$;" 2>&1 | grep -c 'SQLSTATE_OK' || true)"
  eq "$1 (SQLSTATE $2)" "$got" "1"
}
A22='22222222-2222-2222-2222-111111111111'
UA='00000000-0000-0000-0000-00000000aaaa'

expect_sqlstate "afiacao SEM valor_tabela é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, NULL, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "afiacao com valor 0 é barrada (ausente ≠ zero)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 0, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "monetizável SEM referencia é barrado (lastro Omie obrigatório)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_ATUAL}', NULL, '$UA')"
expect_sqlstate "afiacao com valor ≠ quantidade×snapshot é barrada (contrafactual auditável)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 999.99, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "afiacao SEM snapshot de preço é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, NULL, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "snapshot em tipo não-afiacao é barrado" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','desconto_abrasivo', 1, 25, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "prioridade COM valor_tabela é barrada (não monetiza operacional)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','prioridade_entrega', 1, 10, '${MES_ATUAL}', '$UA')"
expect_sqlstate "bonus COM valor_tabela é barrado (crédito não monetiza)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 50, 60, '${MES_ATUAL}', '$UA')"
expect_sqlstate "dentes fracionados são barrados" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96.5, 115.80, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "evento operacional com quantidade≠1 é barrado" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 2, NULL, '${MES_ATUAL}', '$UA')"
expect_sqlstate "bonus acima de 50 dentes é barrado (teto do spec)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 60, NULL, '${MES_ATUAL}', '$UA')"
expect_sqlstate "competencia fora do dia 1 é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, ('${MES_ATUAL}'::date + 5), 'PV-X', '$UA')"
expect_sqlstate "competencia FUTURA é barrada (vigência)" "P0001" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_QUE_VEM}', 'PV-X', '$UA')"
expect_sqlstate "preco_mensal <= 0 é barrado" "23514" \
  "INSERT INTO public.prime_planos (nome, preco_mensal, franquia_dentes) VALUES ('x', 0, 100)"
expect_sqlstate "status inválido é barrado" "23514" \
  "UPDATE public.prime_assinaturas SET status='pausada' WHERE id='$A22'"
expect_sqlstate "cancelada SEM data_fim é barrada (senão bloqueia o cliente pra sempre)" "23514" \
  "UPDATE public.prime_assinaturas SET status='cancelada' WHERE id='$A22'"
expect_sqlstate "suspensa SEM suspensa_em é barrada" "23514" \
  "UPDATE public.prime_assinaturas SET status='suspensa' WHERE id='$A22'"
expect_sqlstate "ativa COM suspensa_em é barrada (estado amarrado às datas)" "23514" \
  "UPDATE public.prime_assinaturas SET suspensa_em = '${MES_ATUAL}' WHERE id='$A22'"
expect_sqlstate "2ª assinatura VIVA do mesmo cliente é barrada (UNIQUE parcial)" "23505" \
  "INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by) VALUES ('00000000-0000-0000-0000-00000000bbbb','11111111-1111-1111-1111-111111111111', 99, 200, '${MES_QUE_VEM}', '$UA')"

# ════════ ZONA 5 — uso real do mês (staff registra) + view + bônus/estorno ════════
P -q <<SQL
SET test.uid = '$UA';
-- mês corrente: serra 96 dentes (96×1,20 = R\$115,20), bônus cross-sell +50, 1 coleta
INSERT INTO public.prime_beneficio_uso (id, assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES
  ('33333333-3333-3333-3333-111111111111','$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_ATUAL}', 'PV-TESTE-1', '$UA');
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES
  ('$A22','bonus_dentes',   50, NULL, '${MES_ATUAL}', '$UA'),
  ('$A22','coleta_rota',     1, NULL, '${MES_ATUAL}', '$UA');
SQL
ok "zona 5: uso do mês registrado (96 dentes + bônus 50 + coleta)"

expect_sqlstate "2º bônus VIVO no mesmo mês é barrado (crédito não acumula por erro)" "23505" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 50, NULL, '${MES_ATUAL}', '$UA')"

eq "extrato tem 2 meses (início mês passado → corrente)" \
   "$(Pq -c "SELECT count(*) FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22'")" "2"
eq "mês corrente: monetizado = 115.20 (comparação SQL, não formato)" \
   "$(Pq -c "SELECT monetizado_total = 115.20 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "view expõe mensalidade_contratada = 99 (contrato, NUNCA 'pago')" \
   "$(Pq -c "SELECT mensalidade_contratada = 99 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: franquia_total = 250 (200 contratada + 50 bônus)" \
   "$(Pq -c "SELECT franquia_total = 250 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: dentes_restantes = 154 (250 − 96)" \
   "$(Pq -c "SELECT dentes_restantes = 154 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: 1 uso operacional (só a coleta; bônus NÃO conta)" \
   "$(Pq -c "SELECT usos_operacionais FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "1"
eq "mês passado (sem uso): monetizado é NULL (nunca 0 fabricado)" \
   "$(Pq -c "SELECT monetizado_total IS NULL FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_PASSADO}'")" "t"
eq "mês passado: n_registros = 0 (UI mostra 'sem uso registrado')" \
   "$(Pq -c "SELECT n_registros FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_PASSADO}'")" "0"

# — overfranchise: registrar 200 dentes a mais NÃO some — a view EXPÕE o excedente —
P -q <<SQL
SET test.uid = '$UA';
INSERT INTO public.prime_beneficio_uso (id, assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES
  ('33333333-3333-3333-3333-222222222222','$A22','afiacao_dentes', 200, 240.00, 1.20, '${MES_ATUAL}', 'PV-TESTE-2', '$UA');
SQL
eq "overfranchise: dentes_restantes = 0" \
   "$(Pq -c "SELECT dentes_restantes = 0 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "overfranchise: dentes_excedentes = 46 (296 − 250, exposto, nunca escondido)" \
   "$(Pq -c "SELECT dentes_excedentes = 46 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"

# — estorno: UPDATE só-estorno; view exclui estornado —
expect_sqlstate "editar VALOR de registro monetário é barrado (append-only)" "P0001" \
  "UPDATE public.prime_beneficio_uso SET valor_tabela = 1.00 WHERE id='33333333-3333-3333-3333-222222222222'"
P -q -c "SET test.uid='$UA'; UPDATE public.prime_beneficio_uso SET estornado_em = now(), estornado_por = '$UA' WHERE id='33333333-3333-3333-3333-222222222222';"
ok "estorno do registro de 200 dentes executado (staff)"
eq "pós-estorno: monetizado volta a 115.20 (estornado FORA da view)" \
   "$(Pq -c "SELECT monetizado_total = 115.20 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
expect_sqlstate "registro JÁ estornado é imutável" "P0001" \
  "UPDATE public.prime_beneficio_uso SET estornado_em = now(), estornado_por = '$UA' WHERE id='33333333-3333-3333-3333-222222222222'"

# F1 (falsificação embutida — roda AQUI, com a assinatura ainda ATIVA, senão o trigger
# de vigência barraria antes da constraint e a falsificação perderia o alvo): sem a
# constraint de honestidade, valor fabricado em operacional PASSARIA.
F1="$(P -qtA <<SQL
BEGIN;
SET test.uid = '$UA';
ALTER TABLE public.prime_beneficio_uso DROP CONSTRAINT prime_uso_valor_por_tipo;
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by)
  VALUES ('$A22','prioridade_entrega', 1, 999, '${MES_ATUAL}', '$UA') RETURNING 'ACEITOU_LIXO';
ROLLBACK;
SQL
)"
eq "F1: SEM a constraint, R\$ fabricado em prioridade PASSARIA (dente provado)" \
   "$(echo "$F1" | grep -c 'ACEITOU_LIXO' || true)" "1"

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
UD='00000000-0000-0000-0000-00000000dddd'  # logado SEM role nenhum

eq "staff lê a assinatura" "$(rls $UA "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente dono lê a própria assinatura" "$(rls $UB "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente ALHEIO não vê assinatura de outro" "$(rls $UC "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "logado SEM role não vê assinaturas" "$(rls $UD "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "anon não vê assinaturas" "$(rls '' "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "cliente dono lê o próprio uso (4 linhas, incl. estornada)" "$(rls $UB "SELECT count(*) FROM public.prime_beneficio_uso")" "4"
eq "cliente ALHEIO não vê uso de outro" "$(rls $UC "SELECT count(*) FROM public.prime_beneficio_uso")" "0"
eq "cliente vê o catálogo ATIVO (1 plano)" "$(rls $UB "SELECT count(*) FROM public.prime_planos")" "1"
eq "anon não vê catálogo" "$(rls '' "SELECT count(*) FROM public.prime_planos")" "0"
eq "cliente dono vê o próprio extrato (2 meses)" "$(rls $UB "SELECT count(*) FROM public.v_prime_extrato_mensal")" "2"
eq "cliente ALHEIO vê extrato vazio" "$(rls $UC "SELECT count(*) FROM public.v_prime_extrato_mensal")" "0"
eq "anon vê extrato vazio (view security_invoker)" "$(rls '' "SELECT count(*) FROM public.v_prime_extrato_mensal")" "0"
CLIENTE_INSERT="$(rls $UB "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UB') RETURNING 1" | grep -c '42501\|row-level security' || true)"
eq "cliente NÃO registra uso (writer único staff)" "$CLIENTE_INSERT" "1"
CLIENTE_UPDATE="$(rls $UB "UPDATE public.prime_beneficio_uso SET estornado_em=now(), estornado_por='$UB' WHERE assinatura_id='$A22' RETURNING 1" | grep -c 'RETURNING\|^1$' || true)"
eq "cliente NÃO estorna/edita uso (UPDATE 0 linhas sob RLS)" "$CLIENTE_UPDATE" "0"
CLIENTE_DELETE="$(rls $UB "DELETE FROM public.prime_beneficio_uso WHERE assinatura_id='$A22' RETURNING 1" | grep -c '^1$' || true)"
eq "cliente NÃO deleta uso" "$CLIENTE_DELETE" "0"
STAFF_DELETE="$(rls $UA "DELETE FROM public.prime_beneficio_uso WHERE assinatura_id='$A22' RETURNING 1" | grep -c '^1$' || true)"
eq "NEM STAFF deleta uso (sem policy de DELETE = append-only de verdade)" "$STAFF_DELETE" "0"
STAFF_FORJA="$(rls $UA "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UB') RETURNING 1" | grep -c '42501\|row-level security' || true)"
eq "staff NÃO forja created_by de outro (WITH CHECK created_by=auth.uid())" "$STAFF_FORJA" "1"

# ════════ ZONA 7 — ciclo de vida: suspensão congela; cancelar × sobreposição ════════
P -q <<SQL
SET test.uid = '$UA';
UPDATE public.prime_assinaturas SET status='suspensa', suspensa_em = '${MES_ATUAL}' WHERE id='$A22';
SQL
expect_sqlstate "uso em assinatura SUSPENSA é barrado (suspensa congela franquia)" "P0001" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UA')"
eq "extrato NÃO cresce após suspensa_em (2 meses, congelado)" \
   "$(Pq -c "SELECT count(*) FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22'")" "2"
P -q <<SQL
SET test.uid = '$UA';
UPDATE public.prime_assinaturas SET status='cancelada', data_fim = (now() AT TIME ZONE 'America/Sao_Paulo')::date WHERE id='$A22';
SQL
expect_sqlstate "nova assinatura no MESMO mês do fim da anterior é barrada (competência não duplica)" "P0001" \
  "INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by) VALUES ('$UB','11111111-1111-1111-1111-111111111111', 119, 200, '${MES_ATUAL}', '$UA')"
P -q <<SQL
SET test.uid = '$UA';
INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by)
  VALUES ('$UB','11111111-1111-1111-1111-111111111111', 119, 200, '${MES_QUE_VEM}', '$UA');
SQL
eq "nova assinatura no mês SEGUINTE passa (preço novo = ciclo novo, grandfathering)" \
   "$(Pq -c "SELECT count(*) FROM public.prime_assinaturas WHERE customer_user_id='$UB'")" "2"
expect_sqlstate "UPDATE que puxa o início pra mês já coberto é barrado (sobreposição via UPDATE)" "P0001" \
  "UPDATE public.prime_assinaturas SET data_inicio = '${MES_ATUAL}' WHERE customer_user_id='$UB' AND status='ativa'"
eq "updated_at avançou no UPDATE (trigger vivo)" \
   "$(Pq -c "SELECT updated_at > created_at FROM public.prime_assinaturas WHERE id='$A22'")" "t"

# ════════ ZONA 8 — FALSIFICAÇÃO EMBUTIDA F2 (F1 rodou no fim da zona 5) ════════
# F2: com a policy do cliente sabotada para USING(true), o ALHEIO passa a ver tudo.
F2="$(P -qtA <<SQL
BEGIN;
ALTER POLICY prime_assinaturas_cliente_read ON public.prime_assinaturas USING (true);
SET ROLE authenticated; SET test.uid='$UC';
SELECT count(*) FROM public.prime_assinaturas;
RESET ROLE;
ROLLBACK;
SQL
)"
eq "F2: policy sabotada p/ USING(true) → cliente ALHEIO vê 2 assinaturas (dente provado)" \
   "$(echo "$F2" | tail -1)" "2"

# F4 (meta-falsificação do HELPER): SQL que NÃO falha + expectativa P0001 tem que dar 0.
# Sem o ERRCODE '99999' no sentinela, o próprio sentinela (P0001 default) casaria com a
# expectativa e o helper daria PASS FALSO em guarda quebrada (achado do review T2).
META="$(P -qtA -c "DO \$\$ BEGIN PERFORM 1; RAISE EXCEPTION 'NAO_FALHOU' USING ERRCODE = '99999'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE = 'P0001' THEN RAISE NOTICE 'SQLSTATE_OK'; ELSE RAISE; END IF; END \$\$;" 2>&1 | grep -c 'SQLSTATE_OK' || true)"
eq "F4: helper NÃO aceita P0001 quando o SQL sob teste passa (sentinela não colide)" "$META" "0"

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
Expected: `exit=0`. Conferir: `rg "PASS=|FAIL=|❌" /tmp/prime-sql.log` → `FAIL=0`, nenhum `❌`.

- [ ] **Step 3: Se algum assert falhar** — corrigir a MIGRATION (ainda não saiu do branch → pode ser emendada ANTES do push; depois do PR aberto, correção = arquivo novo). Repetir Step 2 até `FAIL=0`.

- [ ] **Step 4: Commit**

```bash
git add db/test-prime-fundacao.sh
git commit -m "test(prime): prova PG17 da fundação — RLS matriz, append-only/estorno, vigência, honestidade, F1/F2"
```

---

### Task 3: Falsificação externa (sabotar → vermelho → restaurar → verde)

**Files:**
- Modify (temporariamente, SEM commitar): `supabase/migrations/20260711090000_prime_fundacao.sql`

**Interfaces:**
- Consumes: harness da Task 2 (verde) e migration da Task 1.
- Produces: evidência textual (saída vermelha) para o corpo do PR — prova de que o harness morde a migration real.

- [ ] **Step 1: Commitar tudo ANTES de sabotar** (lição do repo: falsificação externa sem commit quase engoliu fix)

Run: `git status --porcelain` → Expected: vazio.

- [ ] **Step 2: Sabotagem A — afrouxar o contrafactual da afiação**

```bash
sed -i '' "s/AND valor_tabela = round(quantidade \* preco_unitario_snapshot, 2)/AND true/" supabase/migrations/20260711090000_prime_fundacao.sql
bash db/test-prime-fundacao.sh > /tmp/prime-falsif-a.log 2>&1; echo "exit=$?"
```
Expected: `exit=1` e `rg "❌" /tmp/prime-falsif-a.log` mostra "afiacao com valor ≠ quantidade×snapshot" vermelho. Se ficar VERDE, o harness não tem dente — pare e conserte o teste.

- [ ] **Step 3: Restaurar**

```bash
git checkout -- supabase/migrations/20260711090000_prime_fundacao.sql
```

- [ ] **Step 4: Sabotagem B — trocar o isolamento do cliente por `true`**

```bash
sed -i '' "s/USING (customer_user_id = auth.uid())/USING (true)/" supabase/migrations/20260711090000_prime_fundacao.sql
bash db/test-prime-fundacao.sh > /tmp/prime-falsif-b.log 2>&1; echo "exit=$?"
```
Expected: `exit=1` e "cliente ALHEIO não vê assinatura de outro" vermelho no log.

- [ ] **Step 5: Restaurar e re-provar o verde final**

```bash
git checkout -- supabase/migrations/20260711090000_prime_fundacao.sql
heavy bash db/test-prime-fundacao.sh > /tmp/prime-sql-final.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`, `FAIL=0`. Guardar `PASS=N` para o PR. `git status --porcelain` vazio.

---

### Task 4: Artefatos do ritual lovable-db-operator

**Files:**
- Modify: `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` (regenerados por `bun run audit:migrations`)

**Interfaces:**
- Consumes: migration da Task 1.
- Produces: bloco de apply + query de validação pós-apply (vão no corpo do PR da Task 5).

- [ ] **Step 1: Regenerar o audit de migrations**

```bash
bun run audit:migrations
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(db): regenera audit de migrations (prime_fundacao)"
```
Nota: se este PR reconflitar no audit com outros merges (ímã de conflito conhecido), tomar a versão de `main` (`git checkout origin/main -- docs/migrations-audit.md scripts/audit-custom-migrations.sql`) em vez de regenerar.

- [ ] **Step 2: Query de validação pós-apply** (staff cola no SQL Editor DEPOIS do apply; deve retornar `4 | 3 | 8 | 5`)

```sql
SELECT
  (SELECT count(*) FROM (VALUES (to_regclass('public.prime_planos')), (to_regclass('public.prime_assinaturas')), (to_regclass('public.prime_beneficio_uso')), (to_regclass('public.v_prime_extrato_mensal'))) t(r) WHERE r IS NOT NULL) AS objetos,
  (SELECT count(*) FROM pg_class WHERE relname IN ('prime_planos','prime_assinaturas','prime_beneficio_uso') AND relrowsecurity) AS rls_ligada,
  (SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%') AS policies,
  (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_prime_%' AND NOT tgisinternal) AS triggers;
```

Este bloco vai verbatim no corpo do PR (Task 5).

---

### Task 5: PR com nota de deploy manual + watch

**Files:**
- Nenhum novo (push + PR).

**Interfaces:**
- Consumes: commits das Tasks 1–4; contagem `PASS=N` da Task 3 Step 5.
- Produces: PR aberto (auto-merge quando CI `validate` passar) + `scripts/pr-watch.sh` armado em background.

- [ ] **Step 1: Push do branch**

```bash
git push -u origin claude/amazon-prime-loyalty-brainstorm-43f604
```

- [ ] **Step 2: Criar o PR (título e corpo exatos; substituir N pelo PASS real)**

```bash
gh pr create --title "feat(prime): PR-1 fundação de dados — planos, assinaturas, uso append-only, extrato honesto" --body "$(cat <<'EOF'
Fundação de dados do Prime Colacor (spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7; plano com fold do challenge Codex xhigh: docs/superpowers/plans/2026-07-11-prime-colacor-pr1-fundacao.md).

- 3 tabelas (`prime_planos`, `prime_assinaturas`, `prime_beneficio_uso`) + view `v_prime_extrato_mensal` (security_invoker), transação única com preflight de dependências.
- Honestidade money-path NO BANCO: monetizável exige `valor_tabela > 0` + `referencia` (lastro Omie); afiação amarra `valor_tabela = quantidade × preco_unitario_snapshot` (contrafactual auditável); operacional/bônus exige `NULL` (ausente ≠ zero).
- Registro monetário **append-only**: UPDATE só-estorno (trigger), DELETE sem policy (nem staff), `created_by = auth.uid()` no WITH CHECK.
- Vigência no banco: uso só em assinatura ATIVA e competência dentro da vigência (suspensa CONGELA franquia e extrato); ciclos do mesmo cliente não sobrepõem competência (INSERT e UPDATE); status amarrado às datas (cancelada exige `data_fim` — sem isso a anti-sobreposição bloquearia o cliente pra sempre); bônus 1/mês com teto de 50.
- Grandfathering: preço e franquia congelados na assinatura; view expõe `mensalidade_contratada` (nunca "pagou" — não há fato de pagamento na v1) e `dentes_excedentes` (estouro nunca escondido).
- **Provado PG17** `db/test-prime-fundacao.sh`: N/0 asserts (RLS matriz staff/cliente/sem-role/anon incl. view, SQLSTATE 23514/23505/P0001, estorno, overfranchise, suspensão, sobreposição) + falsificações F1/F2 embutidas + 2 falsificações externas executadas (contrafactual e isolamento → vermelho com dente; logs `/tmp/prime-falsif-{a,b}.log`).

⚠️ **Migration manual** (Lovable não auto-aplica nome custom): colar `supabase/migrations/20260711090000_prime_fundacao.sql` no SQL Editor → Run. Validação pós-apply (deve retornar `4 | 3 | 8 | 5`):

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

- [ ] **Step 4: Registrar a pendência de deploy** — o merge NÃO aplica a migration. Mensagem final ao founder: apply manual no SQL Editor + validação (`4 | 3 | 8 | 5`) ANTES de qualquer PR seguinte depender das tabelas.
