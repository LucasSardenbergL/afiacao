# `sales_history_status` — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para executar tarefa-a-tarefa. Os steps usam checkbox (`- [ ]`).
>
> **Money-path.** Skills obrigatórias por tarefa: `prove-sql-money-path` (T3), `lovable-db-operator` (T2/T3 handoff), `lovable-deploy-verify` (T15). Idioma pt-BR. Spec: [docs/superpowers/specs/2026-06-20-sales-history-status-design.md](../specs/2026-06-20-sales-history-status-design.md) (v2, Codex incorporado).

**Goal:** Propagar um `sales_history_status` ('sem_historico'|'stale'|'ativo'|NULL) de `farmer_client_scores` para UI/agenda/plano/dashboards, para que o farmer não trate o health baixo de quem **nunca comprou** como saúde ruim — sem fabricar número (ausente≠zero no output).

**Architecture:** Helper puro testado (`src/lib/scoring/salesHistoryStatus.ts`) espelhado inline no edge `calculate-scores`, que deriva o status do snapshot `get_customer_sales_summary` e persiste via RPC `apply_score_updates` **estendida com COALESCE** (deploy bidirecional-seguro, fora do guard das 13 obrigatórias). Leitura propaga por hooks; a "verdade visual" aparece em lista/perfil/semáforo/dashboards; a agenda ganha um `agenda_type:'ativacao'` com guard de slot; o plano (e seu edge LLM) recebem o status. **Nenhum churn/priority persistido é tocado** — o guard da agenda é read-time.

**Tech Stack:** React 18 + TS strict (vitest), Supabase Postgres (migration SQL + PL/pgSQL), Deno edge functions. Testes: `bun run test` (vitest, canônico), `bun run typecheck`, `prove-sql-money-path` (PG17 local).

**Verdades de prod confirmadas (psql-ro, 2026-06-21):**
- RPC real = versão **#987** (13 chaves obrigatórias + GUARD `RAISE EXCEPTION check_violation` que **aborta o lote** se faltar campo). A migration do repo (`20260618200000`, 9 campos) está **desatualizada** → **partir do texto de prod**, não do repo (senão deleta a recência-viva).
- Coluna `sales_history_status` **não existe** ainda; `farmer_algorithm_config` = (`key text NOT NULL`, `value numeric NOT NULL`, `description text`).
- `signal_modifiers` vazio em 100% da base → nudge=0 → prioridade efetiva = base.

---

## FASE A — Núcleo (dado · derivação · persistência)

### Task 1: Helper puro `salesHistoryStatus.ts` (+ vitest + falsificação)

**Files:**
- Create: `src/lib/scoring/salesHistoryStatus.ts`
- Test: `src/lib/scoring/__tests__/salesHistoryStatus.test.ts`

- [ ] **Step 1: Escrever os testes (espelha o padrão de `salesBase.test.ts`)**

```typescript
import { describe, it, expect } from 'vitest';
import { deriveSalesHistoryStatus, clampActiveDays } from '../salesHistoryStatus';

describe('clampActiveDays', () => {
  it('NaN/null/undefined → 180 (default)', () => {
    expect(clampActiveDays(NaN)).toBe(180);
    expect(clampActiveDays(null)).toBe(180);
    expect(clampActiveDays(undefined)).toBe(180);
  });
  it('abaixo do piso → 30; acima do teto → 999; fração → round', () => {
    expect(clampActiveDays(10)).toBe(30);
    expect(clampActiveDays(5000)).toBe(999);
    expect(clampActiveDays(90.4)).toBe(90);
  });
});

describe('deriveSalesHistoryStatus (degradação honesta — ausente≠zero)', () => {
  it('ausente (undefined/null) → sem_historico', () => {
    expect(deriveSalesHistoryStatus(undefined)).toBe('sem_historico');
    expect(deriveSalesHistoryStatus(null)).toBe('sem_historico');
  });
  it('revenue 0 ou negativo → sem_historico (sem venda válida, NÃO "nunca comprou")', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 0, days_since_last_purchase: 5 })).toBe('sem_historico');
    expect(deriveSalesHistoryStatus({ total_revenue: -10, days_since_last_purchase: 5 })).toBe('sem_historico');
  });
  it('revenue>0 e days ≤ cap → ativo', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 180 })).toBe('ativo');
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 0 })).toBe('ativo');
  });
  it('revenue>0 e days > cap → stale', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 181 })).toBe('stale');
  });
  it('ANÓMALO: revenue>0 e days null → stale explícito (não comparação falsa)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: null })).toBe('stale');
  });
  it('numeric-string do PG → coage (revenue e days)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: ('900' as unknown as number), days_since_last_purchase: ('12' as unknown as number) })).toBe('ativo');
  });
  it('NaN em revenue → sem_historico (Number.isFinite guard)', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: Number('xx'), days_since_last_purchase: 5 })).toBe('sem_historico');
  });
  it('cap custom: days=120 com cap 90 → stale; com cap 180 → ativo', () => {
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 120 }, 90)).toBe('stale');
    expect(deriveSalesHistoryStatus({ total_revenue: 100, days_since_last_purchase: 120 }, 180)).toBe('ativo');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test src/lib/scoring/__tests__/salesHistoryStatus.test.ts`
Expected: FAIL — "Cannot find module '../salesHistoryStatus'".

- [ ] **Step 3: Implementar o helper**

```typescript
/**
 * Deriva o STATUS DE HISTÓRICO DE VENDAS do cliente a partir do snapshot da RPC
 * `get_customer_sales_summary`, com degradação HONESTA (money-path: "ausente ≠ zero" no OUTPUT).
 *
 * Semântica precisa (NÃO é "nunca comprou"): `sem_historico` = "sem venda VÁLIDA monetizada no
 * resumo". A RPC agrega `order_items` com customer_user_id, blocklist de status e deleted_at IS NULL
 * — pedido sem item / receita ≤0 / devolução / status novo caem em `sem_historico`. Label de UI:
 * "Sem histórico".
 *
 * Função PURA (vitest). Espelhada inline no edge `calculate-scores` (Deno não importa de `src/`).
 * `clampActiveDays` é PRÓPRIO deste helper (não importa de recency.ts — frente paralela do cap).
 */
export type SalesHistoryStatus = 'sem_historico' | 'stale' | 'ativo';

export interface SalesStatusInput {
  total_revenue: number | null;
  days_since_last_purchase: number | null;
}

const DEFAULT_ACTIVE_DAYS = 180;

/** Clamp do limiar de "ativo" (dias). NaN/ausente → 180; piso 30, teto 999; arredonda. */
export function clampActiveDays(raw: number | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ACTIVE_DAYS;
  return Math.min(999, Math.max(30, Math.round(n)));
}

export function deriveSalesHistoryStatus(
  sales: SalesStatusInput | null | undefined,
  activeThresholdDays: number = DEFAULT_ACTIVE_DAYS,
): SalesHistoryStatus {
  const cap = clampActiveDays(activeThresholdDays);
  // sem venda válida monetizada → sem_historico (ausente≠zero: não fabrica recência)
  const revenue = sales ? Number(sales.total_revenue ?? 0) : 0;
  if (!Number.isFinite(revenue) || revenue <= 0) return 'sem_historico';
  // tem receita mas SEM data de compra → anômalo; conservador e EXPLÍCITO: stale (não comparação falsa)
  const daysRaw = sales ? sales.days_since_last_purchase : null;
  const days = Number(daysRaw);
  if (daysRaw == null || !Number.isFinite(days)) return 'stale';
  return days <= cap ? 'ativo' : 'stale';
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test src/lib/scoring/__tests__/salesHistoryStatus.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: FALSIFICAR (exigir vermelho)**

Edite temporariamente o helper: troque `days <= cap` por `days < cap`.
Run: `bun run test src/lib/scoring/__tests__/salesHistoryStatus.test.ts`
Expected: FAIL no caso `days_since_last_purchase: 180 → ativo` (fronteira). **Reverta** a sabotagem e rode de novo → PASS. (Prova que o teste pega a fronteira.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/scoring/salesHistoryStatus.ts src/lib/scoring/__tests__/salesHistoryStatus.test.ts
git commit -m "feat(scoring): helper puro deriveSalesHistoryStatus (vitest + falsificação)"
```

---

### Task 2: Migration — coluna `sales_history_status` + CHECK + config

**Files:**
- Create: `supabase/migrations/20260621120000_sales_history_status_coluna.sql`

**Skill:** invoque `lovable-db-operator` (gera o arquivo + bloco do SQL Editor + query de validação + nota de PR + regenera o audit). O conteúdo SQL:

- [ ] **Step 1: Escrever a migration**

```sql
-- ============================================================================
-- sales_history_status: degradação honesta do health (ausente≠zero no OUTPUT).
-- text NULL + CHECK. NULL = "ainda não computado" → a UI se comporta como hoje
-- (NÃO esconde health, NÃO assume sem_historico). Espelha health_class (text, sem enum).
-- + config próprio sales_active_threshold_days (desacoplado de hs_recency_cap_days).
-- Spec: docs/superpowers/specs/2026-06-20-sales-history-status-design.md
-- ============================================================================
ALTER TABLE public.farmer_client_scores
  ADD COLUMN IF NOT EXISTS sales_history_status text;

ALTER TABLE public.farmer_client_scores
  DROP CONSTRAINT IF EXISTS farmer_client_scores_sales_history_status_check;
ALTER TABLE public.farmer_client_scores
  ADD CONSTRAINT farmer_client_scores_sales_history_status_check
  CHECK (sales_history_status IS NULL OR sales_history_status IN ('sem_historico','stale','ativo'));

-- config próprio (value é numeric NOT NULL). WHERE NOT EXISTS = idempotente sem depender de UNIQUE(key).
INSERT INTO public.farmer_algorithm_config (key, value, description)
SELECT 'sales_active_threshold_days', 180,
       'Limiar (dias) p/ sales_history_status ativo vs stale — desacoplado de hs_recency_cap_days'
WHERE NOT EXISTS (
  SELECT 1 FROM public.farmer_algorithm_config WHERE key = 'sales_active_threshold_days'
);
```

- [ ] **Step 2: Validação pós-apply (cole no SQL Editor após o founder aplicar)**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='farmer_client_scores' AND column_name='sales_history_status') AS col_existe,      -- =1
  (SELECT count(*) FROM information_schema.check_constraints
     WHERE constraint_name='farmer_client_scores_sales_history_status_check')        AS check_existe,    -- =1
  (SELECT value FROM public.farmer_algorithm_config WHERE key='sales_active_threshold_days') AS limiar;   -- =180
```

- [ ] **Step 3: Commit (arquivo + audit regenerado pela skill)**

```bash
git add supabase/migrations/20260621120000_sales_history_status_coluna.sql docs/
git commit -m "feat(db): coluna sales_history_status + CHECK + config sales_active_threshold_days"
```

> **Apply é manual** (founder cola no SQL Editor do Lovable). A coluna NÃO entra em vigor por merge. Ordem de deploy: §T15.

---

### Task 3: Migration — RPC `apply_score_updates` v2 (COALESCE, fora do guard)

**Files:**
- Create: `supabase/migrations/20260621120100_apply_score_updates_sales_history_status.sql`

**Skills:** `prove-sql-money-path` (PG17 local + falsificação) ANTES de entregar; `lovable-db-operator` para o handoff.

> ⚠️ **PARTIR DO TEXTO DE PROD #987** (capturado via `pg_get_functiondef`), não da migration `20260618200000` do repo (que tem só 9 campos — recriar a partir dela DELETARIA a recência-viva). `sales_history_status` entra **só no recordset do UPDATE + COALESCE**, **NÃO** no guard das 13 obrigatórias (senão o edge antigo, que não envia o campo, dispara `RAISE EXCEPTION` e aborta TODO o recompute).

- [ ] **Step 1: Escrever a migration (recria a função preservando o guard #987 + 13 campos, adicionando a 14ª opcional)**

```sql
-- ============================================================================
-- apply_score_updates v2 (#987 + sales_history_status). Money-path · anti-ressurreição.
-- Estende a v#987 (UPDATE-only por id, guard full-update das 13 chaves) com a 14ª chave
-- sales_history_status — OPCIONAL e COALESCE (preserva-se-ausente) → deploy bidirecional-seguro:
--   edge ANTIGO (não envia) + RPC nova  → COALESCE preserva o valor atual (NÃO apaga em massa)
--   edge novo + RPC ANTIGA              → chave ignorada (sem erro); status só persiste pós-apply
--   edge novo + RPC nova                → atualiza
-- O guard das 13 é PRESERVADO intacto (sales_history_status fica FORA dele): o edge antigo
-- continua válido. Pré-flight pg_get_functiondef da prod antes do apply (a última recriação vence).
-- Provado em PG17 + falsificação: prove-sql-money-path.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_total int;
  v_valid int;
BEGIN
  -- ── GUARD DE CONTRATO (full-update only): as 13 chaves CORE são obrigatórias em TODA linha ──
  -- sales_history_status NÃO entra aqui (é opcional/COALESCE) → edge antigo segue válido.
  v_total := jsonb_array_length(p_updates);

  SELECT count(*) INTO v_valid
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE id                       IS NOT NULL
    AND health_score             IS NOT NULL
    AND health_class             IS NOT NULL
    AND churn_risk               IS NOT NULL
    AND priority_score           IS NOT NULL
    AND rf_score                 IS NOT NULL
    AND m_score                  IS NOT NULL
    AND g_score                  IS NOT NULL
    AND days_since_last_purchase IS NOT NULL
    AND avg_monthly_spend_180d   IS NOT NULL
    AND category_count           IS NOT NULL
    AND calculated_at            IS NOT NULL
    AND updated_at               IS NOT NULL;

  IF v_valid <> v_total THEN
    RAISE EXCEPTION
      'apply_score_updates: contrato full-update violado — % de % elemento(s) com campo obrigatorio nulo/ausente (as 13 chaves sao obrigatorias; jsonb_to_recordset nao faz COALESCE)',
      (v_total - v_valid), v_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── UPDATE-only por id (anti-ressurreição #971), base de vendas (#987) + sales_history_status (COALESCE) ──
  UPDATE public.farmer_client_scores f SET
    health_score             = u.health_score,
    health_class             = u.health_class,
    churn_risk               = u.churn_risk,
    priority_score           = u.priority_score,
    rf_score                 = u.rf_score,
    m_score                  = u.m_score,
    g_score                  = u.g_score,
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,
    category_count           = u.category_count,
    sales_history_status     = COALESCE(u.sales_history_status, f.sales_history_status),
    calculated_at            = u.calculated_at,
    updated_at               = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id                       uuid,
    health_score             numeric,
    health_class             text,
    churn_risk               numeric,
    priority_score           numeric,
    rf_score                 numeric,
    m_score                  numeric,
    g_score                  numeric,
    days_since_last_purchase integer,
    avg_monthly_spend_180d   numeric,
    category_count           integer,
    sales_history_status     text,
    calculated_at            timestamptz,
    updated_at               timestamptz
  )
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL    ON FUNCTION public.apply_score_updates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO service_role;
```

- [ ] **Step 2: Provar em PG17 (prove-sql-money-path) — asserts + falsificação**

Invoque `prove-sql-money-path`. O harness deve:
1. Aplicar a migration da coluna (T2) + esta RPC sobre um `farmer_client_scores` semeado.
2. **Assert COALESCE preserva:** linha com `sales_history_status='ativo'`; enviar update SEM a chave `sales_history_status` (mas com as 13 core) → a RPC retorna 1 e a linha **mantém** `'ativo'` (não vira NULL).
3. **Assert atualiza:** enviar com `sales_history_status='stale'` → linha vira `'stale'`.
4. **Assert null explícito preserva:** linha `'ativo'`, enviar `sales_history_status: null` → mantém `'ativo'`.
5. **Assert guard intacto:** enviar uma linha faltando `health_class` (core) → `RAISE check_violation` (SQLSTATE 23514), capturada e re-lançada.
6. **Assert grant:** `has_function_privilege('authenticated', ..., 'EXECUTE')` = false.
7. **FALSIFICAR:** trocar `COALESCE(u.sales_history_status, f.sales_history_status)` por `u.sales_history_status` → o assert (2) deve virar VERMELHO (apaga). Reverter.

- [ ] **Step 3: Validação pós-apply (SQL Editor)**

```sql
SELECT pg_get_functiondef('public.apply_score_updates(jsonb)'::regprocedure) LIKE '%COALESCE(u.sales_history_status%' AS tem_coalesce,  -- t
  has_function_privilege('authenticated','public.apply_score_updates(jsonb)','EXECUTE') AS exec_auth;  -- f
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260621120100_apply_score_updates_sales_history_status.sql docs/
git commit -m "feat(db): apply_score_updates v2 — sales_history_status com COALESCE (deploy bidirecional-seguro)"
```

---

### Task 4: Edge `calculate-scores` — derivar + persistir o status

**Files:**
- Modify: `supabase/functions/calculate-scores/index.ts` (helper inline; `FarmerClientScoreSeed:50`; `ScoreUpdate:73`; config `:160`; seed `:328`; compute/push `:510`)

- [ ] **Step 1: Adicionar o helper inline (espelho de `salesHistoryStatus.ts`) após `deriveSalesBase` (depois da linha 132)**

```typescript
// Espelho inline de src/lib/scoring/salesHistoryStatus.ts (vitest; Deno não importa de src/).
// Money-path: "ausente ≠ zero" no OUTPUT. sem_historico = sem venda válida monetizada no resumo.
function clampActiveDays(raw: number | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 180;
  return Math.min(999, Math.max(30, Math.round(n)));
}
function deriveSalesHistoryStatus(
  sales: CustomerSalesSummaryRow | null | undefined,
  activeThresholdDays: number,
): 'sem_historico' | 'stale' | 'ativo' {
  const cap = clampActiveDays(activeThresholdDays);
  const revenue = sales ? Number(sales.total_revenue ?? 0) : 0;
  if (!Number.isFinite(revenue) || revenue <= 0) return 'sem_historico';
  const daysRaw = sales ? sales.days_since_last_purchase : null;
  const days = Number(daysRaw);
  if (daysRaw == null || !Number.isFinite(days)) return 'stale';
  return days <= cap ? 'ativo' : 'stale';
}
```

- [ ] **Step 2: Ler o config do limiar (após o bloco `ps_w`, depois da linha 176)**

```typescript
    const salesActiveDays = config['sales_active_threshold_days'] ?? 180;
```

- [ ] **Step 3: Adicionar `sales_history_status` ao seed — interface `FarmerClientScoreSeed` (após `eff_score: number;` na linha 70) e ao registro (após `eff_score: 0,` na linha 348)**

Interface (linha 70 → adicionar antes do `}`):
```typescript
  eff_score: number;
  sales_history_status: 'sem_historico' | 'stale' | 'ativo';
```

Registro do seed (no `seedRecords.push({...})`, após `eff_score: 0,`):
```typescript
      eff_score: 0,
      sales_history_status: deriveSalesHistoryStatus(salesMap.get(client.user_id), salesActiveDays),
```

- [ ] **Step 4: Adicionar `sales_history_status` ao `ScoreUpdate` (interface, após `category_count: number;` na linha 92)**

```typescript
  category_count: number;
  // OPCIONAL na RPC (COALESCE, fora do guard das 13): null quando salesRefreshFatal → preserva o atual.
  sales_history_status: 'sem_historico' | 'stale' | 'ativo' | null;
```

- [ ] **Step 5: Derivar e enviar no compute loop — no `updates.push({...})` (após `category_count: client.category_count ?? 0,` na linha 526)**

```typescript
        category_count: client.category_count ?? 0,
        // salesRefreshFatal → null → a RPC (COALESCE) preserva o valor atual (não fabrica por RPC ausente).
        sales_history_status: salesRefreshFatal ? null : deriveSalesHistoryStatus(salesMap.get(client.customer_user_id), salesActiveDays),
```

- [ ] **Step 6: Verificar tipos do edge (Deno)**

Run: `cd supabase/functions && deno check calculate-scores/index.ts`
Expected: sem erros. (Se `deno` não estiver disponível localmente, registrar e validar no deploy.)

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/calculate-scores/index.ts
git commit -m "feat(edge): calculate-scores deriva e persiste sales_history_status (degrada p/ null em RPC-falha)"
```

> **Deploy do edge é manual** (chat do Lovable, verbatim do repo). Ordem: §T15.

---

## FASE B — Propagação (leitura · tipos)

### Task 5: `agenda.ts` — `agenda_type:'ativacao'` + guard de slot (tie-break)

**Files:**
- Modify: `src/lib/scoring/agenda.ts` (`CarteiraRow:21`, `AgendaItem:30`, `buildAgendaItems:100`)
- Test: `src/lib/scoring/__tests__/agenda.test.ts`

- [ ] **Step 1: Escrever os testes novos (append ao describe existente)**

```typescript
  it('sem_historico NÃO vira risco mesmo com churn alto/health crítico → agenda_type "ativacao"', () => {
    const items = buildAgendaItems([
      { customer_user_id: 'a', priority_score: 40, churn_risk: 95, expansion_score: 0, health_class: 'critico', signal_modifiers: null, sales_history_status: 'sem_historico' },
    ]);
    expect(items[0].agenda_type).toBe('ativacao');
  });

  it('guard de slot: em prioridade igual, recuperação (risco) vem ANTES de ativação', () => {
    const items = buildAgendaItems([
      { customer_user_id: 'novo', priority_score: 50, churn_risk: 0, expansion_score: 0, health_class: 'novo', signal_modifiers: null, sales_history_status: 'sem_historico' },
      { customer_user_id: 'risco', priority_score: 50, churn_risk: 80, expansion_score: 0, health_class: 'critico', signal_modifiers: null, sales_history_status: 'stale' },
    ], 1);
    expect(items[0].customer_user_id).toBe('risco');
    expect(items[0].agenda_type).toBe('risco');
  });

  it('ativo/stale mantêm a classificação atual (risco/expansao/follow_up)', () => {
    const items = buildAgendaItems([
      { customer_user_id: 'x', priority_score: 30, churn_risk: 70, expansion_score: 0, health_class: 'estavel', signal_modifiers: null, sales_history_status: 'ativo' },
    ]);
    expect(items[0].agenda_type).toBe('risco');
  });
```

> Atualize também os mocks existentes em `agenda.test.ts` para incluir `sales_history_status` (ex.: `sales_history_status: 'ativo'`) — o campo é obrigatório em `CarteiraRow`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test src/lib/scoring/__tests__/agenda.test.ts`
Expected: FAIL (campo `sales_history_status` ausente no tipo / `'ativacao'` não existe).

- [ ] **Step 3: Editar `agenda.ts`**

`CarteiraRow` (após `signal_modifiers: ScoreAdjustment | null;` linha 27):
```typescript
  signal_modifiers: ScoreAdjustment | null;
  sales_history_status: string | null;
```

`AgendaItem.agenda_type` (linha 37):
```typescript
  agenda_type: 'risco' | 'expansao' | 'ativacao' | 'follow_up';
```

`buildAgendaItems` — no `.map`, substituir o bloco de derivação do `agenda_type` (linhas 106-111) por (precedência de `sem_historico`):
```typescript
      let agenda_type: AgendaItem['agenda_type'] = 'follow_up';
      if (s.sales_history_status === 'sem_historico') {
        agenda_type = 'ativacao';
      } else if (churn > 50 || s.health_class === 'critico' || s.health_class === 'atencao') {
        agenda_type = 'risco';
      } else if (expansion > 50) {
        agenda_type = 'expansao';
      }
```

E substituir o `.sort(...)` (linha 122) pelo tie-break que rebaixa ativação (guard de slot — recuperação real ganha o slot em prioridade igual):
```typescript
    .sort((a, b) => {
      const pd = b.priority_score - a.priority_score;
      if (pd !== 0) return pd;
      // guard de slot: ativação (sem_historico) nunca rouba a vaga de um item com histórico em empate
      const rank = (t: AgendaItem['agenda_type']) => (t === 'ativacao' ? 1 : 0);
      return rank(a.agenda_type) - rank(b.agenda_type);
    })
```

Atualize também o doc-comment de `buildAgendaItems` (linha 93-99) para mencionar `'ativacao'`.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test src/lib/scoring/__tests__/agenda.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scoring/agenda.ts src/lib/scoring/__tests__/agenda.test.ts
git commit -m "feat(scoring): agenda_type 'ativacao' p/ sem_historico + guard de slot (tie-break)"
```

---

### Task 6: `useMyCarteiraScores.ts` — trazer o campo (alimenta a agenda)

**Files:**
- Modify: `src/hooks/useMyCarteiraScores.ts` (`CarteiraScoreRow:8`, `.select(...):50`)

- [ ] **Step 1: Adicionar ao shape `CarteiraScoreRow` (após `signal_modifiers: ScoreAdjustment | null;` linha 18)**

```typescript
  signal_modifiers: ScoreAdjustment | null;
  sales_history_status: string | null;
```

- [ ] **Step 2: Adicionar ao `.select(...)` (linha 50) — incluir `sales_history_status` na string**

De:
```typescript
      .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, last_signal_recalc_at')
```
Para (adicionar `, sales_history_status` antes de `, last_signal_recalc_at`):
```typescript
      .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, expansion_score, recover_score, revenue_potential, days_since_last_purchase, avg_monthly_spend_180d, signal_modifiers, sales_history_status, last_signal_recalc_at')
```

- [ ] **Step 3: Verificar tipos (o resultado alimenta `buildAgendaItems` via `useMyAgendaToday`)**

Run: `bun run typecheck`
Expected: sem erros. (`CarteiraScoreRow` agora satisfaz `CarteiraRow` em `useMyAgendaToday.ts:20`.)

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useMyCarteiraScores.ts
git commit -m "feat(scoring): useMyCarteiraScores traz sales_history_status p/ a agenda"
```

---

### Task 7: `fetchScoresPorCustomer` + `ClientScore` (lista admin)

**Files:**
- Modify: `src/lib/carteira/escopo-clientes.ts` (`fetchScoresPorCustomer:165`)
- Modify: `src/components/adminCustomers/types.ts` (`ClientScore:33`)

- [ ] **Step 1: `ClientScore` (types.ts) — adicionar o campo (após `avg_repurchase_interval?: number | null;` linha 44)**

```typescript
  avg_repurchase_interval?: number | null;
  sales_history_status: string | null;
```

- [ ] **Step 2: `fetchScoresPorCustomer` — select (linha 171) + map.set (linha 177)**

Select — adicionar `, sales_history_status`:
```typescript
      .select('customer_user_id, health_score, health_class, churn_risk, expansion_score, priority_score, avg_monthly_spend_180d, days_since_last_purchase, category_count, gross_margin_pct, avg_repurchase_interval, sales_history_status')
```

`map.set` (após `gross_margin_pct: s.gross_margin_pct ?? 0,` linha 187):
```typescript
      gross_margin_pct: s.gross_margin_pct ?? 0,
      sales_history_status: s.sales_history_status ?? null,
```

- [ ] **Step 3: Verificar tipos**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/lib/carteira/escopo-clientes.ts src/components/adminCustomers/types.ts
git commit -m "feat(scoring): fetchScoresPorCustomer + ClientScore trazem sales_history_status"
```

---

### Task 8: `useCustomerScore` (perfil 360) — trazer o campo

**Files:**
- Modify: `src/components/customer360/hooks.ts` (`useCustomerScore:53`, dois `.select(...)` em 62 e 69)

- [ ] **Step 1: Adicionar `, sales_history_status` aos DOIS selects (próprio + fallback)**

Em ambas as linhas (62 e 69), a string `.select('health_score, health_class, churn_risk, expansion_score, priority_score, gross_margin_pct, avg_monthly_spend_180d, days_since_last_purchase, category_count, avg_repurchase_interval, revenue_potential')` passa a terminar com `, revenue_potential, sales_history_status')`.

- [ ] **Step 2: Verificar tipos**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/customer360/hooks.ts
git commit -m "feat(scoring): useCustomerScore traz sales_history_status"
```

---

### Task 9: `useTacticalPlan.ts` — objetivo `ativacao` + contexto LLM

**Files:**
- Modify: `src/hooks/useTacticalPlan.ts` (`ClientScoreFull:106`, `objectiveLabels:173`, `selectObjective:190`, `generatePlan:340/350/370/409`)

- [ ] **Step 1: `ClientScoreFull` — adicionar o campo (após `revenue_potential: number | string | null;` linha 114)**

```typescript
  revenue_potential: number | string | null;
  sales_history_status: string | null;
```

- [ ] **Step 2: `objectiveLabels` — adicionar `ativacao` (após `reativacao:` linha 177)**

```typescript
  reativacao: '🟡 Reativação',
  ativacao: '🆕 Ativação (1ª compra)',
```

- [ ] **Step 3: `selectObjective` — receber o status com precedência (linha 190)**

```typescript
const selectObjective = (churnRisk: number, mixGap: number, marginPct: number, clusterMargin: number, daysSince: number, salesHistoryStatus: string | null): string => {
  if (salesHistoryStatus === 'sem_historico') return 'ativacao';  // nunca comprou → ativação, não recuperação/reativação
  if (daysSince > 90) return 'reativacao';
  if (churnRisk > 60) return 'recuperacao';
  if (mixGap > 3) return 'expansao_mix';
  if (marginPct < clusterMargin * 0.8) return 'consolidacao_margem';
  return 'upsell_premium';
};
```

- [ ] **Step 4: `generatePlan` — ler o status, passar ao `selectObjective` e ao `customerContext`**

Após `const revenuePotential = Number(score.revenue_potential || 0);` (linha 357):
```typescript
      const revenuePotential = Number(score.revenue_potential || 0);
      const salesHistoryStatus = score.sales_history_status ?? null;
```

Chamada do `selectObjective` (linha 370) — adicionar o argumento:
```typescript
      const strategicObjective = selectObjective(churnRisk, mixGap, marginPct, clusterMargin, daysSince, salesHistoryStatus);
```

No `customerContext` enviado à edge LLM (dentro de `body.customerContext`, após `revenuePotential,` na linha 423):
```typescript
            revenuePotential,
            salesHistoryStatus,
```

- [ ] **Step 5: Verificar tipos**

Run: `bun run typecheck`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useTacticalPlan.ts
git commit -m "feat(plano): objetivo 'ativacao' p/ sem_historico + salesHistoryStatus no contexto LLM"
```

---

### Task 10 (OPCIONAL — coerência): `useFarmerScoring.ts` — 2º engine (front)

**Files:**
- Modify: `src/hooks/useFarmerScoring.ts` (`ClientScore:35`, push do score `:340`, `scoreUpsert:443`)

> **Opcional:** o upsert deste hook é `onConflict 'customer_user_id,farmer_id'` e NÃO envia o status → ON CONFLICT **preserva** o `sales_history_status` gravado pelo edge (a coerência básica já existe sem esta task). T10 só fecha o caso de clientes que existam APENAS via este engine front (raro — o edge auto-seed todos os `omie_clientes`). Pode ser pulada sem quebrar a fatia; incluída para coerência total.

- [ ] **Step 1: Importar o helper (topo do arquivo, junto aos imports de `@/lib/scoring`)**

```typescript
import { deriveSalesHistoryStatus } from '@/lib/scoring/salesHistoryStatus';
```

- [ ] **Step 2: `ClientScore` — adicionar o campo (após `revenuePotential: number;` linha 55)**

```typescript
  revenuePotential: number;
  salesHistoryStatus: 'sem_historico' | 'stale' | 'ativo';
```

- [ ] **Step 3: No `scores.push({...})` (após `revenuePotential: ...` linha ~362) — derivar do total do cliente**

> Use a receita total all-time do cliente já disponível no cálculo (a variável de receita acumulada usada para `avgMonthly`/`revenuePotential`; no arquivo é o total de compras do cliente). Se o nome local diferir, use o agregado de receita all-time do cliente:
```typescript
      revenuePotential: Math.round(expectedMonthly * delayedMonths * 100) / 100,
      salesHistoryStatus: deriveSalesHistoryStatus({ total_revenue: cd.totalRevenue ?? 0, days_since_last_purchase: D }, config.sales_active_threshold_days ?? 180),
```
> `cd.totalRevenue` é a receita all-time do cliente (confirmado: `useFarmerScoring.ts:313`); `D` é o days-since (`:292`). Se o objeto `config` deste hook for tipado e não aceitar a chave `sales_active_threshold_days`, adicione-a à leitura/interface de config local.

- [ ] **Step 4: `scoreUpsert` (linha 443) — gravar a coluna (após `revenue_potential: s.revenuePotential,` linha ~465)**

```typescript
    revenue_potential: s.revenuePotential,
    sales_history_status: s.salesHistoryStatus,
```

- [ ] **Step 5: Verificar tipos + testes**

Run: `bun run typecheck && bun run test src/hooks`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useFarmerScoring.ts
git commit -m "feat(scoring): useFarmerScoring (2º engine front) deriva e grava sales_history_status"
```

---

## FASE C — Verdade visual (comportamento · UI · dashboards · LLM)

### Task 11: Semáforo neutro — `format.ts` + `CustomerHero.tsx`

**Files:**
- Modify: `src/components/customer360/format.ts` (`healthTone:97`)
- Modify: `src/components/customer360/CustomerHero.tsx` (`:27`, `:107-122`)

- [ ] **Step 1: `healthTone` — 2º parâmetro `salesHistoryStatus`, com precedência neutra**

```typescript
export function healthTone(healthClass: string | null, salesHistoryStatus?: string | null): {
  label: string;
  className: string;
  dot: string;
} {
  if (salesHistoryStatus === 'sem_historico') {
    return { label: 'Sem histórico', className: 'text-muted-foreground', dot: 'bg-muted-foreground' };
  }
  switch (healthClass) {
    case 'saudavel':
      return { label: 'Saudável', className: 'text-status-success-bold', dot: 'bg-status-success' };
    case 'atencao':
      return { label: 'Atenção', className: 'text-status-warning-bold', dot: 'bg-status-warning' };
    case 'risco':
      return { label: 'Em risco', className: 'text-status-error-bold', dot: 'bg-status-error' };
    case 'critico':
      return { label: 'Crítico', className: 'text-status-error-bold', dot: 'bg-status-error' };
    default:
      return { label: 'Sem score', className: 'text-muted-foreground', dot: 'bg-muted-foreground' };
  }
}
```

- [ ] **Step 2: `CustomerHero.tsx` — passar o status e neutralizar o switch inline**

Linha 27:
```typescript
const health = healthTone(s?.health_class ?? null, s?.sales_history_status ?? null);
```

No JSX (linhas 107-122), trocar a expressão de `className` para priorizar `sem_historico` (neutro) antes das classes de erro/aviso:
```typescript
<span
  className={cn(
    'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border',
    s?.sales_history_status === 'sem_historico'
      ? 'bg-muted text-muted-foreground border-border'
      : s?.health_class === 'critico' || s?.health_class === 'risco'
        ? 'bg-status-error-bg text-status-error-bold border-status-error/20'
        : s?.health_class === 'atencao'
          ? 'bg-status-warning-bg text-status-warning-bold border-status-warning/20'
          : s?.health_class === 'saudavel'
            ? 'bg-status-success-bg text-status-success-bold border-status-success/20'
            : 'bg-muted text-muted-foreground border-border',
  )}
>
  <span className={cn('inline-block w-1.5 h-1.5 rounded-full', health.dot)} />
  {health.label}
</span>
```

- [ ] **Step 3: Verificar tipos**

Run: `bun run typecheck`
Expected: sem erros. (`useCustomerScore` já traz `sales_history_status` — T8.)

- [ ] **Step 4: Commit**

```bash
git add src/components/customer360/format.ts src/components/customer360/CustomerHero.tsx
git commit -m "feat(ui): semáforo neutro 'Sem histórico' no perfil 360"
```

---

### Task 12: Lista admin — fix do drift + filtro/badge de status

**Files:**
- Modify: `src/components/adminCustomers/config.ts` (`HEALTH_CLASSES:6`)
- Modify: `src/components/adminCustomers/CustomerListView.tsx` (filtro `:91`, dropdown `:218`, badge `:256/290`)
- Test: `src/components/adminCustomers/__tests__/CustomerListView.test.tsx`

- [ ] **Step 1: `config.ts` — CORRIGIR o drift (`alerta`→`atencao`) + adicionar `estavel`/`novo` + `SALES_HISTORY_LABELS`**

```typescript
export const HEALTH_CLASSES: Record<string, { label: string; className: string }> = {
  saudavel: { label: 'Saudável', className: 'status-success' },
  estavel: { label: 'Estável', className: 'status-info' },
  atencao: { label: 'Atenção', className: 'status-pending' },
  critico: { label: 'Crítico', className: 'status-danger' },
  novo: { label: 'Novo', className: 'status-muted' },
};

export const SALES_HISTORY_LABELS: Record<string, { label: string; className: string }> = {
  sem_historico: { label: 'Sem histórico', className: 'status-muted' },
  stale: { label: 'Inativo', className: 'status-pending' },
  ativo: { label: 'Ativo', className: 'status-success' },
};
```

- [ ] **Step 2: `CustomerListView.tsx` — dropdown de saúde: trocar `'alerta'`→`'atencao'` e adicionar `Estável` (linhas 232-234)**

```typescript
    <DropdownMenuItem onClick={() => setFilterHealth('all')}>Todos</DropdownMenuItem>
    <DropdownMenuItem onClick={() => setFilterHealth('saudavel')}>🟢 Saudável</DropdownMenuItem>
    <DropdownMenuItem onClick={() => setFilterHealth('estavel')}>🔵 Estável</DropdownMenuItem>
    <DropdownMenuItem onClick={() => setFilterHealth('atencao')}>🟡 Atenção</DropdownMenuItem>
    <DropdownMenuItem onClick={() => setFilterHealth('critico')}>🔴 Crítico</DropdownMenuItem>
```

- [ ] **Step 3: `CustomerListView.tsx` — badge da tabela: `sem_historico` mostra "Sem histórico" (neutro) em vez de health (linha 256-257 + 290-293)**

Linha 256-257:
```typescript
            const score = scores.get(customer.user_id);
            const isSemHistorico = score?.sales_history_status === 'sem_historico';
            const healthInfo = score ? HEALTH_CLASSES[score.health_class] : undefined;
```

Badge (linhas 290-293):
```typescript
              <td className="px-3 py-2.5 text-center">
                {isSemHistorico ? (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">Sem histórico</Badge>
                ) : (
                  <Badge variant="outline" className={cn('text-[10px]', healthInfo?.className)}>
                    {healthInfo?.label || 'N/A'}
                  </Badge>
                )}
              </td>
```

- [ ] **Step 4: Rodar os testes existentes da lista (não quebrar) + typecheck**

Run: `bun run test src/components/adminCustomers/__tests__/CustomerListView.test.tsx && bun run typecheck`
Expected: PASS. (Se os mocks de `ClientScore` no teste não tiverem `sales_history_status`, adicione `sales_history_status: 'ativo'` a eles.)

- [ ] **Step 5: Commit**

```bash
git add src/components/adminCustomers/config.ts src/components/adminCustomers/CustomerListView.tsx src/components/adminCustomers/__tests__/CustomerListView.test.tsx
git commit -m "fix(ui): drift health_class atencao + badge 'Sem histórico' na lista admin"
```

---

### Task 13: Dashboards de Inteligência — excluir `sem_historico` do "em risco"

**Files:**
- Modify: `src/components/intelligence/IntelligenceOperationalTab.tsx` (`:89`, `:153`)
- Modify: `src/components/intelligence/IntelligenceManagerialTab.tsx` (`:71`, `:90`)

> Ambos usam `.select('*')` → o campo já vem. Só muda a lógica de contagem. Helper de predicado local mantém DRY.

- [ ] **Step 1: `IntelligenceOperationalTab.tsx` — `atRiskClients` (linha 89) exclui `sem_historico`**

```typescript
const isRealRisk = (c: { health_class?: string | null; sales_history_status?: string | null }) =>
  (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico';
const atRiskClients = clientScores?.filter(isRealRisk).length || 0;
```

E na lista "Clientes em Risco" (linha 153), trocar o filtro inline por `isRealRisk`:
```typescript
{clientScores?.filter(isRealRisk)
  .slice(0, 5)
```

- [ ] **Step 2: `IntelligenceManagerialTab.tsx` — `atRisk` por vendedor (linha 71) + KPI (linha 90) excluem `sem_historico`**

Linha 71:
```typescript
  const atRisk = clients.filter(c => (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico').length;
```

KPI (linha 90):
```typescript
<KpiCard title="Clientes em Risco" value={String(allScores?.filter(c => (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico').length || 0)} icon={AlertTriangle} trend="down" />
```

- [ ] **Step 3: Verificar tipos**

Run: `bun run typecheck`
Expected: sem erros. (Os scores vêm de `.select('*')` — o tipo gerado de `farmer_client_scores` inclui `sales_history_status` após a migration T2 + regeneração de tipos; se o tipo gerado ainda não tiver o campo, use a asserção local `as { sales_history_status?: string | null }` no predicado.)

- [ ] **Step 4: Commit**

```bash
git add src/components/intelligence/IntelligenceOperationalTab.tsx src/components/intelligence/IntelligenceManagerialTab.tsx
git commit -m "fix(intel): KPI 'Clientes em Risco' exclui sem_historico (verdade gerencial)"
```

---

### Task 14: Edge `generate-tactical-plan` — status no contexto + prompts

**Files:**
- Modify: `supabase/functions/generate-tactical-plan/index.ts` (`score` self-contained `:79/85/97`; prompts `:112/135`)

- [ ] **Step 1: Self-contained — ler o status, usar no `strategicObjective` e no `customerContext`**

Após `const marginPct = num(score.gross_margin_pct), ...daysSince = num(score.days_since_last_purchase);` (linha 80):
```typescript
      const salesHistoryStatus = (score.sales_history_status ?? null) as string | null;
```

No `strategicObjective` (linha 85-86), adicionar a precedência:
```typescript
const strategicObjective = salesHistoryStatus === 'sem_historico' ? 'ativacao'
  : daysSince > 90 ? 'reativacao' : churnRisk > 60 ? 'recuperacao'
  : mixGap > 3 ? 'expansao_mix' : marginPct < clusterMargin * 0.8 ? 'consolidacao_margem' : 'upsell_premium';
```

No `customerContext` (linha 97), adicionar `salesHistoryStatus`:
```typescript
      customerContext = { name: profile?.name, cnae: profile?.cnae, customerType: profile?.customer_type, profile: customerProfile, healthScore, churnRisk, avgMonthlySpend: avgSpend, grossMarginPct: marginPct, categoryCount, daysSinceLastPurchase: daysSince, mixGap, clusterAvgMargin: clusterMargin, expansionPotential: num(score.expansion_score), revenuePotential: num(score.revenue_potential), salesHistoryStatus };
```

- [ ] **Step 2: Prompts (essential `:112` e strategic `:135`) — adicionar `ativacao` ao enum + instrução**

Em AMBOS os prompts, na linha do `strategic_objective`, trocar a enumeração para incluir `"ativacao"`:
```
1. "strategic_objective": Exatamente um de: "ativacao", "recuperacao", "expansao_mix", "upsell_premium", "reativacao", "consolidacao_margem"
```

E adicionar, logo após essa linha em ambos os prompts, a instrução:
```
   IMPORTANTE: se o campo "salesHistoryStatus" do cliente for "sem_historico", o cliente NUNCA comprou — o objetivo é "ativacao" (primeira compra). NÃO trate health/churn como recuperação: não há histórico para recuperar. Foque em descoberta de necessidade e primeira oferta.
```

- [ ] **Step 3: Verificar tipos do edge (Deno)**

Run: `cd supabase/functions && deno check generate-tactical-plan/index.ts`
Expected: sem erros. (Se `deno` indisponível, validar no deploy.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/generate-tactical-plan/index.ts
git commit -m "feat(edge): generate-tactical-plan trata sem_historico como ativação (contexto + prompt)"
```

---

### Task 15: Verificação final (health stack) + handoff de deploy

**Files:** (nenhum novo — verificação)

- [ ] **Step 1: Health stack completo**

Run: `heavy bun run typecheck && heavy bun run lint && heavy bun run test && bunx knip`
Expected: tudo verde. (Atenção a `knip`: o helper novo é usado no front e no edge — o edge não conta para o knip do front, mas `salesHistoryStatus.ts` é importado por `useFarmerScoring` T10, então não fica órfão.)

- [ ] **Step 2: Regenerar tipos do Supabase (se o projeto tiver o script) — para `sales_history_status` entrar em `@/integrations/supabase/types`**

> Verifique se há script (`bun run db:types` ou similar). Se houver, rode e commite. Se não, as asserções locais (T13 Step 3) cobrem; registre a pendência.

- [ ] **Step 3: Commit (se tipos regenerados)**

```bash
git add src/integrations/supabase/types.ts
git commit -m "chore(db): regenera tipos com sales_history_status"
```

- [ ] **Step 4: Handoff de deploy (founder — manual no Lovable). Invoque `lovable-deploy-verify`.**

Ordem OBRIGATÓRIA (o COALESCE tira o risco de ordem, mas o gate de cobertura protege a UI):
1. **SQL Editor:** aplicar T2 (coluna+CHECK+config) → validar (col_existe=1, limiar=180).
2. **SQL Editor:** aplicar T3 (RPC v2) — **pré-flight `pg_get_functiondef` antes** → validar (tem_coalesce=t, exec_auth=f).
3. **Chat do Lovable:** redeploy do edge `calculate-scores` (verbatim do repo).
4. **GATE DE COBERTURA (psql-ro):** após o 1º run do cron (ou disparo manual), validar que a coluna populou:
   ```sql
   SELECT sales_history_status, count(*) FROM farmer_client_scores GROUP BY 1 ORDER BY 2 DESC;
   -- esperado ~ sem_historico 5606 / stale 421 / ativo 373; count(NULL) deve cair a ~0
   ```
5. **Chat do Lovable:** redeploy do edge `generate-tactical-plan` (verbatim).
6. **Publish (frontend):** SÓ após o gate (4) confirmar cobertura. Verificar o bundle (`lovable-deploy-verify`).

- [ ] **Step 5: Medição before/after (psql-ro) — confirmar que o top-10 por farmer NÃO mudou**

```sql
-- top-10 por priority_score por farmer não deve ter passado a incluir sem_historico
-- (guard read-time na agenda + nudge=0). Rodar a query da §Prova do spec e comparar.
```

---

## Self-Review (cobertura do spec v2)

| Requisito do spec (v2) | Task |
|---|---|
| §1 Coluna text NULL + CHECK; config próprio | T2 |
| §2 Helper "sem venda válida"; branch days-null explícito; clamp local | T1 |
| §2 Espelho no edge | T4 |
| §3 RPC COALESCE fora do guard das 13; pré-flight prod | T3 |
| §3 Edge: seed + ScoreUpdate + degradação null | T4 |
| §4 Semáforo neutro (perfil) | T11 |
| §4 Lista: filtro/badge + fix drift atencao/alerta | T12 |
| §4 Dashboards excluem sem_historico do "em risco" | T13 |
| §5 Agenda: 'ativacao' + guard de slot (não só rótulo) | T5 |
| §5 Plano: tipo + selectObjective + contexto LLM | T9 |
| §5 Edge LLM: status + prompt | T14 |
| §5 Hooks propagam o campo | T6, T7, T8, T10 |
| Prova: vitest+falsificação (helper, agenda); prove-sql (RPC) | T1, T5, T3 |
| Deploy: ordem + gate de cobertura + alarme count(null) | T15 |

**Consistência de tipos:** `deriveSalesHistoryStatus(sales, activeThresholdDays)` / `clampActiveDays(raw)` idênticos em T1 e T4 (espelho). `sales_history_status` é `string | null` nos shapes de leitura (T5/6/7/8/9) e união literal nos de escrita (T1/4/10). `agenda_type` união com `'ativacao'` consistente T5↔consumidores. `healthTone(healthClass, salesHistoryStatus?)` (T11) — call-site único em CustomerHero atualizado.

**Pendências de execução sinalizadas (não placeholders):** existência de script de regeneração de tipos do Supabase (T15 Step 2 — se não houver, asserções locais cobrem); disponibilidade de `deno` local para `deno check` (T4/T14 — senão validar no deploy). T10 é opcional (coerência) — o upsert do 2º engine já preserva o status do edge.
