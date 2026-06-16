# Sentinela de Saúde de Dados — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir uma camada de saúde de dados que transforma falhas silenciosas de sync (como o bug do saldo R$ 0) em alertas visíveis: badge global + tela diagnóstica (master/gestão) + banners inline nas telas críticas.

**Architecture:** Uma RPC Postgres `SECURITY DEFINER` on-demand (`get_data_health`) que unifica frescor de tabelas + `fin_sync_log` + `get_carteira_saude` num diagnóstico com redação por papel. Frontend lê via react-query e renderiza badge/tela/banners. Lógica de status/rollup/cor isolada num helper puro testado por vitest. Read-only; 1 migration; sem cron/edge novo.

**Tech Stack:** Postgres (RPC SQL), Supabase, React 18 + TS, @tanstack/react-query, shadcn/ui, vitest. Spec: `docs/superpowers/specs/2026-05-26-sentinela-saude-dados-design.md`.

**Constraint Lovable:** a migration da RPC é aplicada MANUALMENTE pelo founder no SQL Editor do Lovable (sem CLI). O frontend mergeia normal (rebuild automático). Tasks de migration entregam o bloco SQL + a query de validação.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| Create `src/lib/dataHealth/types.ts` | Tipo `DataHealthCheck` + `HealthStatus` + `HealthDomain` (contrato compartilhado front) |
| Create `src/lib/dataHealth/health-helpers.ts` | Lógica PURA: rollup por domínio, nível do badge, formatação de idade, mensagem de banner, regra "sem verde silencioso" |
| Create `src/lib/dataHealth/__tests__/health-helpers.test.ts` | Testes vitest do helper puro |
| Create `supabase/migrations/<ts>_data_health_rpc.sql` | RPC `get_data_health()` (Fase 1: financeiro + carteira) |
| Create `src/hooks/useDataHealth.ts` | Hook react-query: chama a RPC, mapeia erro→estado vermelho |
| Create `src/components/shell/DataHealthBadge.tsx` | Badge no topbar (master/gestão) |
| Create `src/pages/SaudeDados.tsx` | Tela `/gestao/saude-dados` (master/gestão) |
| Create `src/components/dataHealth/DataHealthBanner.tsx` | Banner inline por fonte (qualquer staff) |
| Modify `src/App.tsx` | Rota lazy `gestao/saude-dados` + item de nav (seção Gestão, masterOnly/managerOnly) |
| Modify `src/components/AppShell.tsx` | Montar `<DataHealthBadge/>` no topbar |
| Modify `src/components/financeiro/dashboard/VisaoGeralTab.tsx` | `<DataHealthBanner source="saldo_bancario"/>` acima das Contas Correntes |

---

## FASE 1 — Fatia MVP end-to-end (financeiro + carteira)

### Task 1: Tipos + helper puro (TDD)

**Files:**
- Create: `src/lib/dataHealth/types.ts`
- Create: `src/lib/dataHealth/health-helpers.ts`
- Test: `src/lib/dataHealth/__tests__/health-helpers.test.ts`

- [ ] **Step 1: Criar os tipos**

Create `src/lib/dataHealth/types.ts`:

```ts
export type HealthStatus = 'ok' | 'stale' | 'broken' | 'unknown';
export type HealthDomain = 'financeiro' | 'omie_sync' | 'carteira' | 'estoque';
export type HealthLevel = 'green' | 'amber' | 'red';

/** Um check individual retornado pela RPC get_data_health. */
export interface DataHealthCheck {
  source: string;
  domain: HealthDomain;
  status: HealthStatus;
  age_seconds: number | null;
  expected_max_age_seconds: number | null;
  freshness_basis: string | null;
  message: string;            // sempre presente (banner-safe)
  last_error: string | null;       // só audiência full
  probable_cause: string | null;   // só audiência full
  how_to_fix: string | null;       // só audiência full
  severity: 'critical' | 'warning' | 'info';
}
```

- [ ] **Step 2: Escrever os testes que falham**

Create `src/lib/dataHealth/__tests__/health-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { badgeLevel, rollupDomain, formatAge, isHealthy } from '../health-helpers';
import type { DataHealthCheck } from '../types';

const mk = (over: Partial<DataHealthCheck>): DataHealthCheck => ({
  source: 's', domain: 'financeiro', status: 'ok', age_seconds: 0,
  expected_max_age_seconds: 3600, freshness_basis: 'max_updated_at',
  message: '', last_error: null, probable_cause: null, how_to_fix: null,
  severity: 'info', ...over,
});

describe('badgeLevel', () => {
  it('verde quando todos ok', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'ok' })])).toBe('green');
  });
  it('vermelho quando algum broken', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'broken' })])).toBe('red');
  });
  it('amarelo quando algum stale (e nenhum broken)', () => {
    expect(badgeLevel([mk({ status: 'ok' }), mk({ status: 'stale' })])).toBe('amber');
  });
  it('SEM VERDE SILENCIOSO: lista vazia => vermelho (não consegue provar saúde)', () => {
    expect(badgeLevel([])).toBe('red');
  });
  it('SEM VERDE SILENCIOSO: unknown => vermelho', () => {
    expect(badgeLevel([mk({ status: 'unknown' })])).toBe('red');
  });
});

describe('rollupDomain', () => {
  it('agrupa pegando o pior status do domínio', () => {
    const checks = [
      mk({ domain: 'financeiro', source: 'cp', status: 'ok' }),
      mk({ domain: 'financeiro', source: 'cr', status: 'stale' }),
      mk({ domain: 'carteira', source: 'scores', status: 'ok' }),
    ];
    const r = rollupDomain(checks);
    expect(r.find(d => d.domain === 'financeiro')?.status).toBe('stale');
    expect(r.find(d => d.domain === 'carteira')?.status).toBe('ok');
  });
});

describe('formatAge', () => {
  it('null => "desconhecido"', () => { expect(formatAge(null)).toBe('desconhecido'); });
  it('segundos => "há X min"', () => { expect(formatAge(120)).toBe('há 2 min'); });
  it('horas', () => { expect(formatAge(7200)).toBe('há 2 h'); });
  it('dias', () => { expect(formatAge(172800)).toBe('há 2 dias'); });
});

describe('isHealthy', () => {
  it('só ok', () => { expect(isHealthy([mk({ status: 'ok' })])).toBe(true); });
  it('stale não é healthy', () => { expect(isHealthy([mk({ status: 'stale' })])).toBe(false); });
});
```

- [ ] **Step 3: Rodar os testes pra confirmar que falham**

Run: `heavy bun run test -- src/lib/dataHealth/__tests__/health-helpers.test.ts`
Expected: FAIL (`badgeLevel`/`rollupDomain`/`formatAge`/`isHealthy` is not a function).

- [ ] **Step 4: Implementar o helper puro**

Create `src/lib/dataHealth/health-helpers.ts`:

```ts
import type { DataHealthCheck, HealthDomain, HealthLevel, HealthStatus } from './types';

const STATUS_RANK: Record<HealthStatus, number> = { ok: 0, stale: 1, unknown: 2, broken: 3 };

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Nível do badge. SEM VERDE SILENCIOSO: vazio ou qualquer unknown/broken => red. */
export function badgeLevel(checks: DataHealthCheck[]): HealthLevel {
  if (checks.length === 0) return 'red';
  if (checks.some(c => c.status === 'broken' || c.status === 'unknown')) return 'red';
  if (checks.some(c => c.status === 'stale')) return 'amber';
  return 'green';
}

export function isHealthy(checks: DataHealthCheck[]): boolean {
  return checks.length > 0 && checks.every(c => c.status === 'ok');
}

export interface DomainRollup { domain: HealthDomain; status: HealthStatus; checks: DataHealthCheck[]; }

export function rollupDomain(checks: DataHealthCheck[]): DomainRollup[] {
  const byDomain = new Map<HealthDomain, DataHealthCheck[]>();
  for (const c of checks) {
    const arr = byDomain.get(c.domain) ?? [];
    arr.push(c);
    byDomain.set(c.domain, arr);
  }
  return [...byDomain.entries()].map(([domain, list]) => ({
    domain,
    status: list.reduce<HealthStatus>((acc, c) => worst(acc, c.status), 'ok'),
    checks: list,
  }));
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return 'desconhecido';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return `há ${Math.round(seconds / 86400)} dias`;
}
```

- [ ] **Step 5: Rodar os testes pra confirmar que passam**

Run: `heavy bun run test -- src/lib/dataHealth/__tests__/health-helpers.test.ts`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add src/lib/dataHealth/types.ts src/lib/dataHealth/health-helpers.ts src/lib/dataHealth/__tests__/health-helpers.test.ts
git commit -m "feat(data-health): tipos + helper puro de saúde de dados (TDD)"
```

---

### Task 2: RPC `get_data_health()` (Fase 1: financeiro + carteira)

**Files:**
- Create: `supabase/migrations/20260526160000_data_health_rpc.sql`

> ⚠️ Migration aplicada MANUALMENTE no SQL Editor do Lovable. Esta task entrega o arquivo + a query de validação. Use a skill `lovable-db-operator` pra empacotar.

- [ ] **Step 1: Escrever a migration**

Create `supabase/migrations/20260526160000_data_health_rpc.sql`:

```sql
-- Sentinela de Saúde de Dados — RPC on-demand de diagnóstico (Fase 1: financeiro + carteira).
-- Verdade primária = frescor de tabela + fin_sync_log. net._http_response = evidência (Fase 2).
-- cron.job_run_details NÃO é fonte (reporta 'succeeded' mesmo em 401).
-- Redação por papel: full (master/gestor) vê erro/causa/como-resolver; demais veem só banner-safe.
-- SEM VERDE SILENCIOSO: o que não consegue provar => 'unknown'/'broken'.

CREATE OR REPLACE FUNCTION public.get_data_health()
RETURNS TABLE (
  source text, domain text, status text,
  age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text,
  message text, last_error text, probable_cause text, how_to_fix text, severity text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: não autenticado' USING ERRCODE = '42501';
  END IF;
  -- audiência full = master OU gestor comercial (helper existente). COALESCE => fail-closed.
  v_full := COALESCE(public.pode_ver_carteira_completa(auth.uid()), false);

  RETURN QUERY
  WITH checks AS (
    -- ── FINANCEIRO: saldo bancário (frescor por saldo_data) ──
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE
        WHEN max(cc.saldo_data) IS NULL THEN 'broken'
        WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale'
        ELSE 'ok'
      END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds,
      'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL
           THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true

    UNION ALL
    -- ── FINANCEIRO: contas a receber (frescor por updated_at) ──
    SELECT 'contas_receber', 'financeiro',
      CASE WHEN max(cr.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cr.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cr.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a receber: atualizado ' || COALESCE(to_char(max(cr.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cr.updated_at) IS NULL THEN 'Sync CR nunca completou' ELSE NULL END,
      'Rode sync_contas_receber no Lovable', 'warning'
    FROM public.fin_contas_receber cr

    UNION ALL
    -- ── FINANCEIRO: contas a pagar ──
    SELECT 'contas_pagar', 'financeiro',
      CASE WHEN max(cp.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cp.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cp.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a pagar: atualizado ' || COALESCE(to_char(max(cp.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cp.updated_at) IS NULL THEN 'Sync CP nunca completou' ELSE NULL END,
      'Rode sync_contas_pagar no Lovable', 'warning'
    FROM public.fin_contas_pagar cp

    UNION ALL
    -- ── FINANCEIRO: erro explícito recente em fin_sync_log ──
    SELECT 'omie_sync_financeiro', 'omie_sync',
      CASE WHEN bool_or(l.status = 'error') THEN 'broken' ELSE 'ok' END,
      NULL::bigint, NULL::bigint, 'fin_sync_log',
      CASE WHEN bool_or(l.status='error') THEN 'Sync financeiro com erro nas últimas 24h' ELSE 'Sync financeiro sem erros recentes' END,
      max(l.error_message) FILTER (WHERE l.status='error'),
      CASE WHEN bool_or(l.status='error') THEN 'Falha em action de sync (ver fin_sync_log)' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou', 'critical'
    FROM public.fin_sync_log l WHERE l.completed_at > now() - interval '24 hours'

    UNION ALL
    -- ── CARTEIRA: reusa get_carteira_saude (jsonb) ──
    SELECT 'carteira_scores', 'carteira',
      COALESCE((public.get_carteira_saude() ->> 'status'), 'unknown'),
      NULL::bigint, NULL::bigint, 'calculated_at',
      'Carteira/scoring: ' || COALESCE((public.get_carteira_saude() ->> 'status'), 'desconhecido'),
      NULL, NULL, 'Re-rode calculate-scores no Lovable', 'warning'
  )
  SELECT
    c.source, c.domain,
    -- SEM VERDE SILENCIOSO: status nulo/desconhecido => 'unknown'
    COALESCE(NULLIF(c.status, ''), 'unknown'),
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN v_full THEN c.last_error ELSE NULL END,
    CASE WHEN v_full THEN c.probable_cause ELSE NULL END,
    CASE WHEN v_full THEN c.how_to_fix ELSE NULL END,
    c.severity
  FROM checks c;
END;
$$;

REVOKE ALL ON FUNCTION public.get_data_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_data_health() TO authenticated;
```

- [ ] **Step 2: Query de validação (colar no SQL Editor após o apply)**

```sql
SELECT 'get_data_health OK' AS status, count(*) AS n_checks,
       count(*) FILTER (WHERE status NOT IN ('ok','stale','broken','unknown')) AS status_invalidos
FROM public.get_data_health();
```
Expected: `n_checks >= 5`, `status_invalidos = 0`. (Se o saldo estiver quebrado, deve aparecer `saldo_bancario` com `broken`.)

- [ ] **Step 3: Commit do arquivo (apply é manual no Lovable)**

```bash
git add supabase/migrations/20260526160000_data_health_rpc.sql
git commit -m "feat(data-health): RPC get_data_health (financeiro + carteira)"
```

> ⚠️ No PR: marcar "ATENÇÃO: migration manual necessária" + colar o bloco SQL no body. Confirmar que `public.pode_ver_carteira_completa(uuid)` e `public.get_carteira_saude()` existem em produção (se não, ajustar o gate/check no apply).

---

### Task 3: Hook `useDataHealth`

**Files:**
- Create: `src/hooks/useDataHealth.ts`

- [ ] **Step 1: Implementar o hook**

Create `src/hooks/useDataHealth.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DataHealthCheck } from '@/lib/dataHealth/types';

export function useDataHealth() {
  return useQuery<DataHealthCheck[]>({
    queryKey: ['data-health'],
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_data_health');
      if (error) throw error;
      return (data ?? []) as unknown as DataHealthCheck[];
    },
  });
}
```

- [ ] **Step 2: Rodar typecheck**

Run: `heavy bun run typecheck:strict` (se o arquivo entrar no include) e `bunx tsc --noEmit`
Expected: 0 erros novos. (Se `get_data_health` não estiver nos tipos gerados, usar `supabase.rpc('get_data_health' as never)` ou cast — seguir o padrão do repo pra RPCs fora dos tipos.)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useDataHealth.ts
git commit -m "feat(data-health): hook useDataHealth (react-query)"
```

---

### Task 4: `DataHealthBadge` no topbar

**Files:**
- Create: `src/components/shell/DataHealthBadge.tsx`
- Modify: `src/components/AppShell.tsx` (montar o badge no topbar, perto do NetworkStatusIndicator)

- [ ] **Step 1: Implementar o badge**

Create `src/components/shell/DataHealthBadge.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { badgeLevel } from '@/lib/dataHealth/health-helpers';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

export function DataHealthBadge() {
  const navigate = useNavigate();
  const { isMaster, isStaff } = useAuth();
  const { data, isError } = useDataHealth();

  // Badge só pra master/gestão (banners inline cobrem o resto)
  if (!isStaff) return null;

  // SEM VERDE SILENCIOSO: erro de query => vermelho
  const level = isError ? 'red' : badgeLevel(data ?? []);
  if (level === 'green') return null; // verde = silencioso por design (só aparece quando há problema)

  const cfg = {
    red: { Icon: ShieldAlert, cls: 'text-status-error', label: 'Saúde de dados: problema' },
    amber: { Icon: ShieldQuestion, cls: 'text-status-warning', label: 'Saúde de dados: atenção' },
  }[level];

  return (
    <button
      onClick={() => navigate('/gestao/saude-dados')}
      title={cfg.label}
      aria-label={cfg.label}
      className={cn('inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent', cfg.cls)}
    >
      <cfg.Icon className="h-4 w-4" />
    </button>
  );
}
```

> Nota: verde não renderiza nada (não polui o topbar quando está tudo ok). O badge só aparece em amber/red. A tela `/gestao/saude-dados` mostra o verde também.

- [ ] **Step 2: Montar no topbar do AppShell**

Modify `src/components/AppShell.tsx`: importar e renderizar `<DataHealthBadge />` ao lado do `<NetworkStatusIndicator />` no topbar.

```tsx
import { DataHealthBadge } from '@/components/shell/DataHealthBadge';
// ...no topbar, perto de <NetworkStatusIndicator />:
<DataHealthBadge />
```

- [ ] **Step 3: Verificar no browser (não há teste unitário de componente)**

Subir `bun dev`, logar como master, abrir o app. Se houver fonte stale/broken, o ícone aparece no topbar e leva pra `/gestao/saude-dados` ao clicar.

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/DataHealthBadge.tsx src/components/AppShell.tsx
git commit -m "feat(data-health): badge de saúde no topbar (master/gestão)"
```

---

### Task 5: Tela `SaudeDados` + rota

**Files:**
- Create: `src/pages/SaudeDados.tsx`
- Modify: `src/App.tsx` (rota lazy + item de nav na seção Gestão, `managerOnly`)

- [ ] **Step 1: Implementar a tela**

Create `src/pages/SaudeDados.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { ShieldAlert } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { rollupDomain, formatAge, badgeLevel } from '@/lib/dataHealth/health-helpers';

const DOMAIN_LABEL: Record<string, string> = {
  financeiro: 'Financeiro', omie_sync: 'Syncs Omie', carteira: 'Carteira / Scoring', estoque: 'Estoque / Reposição',
};
const STATUS_CLS: Record<string, string> = {
  ok: 'text-status-success', stale: 'text-status-warning', broken: 'text-status-error', unknown: 'text-status-error',
};

export default function SaudeDados() {
  const { data, isLoading, isError } = useDataHealth();
  if (isLoading) return <PageSkeleton variant="list" />;

  if (isError || !data) {
    // SEM VERDE SILENCIOSO: erro => estado vermelho explícito, não tela vazia.
    return (
      <div className="max-w-4xl mx-auto p-4">
        <EmptyState icon={ShieldAlert} title="Saúde de dados indisponível"
          description="Não foi possível computar os checks. Trate como NÃO confiável até resolver." tone="operational" />
      </div>
    );
  }

  const domains = rollupDomain(data);
  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div>
        <h1 className="font-display" style={{ fontSize: '2rem', fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1.1 }}>
          Saúde de Dados
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Frescor e integridade das fontes que alimentam as decisões. Nível: {badgeLevel(data)}.
        </p>
      </div>
      {domains.map(d => (
        <Card key={d.domain}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <span className={STATUS_CLS[d.status]}>●</span>{DOMAIN_LABEL[d.domain] ?? d.domain}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.checks.map(c => (
              <div key={c.source} className="border-b last:border-0 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{c.message}</span>
                  <span className={`text-xs font-medium ${STATUS_CLS[c.status]}`}>
                    {c.status} · {formatAge(c.age_seconds)}
                  </span>
                </div>
                {c.probable_cause && <p className="text-xs text-muted-foreground mt-0.5">Causa provável: {c.probable_cause}</p>}
                {c.how_to_fix && <p className="text-xs text-status-info mt-0.5">Como resolver: {c.how_to_fix}</p>}
                {c.last_error && <p className="text-xs text-status-error mt-0.5 font-mono">{c.last_error}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Adicionar rota + nav no App.tsx**

Modify `src/App.tsx`:
- Declarar lazy: `const SaudeDados = lazy(() => import("./pages/SaudeDados"));`
- Adicionar rota dentro do bloco autenticado: `<Route path="gestao/saude-dados" element={<SaudeDados />} />`

Modify `src/components/AppShell.tsx` — adicionar item na seção "Gestão" do `unifiedNavSections`:
```tsx
{ icon: ShieldCheck, label: 'Saúde de Dados', path: '/gestao/saude-dados', managerOnly: true },
```
(importar `ShieldCheck` de lucide-react se ainda não estiver.)

- [ ] **Step 3: Verificar no browser**

`bun dev` → logar master → abrir `/gestao/saude-dados` → ver os domínios e checks; forçar um stale (ex: a fonte de saldo) e confirmar que aparece vermelho/amarelo com causa + como-resolver.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SaudeDados.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(data-health): tela /gestao/saude-dados (master/gestão)"
```

---

### Task 6: `DataHealthBanner` inline + wiring no financeiro

**Files:**
- Create: `src/components/dataHealth/DataHealthBanner.tsx`
- Modify: `src/components/financeiro/dashboard/VisaoGeralTab.tsx`

- [ ] **Step 1: Implementar o banner**

Create `src/components/dataHealth/DataHealthBanner.tsx`:

```tsx
import { AlertTriangle } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { cn } from '@/lib/utils';

/** Banner inline não-bloqueante pra UMA fonte. Aparece pra qualquer staff que abra a tela. */
export function DataHealthBanner({ source }: { source: string }) {
  const { data } = useDataHealth();
  const check = data?.find(c => c.source === source);
  if (!check || check.status === 'ok') return null;

  const isBroken = check.status === 'broken' || check.status === 'unknown';
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-md border px-3 py-2 text-sm mb-3',
      isBroken ? 'bg-status-error-bg border-status-error/30 text-status-error'
               : 'bg-status-warning-bg border-status-warning/30 text-status-warning',
    )}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{check.message} — dado não confiável, não decida por aqui.</span>
    </div>
  );
}
```

- [ ] **Step 2: Wire no VisaoGeralTab (acima das Contas Correntes)**

Modify `src/components/financeiro/dashboard/VisaoGeralTab.tsx`: importar e renderizar `<DataHealthBanner source="saldo_bancario" />` logo antes do card "Contas Correntes".

```tsx
import { DataHealthBanner } from '@/components/dataHealth/DataHealthBanner';
// ...antes do bloco {/* Contas Correntes */}:
<DataHealthBanner source="saldo_bancario" />
```

- [ ] **Step 3: Verificar no browser**

`bun dev` → `/financeiro` (Visão Geral). Se o saldo estiver stale/broken, o banner aparece acima das Contas Correntes. (Se o saldo estiver ok, o banner some — comportamento correto.)

- [ ] **Step 4: Commit**

```bash
git add src/components/dataHealth/DataHealthBanner.tsx src/components/financeiro/dashboard/VisaoGeralTab.tsx
git commit -m "feat(data-health): banner inline de saldo no financeiro"
```

---

### Task 7: Gate completo + ship da Fase 1

- [ ] **Step 1: Rodar o gate completo (lição: typecheck:strict + tests + build antes do push)**

```bash
heavy bun run typecheck:strict
heavy bun run test
heavy bun run build
bun lint
```
Expected: typecheck:strict 0 erros; tests todos passando; build ok; lint sem erro novo nos arquivos tocados.

- [ ] **Step 2: PR + merge**

```bash
git push -u origin feat/sentinela-saude-dados
gh pr create --base main --title "feat(data-health): Sentinela de Saúde de Dados (Fase 1: financeiro + carteira)" --body "<resumo + ATENÇÃO migration manual: colar supabase/migrations/20260526160000_data_health_rpc.sql no SQL Editor do Lovable + query de validação>"
gh pr merge <n> --squash --auto
```

- [ ] **Step 3: Entregar a migration pro founder (ritual Lovable)**

Colar na conversa: o bloco SQL da RPC (1 bloco) + a query de validação. Confirmar `pode_ver_carteira_completa` e `get_carteira_saude` existem em prod. Após apply + "Success", validar que o badge/tela/banner reagem ao estado real.

---

## FASE 2 — Estender domínios (após Fase 1 em produção)

> Mesmo padrão: adicionar blocos `UNION ALL` na RPC (nova migration `ALTER`/`CREATE OR REPLACE`) + um `<DataHealthBanner>` na tela do domínio. Cada um é um PR pequeno.

### Task 8: Checks de Omie sync (evidência HTTP) + estoque/reposição
- [ ] Adicionar à RPC (via `CREATE OR REPLACE`): bloco por entidade Omie usando `fin_sync_log` por `action`/`company`; e bloco de `net._http_response` como EVIDÊNCIA (janela 24-72h, allowlist de funções, `left(content,500)`) — marcado `severity='info'`, nunca canônico.
- [ ] Adicionar checks de estoque/reposição (frescor de picking/recebimento + sugestão de compra) — confirmar colunas exatas antes (ex: `picking_tasks`, `nfe_recebimentos`, `pedido_compra_sugerido`).
- [ ] `<DataHealthBanner source="carteira_scores" />` em `/farmer` (FarmerCalls).
- [ ] Gate completo + PR + migration manual.

### Task 9 (futuro, fora do MVP): snapshot por cron
- [ ] `data_health_snapshot` + cron (dead-man switch: alerta mesmo sem ninguém abrir o app). Só quando houver demanda de histórico/alerta proativo.

---

## Self-Review (preenchido)

- **Cobertura da spec:** badge ✓(T4), tela master/gestão ✓(T5), banner inline ✓(T6), 4 domínios (financeiro+carteira na Fase 1 ✓; omie+estoque na Fase 2 ✓), redação por papel ✓(T2 `v_full`), sem-verde-silencioso ✓(T1 testes + T2 COALESCE unknown + T4/T5 erro→vermelho), read-only ✓, 1 migration sem cron/edge ✓(T2).
- **Placeholders:** nenhum — código real em cada step. (Fase 2 lista colunas a confirmar antes, explicitamente, porque não foram verificadas.)
- **Consistência de tipos:** `DataHealthCheck` (T1) = retorno da RPC (T2) = consumo do hook (T3) = badge/tela/banner (T4-6). `badgeLevel`/`rollupDomain`/`formatAge` mesmos nomes em todo lugar.
- **Risco conhecido:** se `supabase.rpc('get_data_health')` não estiver nos tipos gerados, cast (T3 nota). Se `pode_ver_carteira_completa`/`get_carteira_saude` não existirem em prod, ajustar no apply (T2 nota).
