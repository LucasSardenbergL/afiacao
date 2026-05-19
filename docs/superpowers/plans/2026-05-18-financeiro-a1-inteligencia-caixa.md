# Financeiro A1 — Inteligência de Caixa (CFO mode) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar A1 do Tema A — fluxo de caixa 13 semanas com 3 cenários (realista/otimista/pessimista), NCG calculada e projetada, alertas configuráveis, refator de `FinanceiroCapitalGiro` em 4 tabs + 1 oculta. Tudo em cima da Fundação Tier 1 já deployada.

**Architecture:** Híbrida (consistente com Fundação). Triggers DB para audit + period lock nas 5 tabelas novas. Edge function `fin-cashflow-engine` em TypeScript (pipeline de 10 passos: carregar dados → taxas históricas → cenário → loop semanas → NCG → indicadores → alertas → snapshot). React + shadcn + recharts pra UI. Cron diário pra snapshot histórico.

**Tech Stack:** Postgres 15 (Supabase), Deno (Edge Functions), TypeScript, React 18, Tailwind, shadcn/ui (Tabs, Card, Table, ToggleGroup, Alert, Chart), recharts, vitest. Spec de referência: [docs/superpowers/specs/2026-05-18-financeiro-a1-inteligencia-caixa-design.md](../specs/2026-05-18-financeiro-a1-inteligencia-caixa-design.md).

**Pré-requisito:** Fundação Tier 1 já deployada (15 migrations + 4 edge fns aplicados no Supabase). Confirmado em produção.

**Cronograma de fases (cada fase = 1 PR shippable):**
1. **Phase 0** — Setup compartilhado (helpers de format + ncg)
2. **Phase 1** — Schema (5 tabelas + audit/lock attach)
3. **Phase 2** — Engine `fin-cashflow-engine` (pipeline completo + testes)
4. **Phase 3** — Hooks + Tab Eventos (CRUD recorrentes + eventuais — primeiro user value)
5. **Phase 4** — Tab Fluxo 13s (CenarioToggle + AlertasStack + gráfico + tabela)
6. **Phase 5** — Tab NCG (decomposição + projeção + sensitivity)
7. **Phase 6** — Tab Configuração (master only, thresholds + cenário overrides)
8. **Phase 7** — Cron snapshot diário + onboarding wizard
9. **Phase 8** — Docs + encerramento

Cada fase fecha com `bun lint && bun build && bun test` verde + commit final `[PR-READY: Phase X]`. Modo files-only: subagents NÃO rodam `bunx supabase db push` nem `supabase functions deploy` — você (founder) aplica nos boundaries das fases via o caminho que já estabelecemos (Dashboard SQL Editor ou Supabase CLI).

---

## Phase 0: Setup compartilhado

### Task 0.1: Helper `lib/financeiro/cashflow-format.ts`

**Files:**
- Create: `src/lib/financeiro/cashflow-format.ts`
- Test: `src/lib/financeiro/__tests__/cashflow-format.test.ts`

- [ ] **Step 1: Criar teste falhando**

Arquivo `src/lib/financeiro/__tests__/cashflow-format.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatSemana,
  formatBRL,
  formatDelta,
  expandirRecorrente,
  inicioSemana,
} from '../cashflow-format';

describe('formatSemana', () => {
  it('formats YYYY-MM-DD week as "DD/MM"', () => {
    expect(formatSemana('2026-05-19')).toBe('19/05');
  });
});

describe('formatBRL', () => {
  it('formats positive as R$ X.XXX,XX', () => {
    expect(formatBRL(1234.5)).toMatch(/R\$\s?1\.234,50/);
  });
  it('formats negative with sinal', () => {
    expect(formatBRL(-500)).toMatch(/-R\$\s?500,00/);
  });
  it('formats zero', () => {
    expect(formatBRL(0)).toMatch(/R\$\s?0,00/);
  });
});

describe('formatDelta', () => {
  it('positive delta has + prefix', () => {
    expect(formatDelta(100)).toMatch(/^\+/);
  });
  it('negative delta has - prefix', () => {
    expect(formatDelta(-100)).toMatch(/^-/);
  });
  it('zero has no prefix', () => {
    expect(formatDelta(0)).not.toMatch(/^[+-]/);
  });
});

describe('inicioSemana', () => {
  it('returns Monday for any day of the week (ISO week)', () => {
    // 2026-05-21 is a Thursday; Monday of that week is 2026-05-18
    expect(inicioSemana('2026-05-21')).toBe('2026-05-18');
  });
  it('returns same day if input is Monday', () => {
    expect(inicioSemana('2026-05-18')).toBe('2026-05-18');
  });
});

describe('expandirRecorrente', () => {
  it('returns one occurrence per month within window', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 5,
      inicio: '2026-05-01',
      fim: null,
    }, { de: '2026-05-01', ate: '2026-07-31' });
    expect(ocorrencias).toEqual(['2026-05-05', '2026-06-05', '2026-07-05']);
  });

  it('clamps day 31 to last day of month for February', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 31,
      inicio: '2026-01-01',
      fim: null,
    }, { de: '2026-01-01', ate: '2026-03-31' });
    expect(ocorrencias).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('respects inicio (no occurrences before)', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 15,
      inicio: '2026-06-01',
      fim: null,
    }, { de: '2026-05-01', ate: '2026-07-31' });
    expect(ocorrencias).toEqual(['2026-06-15', '2026-07-15']);
  });

  it('respects fim (no occurrences after)', () => {
    const ocorrencias = expandirRecorrente({
      dia_do_mes: 10,
      inicio: '2026-05-01',
      fim: '2026-06-15',
    }, { de: '2026-05-01', ate: '2026-08-31' });
    expect(ocorrencias).toEqual(['2026-05-10', '2026-06-10']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/lib/financeiro/__tests__/cashflow-format.test.ts
```

Expected: FAIL (`Cannot find module '../cashflow-format'`)

- [ ] **Step 3: Implementar `src/lib/financeiro/cashflow-format.ts`**

```typescript
/**
 * Helpers de formatação e expansão pro módulo de cashflow.
 * Todos timezone-agnostic (operam em ISO strings YYYY-MM-DD).
 */

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatSemana(isoDate: string): string {
  const [, mm, dd] = isoDate.split('-');
  return `${dd}/${mm}`;
}

export function formatBRL(value: number): string {
  return BRL.format(value);
}

export function formatDelta(value: number): string {
  if (value === 0) return formatBRL(0);
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatBRL(value)}`;
}

/**
 * Segunda-feira da semana ISO da data informada.
 * ISO weeks start on Monday.
 */
export function inicioSemana(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=domingo, 1=segunda, ..., 6=sábado
  const diff = day === 0 ? -6 : 1 - day; // dom→-6, seg→0, ter→-1, ...
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

type Recorrente = { dia_do_mes: number; inicio: string; fim: string | null };
type Janela = { de: string; ate: string };

function ultimoDiaMes(ano: number, mes1: number): number {
  // mes1 = 1..12
  return new Date(Date.UTC(ano, mes1, 0)).getUTCDate();
}

export function expandirRecorrente(rec: Recorrente, janela: Janela): string[] {
  const result: string[] = [];
  const start = new Date((rec.inicio > janela.de ? rec.inicio : janela.de) + 'T00:00:00Z');
  const end = new Date(janela.ate + 'T00:00:00Z');
  const fim = rec.fim ? new Date(rec.fim + 'T00:00:00Z') : null;

  let ano = start.getUTCFullYear();
  let mes1 = start.getUTCMonth() + 1; // 1..12

  while (true) {
    const dia = Math.min(rec.dia_do_mes, ultimoDiaMes(ano, mes1));
    const candidato = new Date(Date.UTC(ano, mes1 - 1, dia));
    if (candidato > end) break;
    if (candidato >= start && (!fim || candidato <= fim)) {
      result.push(candidato.toISOString().slice(0, 10));
    }
    mes1++;
    if (mes1 > 12) { mes1 = 1; ano++; }
  }

  return result;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun test src/lib/financeiro/__tests__/cashflow-format.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/cashflow-format.ts src/lib/financeiro/__tests__/cashflow-format.test.ts
git commit -m "feat(financeiro): helpers cashflow-format (BRL, semana, expansão recorrente)"
```

### Task 0.2: Helper `lib/financeiro/ncg-helpers.ts`

**Files:**
- Create: `src/lib/financeiro/ncg-helpers.ts`
- Test: `src/lib/financeiro/__tests__/ncg-helpers.test.ts`

- [ ] **Step 1: Criar teste**

```typescript
import { describe, it, expect } from 'vitest';
import { classificarCR, classificarCP, calcularACO, calcularPCO } from '../ncg-helpers';

describe('classificarCR', () => {
  it('aberto sempre conta pra ACO', () => {
    expect(classificarCR({ saldo: 100, status_titulo: 'ABERTO' })).toBe('aco_cr_aberto');
  });
  it('liquidado não conta', () => {
    expect(classificarCR({ saldo: 0, status_titulo: 'LIQUIDADO' })).toBe('nenhum');
  });
});

describe('classificarCP', () => {
  it('categoria adiantamento classifica como ACO', () => {
    expect(classificarCP(
      { saldo: 500, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },
      ['2.01.01']
    )).toBe('aco_adiantamento');
  });
  it('categoria de imposto vai pra PCO tributos', () => {
    expect(classificarCP(
      { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.99.01' },
      []
    )).toBe('pco_cp_fornecedor'); // sem mapping ainda — fallback fornecedor
  });
  it('aberto comum vai pra PCO fornecedor', () => {
    expect(classificarCP(
      { saldo: 200, status_titulo: 'ABERTO', categoria_codigo: '3.01.01' },
      []
    )).toBe('pco_cp_fornecedor');
  });
});

describe('calcularACO', () => {
  it('soma CR aberto + estoque + adiantamentos', () => {
    const aco = calcularACO({
      crs: [
        { saldo: 1000, status_titulo: 'ABERTO' },
        { saldo: 500, status_titulo: 'ABERTO' },
      ],
      cps: [
        { saldo: 300, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },
      ],
      adiantamento_categorias_codigos: ['2.01.01'],
      estoque_valor: 2000,
    });
    expect(aco.cr_aberto).toBe(1500);
    expect(aco.estoque).toBe(2000);
    expect(aco.adiantamentos).toBe(300);
    expect(aco.total).toBe(3800);
  });
});

describe('calcularPCO', () => {
  it('soma CP fornecedor (exceto adiantamentos) + folha + tributos', () => {
    const pco = calcularPCO({
      cps: [
        { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.01.01' }, // fornecedor
        { saldo: 200, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' }, // adiantamento (não conta)
      ],
      adiantamento_categorias_codigos: ['2.01.01'],
      folha_30d: 50000,
      tributos_30d: 8000,
    });
    expect(pco.cp_fornecedor).toBe(1000);
    expect(pco.folha_30d).toBe(50000);
    expect(pco.tributos_a_pagar).toBe(8000);
    expect(pco.total).toBe(59000);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/lib/financeiro/__tests__/ncg-helpers.test.ts
```

- [ ] **Step 3: Implementar `src/lib/financeiro/ncg-helpers.ts`**

```typescript
type CR = { saldo: number; status_titulo: string };
type CP = { saldo: number; status_titulo: string; categoria_codigo: string | null };

export type ClassificacaoCR = 'aco_cr_aberto' | 'nenhum';
export type ClassificacaoCP =
  | 'aco_adiantamento'
  | 'pco_cp_fornecedor'
  | 'pco_tributos'
  | 'nenhum';

export function classificarCR(cr: CR): ClassificacaoCR {
  const aberto = ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(cr.status_titulo);
  if (aberto && cr.saldo > 0) return 'aco_cr_aberto';
  return 'nenhum';
}

export function classificarCP(
  cp: CP,
  adiantamento_codigos: string[],
): ClassificacaoCP {
  const aberto = ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(cp.status_titulo);
  if (!aberto || cp.saldo <= 0) return 'nenhum';
  if (cp.categoria_codigo && adiantamento_codigos.includes(cp.categoria_codigo)) {
    return 'aco_adiantamento';
  }
  return 'pco_cp_fornecedor';
}

export type ACO = {
  cr_aberto: number;
  estoque: number;
  adiantamentos: number;
  total: number;
};

export type PCO = {
  cp_fornecedor: number;
  folha_30d: number;
  tributos_a_pagar: number;
  total: number;
};

export function calcularACO(input: {
  crs: CR[];
  cps: CP[];
  adiantamento_categorias_codigos: string[];
  estoque_valor: number;
}): ACO {
  let cr_aberto = 0;
  for (const cr of input.crs) {
    if (classificarCR(cr) === 'aco_cr_aberto') cr_aberto += cr.saldo;
  }
  let adiantamentos = 0;
  for (const cp of input.cps) {
    if (classificarCP(cp, input.adiantamento_categorias_codigos) === 'aco_adiantamento') {
      adiantamentos += cp.saldo;
    }
  }
  const total = cr_aberto + input.estoque_valor + adiantamentos;
  return { cr_aberto, estoque: input.estoque_valor, adiantamentos, total };
}

export function calcularPCO(input: {
  cps: CP[];
  adiantamento_categorias_codigos: string[];
  folha_30d: number;
  tributos_30d: number;
}): PCO {
  let cp_fornecedor = 0;
  for (const cp of input.cps) {
    if (classificarCP(cp, input.adiantamento_categorias_codigos) === 'pco_cp_fornecedor') {
      cp_fornecedor += cp.saldo;
    }
  }
  const total = cp_fornecedor + input.folha_30d + input.tributos_30d;
  return {
    cp_fornecedor,
    folha_30d: input.folha_30d,
    tributos_a_pagar: input.tributos_30d,
    total,
  };
}
```

- [ ] **Step 4: Rodar teste**

```bash
bun test src/lib/financeiro/__tests__/ncg-helpers.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/ncg-helpers.ts src/lib/financeiro/__tests__/ncg-helpers.test.ts
git commit -m "feat(financeiro): helpers ncg (classificação CR/CP, cálculo ACO/PCO)"
```

---

## Phase 1: Schema (5 tabelas + audit/lock attach)

### Task 1.1: Migration `fin_eventos_recorrentes` + `fin_eventos_eventuais`

**Files:**
- Create: `supabase/migrations/20260519000000_fin_a1_eventos.sql`

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- A1 — Eventos recorrentes e eventuais pro cashflow
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_eventos_recorrentes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria_dre   text CHECK (categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  is_folha        boolean NOT NULL DEFAULT false,
  dia_do_mes      integer NOT NULL CHECK (dia_do_mes BETWEEN 1 AND 31),
  inicio          date NOT NULL,
  fim             date,
  ativo           boolean NOT NULL DEFAULT true,
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_eventos_rec_company_ativo_idx
  ON fin_eventos_recorrentes (company, ativo);
CREATE INDEX IF NOT EXISTS fin_eventos_rec_categoria_idx
  ON fin_eventos_recorrentes (categoria_dre);

ALTER TABLE fin_eventos_recorrentes ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_eventos_rec_select_staff ON fin_eventos_recorrentes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_eventos_rec_write_staff ON fin_eventos_recorrentes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_eventos_recorrentes IS
  'Eventos que se repetem mensalmente (folha, aluguel, pró-labore, dividendo). Usados pra projetar cashflow 13s.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_eventos_eventuais (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  descricao       text NOT NULL,
  valor           numeric(15,2) NOT NULL,
  tipo            text NOT NULL CHECK (tipo IN ('entrada','saida')),
  categoria_dre   text CHECK (categoria_dre IS NULL OR categoria_dre IN (
    'receita_bruta','deducoes','cmv',
    'despesas_operacionais','despesas_administrativas','despesas_comerciais',
    'despesas_financeiras','receitas_financeiras',
    'outras_receitas','outras_despesas','impostos'
  )),
  data_prevista   date NOT NULL,
  data_realizada  date,
  status          text NOT NULL CHECK (status IN ('previsto','confirmado','cancelado','realizado'))
                  DEFAULT 'previsto',
  observacao      text,
  criado_por      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_eventos_ev_company_data_idx
  ON fin_eventos_eventuais (company, data_prevista);
CREATE INDEX IF NOT EXISTS fin_eventos_ev_status_idx
  ON fin_eventos_eventuais (status, company);

ALTER TABLE fin_eventos_eventuais ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_eventos_ev_select_staff ON fin_eventos_eventuais
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_eventos_ev_write_staff ON fin_eventos_eventuais
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_eventos_eventuais IS
  'Eventos pontuais (aporte, compra de máquina, empréstimo). Status: previsto → confirmado → realizado (ou cancelado).';
```

- [ ] **Step 2: Commit (modo files-only — user aplica depois)**

```bash
git add supabase/migrations/20260519000000_fin_a1_eventos.sql
git commit -m "feat(financeiro a1): tabelas fin_eventos_recorrentes + fin_eventos_eventuais"
```

### Task 1.2: Migration `fin_projecao_snapshots` + `fin_alertas` + `fin_config_cashflow`

**Files:**
- Create: `supabase/migrations/20260519000100_fin_a1_snapshots_alertas_config.sql`

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- A1 — Snapshots de projeção, alertas, config
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_projecao_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  snapshot_at     timestamptz NOT NULL DEFAULT now(),
  cenario         text NOT NULL CHECK (cenario IN ('realista','otimista','pessimista')),
  horizon_weeks   integer NOT NULL DEFAULT 13,
  dados           jsonb NOT NULL,
  ncg             numeric(15,2),
  capital_giro_proprio numeric(15,2),
  saldo_tesouraria numeric(15,2),
  dias_cobertura  numeric(10,2),
  premissas       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS fin_proj_company_snap_idx
  ON fin_projecao_snapshots (company, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS fin_proj_cenario_idx
  ON fin_projecao_snapshots (cenario, snapshot_at DESC);

ALTER TABLE fin_projecao_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_proj_select_staff ON fin_projecao_snapshots
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

-- Escrita só via edge function (SECURITY DEFINER) ou service_role.
-- Nenhuma policy de INSERT/UPDATE/DELETE para usuários.

COMMENT ON TABLE fin_projecao_snapshots IS
  'Snapshot diário (via cron) da projeção 13s + NCG + indicadores. Permite trend e comparação histórica.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_alertas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  tipo            text NOT NULL,
  severidade      text NOT NULL CHECK (severidade IN ('info','aviso','critico')),
  mensagem        text NOT NULL,
  valor           numeric(15,2),
  threshold       numeric(15,2),
  contexto        jsonb,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  dismissed_at    timestamptz,
  dismissed_by    uuid REFERENCES auth.users(id),
  dismissed_until timestamptz
);

CREATE INDEX IF NOT EXISTS fin_alertas_company_criado_idx
  ON fin_alertas (company, criado_em DESC) WHERE dismissed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS fin_alertas_unique_ativo
  ON fin_alertas (company, tipo) WHERE dismissed_at IS NULL;

ALTER TABLE fin_alertas ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_alertas_select_staff ON fin_alertas
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_alertas_update_staff ON fin_alertas
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

COMMENT ON TABLE fin_alertas IS
  'Alertas avaliados pela engine. UNIQUE em (company, tipo) WHERE dismissed_at IS NULL evita spam.';

-- ============================================================

CREATE TABLE IF NOT EXISTS fin_config_cashflow (
  company         text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  overrides_cenario jsonb NOT NULL DEFAULT '{
    "otimista":   {"recebimento_no_prazo_pct_delta": 10, "inadimplencia_pct_delta": -50},
    "pessimista": {"recebimento_no_prazo_pct_delta": -15, "inadimplencia_pct_delta": 50}
  }'::jsonb,
  thresholds      jsonb NOT NULL DEFAULT '{
    "caixa_negativo_semanas": 4,
    "ncg_deficit_alerta": 0,
    "dias_cobertura_min": 30,
    "inadimplencia_max_pct": 10,
    "concentracao_top1_max_pct": 20,
    "pmr_crescimento_max_pct_90d": 15
  }'::jsonb,
  adiantamento_categorias_codigos text[] NOT NULL DEFAULT '{}'::text[],
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id)
);

ALTER TABLE fin_config_cashflow ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_config_select_staff ON fin_config_cashflow
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_config_write_master ON fin_config_cashflow
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

-- Seed: 3 linhas com defaults pra cada empresa
INSERT INTO fin_config_cashflow (company) VALUES
  ('oben'), ('colacor'), ('colacor_sc')
ON CONFLICT (company) DO NOTHING;

COMMENT ON TABLE fin_config_cashflow IS
  'Config por empresa: thresholds de alertas + overrides de cenário + categorias de adiantamento.';
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260519000100_fin_a1_snapshots_alertas_config.sql
git commit -m "feat(financeiro a1): tabelas fin_projecao_snapshots + fin_alertas + fin_config_cashflow"
```

### Task 1.3: Anexar audit + period lock nas 4 tabelas que precisam

**Files:**
- Create: `supabase/migrations/20260519000200_fin_a1_audit_lock_attach.sql`

> Por que `fin_projecao_snapshots` fica fora? Porque é write-only pelo cron, não tem audit por linha (audit do snapshot estaria em outra camada — futuro).
> Por que `fin_eventos_eventuais` tem period lock baseado em `data_prevista`? Porque editar uma previsão passada altera retroativamente a projeção daquele período já fechado.

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- A1 — Audit + Period Lock attach nas 4 tabelas que precisam
-- ============================================================

-- Audit: aplicado em todas as 4 tabelas auditáveis
DROP TRIGGER IF EXISTS trg_audit ON fin_eventos_recorrentes;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eventos_recorrentes
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_eventos_eventuais;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eventos_eventuais
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_alertas;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_alertas
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_config_cashflow;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_config_cashflow
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

-- ============================================================
-- Period Lock: aplicado em eventos que afetam período fechado
-- fin_eventos_recorrentes: data-chave = inicio (mudança no inicio em período fechado bloqueia)
-- fin_eventos_eventuais: data-chave = data_prevista
-- ============================================================

-- A função fin_period_lock_trigger() atual NÃO conhece as novas tabelas.
-- Estendemos a função pra incluir os 2 novos casos.
-- (Mantemos os casos existentes intactos — só adicionamos.)

CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_date date;
  v_target_company text;
  v_last_closed_year int;
  v_last_closed_month int;
  v_last_closed_date date;
  v_has_override boolean;
  v_bypass text := current_setting('fin.bypass_lock', true);
BEGIN
  IF v_bypass = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_target_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company'
  );

  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'          THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'         THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
    -- A1: novos casos
    WHEN 'fin_eventos_recorrentes'   THEN COALESCE((NEW).inicio, (OLD).inicio)
    WHEN 'fin_eventos_eventuais'     THEN COALESCE((NEW).data_prevista, (OLD).data_prevista)
  END;

  -- INSERT em mapping ou eventos recorrentes/eventuais sempre passa (criação livre)
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping',
    'fin_eventos_recorrentes',
    'fin_eventos_eventuais'
  ) THEN
    RETURN NEW;
  END IF;

  IF v_target_date IS NULL OR v_target_company IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company
     AND status = 'fechado'
     AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now()
       AND closed_at IS NULL
       AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date),
    v_target_company,
    v_last_closed_date
    USING ERRCODE = 'P0001';
END $$;

-- Anexar trigger nas 2 tabelas novas (BEFORE UPDATE/DELETE só)
DROP TRIGGER IF EXISTS trg_period_lock ON fin_eventos_recorrentes;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_eventos_recorrentes
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_eventos_eventuais;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_eventos_eventuais
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260519000200_fin_a1_audit_lock_attach.sql
git commit -m "feat(financeiro a1): anexa audit + period lock nas tabelas A1 + estende função lock"
```

### Task 1.4: Smoke test SQL pras 5 tabelas

**Files:**
- Create: `supabase/tests/fin_a1_schema_smoke.sql`

- [ ] **Step 1: Criar smoke test**

```sql
-- Smoke: A1 schema funciona ponta a ponta
-- Rodar com: psql ou Supabase SQL Editor
-- Tudo em BEGIN/ROLLBACK pra não deixar lixo.

BEGIN;

-- 1. Insert evento recorrente
INSERT INTO fin_eventos_recorrentes (
  company, descricao, valor, tipo, categoria_dre, is_folha,
  dia_do_mes, inicio
) VALUES (
  'colacor', 'Folha de pagamento', 50000, 'saida', 'despesas_administrativas', true,
  5, '2026-05-01'
);

-- 2. Insert evento eventual
INSERT INTO fin_eventos_eventuais (
  company, descricao, valor, tipo, data_prevista, status
) VALUES (
  'colacor', 'Aporte sócio', 100000, 'entrada', '2026-08-01', 'previsto'
);

-- 3. Insert alerta + tenta inserir duplicado (deve falhar por UNIQUE)
INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 1');

DO $$
BEGIN
  BEGIN
    INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
    VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 2');
    RAISE EXCEPTION 'EXPECTED_FAILURE: unique constraint não bloqueou alerta duplicado';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: unique constraint bloqueou alerta duplicado conforme esperado';
  END;
END $$;

-- 4. Dismiss um alerta e tenta inserir mesmo tipo (deve permitir)
UPDATE fin_alertas SET dismissed_at = now()
 WHERE company = 'colacor' AND tipo = 'caixa_negativo';

INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
VALUES ('colacor', 'caixa_negativo', 'critico', 'teste 3 após dismiss');

-- 5. Config seed deve ter 3 linhas
SELECT COUNT(*) AS qtd_config FROM fin_config_cashflow;
-- Expected: 3

-- 6. Audit trail deve ter capturado as inserções
SELECT table_name, COUNT(*) AS qtd
  FROM fin_audit_log
 WHERE table_name IN ('fin_eventos_recorrentes', 'fin_eventos_eventuais',
                      'fin_alertas', 'fin_config_cashflow')
   AND op = 'INSERT'
   AND changed_at > now() - interval '1 minute'
 GROUP BY table_name
 ORDER BY table_name;
-- Expected: 4 linhas

ROLLBACK;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/tests/fin_a1_schema_smoke.sql
git commit -m "test(financeiro a1): smoke SQL schema + audit + unique alertas"
```

### Task 1.5: Pipeline + marker fim Phase 1

- [ ] **Step 1: Pipeline geral**

```bash
bun lint && bun build && bun test src/lib/financeiro/__tests__/
```

Expected: lint OK (warnings pré-existentes), build verde, tests novos (Phase 0) passando.

- [ ] **Step 2: Marker commit**

```bash
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 1] Schema A1 completo"
```

---

## Phase 2: Engine `fin-cashflow-engine`

### Task 2.1: Skeleton da edge function + auth

**Files:**
- Create: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Criar arquivo com skeleton**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Company = 'oben' | 'colacor' | 'colacor_sc';
type Cenario = 'realista' | 'otimista' | 'pessimista';

type Input = {
  company: Company;
  cenario?: Cenario;
  horizon_weeks?: number;
  save_snapshot?: boolean;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  let payload: Input;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  if (!payload.company || !['oben', 'colacor', 'colacor_sc'].includes(payload.company)) {
    return jsonResponse({ error: 'company inválido' }, 400);
  }

  const cenario: Cenario = payload.cenario ?? 'realista';
  const horizon = payload.horizon_weeks ?? 13;
  const save = payload.save_snapshot ?? false;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const result = await calcular(supabase, payload.company, cenario, horizon, save);
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: String((err as Error).message ?? err) }, 500);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// === Pipeline (será implementada nas próximas tasks) ===
async function calcular(
  _supabase: ReturnType<typeof createClient>,
  _company: Company,
  _cenario: Cenario,
  _horizon: number,
  _save: boolean,
) {
  // TODO: Phase 2.2-2.9
  return { ok: true, todo: 'pipeline' };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): skeleton fin-cashflow-engine + auth + input validation"
```

### Task 2.2: Carregar dados base (CR/CP/saldo/estoque/eventos/config)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar tipos e função `carregarDados`**

Substitui o `calcular` stub anterior por:

```typescript
type CR = {
  id: string;
  saldo: number;
  valor_documento: number;
  valor_recebido: number;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_recebimento: string | null;
  status_titulo: string;
  cliente_id: string | null;
  nome_cliente: string | null;
  categoria_codigo: string | null;
};

type CP = {
  id: string;
  saldo: number;
  valor_documento: number;
  valor_pago: number;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status_titulo: string;
  categoria_codigo: string | null;
};

type EventoRecorrente = {
  id: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  is_folha: boolean;
  dia_do_mes: number;
  inicio: string;
  fim: string | null;
};

type EventoEventual = {
  id: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  data_prevista: string;
  status: 'previsto' | 'confirmado' | 'cancelado' | 'realizado';
};

type Config = {
  overrides_cenario: {
    otimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
    pessimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
  };
  thresholds: {
    caixa_negativo_semanas: number;
    ncg_deficit_alerta: number;
    dias_cobertura_min: number;
    inadimplencia_max_pct: number;
    concentracao_top1_max_pct: number;
    pmr_crescimento_max_pct_90d: number;
  };
  adiantamento_categorias_codigos: string[];
};

type DadosBase = {
  crs: CR[];
  cps: CP[];
  saldo_cc: number;
  estoque_valor: number;
  eventos_rec: EventoRecorrente[];
  eventos_ev: EventoEventual[];
  config: Config;
};

async function carregarDados(
  supabase: ReturnType<typeof createClient>,
  company: Company,
): Promise<DadosBase> {
  const [crsRes, cpsRes, ccRes, recRes, evRes, configRes] = await Promise.all([
    supabase.from('fin_contas_receber').select('id, saldo, valor_documento, valor_recebido, data_emissao, data_vencimento, data_recebimento, status_titulo, omie_codigo_cliente, nome_cliente, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
    supabase.from('fin_contas_pagar').select('id, saldo, valor_documento, valor_pago, data_emissao, data_vencimento, data_pagamento, status_titulo, categoria_codigo')
      .eq('company', company)
      .neq('status_titulo', 'CANCELADO'),
    supabase.from('fin_contas_correntes').select('saldo_atual')
      .eq('company', company).eq('ativo', true),
    supabase.from('fin_eventos_recorrentes').select('id, descricao, valor, tipo, categoria_dre, is_folha, dia_do_mes, inicio, fim')
      .eq('company', company).eq('ativo', true),
    supabase.from('fin_eventos_eventuais').select('id, descricao, valor, tipo, categoria_dre, data_prevista, status')
      .eq('company', company).in('status', ['previsto', 'confirmado']),
    supabase.from('fin_config_cashflow').select('overrides_cenario, thresholds, adiantamento_categorias_codigos')
      .eq('company', company).maybeSingle(),
  ]);

  const saldo_cc = (ccRes.data ?? []).reduce((s, c) => s + Number((c as { saldo_atual?: number }).saldo_atual ?? 0), 0);

  // Estoque: tenta tabela fin_estoque_resumo ou similar. Por enquanto: 0 com warning.
  // (Phase 2.X futura pode integrar estoque real. Por ora, founder pode setar manualmente via config.)
  const estoque_valor = 0;

  if (!configRes.data) {
    throw new Error(`Config ausente pra ${company}. Aplique seed em fin_config_cashflow.`);
  }

  return {
    crs: (crsRes.data ?? []).map(c => ({
      id: c.id as string,
      saldo: Number(c.saldo ?? 0),
      valor_documento: Number(c.valor_documento ?? 0),
      valor_recebido: Number(c.valor_recebido ?? 0),
      data_emissao: c.data_emissao as string | null,
      data_vencimento: c.data_vencimento as string | null,
      data_recebimento: c.data_recebimento as string | null,
      status_titulo: c.status_titulo as string,
      cliente_id: c.omie_codigo_cliente ? String(c.omie_codigo_cliente) : null,
      nome_cliente: c.nome_cliente as string | null,
      categoria_codigo: c.categoria_codigo as string | null,
    })),
    cps: (cpsRes.data ?? []).map(c => ({
      id: c.id as string,
      saldo: Number(c.saldo ?? 0),
      valor_documento: Number(c.valor_documento ?? 0),
      valor_pago: Number(c.valor_pago ?? 0),
      data_emissao: c.data_emissao as string | null,
      data_vencimento: c.data_vencimento as string | null,
      data_pagamento: c.data_pagamento as string | null,
      status_titulo: c.status_titulo as string,
      categoria_codigo: c.categoria_codigo as string | null,
    })),
    saldo_cc,
    estoque_valor,
    eventos_rec: (recRes.data ?? []) as EventoRecorrente[],
    eventos_ev: (evRes.data ?? []) as EventoEventual[],
    config: configRes.data as Config,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): carregarDados — CR/CP/saldo/estoque/eventos/config paralelo"
```

### Task 2.3: Calcular taxas históricas (atraso + inadimplência)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `calcularTaxasHistoricas`**

Append no arquivo:

```typescript
type TaxasHistoricas = {
  atraso_medio_dias: number;
  inadimplencia_observada_pct: number;
  amostra_suficiente: boolean;
  qtd_titulos: number;
};

function calcularTaxasHistoricas(crs: CR[]): TaxasHistoricas {
  const agora = Date.now();
  const noventa = 90 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(agora - 12 * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const recentes = crs.filter(c =>
    c.data_vencimento && c.data_vencimento >= cutoff
  );

  // Atraso médio entre títulos liquidados
  const liquidados = recentes.filter(c => c.data_recebimento && c.data_vencimento);
  let somaAtraso = 0;
  for (const c of liquidados) {
    const venc = new Date(c.data_vencimento!).getTime();
    const rec = new Date(c.data_recebimento!).getTime();
    somaAtraso += Math.max(0, (rec - venc) / (24 * 60 * 60 * 1000));
  }
  const atraso_medio_dias = liquidados.length > 0 ? somaAtraso / liquidados.length : 0;

  // Inadimplência = saldo vencido > 90d / faturamento_12m
  const vencidoLongo = recentes.filter(c =>
    c.data_vencimento &&
    c.saldo > 0 &&
    (agora - new Date(c.data_vencimento).getTime()) > noventa
  ).reduce((s, c) => s + c.saldo, 0);

  const faturamento12m = recentes.reduce((s, c) => s + c.valor_documento, 0);
  const inadimplencia_observada_pct = faturamento12m > 0
    ? (vencidoLongo / faturamento12m) * 100
    : 0;

  return {
    atraso_medio_dias,
    inadimplencia_observada_pct,
    amostra_suficiente: liquidados.length >= 30,
    qtd_titulos: liquidados.length,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): calcularTaxasHistoricas (atraso médio + inadimplência observada)"
```

### Task 2.4: Aplicar cenário (deltas)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `aplicarCenario`**

```typescript
type PremissasAplicadas = {
  inadimplencia_pct: number;
  atraso_medio_dias: number;
  overrides_cenario: Record<string, unknown>;
};

function aplicarCenario(
  taxas: TaxasHistoricas,
  cenario: Cenario,
  config: Config,
): PremissasAplicadas {
  if (cenario === 'realista') {
    return {
      inadimplencia_pct: taxas.inadimplencia_observada_pct,
      atraso_medio_dias: taxas.atraso_medio_dias,
      overrides_cenario: {},
    };
  }

  const overrides = config.overrides_cenario[cenario];
  // delta vem em pct relativo: +10 = +10% sobre o valor base
  const inadAjustado = taxas.inadimplencia_observada_pct * (1 + overrides.inadimplencia_pct_delta / 100);
  // Atraso: otimista REDUZ atraso, pessimista AUMENTA. Usamos -delta no atraso pra inverter.
  const atrasoAjustado = taxas.atraso_medio_dias * (1 - overrides.recebimento_no_prazo_pct_delta / 100);

  return {
    inadimplencia_pct: Math.max(0, inadAjustado),
    atraso_medio_dias: Math.max(0, atrasoAjustado),
    overrides_cenario: overrides as Record<string, unknown>,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): aplicarCenario com deltas de inadimplência e atraso"
```

### Task 2.5: Loop de semanas (entradas/saídas/saldo)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `gerarSemanas` + helpers de data**

```typescript
type LinhaCashflow = {
  origem: 'cr_omie' | 'cp_omie' | 'evento_recorrente' | 'evento_eventual';
  desc: string;
  data: string;
  valor: number;
  id_origem: string;
};

type Semana = {
  inicio: string;
  fim: string;
  saldo_inicial: number;
  entradas: LinhaCashflow[];
  saidas: LinhaCashflow[];
  total_entradas: number;
  total_saidas: number;
  saldo_final: number;
};

function inicioSemanaUTC(isoDate: string): string {
  // ISO week: Monday start
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function expandirRecorrenteDeno(
  rec: EventoRecorrente,
  de: string,
  ate: string,
): string[] {
  const result: string[] = [];
  const startBase = rec.inicio > de ? rec.inicio : de;
  const start = new Date(startBase + 'T00:00:00Z');
  const end = new Date(ate + 'T00:00:00Z');
  const fim = rec.fim ? new Date(rec.fim + 'T00:00:00Z') : null;

  let ano = start.getUTCFullYear();
  let mes1 = start.getUTCMonth() + 1;
  while (true) {
    const ultimoDia = new Date(Date.UTC(ano, mes1, 0)).getUTCDate();
    const dia = Math.min(rec.dia_do_mes, ultimoDia);
    const candidato = new Date(Date.UTC(ano, mes1 - 1, dia));
    if (candidato > end) break;
    if (candidato >= start && (!fim || candidato <= fim)) {
      result.push(candidato.toISOString().slice(0, 10));
    }
    mes1++;
    if (mes1 > 12) { mes1 = 1; ano++; }
  }
  return result;
}

function gerarSemanas(
  dados: DadosBase,
  premissas: PremissasAplicadas,
  horizon: number,
): Semana[] {
  const hoje = new Date().toISOString().slice(0, 10);
  const semanaInicio = inicioSemanaUTC(hoje);

  const semanas: Semana[] = [];
  let saldoAtual = dados.saldo_cc;

  for (let i = 0; i < horizon; i++) {
    const inicio = addDays(semanaInicio, i * 7);
    const fim = addDays(inicio, 6);

    const entradas: LinhaCashflow[] = [];
    const saidas: LinhaCashflow[] = [];

    // CR vencendo na semana (aplicar inadimplência)
    for (const cr of dados.crs) {
      if (!cr.data_vencimento || cr.saldo <= 0) continue;
      if (cr.data_vencimento < inicio || cr.data_vencimento > fim) continue;
      const valorAjustado = cr.saldo * (1 - premissas.inadimplencia_pct / 100);
      entradas.push({
        origem: 'cr_omie',
        desc: cr.nome_cliente || 'Cliente',
        data: cr.data_vencimento,
        valor: valorAjustado,
        id_origem: cr.id,
      });
    }

    // CP vencendo na semana (sem ajuste — esperamos pagar tudo)
    for (const cp of dados.cps) {
      if (!cp.data_vencimento || cp.saldo <= 0) continue;
      if (cp.data_vencimento < inicio || cp.data_vencimento > fim) continue;
      saidas.push({
        origem: 'cp_omie',
        desc: cp.categoria_codigo || 'Fornecedor',
        data: cp.data_vencimento,
        valor: cp.saldo,
        id_origem: cp.id,
      });
    }

    // Eventos recorrentes nessa semana
    for (const rec of dados.eventos_rec) {
      const ocorrencias = expandirRecorrenteDeno(rec, inicio, fim);
      for (const dataOc of ocorrencias) {
        const linha: LinhaCashflow = {
          origem: 'evento_recorrente',
          desc: rec.descricao,
          data: dataOc,
          valor: rec.valor,
          id_origem: rec.id,
        };
        if (rec.tipo === 'entrada') entradas.push(linha);
        else saidas.push(linha);
      }
    }

    // Eventos eventuais nessa semana
    for (const ev of dados.eventos_ev) {
      if (ev.data_prevista < inicio || ev.data_prevista > fim) continue;
      const linha: LinhaCashflow = {
        origem: 'evento_eventual',
        desc: ev.descricao,
        data: ev.data_prevista,
        valor: ev.valor,
        id_origem: ev.id,
      };
      if (ev.tipo === 'entrada') entradas.push(linha);
      else saidas.push(linha);
    }

    const total_entradas = entradas.reduce((s, l) => s + l.valor, 0);
    const total_saidas = saidas.reduce((s, l) => s + l.valor, 0);
    const saldo_final = saldoAtual + total_entradas - total_saidas;

    semanas.push({
      inicio, fim,
      saldo_inicial: saldoAtual,
      entradas, saidas,
      total_entradas, total_saidas,
      saldo_final,
    });

    saldoAtual = saldo_final;
  }

  return semanas;
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): gerarSemanas — loop 13 semanas com CR/CP/eventos + inadimplência"
```

### Task 2.6: Calcular NCG (ACO/PCO + projeção 12m)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `calcularNCG`**

```typescript
type NCG = {
  aco: { cr_aberto: number; estoque: number; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
  projecao_12m: Array<{ mes: string; valor: number }>;
};

function calcularNCG(dados: DadosBase): NCG {
  // ACO
  const cr_aberto = dados.crs
    .filter(c => ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) && c.saldo > 0)
    .reduce((s, c) => s + c.saldo, 0);
  const adiantamentos = dados.cps
    .filter(c =>
      c.categoria_codigo &&
      dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo) &&
      ['ABERTO', 'PARCIAL'].includes(c.status_titulo) &&
      c.saldo > 0
    )
    .reduce((s, c) => s + c.saldo, 0);
  const aco = {
    cr_aberto,
    estoque: dados.estoque_valor,
    adiantamentos,
    total: cr_aberto + dados.estoque_valor + adiantamentos,
  };

  // PCO
  const cp_fornecedor = dados.cps
    .filter(c =>
      ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) &&
      c.saldo > 0 &&
      (!c.categoria_codigo || !dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo))
    )
    .reduce((s, c) => s + c.saldo, 0);

  // Folha próx 30d: soma 1 ocorrência por mês de eventos recorrentes com is_folha=true
  const folha_30d = dados.eventos_rec
    .filter(e => e.is_folha && e.tipo === 'saida')
    .reduce((s, e) => s + e.valor, 0);

  // Tributos a pagar: CPs com categoria_dre mapeada como 'impostos' (via fin_categoria_dre_mapping seria ideal,
  // mas pra simplificar: usa categoria_codigo via prefixo "3.99" (convenção comum) ou marcador na config futuro)
  const tributos_a_pagar = dados.cps
    .filter(c =>
      ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) &&
      c.saldo > 0 &&
      c.categoria_codigo && c.categoria_codigo.startsWith('3.99')
    )
    .reduce((s, c) => s + c.saldo, 0);

  const pco = {
    cp_fornecedor,
    folha_30d,
    tributos_a_pagar,
    total: cp_fornecedor + folha_30d + tributos_a_pagar,
  };

  const valor = aco.total - pco.total;

  // Projeção 12m: extrapolação simples (taxa de crescimento ~0% por padrão, sem DRE comp histórico aqui)
  // Versão MVP: replica valor atual nos 12 meses. Futuro: aplicar growth rate observado.
  const hoje = new Date();
  const projecao_12m: Array<{ mes: string; valor: number }> = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    projecao_12m.push({
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      valor,
    });
  }

  return { aco, pco, valor, projecao_12m };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): calcularNCG — ACO/PCO + projeção 12m (MVP linear)"
```

### Task 2.7: Indicadores derivados (PMR/PMP/CCC/concentração)

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `calcularIndicadores`**

```typescript
type Indicadores = {
  dias_cobertura: number;
  capital_giro_proprio: number;
  saldo_tesouraria: number;
  inadimplencia_pct: number;
  concentracao_top5_clientes: Array<{ cliente: string; pct: number; valor: number }>;
  prazo_medio_recebimento: number;
  prazo_medio_pagamento: number;
  cash_conversion_cycle: number;
};

function calcularIndicadores(
  dados: DadosBase,
  ncg: NCG,
  taxas: TaxasHistoricas,
): Indicadores {
  // Saída média diária = média das saídas reais dos últimos 90 dias
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const saidasUltimos90 = dados.cps
    .filter(c => c.data_pagamento && c.data_pagamento >= cutoff90)
    .reduce((s, c) => s + c.valor_pago, 0);
  const saidaDiariaMedia = saidasUltimos90 / 90;
  const dias_cobertura = saidaDiariaMedia > 0 ? dados.saldo_cc / saidaDiariaMedia : 999;

  const capital_giro_proprio = dados.saldo_cc + ncg.aco.cr_aberto + ncg.aco.estoque - ncg.pco.total;
  const saldo_tesouraria = dados.saldo_cc - ncg.pco.folha_30d;

  // PMR = média de (data_recebimento - data_emissao) em dias
  const crsLiquidados = dados.crs.filter(c => c.data_recebimento && c.data_emissao);
  const pmr = crsLiquidados.length > 0
    ? crsLiquidados.reduce((s, c) => {
        const dias = (new Date(c.data_recebimento!).getTime() - new Date(c.data_emissao!).getTime()) / (24 * 60 * 60 * 1000);
        return s + dias;
      }, 0) / crsLiquidados.length
    : 0;

  const cpsLiquidados = dados.cps.filter(c => c.data_pagamento && c.data_emissao);
  const pmp = cpsLiquidados.length > 0
    ? cpsLiquidados.reduce((s, c) => {
        const dias = (new Date(c.data_pagamento!).getTime() - new Date(c.data_emissao!).getTime()) / (24 * 60 * 60 * 1000);
        return s + dias;
      }, 0) / cpsLiquidados.length
    : 0;

  // CCC = PMR + dias_estoque (placeholder=0 pra MVP) - PMP
  const ccc = pmr - pmp;

  // Top 5 clientes pelo saldo CR aberto
  const porCliente = new Map<string, number>();
  for (const cr of dados.crs) {
    if (cr.saldo <= 0) continue;
    const key = cr.nome_cliente || cr.cliente_id || 'sem cliente';
    porCliente.set(key, (porCliente.get(key) ?? 0) + cr.saldo);
  }
  const totalAberto = ncg.aco.cr_aberto;
  const concentracao_top5_clientes = Array.from(porCliente.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cliente, valor]) => ({
      cliente,
      valor,
      pct: totalAberto > 0 ? (valor / totalAberto) * 100 : 0,
    }));

  return {
    dias_cobertura,
    capital_giro_proprio,
    saldo_tesouraria,
    inadimplencia_pct: taxas.inadimplencia_observada_pct,
    concentracao_top5_clientes,
    prazo_medio_recebimento: pmr,
    prazo_medio_pagamento: pmp,
    cash_conversion_cycle: ccc,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): calcularIndicadores — dias cobertura, PMR/PMP, CCC, concentração"
```

### Task 2.8: Avaliar alertas

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Adicionar função `avaliarAlertas`**

```typescript
type Alerta = {
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  valor: number | null;
  threshold: number | null;
  contexto: Record<string, unknown>;
};

function avaliarAlertas(
  semanas: Semana[],
  ncg: NCG,
  indicadores: Indicadores,
  config: Config,
): Alerta[] {
  const alertas: Alerta[] = [];
  const t = config.thresholds;

  // 1. Caixa negativo em até N semanas
  const semanaNeg = semanas.slice(0, t.caixa_negativo_semanas).findIndex(s => s.saldo_final < 0);
  if (semanaNeg >= 0) {
    const s = semanas[semanaNeg];
    alertas.push({
      tipo: 'caixa_negativo',
      severidade: 'critico',
      mensagem: `Caixa fica negativo em ${s.inicio} (semana ${semanaNeg + 1}): ${formatBRLSimple(s.saldo_final)}`,
      valor: s.saldo_final,
      threshold: 0,
      contexto: { semana: semanaNeg + 1, inicio: s.inicio },
    });
  }

  // 2. NCG > Capital Giro Próprio (déficit)
  if (ncg.valor > indicadores.capital_giro_proprio) {
    const gap = ncg.valor - indicadores.capital_giro_proprio;
    alertas.push({
      tipo: 'ncg_deficit',
      severidade: 'aviso',
      mensagem: `NCG ${formatBRLSimple(ncg.valor)} excede Capital Giro Próprio ${formatBRLSimple(indicadores.capital_giro_proprio)} em ${formatBRLSimple(gap)}. Risco de liquidez.`,
      valor: gap,
      threshold: 0,
      contexto: { ncg: ncg.valor, cgp: indicadores.capital_giro_proprio },
    });
  }

  // 3. Dias cobertura baixo
  if (indicadores.dias_cobertura < t.dias_cobertura_min) {
    alertas.push({
      tipo: 'cobertura_baixa',
      severidade: 'aviso',
      mensagem: `Caixa cobre só ${indicadores.dias_cobertura.toFixed(1)} dias de operação (mín: ${t.dias_cobertura_min})`,
      valor: indicadores.dias_cobertura,
      threshold: t.dias_cobertura_min,
      contexto: {},
    });
  }

  // 4. Inadimplência alta
  if (indicadores.inadimplencia_pct > t.inadimplencia_max_pct) {
    alertas.push({
      tipo: 'inadimplencia_alta',
      severidade: 'aviso',
      mensagem: `Inadimplência ${indicadores.inadimplencia_pct.toFixed(1)}% acima do limite de ${t.inadimplencia_max_pct}%`,
      valor: indicadores.inadimplencia_pct,
      threshold: t.inadimplencia_max_pct,
      contexto: {},
    });
  }

  // 5. Concentração top1
  const top1 = indicadores.concentracao_top5_clientes[0];
  if (top1 && top1.pct > t.concentracao_top1_max_pct) {
    alertas.push({
      tipo: 'concentracao_top1',
      severidade: 'info',
      mensagem: `Cliente "${top1.cliente}" representa ${top1.pct.toFixed(1)}% do CR aberto (limite: ${t.concentracao_top1_max_pct}%)`,
      valor: top1.pct,
      threshold: t.concentracao_top1_max_pct,
      contexto: { cliente: top1.cliente, valor: top1.valor },
    });
  }

  // NOTA: spec original lista 7 alertas — `pmr_subindo` (PMR cresceu >15% em 90d) é
  // deferido pra próximo ciclo porque depende de snapshots históricos (precisa 90d de
  // cron rodando pra ter base de comparação). Será adicionado quando dados existirem.

  // 6. Próxima semana saída > entrada × 2
  const s0 = semanas[0];
  if (s0 && s0.total_entradas > 0 && s0.total_saidas > s0.total_entradas * 2) {
    alertas.push({
      tipo: 'saida_spike',
      severidade: 'info',
      mensagem: `Próxima semana: saídas ${formatBRLSimple(s0.total_saidas)} vs entradas ${formatBRLSimple(s0.total_entradas)}`,
      valor: s0.total_saidas,
      threshold: s0.total_entradas * 2,
      contexto: { semana_inicio: s0.inicio },
    });
  }

  return alertas;
}

function formatBRLSimple(value: number): string {
  // Edge function não tem Intl plenamente. Fallback simples.
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const formatted = abs.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}R$ ${formatted}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): avaliarAlertas — 6 tipos baseados em thresholds da config"
```

### Task 2.9: Persistir alertas + snapshot opcional + montar response

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: Refatorar a função `calcular` pra orquestrar tudo**

Substitui o stub `calcular` por:

```typescript
async function calcular(
  supabase: ReturnType<typeof createClient>,
  company: Company,
  cenario: Cenario,
  horizon: number,
  save: boolean,
) {
  const dados = await carregarDados(supabase, company);
  const taxas = calcularTaxasHistoricas(dados.crs);
  const premissas = aplicarCenario(taxas, cenario, dados.config);
  const semanas = gerarSemanas(dados, premissas, horizon);
  const ncg = calcularNCG(dados);
  const indicadores = calcularIndicadores(dados, ncg, taxas);
  const alertas = avaliarAlertas(semanas, ncg, indicadores, dados.config);

  // Persistir alertas: insere novos (UNIQUE constraint evita duplicados ativos do mesmo tipo)
  for (const a of alertas) {
    await supabase.from('fin_alertas').insert({
      company,
      tipo: a.tipo,
      severidade: a.severidade,
      mensagem: a.mensagem,
      valor: a.valor,
      threshold: a.threshold,
      contexto: a.contexto,
    }).select().maybeSingle(); // ignora erro de unique (alerta ativo do mesmo tipo já existe)
  }

  if (save) {
    await supabase.from('fin_projecao_snapshots').insert({
      company,
      cenario,
      horizon_weeks: horizon,
      dados: semanas as unknown as Record<string, unknown>,
      ncg: ncg.valor,
      capital_giro_proprio: indicadores.capital_giro_proprio,
      saldo_tesouraria: indicadores.saldo_tesouraria,
      dias_cobertura: indicadores.dias_cobertura,
      premissas: premissas as unknown as Record<string, unknown>,
    });
  }

  return {
    semanas,
    ncg,
    indicadores,
    alertas,
    premissas_aplicadas: premissas,
    metadados: {
      cenario,
      horizon,
      amostra_taxas: { suficiente: taxas.amostra_suficiente, qtd_titulos: taxas.qtd_titulos },
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/fin-cashflow-engine/index.ts
git commit -m "feat(financeiro a1): orquestração final calcular() — pipeline completo + persistência"
```

### Task 2.10: Pipeline + marker fim Phase 2

- [ ] **Step 1: Pipeline geral**

```bash
bun lint && bun build && bun test src/lib/financeiro/__tests__/
```

- [ ] **Step 2: Marker commit**

```bash
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 2] Engine fin-cashflow-engine completa"
```

---

## Phase 3: Hooks + Tab Eventos (primeiro user value)

### Task 3.1: Hook `useEventosRecorrentes`

**Files:**
- Create: `src/hooks/useEventosRecorrentes.ts`

- [ ] **Step 1: Implementar**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EventoRecorrente = {
  id: string;
  company: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  is_folha: boolean;
  dia_do_mes: number;
  inicio: string;
  fim: string | null;
  ativo: boolean;
  observacao: string | null;
};

export type EventoRecorrenteInput = Omit<EventoRecorrente, 'id'>;

export function useEventosRecorrentes(company: string) {
  return useQuery({
    queryKey: ['fin_eventos_recorrentes', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<EventoRecorrente[]> => {
      // @ts-expect-error - tabela existe no DB mas types.ts ainda não regenerou
      const { data, error } = await supabase
        .from('fin_eventos_recorrentes')
        .select('*')
        .eq('company', company)
        .order('descricao');
      if (error) throw error;
      return (data ?? []) as unknown as EventoRecorrente[];
    },
  });
}

export function useCreateEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EventoRecorrenteInput) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      // @ts-expect-error - tabela existe no DB mas types.ts ainda não regenerou
      const { data, error } = await supabase
        .from('fin_eventos_recorrentes')
        .insert({ ...input, criado_por: userId })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EventoRecorrente;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useUpdateEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<EventoRecorrenteInput> }) => {
      // @ts-expect-error - tabela existe no DB mas types.ts ainda não regenerou
      const { error } = await supabase
        .from('fin_eventos_recorrentes')
        .update({ ...input.patch, updated_at: new Date().toISOString() })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useDeleteEventoRecorrente() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // @ts-expect-error - tabela existe no DB mas types.ts ainda não regenerou
      const { error } = await supabase.from('fin_eventos_recorrentes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_recorrentes'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useEventosRecorrentes.ts
git commit -m "feat(financeiro a1): hook useEventosRecorrentes (CRUD)"
```

### Task 3.2: Hook `useEventosEventuais`

**Files:**
- Create: `src/hooks/useEventosEventuais.ts`

- [ ] **Step 1: Implementar**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EventoEventual = {
  id: string;
  company: string;
  descricao: string;
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria_dre: string | null;
  data_prevista: string;
  data_realizada: string | null;
  status: 'previsto' | 'confirmado' | 'cancelado' | 'realizado';
  observacao: string | null;
};

export type EventoEventualInput = Omit<EventoEventual, 'id'>;

export function useEventosEventuais(company: string, periodo?: { de: string; ate: string }) {
  return useQuery({
    queryKey: ['fin_eventos_eventuais', company, periodo?.de, periodo?.ate],
    enabled: Boolean(company),
    queryFn: async (): Promise<EventoEventual[]> => {
      // @ts-expect-error - tabela existe no DB mas types.ts ainda não regenerou
      let q = supabase
        .from('fin_eventos_eventuais')
        .select('*')
        .eq('company', company)
        .order('data_prevista');
      if (periodo) {
        q = q.gte('data_prevista', periodo.de).lte('data_prevista', periodo.ate);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as EventoEventual[];
    },
  });
}

export function useCreateEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EventoEventualInput) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      // @ts-expect-error
      const { data, error } = await supabase
        .from('fin_eventos_eventuais')
        .insert({ ...input, criado_por: userId })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as EventoEventual;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useUpdateEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<EventoEventualInput> }) => {
      // @ts-expect-error
      const { error } = await supabase
        .from('fin_eventos_eventuais')
        .update({ ...input.patch, updated_at: new Date().toISOString() })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}

export function useDeleteEventoEventual() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // @ts-expect-error
      const { error } = await supabase.from('fin_eventos_eventuais').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_eventos_eventuais'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useEventosEventuais.ts
git commit -m "feat(financeiro a1): hook useEventosEventuais (CRUD + filtro período)"
```

### Task 3.3: Componente `EventosManager`

**Files:**
- Create: `src/components/financeiro/cashflow/EventosManager.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import {
  useEventosRecorrentes, useCreateEventoRecorrente,
  useUpdateEventoRecorrente, useDeleteEventoRecorrente,
  type EventoRecorrente,
} from '@/hooks/useEventosRecorrentes';
import {
  useEventosEventuais, useCreateEventoEventual,
  useUpdateEventoEventual, useDeleteEventoEventual,
  type EventoEventual,
} from '@/hooks/useEventosEventuais';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Pencil, History } from 'lucide-react';
import { toast } from 'sonner';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { formatBRL } from '@/lib/financeiro/cashflow-format';

type Tab = 'recorrentes' | 'eventuais';

export function EventosManager() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<Tab>('recorrentes');
  const [editing, setEditing] = useState<EventoRecorrente | EventoEventual | null>(null);
  const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);

  const recQ = useEventosRecorrentes(activeCompany);
  const evQ = useEventosEventuais(activeCompany);

  const delRec = useDeleteEventoRecorrente();
  const delEv = useDeleteEventoEventual();

  const handleDelete = async (kind: Tab, id: string) => {
    try {
      if (kind === 'recorrentes') await delRec.mutateAsync(id);
      else await delEv.mutateAsync(id);
      toast.success('Evento removido');
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant={tab === 'recorrentes' ? 'default' : 'outline'} size="sm" onClick={() => setTab('recorrentes')}>
          Recorrentes ({recQ.data?.length ?? 0})
        </Button>
        <Button variant={tab === 'eventuais' ? 'default' : 'outline'} size="sm" onClick={() => setTab('eventuais')}>
          Eventuais ({evQ.data?.length ?? 0})
        </Button>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setEditing({ id: 'new' } as EventoRecorrente | EventoEventual)}>
            <Plus className="h-3 w-3 mr-1" /> Novo
          </Button>
        </div>
      </div>

      {tab === 'recorrentes' && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Dia</TableHead>
                  <TableHead>Início</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(recQ.data ?? []).map(r => (
                  <TableRow key={r.id}>
                    <TableCell>{r.descricao}{r.is_folha && <Badge className="ml-2">folha</Badge>}</TableCell>
                    <TableCell><Badge variant={r.tipo === 'entrada' ? 'default' : 'destructive'}>{r.tipo}</Badge></TableCell>
                    <TableCell className="tabular-nums">{formatBRL(r.valor)}</TableCell>
                    <TableCell>{r.dia_do_mes}</TableCell>
                    <TableCell className="font-mono text-xs">{r.inicio}</TableCell>
                    <TableCell>{r.ativo ? '✓' : '✗'}</TableCell>
                    <TableCell className="space-x-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(r)}><Pencil className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAuditTarget({ table: 'fin_eventos_recorrentes', id: r.id, title: `Recorrente: ${r.descricao}` })}><History className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete('recorrentes', r.id)}><Trash2 className="h-3 w-3" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(recQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhum evento recorrente cadastrado. Adicione folha, aluguel, pró-labore, etc.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {tab === 'eventuais' && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Data prevista</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(evQ.data ?? []).map(e => (
                  <TableRow key={e.id}>
                    <TableCell>{e.descricao}</TableCell>
                    <TableCell><Badge variant={e.tipo === 'entrada' ? 'default' : 'destructive'}>{e.tipo}</Badge></TableCell>
                    <TableCell className="tabular-nums">{formatBRL(e.valor)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.data_prevista}</TableCell>
                    <TableCell><Badge variant="outline">{e.status}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(e)}><Pencil className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setAuditTarget({ table: 'fin_eventos_eventuais', id: e.id, title: `Eventual: ${e.descricao}` })}><History className="h-3 w-3" /></Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete('eventuais', e.id)}><Trash2 className="h-3 w-3" /></Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(evQ.data ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Nenhum evento eventual. Adicione aportes futuros, compras de máquina, etc.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <EventoFormDialog
        kind={tab}
        company={activeCompany}
        editing={editing}
        onClose={() => setEditing(null)}
      />

      {auditTarget && (
        <AuditTrailDrawer
          open
          onOpenChange={(open) => !open && setAuditTarget(null)}
          tableName={auditTarget.table}
          rowId={auditTarget.id}
          title={auditTarget.title}
        />
      )}
    </div>
  );
}

function EventoFormDialog({
  kind, company, editing, onClose,
}: {
  kind: Tab; company: string;
  editing: (EventoRecorrente | EventoEventual) | null;
  onClose: () => void;
}) {
  const createRec = useCreateEventoRecorrente();
  const updateRec = useUpdateEventoRecorrente();
  const createEv = useCreateEventoEventual();
  const updateEv = useUpdateEventoEventual();

  const isNew = editing?.id === 'new';
  const open = Boolean(editing);

  const [form, setForm] = useState<Record<string, unknown>>({});

  // Reset form quando abrir
  if (open && Object.keys(form).length === 0 && !isNew && editing) {
    setForm(editing as unknown as Record<string, unknown>);
  }
  if (!open && Object.keys(form).length > 0) {
    setForm({});
  }

  const handleSubmit = async () => {
    try {
      if (kind === 'recorrentes') {
        const body = {
          company,
          descricao: String(form.descricao ?? ''),
          valor: Number(form.valor ?? 0),
          tipo: (form.tipo as 'entrada' | 'saida') ?? 'saida',
          categoria_dre: form.categoria_dre as string | null ?? null,
          is_folha: Boolean(form.is_folha),
          dia_do_mes: Number(form.dia_do_mes ?? 1),
          inicio: String(form.inicio ?? new Date().toISOString().slice(0, 10)),
          fim: (form.fim as string | null) ?? null,
          ativo: form.ativo === undefined ? true : Boolean(form.ativo),
          observacao: (form.observacao as string | null) ?? null,
        };
        if (isNew) await createRec.mutateAsync(body);
        else await updateRec.mutateAsync({ id: editing!.id, patch: body });
      } else {
        const body = {
          company,
          descricao: String(form.descricao ?? ''),
          valor: Number(form.valor ?? 0),
          tipo: (form.tipo as 'entrada' | 'saida') ?? 'saida',
          categoria_dre: form.categoria_dre as string | null ?? null,
          data_prevista: String(form.data_prevista ?? new Date().toISOString().slice(0, 10)),
          data_realizada: (form.data_realizada as string | null) ?? null,
          status: (form.status as 'previsto' | 'confirmado' | 'cancelado' | 'realizado') ?? 'previsto',
          observacao: (form.observacao as string | null) ?? null,
        };
        if (isNew) await createEv.mutateAsync(body);
        else await updateEv.mutateAsync({ id: editing!.id, patch: body });
      }
      toast.success(isNew ? 'Evento criado' : 'Evento atualizado');
      onClose();
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'Novo' : 'Editar'} evento {kind === 'recorrentes' ? 'recorrente' : 'eventual'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="descricao">Descrição</Label>
            <Input id="descricao" value={String(form.descricao ?? '')} onChange={e => setForm({ ...form, descricao: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="valor">Valor (R$)</Label>
              <Input id="valor" type="number" step="0.01" value={String(form.valor ?? '')} onChange={e => setForm({ ...form, valor: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="tipo">Tipo</Label>
              <select id="tipo" className="w-full h-9 rounded border px-2"
                value={String(form.tipo ?? 'saida')}
                onChange={e => setForm({ ...form, tipo: e.target.value })}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
            </div>
          </div>
          {kind === 'recorrentes' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="dia_do_mes">Dia do mês</Label>
                  <Input id="dia_do_mes" type="number" min="1" max="31"
                    value={String(form.dia_do_mes ?? '')}
                    onChange={e => setForm({ ...form, dia_do_mes: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="is_folha">É folha?</Label>
                  <select id="is_folha" className="w-full h-9 rounded border px-2"
                    value={form.is_folha ? '1' : '0'}
                    onChange={e => setForm({ ...form, is_folha: e.target.value === '1' })}>
                    <option value="0">Não</option>
                    <option value="1">Sim</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="inicio">Início</Label>
                  <Input id="inicio" type="date" value={String(form.inicio ?? '')} onChange={e => setForm({ ...form, inicio: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="fim">Fim (opcional)</Label>
                  <Input id="fim" type="date" value={String(form.fim ?? '')} onChange={e => setForm({ ...form, fim: e.target.value || null })} />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="data_prevista">Data prevista</Label>
                  <Input id="data_prevista" type="date" value={String(form.data_prevista ?? '')} onChange={e => setForm({ ...form, data_prevista: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <select id="status" className="w-full h-9 rounded border px-2"
                    value={String(form.status ?? 'previsto')}
                    onChange={e => setForm({ ...form, status: e.target.value })}>
                    <option value="previsto">Previsto</option>
                    <option value="confirmado">Confirmado</option>
                    <option value="realizado">Realizado</option>
                    <option value="cancelado">Cancelado</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit}>{isNew ? 'Criar' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/financeiro/cashflow/EventosManager.tsx
git commit -m "feat(financeiro a1): componente EventosManager (CRUD recorrentes + eventuais)"
```

### Task 3.4: Refatorar `FinanceiroCapitalGiro` em 4 tabs (esqueleto)

**Files:**
- Modify: `src/pages/FinanceiroCapitalGiro.tsx`

> Estratégia: extrair o conteúdo atual da página pra um componente novo `PosicaoAgora.tsx` (Tab 1), e a página vira um wrapper com 4 tabs. As outras 3 tabs ficam com placeholders nesta task — serão preenchidas nas Phases 4-6.

- [ ] **Step 1: Criar `PosicaoAgora.tsx` extraindo o conteúdo atual**

Cria `src/components/financeiro/cashflow/PosicaoAgora.tsx` com **EXATAMENTE** o conteúdo JSX (e hooks) que existem hoje em `FinanceiroCapitalGiro.tsx`. Não modifica lógica — só move.

> Pra esta task, copia integralmente o return da `FinanceiroCapitalGiro` atual pra o novo componente, ajustando imports relativos se necessário.

- [ ] **Step 2: Substituir `FinanceiroCapitalGiro.tsx` por wrapper de tabs**

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PosicaoAgora } from '@/components/financeiro/cashflow/PosicaoAgora';
import { EventosManager } from '@/components/financeiro/cashflow/EventosManager';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function FinanceiroCapitalGiro() {
  const { isMaster } = useAuth();
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div className="container mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-display">Capital de Giro</h1>
        {isMaster && (
          <Button size="sm" variant="ghost" onClick={() => setShowConfig(true)} title="Configuração (master)">
            <Settings className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Tabs defaultValue="posicao">
        <TabsList>
          <TabsTrigger value="posicao">Posição agora</TabsTrigger>
          <TabsTrigger value="fluxo">Fluxo 13 semanas</TabsTrigger>
          <TabsTrigger value="ncg">NCG</TabsTrigger>
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
        </TabsList>

        <TabsContent value="posicao"><PosicaoAgora /></TabsContent>
        <TabsContent value="fluxo">
          <div className="text-center text-muted-foreground py-12">Fluxo 13s — disponível na Phase 4</div>
        </TabsContent>
        <TabsContent value="ncg">
          <div className="text-center text-muted-foreground py-12">NCG — disponível na Phase 5</div>
        </TabsContent>
        <TabsContent value="eventos"><EventosManager /></TabsContent>
      </Tabs>

      {showConfig && isMaster && (
        <div className="text-center text-muted-foreground py-4">Configuração — Phase 6</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
bun build
git add src/pages/FinanceiroCapitalGiro.tsx src/components/financeiro/cashflow/PosicaoAgora.tsx
git commit -m "feat(financeiro a1): refator FinanceiroCapitalGiro em 4 tabs (eventos plugado, resto placeholder)"
```

### Task 3.5: Pipeline + marker fim Phase 3

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test src/lib/financeiro/__tests__/
```

- [ ] **Step 2: Marker**

```bash
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 3] Tab Eventos + refator página"
```

---

## Phase 4: Tab Fluxo 13s

### Task 4.1: Hook `useCashflowProjection`

**Files:**
- Create: `src/hooks/useCashflowProjection.ts`

- [ ] **Step 1: Implementar**

```typescript
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Cenario = 'realista' | 'otimista' | 'pessimista';

export type LinhaCashflow = {
  origem: 'cr_omie' | 'cp_omie' | 'evento_recorrente' | 'evento_eventual';
  desc: string;
  data: string;
  valor: number;
  id_origem: string;
};

export type Semana = {
  inicio: string;
  fim: string;
  saldo_inicial: number;
  entradas: LinhaCashflow[];
  saidas: LinhaCashflow[];
  total_entradas: number;
  total_saidas: number;
  saldo_final: number;
};

export type NCGData = {
  aco: { cr_aberto: number; estoque: number; adiantamentos: number; total: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number;
  projecao_12m: Array<{ mes: string; valor: number }>;
};

export type CashflowResult = {
  semanas: Semana[];
  ncg: NCGData;
  indicadores: {
    dias_cobertura: number;
    capital_giro_proprio: number;
    saldo_tesouraria: number;
    inadimplencia_pct: number;
    concentracao_top5_clientes: Array<{ cliente: string; pct: number; valor: number }>;
    prazo_medio_recebimento: number;
    prazo_medio_pagamento: number;
    cash_conversion_cycle: number;
  };
  alertas: Array<{ tipo: string; severidade: string; mensagem: string; valor: number | null; threshold: number | null; contexto: Record<string, unknown> }>;
  premissas_aplicadas: Record<string, unknown>;
};

export function useCashflowProjection(company: string, cenario: Cenario = 'realista', horizonWeeks = 13) {
  return useQuery({
    queryKey: ['fin_cashflow_projection', company, cenario, horizonWeeks],
    enabled: Boolean(company),
    queryFn: async (): Promise<CashflowResult> => {
      const { data, error } = await supabase.functions.invoke('fin-cashflow-engine', {
        body: { company, cenario, horizon_weeks: horizonWeeks },
      });
      if (error) throw error;
      return data as CashflowResult;
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useCashflowProjection.ts
git commit -m "feat(financeiro a1): hook useCashflowProjection invocando fin-cashflow-engine"
```

### Task 4.2: Hook `useCashflowAlertas` + componente `AlertasStack`

**Files:**
- Create: `src/hooks/useCashflowAlertas.ts`
- Create: `src/components/financeiro/cashflow/AlertasStack.tsx`

- [ ] **Step 1: Hook**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Alerta = {
  id: string;
  company: string;
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  valor: number | null;
  threshold: number | null;
  contexto: Record<string, unknown> | null;
  criado_em: string;
  dismissed_at: string | null;
  dismissed_until: string | null;
};

export function useCashflowAlertas(company: string) {
  return useQuery({
    queryKey: ['fin_alertas', 'ativos', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<Alerta[]> => {
      // @ts-expect-error - types.ts ainda sem fin_alertas
      const { data, error } = await supabase
        .from('fin_alertas')
        .select('*')
        .eq('company', company)
        .is('dismissed_at', null)
        .order('criado_em', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Alerta[];
    },
  });
}

export function useDismissAlerta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; snoozeDays?: number }) => {
      const dismissed_at = new Date().toISOString();
      const dismissed_until = input.snoozeDays
        ? new Date(Date.now() + input.snoozeDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const userId = (await supabase.auth.getUser()).data.user?.id;
      // @ts-expect-error
      const { error } = await supabase.from('fin_alertas').update({
        dismissed_at,
        dismissed_until,
        dismissed_by: userId,
      }).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_alertas'] }),
  });
}
```

- [ ] **Step 2: Componente AlertasStack**

```tsx
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowAlertas, useDismissAlerta, type Alerta } from '@/hooks/useCashflowAlertas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, AlertOctagon, Info, X, Clock } from 'lucide-react';
import { toast } from 'sonner';

const SEVERIDADE_ICON: Record<Alerta['severidade'], typeof Info> = {
  info: Info,
  aviso: AlertTriangle,
  critico: AlertOctagon,
};

const SEVERIDADE_STYLE: Record<Alerta['severidade'], string> = {
  info: 'border-status-info bg-status-info-bg',
  aviso: 'border-status-warning bg-status-warning-bg',
  critico: 'border-status-error bg-status-error-bg',
};

export function AlertasStack() {
  const { activeCompany } = useCompany();
  const { data, isLoading } = useCashflowAlertas(activeCompany);
  const dismiss = useDismissAlerta();

  if (isLoading || !data || data.length === 0) return null;

  const handleDismiss = async (id: string, days?: number) => {
    try {
      await dismiss.mutateAsync({ id, snoozeDays: days });
      toast.success(days ? `Alerta silenciado por ${days} dias` : 'Alerta dispensado');
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <div className="space-y-2">
      {data.map(a => {
        const Icon = SEVERIDADE_ICON[a.severidade];
        return (
          <Alert key={a.id} className={SEVERIDADE_STYLE[a.severidade]}>
            <Icon className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">{a.tipo}</Badge>
            </AlertTitle>
            <AlertDescription className="flex items-start justify-between gap-3">
              <span>{a.mensagem}</span>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => handleDismiss(a.id, 7)} title="Silenciar 7 dias">
                  <Clock className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDismiss(a.id)} title="Dispensar permanente">
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCashflowAlertas.ts src/components/financeiro/cashflow/AlertasStack.tsx
git commit -m "feat(financeiro a1): useCashflowAlertas + AlertasStack (dismiss + snooze 7d)"
```

### Task 4.3: Componente `CenarioToggle`

**Files:**
- Create: `src/components/financeiro/cashflow/CenarioToggle.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Cenario } from '@/hooks/useCashflowProjection';

type Props = {
  value: Cenario;
  onChange: (next: Cenario) => void;
};

export function CenarioToggle({ value, onChange }: Props) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => (v === 'realista' || v === 'otimista' || v === 'pessimista') && onChange(v)}
      className="h-8"
      size="sm"
      aria-label="Cenário"
    >
      <ToggleGroupItem value="pessimista" aria-label="Pessimista">Pessimista</ToggleGroupItem>
      <ToggleGroupItem value="realista" aria-label="Realista">Realista</ToggleGroupItem>
      <ToggleGroupItem value="otimista" aria-label="Otimista">Otimista</ToggleGroupItem>
    </ToggleGroup>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/financeiro/cashflow/CenarioToggle.tsx
git commit -m "feat(financeiro a1): CenarioToggle (pessimista/realista/otimista)"
```

### Task 4.4: Componente `Fluxo13Semanas` (gráfico + tabela)

**Files:**
- Create: `src/components/financeiro/cashflow/Fluxo13Semanas.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowProjection, type Cenario, type Semana } from '@/hooks/useCashflowProjection';
import { CenarioToggle } from './CenarioToggle';
import { AlertasStack } from './AlertasStack';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, BarChart, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatBRL, formatSemana } from '@/lib/financeiro/cashflow-format';

export function Fluxo13Semanas() {
  const { activeCompany } = useCompany();
  const [cenario, setCenario] = useState<Cenario>('realista');
  const { data, isLoading, error } = useCashflowProjection(activeCompany, cenario);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) return <div className="text-status-error">Erro: {String((error as Error).message ?? error)}</div>;
  if (!data) return null;

  const chartData = data.semanas.map(s => ({
    semana: formatSemana(s.inicio),
    entradas: Math.round(s.total_entradas),
    saidas: Math.round(s.total_saidas),
    saldo_final: Math.round(s.saldo_final),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CenarioToggle value={cenario} onChange={setCenario} />
        <div className="text-xs text-muted-foreground">
          Horizonte: 13 semanas · Cenário: <strong>{cenario}</strong>
        </div>
      </div>

      <AlertasStack />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Projeção 13 semanas — {cenario}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="semana" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Legend />
              <Bar dataKey="entradas" fill="hsl(var(--status-success-bold))" name="Entradas" />
              <Bar dataKey="saidas" fill="hsl(var(--status-error-bold))" name="Saídas" />
              <Line type="monotone" dataKey="saldo_final" stroke="hsl(var(--foreground))" strokeWidth={2} name="Saldo acumulado" />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Detalhe semana a semana</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Semana</TableHead>
                <TableHead className="text-right">Saldo inicial</TableHead>
                <TableHead className="text-right">Entradas</TableHead>
                <TableHead className="text-right">Saídas</TableHead>
                <TableHead className="text-right">Saldo final</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.semanas.map((s, i) => (
                <TableRow key={i} className={s.saldo_final < 0 ? 'bg-status-error-bg' : ''}>
                  <TableCell className="font-mono text-xs">{formatSemana(s.inicio)} → {formatSemana(s.fim)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(s.saldo_inicial)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-success">+{formatBRL(s.total_entradas)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-error">-{formatBRL(s.total_saidas)}</TableCell>
                  <TableCell className="text-right tabular-nums font-bold">{formatBRL(s.saldo_final)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/financeiro/cashflow/Fluxo13Semanas.tsx
git commit -m "feat(financeiro a1): Fluxo13Semanas (cenário toggle + gráfico + tabela)"
```

### Task 4.5: Plugar `Fluxo13Semanas` no FinanceiroCapitalGiro

**Files:**
- Modify: `src/pages/FinanceiroCapitalGiro.tsx`

- [ ] **Step 1: Substituir placeholder do tab "fluxo"**

```tsx
import { Fluxo13Semanas } from '@/components/financeiro/cashflow/Fluxo13Semanas';

// dentro do <Tabs>:
<TabsContent value="fluxo"><Fluxo13Semanas /></TabsContent>
```

Remover o `<div>` placeholder anterior.

- [ ] **Step 2: Build + commit**

```bash
bun build
git add src/pages/FinanceiroCapitalGiro.tsx
git commit -m "feat(financeiro a1): plug Fluxo13Semanas no tab da página"
```

### Task 4.6: Pipeline + marker fim Phase 4

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test src/lib/financeiro/__tests__/
```

- [ ] **Step 2: Marker**

```bash
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 4] Tab Fluxo 13s + alertas"
```

---

## Phase 5: Tab NCG

### Task 5.1: Componente `NcgDecomposicao`

**Files:**
- Create: `src/components/financeiro/cashflow/NcgDecomposicao.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowProjection, type Cenario } from '@/hooks/useCashflowProjection';
import { CenarioToggle } from './CenarioToggle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatBRL } from '@/lib/financeiro/cashflow-format';

export function NcgDecomposicao() {
  const { activeCompany } = useCompany();
  const [cenario, setCenario] = useState<Cenario>('realista');
  const { data, isLoading } = useCashflowProjection(activeCompany, cenario);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (!data) return null;

  const acoData = [
    { nome: 'CR aberto', valor: data.ncg.aco.cr_aberto, tipo: 'ACO' },
    { nome: 'Estoque', valor: data.ncg.aco.estoque, tipo: 'ACO' },
    { nome: 'Adiantamentos', valor: data.ncg.aco.adiantamentos, tipo: 'ACO' },
    { nome: 'CP fornecedor', valor: data.ncg.pco.cp_fornecedor, tipo: 'PCO' },
    { nome: 'Folha 30d', valor: data.ncg.pco.folha_30d, tipo: 'PCO' },
    { nome: 'Tributos', valor: data.ncg.pco.tributos_a_pagar, tipo: 'PCO' },
  ];

  const proj12Data = data.ncg.projecao_12m;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CenarioToggle value={cenario} onChange={setCenario} />
        <div className="text-xs text-muted-foreground">Cenário: <strong>{cenario}</strong></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-xs">ACO total</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-mono">{formatBRL(data.ncg.aco.total)}</div>
            <div className="text-xs text-muted-foreground mt-1">CR + Estoque + Adiantamentos</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-xs">PCO total</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-mono">{formatBRL(data.ncg.pco.total)}</div>
            <div className="text-xs text-muted-foreground mt-1">CP fornecedor + Folha + Tributos</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-xs">NCG (ACO − PCO)</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-mono ${data.ncg.valor < 0 ? 'text-status-error' : 'text-status-success'}`}>
              {formatBRL(data.ncg.valor)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {data.ncg.valor > data.indicadores.capital_giro_proprio ? '⚠ Excede CGP' : 'Dentro de CGP'}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Decomposição ACO vs PCO</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={acoData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="nome" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Bar dataKey="valor">
                {acoData.map((d, i) => (
                  <Cell key={i} fill={d.tipo === 'ACO' ? 'hsl(var(--status-success-bold))' : 'hsl(var(--status-error-bold))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Projeção NCG 12 meses</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={proj12Data}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="mes" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Line type="monotone" dataKey="valor" stroke="hsl(var(--foreground))" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Cash Conversion Cycle</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-muted-foreground">PMR</div>
              <div className="text-xl font-mono">{data.indicadores.prazo_medio_recebimento.toFixed(0)}d</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">PMP</div>
              <div className="text-xl font-mono">{data.indicadores.prazo_medio_pagamento.toFixed(0)}d</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">CCC</div>
              <div className={`text-xl font-mono ${data.indicadores.cash_conversion_cycle > 60 ? 'text-status-warning' : ''}`}>
                {data.indicadores.cash_conversion_cycle.toFixed(0)}d
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/financeiro/cashflow/NcgDecomposicao.tsx
git commit -m "feat(financeiro a1): NcgDecomposicao (cards + decomp + proj 12m + CCC)"
```

### Task 5.2: Plugar `NcgDecomposicao` no FinanceiroCapitalGiro + marker

**Files:**
- Modify: `src/pages/FinanceiroCapitalGiro.tsx`

- [ ] **Step 1: Plugar**

```tsx
import { NcgDecomposicao } from '@/components/financeiro/cashflow/NcgDecomposicao';

// dentro do <Tabs>:
<TabsContent value="ncg"><NcgDecomposicao /></TabsContent>
```

- [ ] **Step 2: Build + pipeline + marker**

```bash
bun build
git add src/pages/FinanceiroCapitalGiro.tsx
git commit -m "feat(financeiro a1): plug NcgDecomposicao no tab da página"
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 5] Tab NCG"
```

---

## Phase 6: Tab Configuração (master only)

### Task 6.1: Hook `useCashflowConfig`

**Files:**
- Create: `src/hooks/useCashflowConfig.ts`

- [ ] **Step 1: Implementar**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CashflowConfig = {
  company: string;
  overrides_cenario: {
    otimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
    pessimista: { recebimento_no_prazo_pct_delta: number; inadimplencia_pct_delta: number };
  };
  thresholds: {
    caixa_negativo_semanas: number;
    ncg_deficit_alerta: number;
    dias_cobertura_min: number;
    inadimplencia_max_pct: number;
    concentracao_top1_max_pct: number;
    pmr_crescimento_max_pct_90d: number;
  };
  adiantamento_categorias_codigos: string[];
};

export function useCashflowConfig(company: string) {
  return useQuery({
    queryKey: ['fin_config_cashflow', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<CashflowConfig | null> => {
      // @ts-expect-error
      const { data, error } = await supabase
        .from('fin_config_cashflow')
        .select('*')
        .eq('company', company)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as CashflowConfig | null;
    },
  });
}

export function useUpdateCashflowConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { company: string; patch: Partial<Omit<CashflowConfig, 'company'>> }) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      // @ts-expect-error
      const { error } = await supabase
        .from('fin_config_cashflow')
        .update({ ...input.patch, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('company', input.company);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_config_cashflow'] });
      qc.invalidateQueries({ queryKey: ['fin_cashflow_projection'] });
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useCashflowConfig.ts
git commit -m "feat(financeiro a1): hook useCashflowConfig (read + update master)"
```

### Task 6.2: Componente `ConfigCashflowDialog`

**Files:**
- Create: `src/components/financeiro/cashflow/ConfigCashflowDialog.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useState, useEffect } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useAuth } from '@/contexts/AuthContext';
import { useCashflowConfig, useUpdateCashflowConfig } from '@/hooks/useCashflowConfig';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function ConfigCashflowDialog({ open, onOpenChange }: Props) {
  const { activeCompany } = useCompany();
  const { isMaster } = useAuth();
  const { data: config } = useCashflowConfig(activeCompany);
  const update = useUpdateCashflowConfig();

  const [thresholds, setThresholds] = useState(config?.thresholds);
  const [overrides, setOverrides] = useState(config?.overrides_cenario);
  const [adiantamentos, setAdiantamentos] = useState<string>('');

  useEffect(() => {
    if (config) {
      setThresholds(config.thresholds);
      setOverrides(config.overrides_cenario);
      setAdiantamentos(config.adiantamento_categorias_codigos.join(', '));
    }
  }, [config]);

  if (!isMaster) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader><DialogTitle>Permissão insuficiente</DialogTitle></DialogHeader>
          <p className="text-sm">Apenas master pode editar configuração de cashflow.</p>
          <DialogFooter><Button onClick={() => onOpenChange(false)}>OK</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const handleSave = async () => {
    if (!thresholds || !overrides) return;
    try {
      await update.mutateAsync({
        company: activeCompany,
        patch: {
          thresholds,
          overrides_cenario: overrides,
          adiantamento_categorias_codigos: adiantamentos.split(',').map(s => s.trim()).filter(Boolean),
        },
      });
      toast.success('Configuração salva');
      onOpenChange(false);
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  if (!thresholds || !overrides) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configuração de Cashflow — {activeCompany}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Thresholds de alertas</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div>
                <Label>Caixa negativo (semanas pra alertar)</Label>
                <Input type="number" min="1" max="13" value={thresholds.caixa_negativo_semanas} onChange={e => setThresholds({ ...thresholds, caixa_negativo_semanas: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Dias cobertura mínimo</Label>
                <Input type="number" min="0" value={thresholds.dias_cobertura_min} onChange={e => setThresholds({ ...thresholds, dias_cobertura_min: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Inadimplência máxima (%)</Label>
                <Input type="number" step="0.1" min="0" max="100" value={thresholds.inadimplencia_max_pct} onChange={e => setThresholds({ ...thresholds, inadimplencia_max_pct: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Concentração top1 máxima (%)</Label>
                <Input type="number" step="0.1" min="0" max="100" value={thresholds.concentracao_top1_max_pct} onChange={e => setThresholds({ ...thresholds, concentracao_top1_max_pct: Number(e.target.value) })} />
              </div>
              <div>
                <Label>PMR crescimento máx 90d (%)</Label>
                <Input type="number" step="0.1" min="0" value={thresholds.pmr_crescimento_max_pct_90d} onChange={e => setThresholds({ ...thresholds, pmr_crescimento_max_pct_90d: Number(e.target.value) })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Deltas de cenário (% sobre realista)</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div>
                <Label>Otimista: recebimento no prazo Δ%</Label>
                <Input type="number" step="1" value={overrides.otimista.recebimento_no_prazo_pct_delta} onChange={e => setOverrides({ ...overrides, otimista: { ...overrides.otimista, recebimento_no_prazo_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Otimista: inadimplência Δ%</Label>
                <Input type="number" step="1" value={overrides.otimista.inadimplencia_pct_delta} onChange={e => setOverrides({ ...overrides, otimista: { ...overrides.otimista, inadimplencia_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Pessimista: recebimento no prazo Δ%</Label>
                <Input type="number" step="1" value={overrides.pessimista.recebimento_no_prazo_pct_delta} onChange={e => setOverrides({ ...overrides, pessimista: { ...overrides.pessimista, recebimento_no_prazo_pct_delta: Number(e.target.value) } })} />
              </div>
              <div>
                <Label>Pessimista: inadimplência Δ%</Label>
                <Input type="number" step="1" value={overrides.pessimista.inadimplencia_pct_delta} onChange={e => setOverrides({ ...overrides, pessimista: { ...overrides.pessimista, inadimplencia_pct_delta: Number(e.target.value) } })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Códigos Omie de adiantamentos a fornecedores</CardTitle></CardHeader>
            <CardContent>
              <Label>Códigos separados por vírgula</Label>
              <Input placeholder="2.01.01, 2.01.02" value={adiantamentos} onChange={e => setAdiantamentos(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">CPs com esses códigos serão tratados como ACO (adiantamentos) em vez de PCO.</p>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/financeiro/cashflow/ConfigCashflowDialog.tsx
git commit -m "feat(financeiro a1): ConfigCashflowDialog (thresholds + cenários + adiantamentos)"
```

### Task 6.3: Plugar ConfigDialog na página + marker fim Phase 6

**Files:**
- Modify: `src/pages/FinanceiroCapitalGiro.tsx`

- [ ] **Step 1: Plugar**

Substituir o `{showConfig && isMaster && ...}` placeholder por:

```tsx
import { ConfigCashflowDialog } from '@/components/financeiro/cashflow/ConfigCashflowDialog';

// no fim do JSX:
<ConfigCashflowDialog open={showConfig} onOpenChange={setShowConfig} />
```

- [ ] **Step 2: Build + commit + marker**

```bash
bun build
git add src/pages/FinanceiroCapitalGiro.tsx
git commit -m "feat(financeiro a1): plug ConfigCashflowDialog no botão de gear da página"
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 6] Tab Configuração (master)"
```

---

## Phase 7: Cron snapshot diário + onboarding wizard

### Task 7.1: Migration cron schedule (template)

**Files:**
- Create: `supabase/migrations/20260519010000_fin_a1_cron.sql`

- [ ] **Step 1: Criar migration (documentação — execução manual)**

```sql
-- ============================================================
-- A1 — Cron schedule para snapshot diário da projeção
--
-- SETUP (após habilitar pg_cron + configurar vault secrets):
--
-- Para cada empresa × cada cenário, gera 1 snapshot por dia às 7h BRT (10h UTC).
-- Permite trend de "projeção mudou nas últimas 4 semanas?".
--
-- Vault secrets necessários (rodar uma vez no SQL Editor):
--   SELECT vault.create_secret('https://SEU_PROJECT.supabase.co', 'project_url');
--   SELECT vault.create_secret('SEU_CRON_SECRET', 'cron_secret');
--
-- Cron command (rodar no SQL Editor após vault):
--
-- DO $$
-- DECLARE
--   c text;
--   cen text;
-- BEGIN
--   FOR c IN SELECT unnest(ARRAY['oben','colacor','colacor_sc']) LOOP
--     FOR cen IN SELECT unnest(ARRAY['realista','otimista','pessimista']) LOOP
--       PERFORM cron.schedule(
--         format('fin-cashflow-snapshot-%s-%s', c, cen),
--         '0 10 * * *',
--         format(
--           $cmd$SELECT net.http_post(
--             url := (SELECT value FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/fin-cashflow-engine',
--             headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (SELECT value FROM vault.decrypted_secrets WHERE name = 'cron_secret')),
--             body := jsonb_build_object('company', '%s', 'cenario', '%s', 'save_snapshot', true)
--           );$cmd$,
--           c, cen
--         )
--       );
--     END LOOP;
--   END LOOP;
-- END $$;
--
-- Verificar: SELECT jobname FROM cron.job WHERE jobname LIKE 'fin-cashflow%';
-- ============================================================

-- Placeholder pra registrar a migration na timeline (não cria nada)
SELECT 'fin_a1_cron migration: ver instruções no comentário acima' AS info;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260519010000_fin_a1_cron.sql
git commit -m "docs(financeiro a1): template do cron snapshot diário (setup manual)"
```

### Task 7.2: Onboarding wizard (card sugerindo eventos comuns)

**Files:**
- Create: `src/components/financeiro/cashflow/EventosOnboarding.tsx`
- Modify: `src/components/financeiro/cashflow/EventosManager.tsx`

- [ ] **Step 1: Criar componente de onboarding**

```tsx
import { useCompany } from '@/contexts/CompanyContext';
import { useEventosRecorrentes, useCreateEventoRecorrente } from '@/hooks/useEventosRecorrentes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const SUGESTOES = [
  { descricao: 'Folha de pagamento', valor: 50000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: true, dia_do_mes: 5 },
  { descricao: 'Aluguel', valor: 8000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 10 },
  { descricao: 'Pró-labore sócios', valor: 30000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 5 },
  { descricao: 'Internet + Telefonia', valor: 1500, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 15 },
  { descricao: 'Software / SaaS', valor: 3000, tipo: 'saida' as const, categoria_dre: 'despesas_administrativas', is_folha: false, dia_do_mes: 20 },
];

export function EventosOnboarding({ onDone }: { onDone?: () => void }) {
  const { activeCompany } = useCompany();
  const { data: existing } = useEventosRecorrentes(activeCompany);
  const create = useCreateEventoRecorrente();

  // Só mostra se < 5 recorrentes ativos
  if (!existing || existing.filter(e => e.ativo).length >= 5) return null;

  const handleAdd = async (sug: typeof SUGESTOES[number]) => {
    try {
      await create.mutateAsync({
        company: activeCompany,
        ...sug,
        inicio: new Date().toISOString().slice(0, 10),
        fim: null,
        ativo: true,
        observacao: null,
      });
      toast.success(`Adicionado: ${sug.descricao} (ajuste o valor depois)`);
      onDone?.();
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4" /> Sugestões pra começar
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Adicione eventos típicos com 1 clique. Edite valor e dia depois.
        </p>
        <div className="flex flex-wrap gap-2">
          {SUGESTOES.map(s => (
            <Button key={s.descricao} size="sm" variant="outline" onClick={() => handleAdd(s)}>
              + {s.descricao}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Plugar onboarding em EventosManager**

Em `EventosManager.tsx`, após o `<div className="flex items-center gap-2">` do header e antes do tab content:

```tsx
import { EventosOnboarding } from './EventosOnboarding';

// no JSX, perto do topo:
<EventosOnboarding />
```

- [ ] **Step 3: Build + commit**

```bash
bun build
git add src/components/financeiro/cashflow/EventosOnboarding.tsx src/components/financeiro/cashflow/EventosManager.tsx
git commit -m "feat(financeiro a1): onboarding wizard com sugestões de eventos comuns"
```

### Task 7.3: Pipeline + marker fim Phase 7

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test src/lib/financeiro/__tests__/
```

- [ ] **Step 2: Marker**

```bash
git commit --allow-empty -m "ship(financeiro a1): [PR-READY: Phase 7] Cron template + onboarding"
```

---

## Phase 8: Docs + encerramento

### Task 8.1: Atualizar `FINANCEIRO_CONFIABILIDADE.md`

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Adicionar seção "A1 entregue"**

Inserir no topo da seção "✅ Recém entregues" (após o título da seção):

```markdown
## ✅ A1 — Inteligência de Caixa (CFO mode) — entregue (2026-05-19)

| Funcionalidade | O que mostra | Como usar |
|---|---|---|
| **Fluxo 13 semanas** | Projeção semanal com entradas/saídas/saldo, em 3 cenários (realista/otimista/pessimista). Inclui CR/CP vencendo + eventos recorrentes + eventos eventuais. Aplicação de inadimplência observada (taxa histórica 12m). | Tab "Fluxo 13s" em /financeiro/capital-giro. Toggle de cenário no header. Alertas de caixa negativo aparecem no topo. |
| **NCG decomposta** | ACO (CR aberto + estoque + adiantamentos) − PCO (CP fornecedor + folha 30d + tributos). Projeção 12m. CCC com PMR/PMP. Comparação com Capital Giro Próprio. | Tab "NCG". Indicador visual quando NCG > CGP (déficit de liquidez). |
| **Eventos recorrentes** | Folha, aluguel, pró-labore, etc. Repete mensalmente no dia configurado. Clamp pra último dia em fevereiro. Flag `is_folha` separa pra cálculo de PCO. | Tab "Eventos" → sub-aba Recorrentes. Onboarding sugere 5 eventos comuns na primeira visita. |
| **Eventos eventuais** | Aportes, compras de imobilizado, empréstimos. Status: previsto → confirmado → realizado (ou cancelado). | Tab "Eventos" → sub-aba Eventuais. |
| **Alertas configuráveis** | 6 tipos: caixa negativo, NCG déficit, cobertura baixa, inadimplência alta, concentração top1, saída spike. Thresholds editáveis por empresa. Snooze 7d / dismiss permanente. UNIQUE constraint evita spam. | Card stack no topo da tab Fluxo. Engine avalia a cada chamada. Cron diário registra histórico. |
| **Snapshots diários** | Projeção persiste 1× ao dia (cron) por empresa × cenário. Permite trend "projeção piorou nas últimas 4 semanas?". | Cron `fin-cashflow-snapshot-diario`. Visível em tabela `fin_projecao_snapshots`. |

### Configurações necessárias (one-time, pós-deploy A1)

1. Founder cadastra eventos recorrentes existentes (folha, aluguel, etc.) via Tab Eventos
2. Master ajusta thresholds default em Configuração (gear icon)
3. Master define códigos Omie de adiantamentos em Configuração
4. Cron `fin-cashflow-snapshot-diario` agendado via SQL Editor (template em 20260519010000_fin_a1_cron.sql)

### Não cobrindo ainda (próximos ciclos)

- **A2** — WACC, ROIC, EVA, spread sobre WACC
- **A3** — DuPont, Altman Z-score, Beneish M-score
- Integração estoque com valoração real (atualmente assume estoque_valor=0 — founder pode preencher manual)
- DRE competência growth rate aplicado na projeção NCG 12m (atualmente linear)
```

- [ ] **Step 2: Commit**

```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro a1): seção 'A1 entregue' em FINANCEIRO_CONFIABILIDADE.md"
```

### Task 8.2: Pipeline final + COMPLETE marker

- [ ] **Step 1: Pipeline geral**

```bash
bun lint && bun build && bun test
```

Expected: tudo verde (warnings pré-existentes OK).

- [ ] **Step 2: COMPLETE marker**

```bash
git commit --allow-empty -m "ship(financeiro a1): [COMPLETE] A1 Inteligência de Caixa entregue (8 fases)"
```

---

## Definição de Pronto (A1 inteiro)

- ✅ 5 tabelas novas + triggers audit e period lock anexados
- ✅ Edge function `fin-cashflow-engine` com pipeline completo (carregar → taxas → cenário → semanas → NCG → indicadores → alertas → snapshot)
- ✅ UI refatorada: 4 tabs visíveis (Posição agora, Fluxo 13s, NCG, Eventos) + Config oculta master
- ✅ Founder consegue:
  - Ver fluxo 13s projetado em 3 cenários, alternar ao vivo
  - Cadastrar evento recorrente + ver impacto na projeção
  - Cadastrar evento eventual + ver semana específica mudar
  - Ver NCG decomposta + projeção 12m + CCC
  - Receber alertas configuráveis com snooze/dismiss
  - Master ajusta thresholds e deltas via Config
- ✅ Cron template documentado (setup manual via vault)
- ✅ Doc `FINANCEIRO_CONFIABILIDADE.md` atualizada
- ✅ `bun lint && bun build && bun test` verdes

---

## Pós-deploy (founder via Supabase Dashboard + CLI)

Após mergear o PR final, mesma rotina da Fundação:

1. **Migrations** (Supabase Dashboard → SQL Editor):
   - `20260519000000_fin_a1_eventos.sql`
   - `20260519000100_fin_a1_snapshots_alertas_config.sql`
   - `20260519000200_fin_a1_audit_lock_attach.sql`
   - `20260519010000_fin_a1_cron.sql` (placeholder — cron real é manual)

2. **Edge function** (Supabase CLI):
   ```
   cd ~/Projetos/afiacao
   git pull
   supabase functions deploy fin-cashflow-engine
   ```

3. **Cron snapshot diário** (Supabase Dashboard → SQL Editor): seguir template no comentário da migration 20260519010000.

4. **Onboarding** (na UI):
   - Master abre /financeiro/capital-giro → gear icon → ajusta thresholds
   - Founder vai pra Tab Eventos → adiciona eventos típicos via wizard (ou edita manualmente)
   - Volta na Tab Fluxo 13s e valida que projeção faz sentido
