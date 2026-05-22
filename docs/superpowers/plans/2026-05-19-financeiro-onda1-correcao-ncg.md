# Onda 1 — Correção do NCG · Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 4 problemas de NCG/indicadores do `fin-cashflow-engine` apontados pelo Codex (PCO double-count de tributos, estoque=0, CGP mal rotulado, CCC sem PME), com a lógica testada no espelho frontend `ncg-helpers.ts` e replicada no engine Deno.

**Architecture:** A lógica de NCG existe em dois lugares: `src/lib/financeiro/ncg-helpers.ts` (frontend, com testes vitest) e `supabase/functions/fin-cashflow-engine/index.ts` (engine Deno, server-side, sem teste em CI). Fazemos TDD no helper frontend e espelhamos no engine, mantendo as fórmulas idênticas. Estoque vem de uma nova tabela `fin_estoque_valor` (manual do balancete) com RPC opcional de estimativa via Omie. CMV pro PME vem de `fin_dre_snapshots` (regime competência, TTM).

**Tech Stack:** Supabase (Postgres + edge functions Deno) hospedado no Lovable, React + TypeScript + vitest, TanStack Query, recharts.

**Restrições do Lovable (CRÍTICO):**
- SQL/migrations **não auto-aplicam** — entregar como bloco pra colar no SQL Editor do Lovable (arquivo no repo é só histórico).
- Edge function re-deployada **via chat do Lovable** lendo o arquivo do repo (não há CLI confiável aqui).
- Frontend (`src/`) é buildado pelo Lovable a partir do repo quando mergeado.
- **Não commitar sem o founder pedir explicitamente** (regra do CLAUDE.md).

---

## File Structure

- **Modify** `src/lib/financeiro/ncg-helpers.ts` — `classificarCP` passa a retornar `'pco_tributos'` p/ categorias de imposto; `calcularPCO` soma tributos da classificação (remove param `tributos_30d`); novos helpers `calcularPME` e `calcularCCC`.
- **Modify** `src/lib/financeiro/__tests__/ncg-helpers.test.ts` — corrige o teste que codifica o bug + adiciona testes de PCO mutuamente exclusivo, PME e CCC.
- **Modify** `supabase/functions/fin-cashflow-engine/index.ts` — `carregarDados` carrega estoque + cmv_ttm; `calcularNCG` exclui tributo de `cp_fornecedor` e usa estoque real; `calcularIndicadores` calcula PME + CCC=PMR+PME−PMP e renomeia `capital_giro_proprio`→`liquidez_operacional_liquida`; `avaliarAlertas` usa o novo nome.
- **Modify** `src/hooks/useCashflowProjection.ts` — rename do campo no type + novos campos `prazo_medio_estoque`.
- **Modify** `src/components/financeiro/cashflow/NcgDecomposicao.tsx` — PME no card CCC, relabel "CGP"→"Liquidez Operacional Líquida", banner de estoque desatualizado.
- **Create** `supabase/migrations/20260519020000_fin_onda1_ncg.sql` — tabela `fin_estoque_valor` + RLS + triggers, rename de coluna, RPC `fin_estimar_estoque_omie`, extensão do `fin_period_lock_trigger`.
- **Create** `src/hooks/useEstoqueValor.ts` — hook de leitura/escrita do estoque manual + chamada da estimativa Omie.
- **Modify** `src/components/financeiro/cashflow/ConfigCashflowDialog.tsx` — seção de valor de estoque por empresa.
- **Modify** `docs/FINANCEIRO_CONFIABILIDADE.md` — seção Onda 1.

---

## Task 1: Fix 1 — PCO para de contar tributos 2× (helper frontend, TDD)

**Files:**
- Modify: `src/lib/financeiro/ncg-helpers.ts`
- Test: `src/lib/financeiro/__tests__/ncg-helpers.test.ts`

- [ ] **Step 1: Atualizar o teste que codifica o bug + adicionar caso de exclusão mútua**

Em `src/lib/financeiro/__tests__/ncg-helpers.test.ts`, substituir o teste `'categoria de imposto vai pra PCO tributos'` (que hoje espera `'pco_cp_fornecedor'`) e ajustar `calcularPCO`:

```typescript
  it('categoria de imposto (3.99) classifica como PCO tributos', () => {
    expect(classificarCP(
      { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.99.01' },
      []
    )).toBe('pco_tributos');
  });
```

Substituir o describe `calcularPCO` inteiro por:

```typescript
describe('calcularPCO', () => {
  it('cp_fornecedor exclui tributos (3.99) e adiantamentos; tributos somados à parte', () => {
    const pco = calcularPCO({
      cps: [
        { saldo: 1000, status_titulo: 'ABERTO', categoria_codigo: '3.01.01' }, // fornecedor
        { saldo: 200, status_titulo: 'ABERTO', categoria_codigo: '2.01.01' },  // adiantamento (não conta)
        { saldo: 8000, status_titulo: 'ABERTO', categoria_codigo: '3.99.05' }, // tributo
      ],
      adiantamento_categorias_codigos: ['2.01.01'],
      folha_30d: 50000,
    });
    expect(pco.cp_fornecedor).toBe(1000); // NÃO inclui o tributo
    expect(pco.tributos_a_pagar).toBe(8000);
    expect(pco.folha_30d).toBe(50000);
    expect(pco.total).toBe(59000); // 1000 + 8000 + 50000, sem double-count
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `bun run test -- ncg-helpers`
Expected: FAIL — `classificarCP` retorna `'pco_cp_fornecedor'` p/ `3.99.01` (esperava `'pco_tributos'`); `calcularPCO` não aceita assinatura sem `tributos_30d`.

- [ ] **Step 3: Implementar a correção no helper**

Em `src/lib/financeiro/ncg-helpers.ts`, em `classificarCP`, antes do `return 'pco_cp_fornecedor'`:

```typescript
  if (cp.categoria_codigo && cp.categoria_codigo.startsWith('3.99')) {
    return 'pco_tributos';
  }
  return 'pco_cp_fornecedor';
```

E reescrever `calcularPCO` (soma tributos da própria classificação, sem param externo):

```typescript
export function calcularPCO(input: {
  cps: CP[];
  adiantamento_categorias_codigos: string[];
  folha_30d: number;
}): PCO {
  let cp_fornecedor = 0;
  let tributos_a_pagar = 0;
  for (const cp of input.cps) {
    const c = classificarCP(cp, input.adiantamento_categorias_codigos);
    if (c === 'pco_cp_fornecedor') cp_fornecedor += cp.saldo;
    else if (c === 'pco_tributos') tributos_a_pagar += cp.saldo;
  }
  const total = cp_fornecedor + input.folha_30d + tributos_a_pagar;
  return { cp_fornecedor, folha_30d: input.folha_30d, tributos_a_pagar, total };
}
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `bun run test -- ncg-helpers`
Expected: PASS (todos os describes de ncg-helpers verdes).

---

## Task 2: Fix 4 — Helpers de PME e CCC (frontend, TDD)

**Files:**
- Modify: `src/lib/financeiro/ncg-helpers.ts`
- Test: `src/lib/financeiro/__tests__/ncg-helpers.test.ts`

- [ ] **Step 1: Escrever os testes de PME e CCC**

Adicionar ao fim de `src/lib/financeiro/__tests__/ncg-helpers.test.ts`:

```typescript
import { calcularPME, calcularCCC } from '../ncg-helpers';

describe('calcularPME', () => {
  it('PME = estoque/CMV * 365', () => {
    expect(calcularPME({ estoque_valor: 30000, cmv_ttm: 365000 })).toBeCloseTo(30, 5);
  });
  it('CMV zero ou ausente → PME 0 (serviços)', () => {
    expect(calcularPME({ estoque_valor: 0, cmv_ttm: 0 })).toBe(0);
    expect(calcularPME({ estoque_valor: 5000, cmv_ttm: 0 })).toBe(0);
  });
});

describe('calcularCCC', () => {
  it('CCC = PMR + PME - PMP', () => {
    expect(calcularCCC({ pmr: 40, pme: 30, pmp: 25 })).toBe(45);
  });
  it('sem estoque vira PMR - PMP', () => {
    expect(calcularCCC({ pmr: 40, pme: 0, pmp: 25 })).toBe(15);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- ncg-helpers`
Expected: FAIL — `calcularPME`/`calcularCCC` não exportados.

- [ ] **Step 3: Implementar os helpers**

Adicionar ao fim de `src/lib/financeiro/ncg-helpers.ts`:

```typescript
export function calcularPME(input: { estoque_valor: number; cmv_ttm: number }): number {
  if (input.cmv_ttm <= 0) return 0;
  return (input.estoque_valor / input.cmv_ttm) * 365;
}

export function calcularCCC(input: { pmr: number; pme: number; pmp: number }): number {
  return input.pmr + input.pme - input.pmp;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- ncg-helpers`
Expected: PASS.

---

## Task 3: Migration SQL — fin_estoque_valor + rename + RPC + triggers

**Files:**
- Create: `supabase/migrations/20260519020000_fin_onda1_ncg.sql`

- [ ] **Step 1: Escrever a migration (arquivo no repo, será colada no SQL Editor)**

Conteúdo de `supabase/migrations/20260519020000_fin_onda1_ncg.sql`:

```sql
-- ============================================================
-- Onda 1 — Correção do NCG
-- 1) fin_estoque_valor (histórico de valor de estoque por empresa)
-- 2) rename capital_giro_proprio -> liquidez_operacional_liquida
-- 3) RPC fin_estimar_estoque_omie (estimativa best-effort)
-- 4) estende fin_period_lock_trigger p/ fin_estoque_valor
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_estoque_valor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company       text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  valor         numeric(15,2) NOT NULL CHECK (valor >= 0),
  data_ref      date NOT NULL,
  fonte         text NOT NULL CHECK (fonte IN ('manual','omie_estimado')) DEFAULT 'manual',
  cobertura_pct numeric(5,2),
  observacao    text,
  criado_por    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_estoque_valor_company_data_idx
  ON fin_estoque_valor (company, data_ref DESC);

ALTER TABLE fin_estoque_valor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_estoque_valor_select_staff ON fin_estoque_valor;
CREATE POLICY fin_estoque_valor_select_staff ON fin_estoque_valor FOR SELECT USING (
  EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('employee','master'))
);
DROP POLICY IF EXISTS fin_estoque_valor_write_master ON fin_estoque_valor;
CREATE POLICY fin_estoque_valor_write_master ON fin_estoque_valor FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master'));

-- Audit trigger (genérico da Fundação)
DROP TRIGGER IF EXISTS trg_audit ON fin_estoque_valor;
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON fin_estoque_valor
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

-- Rename da coluna mal rotulada (preserva dados)
ALTER TABLE fin_projecao_snapshots
  RENAME COLUMN capital_giro_proprio TO liquidez_operacional_liquida;

-- Estende a função de lock p/ cobrir fin_estoque_valor por data_ref.
-- (Recria a função inteira com o novo WHEN; mantém os casos existentes.)
CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
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
  IF v_bypass = 'true' THEN RETURN COALESCE(NEW, OLD); END IF;
  v_target_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company'
  );
  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'          THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'         THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date(COALESCE((NEW).ano,(OLD).ano), COALESCE((NEW).mes,(OLD).mes), 1)
    WHEN 'fin_eventos_recorrentes'   THEN COALESCE((NEW).inicio, (OLD).inicio)
    WHEN 'fin_eventos_eventuais'     THEN COALESCE((NEW).data_prevista, (OLD).data_prevista)
    WHEN 'fin_estoque_valor'         THEN COALESCE((NEW).data_ref, (OLD).data_ref)
  END;
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping','fin_eventos_recorrentes','fin_eventos_eventuais','fin_estoque_valor'
  ) THEN RETURN NEW; END IF;
  IF v_target_date IS NULL OR v_target_company IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT ano, mes INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos WHERE company = v_target_company AND status='fechado' AND aprovado_em IS NOT NULL
    ORDER BY ano DESC, mes DESC LIMIT 1;
  IF v_last_closed_year IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1) + interval '1 month - 1 day')::date;
  IF v_target_date > v_last_closed_date THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now() AND closed_at IS NULL AND opened_by = auth.uid()
  ) INTO v_has_override;
  IF v_has_override THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date), v_target_company, v_last_closed_date
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS trg_period_lock ON fin_estoque_valor;
CREATE TRIGGER trg_period_lock BEFORE UPDATE OR DELETE ON fin_estoque_valor
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

-- RPC estimativa de estoque via Omie (best-effort, retorna score de cobertura).
-- Junta sku_estoque_atual (qtd por empresa) a um custo por SKU.
-- Como a fonte de custo confiável por SKU é parcial, devolve cobertura_pct.
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
RETURNS TABLE (valor_estimado numeric, cobertura_pct numeric, skus_total int, skus_com_custo int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH est AS (
    SELECT s.sku_codigo_omie, s.estoque_fisico,
           pc.cost_price AS custo
      FROM sku_estoque_atual s
      LEFT JOIN product_costs pc ON pc.product_id::text = s.sku_codigo_omie
     WHERE s.empresa = p_company AND COALESCE(s.estoque_fisico,0) > 0
  )
  SELECT
    COALESCE(SUM(CASE WHEN custo > 0 THEN estoque_fisico * custo ELSE 0 END), 0) AS valor_estimado,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE custo > 0) / COUNT(*), 2) END AS cobertura_pct,
    COUNT(*)::int AS skus_total,
    COUNT(*) FILTER (WHERE custo > 0)::int AS skus_com_custo
  FROM est;
$$;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated, service_role;

SELECT 'Onda 1 NCG migration OK' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name='fin_projecao_snapshots' AND column_name='liquidez_operacional_liquida') AS coluna_renomeada,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='fin_estoque_valor') AS tabela_estoque;
```

> ⚠️ A junção `product_costs.product_id::text = sku_codigo_omie` é a aposta de reconciliação. Se na validação a cobertura vier sempre 0, ajustar o JOIN (pode ser via `omie_products.codigo` ou `inventory_position`) — mas isso não bloqueia a Onda 1: o caminho manual funciona independente.

- [ ] **Step 2: Entregar o SQL inline pro founder colar no SQL Editor do Lovable**

Postar o bloco acima na conversa, pedir Run, confirmar: `coluna_renomeada = 1`, `tabela_estoque = 1`.

---

## Task 4: Engine — espelhar Fix 1, 2, 4 + rename no `fin-cashflow-engine`

**Files:**
- Modify: `supabase/functions/fin-cashflow-engine/index.ts`

- [ ] **Step 1: `carregarDados` — carregar estoque + cmv_ttm**

No `Promise.all` de `carregarDados`, adicionar duas queries:

```typescript
    // @ts-expect-error - fin_estoque_valor (Onda 1) não está nos types gerados
    supabase.from('fin_estoque_valor').select('valor, data_ref')
      .eq('company', company).order('data_ref', { ascending: false }).limit(1).maybeSingle(),
    // @ts-expect-error - fin_dre_snapshots não está nos types gerados
    supabase.from('fin_dre_snapshots').select('cmv, ano, mes')
      .eq('company', company).eq('regime', 'competencia'),
```

Renomear o destructuring p/ incluir `estoqueRes, dreRes`. Depois do `Promise.all`:

```typescript
  const estoque_valor = Number((estoqueRes.data as { valor?: number } | null)?.valor ?? 0);
  const estoque_data_ref = (estoqueRes.data as { data_ref?: string } | null)?.data_ref ?? null;

  // CMV TTM: soma dos últimos 12 meses de DRE competência
  const hoje = new Date();
  const cutoffAno = hoje.getMonth() === 11 ? hoje.getFullYear() : hoje.getFullYear() - 1;
  const cmv_ttm = ((dreRes.data ?? []) as Array<{ cmv?: number; ano: number; mes: number }>)
    .filter(d => (d.ano * 12 + d.mes) > (cutoffAno * 12 + (hoje.getMonth() + 1)))
    .reduce((s, d) => s + Number(d.cmv ?? 0), 0);
```

Trocar a linha `const estoque_valor = 0;` (linha ~161) pela leitura acima e remover o hardcode. Adicionar `estoque_valor`, `estoque_data_ref`, `cmv_ttm` ao objeto retornado e ao type `DadosBase`:

```typescript
type DadosBase = {
  crs: CR[]; cps: CP[]; saldo_cc: number; estoque_valor: number;
  estoque_data_ref: string | null; cmv_ttm: number;
  eventos_rec: EventoRecorrente[]; eventos_ev: EventoEventual[]; config: Config;
};
```

- [ ] **Step 2: `calcularNCG` — Fix 1 (exclui tributo do fornecedor) + Fix 2 (estoque real)**

Em `calcularNCG`, o `cp_fornecedor` passa a excluir `3.99`:

```typescript
  const cp_fornecedor = dados.cps
    .filter(c =>
      ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(c.status_titulo) &&
      c.saldo > 0 &&
      (!c.categoria_codigo || !dados.config.adiantamento_categorias_codigos.includes(c.categoria_codigo)) &&
      !(c.categoria_codigo && c.categoria_codigo.startsWith('3.99'))
    )
    .reduce((s, c) => s + c.saldo, 0);
```

E o `aco` usa o estoque real (já vem de `dados.estoque_valor`, que agora não é mais 0):

```typescript
  const aco = {
    cr_aberto,
    estoque: dados.estoque_valor,
    adiantamentos,
    total: cr_aberto + dados.estoque_valor + adiantamentos,
  };
```

(A linha `tributos_a_pagar` com `startsWith('3.99')` permanece — agora sem duplicar.)

- [ ] **Step 3: `calcularIndicadores` — Fix 4 (PME + CCC) + Fix 3 (rename)**

Adicionar PME e mudar CCC; renomear o campo de saída:

```typescript
  const pme = dados.cmv_ttm > 0 ? (dados.estoque_valor / dados.cmv_ttm) * 365 : 0;
  const ccc = pmr + pme - pmp;
```

No objeto retornado, trocar `capital_giro_proprio` por `liquidez_operacional_liquida` e adicionar `prazo_medio_estoque`:

```typescript
  return {
    dias_cobertura,
    liquidez_operacional_liquida: capital_giro_proprio_calc, // mesma fórmula, nome honesto
    saldo_tesouraria,
    inadimplencia_pct: taxas.inadimplencia_observada_pct,
    concentracao_top5_clientes,
    prazo_medio_recebimento: pmr,
    prazo_medio_pagamento: pmp,
    prazo_medio_estoque: pme,
    cash_conversion_cycle: ccc,
  };
```

(Renomear a variável local `capital_giro_proprio` p/ `capital_giro_proprio_calc` ou manter a var e só renomear a chave — manter a fórmula `saldo_cc + ncg.aco.cr_aberto + ncg.aco.estoque − ncg.pco.total`.) Atualizar o `type Indicadores` correspondente.

- [ ] **Step 4: `avaliarAlertas` — usar o novo nome**

No alerta `ncg_deficit`, trocar `indicadores.capital_giro_proprio` por `indicadores.liquidez_operacional_liquida` e o texto "Capital Giro Próprio" por "Liquidez Operacional Líquida".

- [ ] **Step 5: `calcular` (persistência) — usar o novo nome no snapshot**

No insert de `fin_projecao_snapshots`, trocar `capital_giro_proprio: indicadores.capital_giro_proprio` por `liquidez_operacional_liquida: indicadores.liquidez_operacional_liquida`.

- [ ] **Step 6: Re-deploy via chat do Lovable**

Entregar prompt pro founder pedindo ao Lovable AI pra ler `supabase/functions/fin-cashflow-engine/index.ts` do repo e re-deployar verbatim (mesmo fluxo do omie-financeiro). Confirmar "Active" + Last updated.

---

## Task 5: Frontend types + UI (rename, PME, banner)

**Files:**
- Modify: `src/hooks/useCashflowProjection.ts`
- Modify: `src/components/financeiro/cashflow/NcgDecomposicao.tsx`

- [ ] **Step 1: Atualizar o type da resposta**

Em `useCashflowProjection.ts`, no type `indicadores`: trocar `capital_giro_proprio: number;` por `liquidez_operacional_liquida: number;` e adicionar `prazo_medio_estoque: number;`.

- [ ] **Step 2: NcgDecomposicao — relabel CGP + PME no CCC**

Linha 58: trocar a comparação e o texto:

```tsx
              {data.ncg.valor > data.indicadores.liquidez_operacional_liquida ? '⚠ Excede liquidez operacional' : 'Dentro da liquidez'}
```

No card "Cash Conversion Cycle" (grid de 3), virar grid de 4 incluindo PME:

```tsx
          <div className="grid grid-cols-4 gap-4 text-center">
            <div><div className="text-xs text-muted-foreground">PMR</div><div className="text-xl font-mono">{data.indicadores.prazo_medio_recebimento.toFixed(0)}d</div></div>
            <div><div className="text-xs text-muted-foreground">PME</div><div className="text-xl font-mono">{data.indicadores.prazo_medio_estoque.toFixed(0)}d</div></div>
            <div><div className="text-xs text-muted-foreground">PMP</div><div className="text-xl font-mono">{data.indicadores.prazo_medio_pagamento.toFixed(0)}d</div></div>
            <div><div className="text-xs text-muted-foreground">CCC</div><div className={`text-xl font-mono ${data.indicadores.cash_conversion_cycle > 60 ? 'text-status-warning' : ''}`}>{data.indicadores.cash_conversion_cycle.toFixed(0)}d</div></div>
          </div>
```

- [ ] **Step 3: Banner de estoque desatualizado**

A resposta do engine não traz `estoque_data_ref` hoje — expor via o hook de estoque (Task 6) é mais limpo. Aqui, mostrar um aviso simples quando `data.ncg.aco.estoque === 0`:

```tsx
      {data.ncg.aco.estoque === 0 && (
        <div className="rounded-md border border-status-warning-fg/30 bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          ⚠ Estoque não informado — NCG e CCC subestimados. Informe o valor do balancete em Configuração.
        </div>
      )}
```

- [ ] **Step 4: Build local pra garantir que não quebrou tipo**

Run: `bun run build:dev`
Expected: build sem erro de tipo (o rename do campo propagou).

---

## Task 6: Config UI — input de estoque + estimar do Omie

**Files:**
- Create: `src/hooks/useEstoqueValor.ts`
- Modify: `src/components/financeiro/cashflow/ConfigCashflowDialog.tsx`

- [ ] **Step 1: Hook de estoque**

Criar `src/hooks/useEstoqueValor.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EstoqueValor = { valor: number; data_ref: string; fonte: string; cobertura_pct: number | null };

export function useEstoqueValor(company: string) {
  return useQuery({
    queryKey: ['fin_estoque_valor', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<EstoqueValor | null> => {
      // @ts-expect-error - fin_estoque_valor não está nos types gerados (Onda 1)
      const { data, error } = await supabase.from('fin_estoque_valor')
        .select('valor, data_ref, fonte, cobertura_pct')
        .eq('company', company).order('data_ref', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return (data as EstoqueValor | null) ?? null;
    },
  });
}

export function useSalvarEstoque(company: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { valor: number; data_ref: string; fonte?: string; cobertura_pct?: number; observacao?: string }) => {
      // @ts-expect-error - fin_estoque_valor não está nos types gerados (Onda 1)
      const { error } = await supabase.from('fin_estoque_valor').insert({
        company, valor: input.valor, data_ref: input.data_ref,
        fonte: input.fonte ?? 'manual', cobertura_pct: input.cobertura_pct ?? null,
        observacao: input.observacao ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_estoque_valor', company] }),
  });
}

export async function estimarEstoqueOmie(company: string) {
  // @ts-expect-error - RPC não está nos types gerados (Onda 1)
  const { data, error } = await supabase.rpc('fin_estimar_estoque_omie', { p_company: company });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { valor_estimado: number; cobertura_pct: number; skus_total: number; skus_com_custo: number };
}
```

- [ ] **Step 2: Seção de estoque no ConfigCashflowDialog**

Ler `src/components/financeiro/cashflow/ConfigCashflowDialog.tsx` e adicionar uma seção "Valor de estoque (balancete)" com: input de valor (R$), input de data_ref, botão "Salvar" (chama `useSalvarEstoque`), e botão "Estimar do Omie" que chama `estimarEstoqueOmie`, mostra `valor_estimado` + `cobertura_pct` ("X% dos SKUs têm custo") e pré-preenche o input — sem salvar automático. Toast via `import { toast } from 'sonner'`.

- [ ] **Step 3: Build local**

Run: `bun run build:dev`
Expected: sem erro de tipo.

---

## Task 7: Docs — seção Onda 1 no CONFIABILIDADE.md

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Adicionar seção**

No topo do doc (depois da seção A1), adicionar uma subseção "Onda 1 — Correção do NCG (2026-05-19)" listando: PCO não duplica tributo; estoque vem do balancete (manual) com estimativa Omie opcional; "Capital Giro Próprio" virou "Liquidez Operacional Líquida" (CGP verdadeiro chega no A2); CCC agora inclui PME. E a regra de ouro: "sem o valor de estoque do balancete, NCG e CCC subestimam — atualize trimestral".

---

## Task 8: Validação ponta-a-ponta

- [ ] **Step 1: Rodar a suíte completa**

Run: `bun run test`
Expected: 100% verde (inclui os novos testes de ncg-helpers).

- [ ] **Step 2: Lint**

Run: `bun lint`
Expected: sem novos erros.

- [ ] **Step 3: Validação funcional no app (pós-deploy)**

Com a migration aplicada + engine re-deployada: numa empresa com estoque informado, conferir na tab NCG que (a) Estoque aparece > 0 no ACO, (b) Tributos não está mais somado em CP fornecedor (PCO menor que antes se havia imposto), (c) CCC mostra os 4 componentes, (d) card renomeado pra "Liquidez Operacional Líquida". Em Colacor SC sem estoque: PME = 0, banner de aviso aparece.

---

## Self-Review (feito)

**1. Cobertura do spec:** Fix 1 (Task 1+4), Fix 2 (Task 3+4), Fix 3 rename (Task 3+4+5), Fix 4 PME/CCC (Task 2+4+5), tabela fin_estoque_valor (Task 3), helper Omie (Task 3+6), UI banner+config (Task 5+6), docs (Task 7). ✅ Sem lacuna.

**2. Placeholders:** nenhum "TBD/TODO"; todo passo de código tem código. Task 6 Step 2 referencia o ConfigCashflowDialog existente (implementer lê o arquivo) mas descreve exatamente os campos e hooks a usar. ✅

**3. Consistência de tipos:** `liquidez_operacional_liquida` usado de forma idêntica em engine (Task 4), type do hook (Task 5), UI (Task 5), snapshot (Task 3 coluna + Task 4 insert). `prazo_medio_estoque` definido no engine (Task 4) e consumido no type/UI (Task 5). `calcularPCO` perde o param `tributos_30d` em Task 1 — nenhum outro caller fora do teste (confirmado: só ncg-helpers e seu test usam). ✅

**Nota de risco:** o JOIN da RPC `fin_estimar_estoque_omie` (`product_costs.product_id::text = sku_codigo_omie`) é a aposta de reconciliação SKU↔custo; se cobertura vier 0 na validação, ajustar o JOIN — não bloqueia a Onda 1 (manual é a fonte de verdade).
