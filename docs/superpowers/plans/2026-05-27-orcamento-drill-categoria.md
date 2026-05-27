# Drill de Variância por Categoria — Plano de Implementação

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. **Codex em todas as etapas** (instrução do founder): metodologia ✓ · spec ✓ (aliases fiscais regime-aware) · plano ← Codex antes de executar · código ← Codex adversarial (Task 3).

**Goal:** Na seção "Forecast de aterrissagem" (`/financeiro/orcamento`), expandir inline cada linha de DRE que **fura a meta** para mostrar de quais categorias do Omie vem o realizado YTD (atribuição por código), com delta YoY mesmos meses fechados e reconciliação honesta vs `fin_dre_snapshots`.

**Architecture:** Helper puro `orcamento-drill-helpers.ts` (TDD) + `getCategoriasDimensaoRaw` no `financeiroV2Service` + expansão inline na página. **Client-side, sem migration/edge/deploy.** Spec: `docs/superpowers/specs/2026-05-27-orcamento-drill-categoria-design.md`.

---

### Task 1: Helper `orcamento-drill-helpers.ts` (TDD)

**Files:** Create `src/lib/financeiro/orcamento-drill-helpers.ts` + `src/lib/financeiro/__tests__/orcamento-drill-helpers.test.ts`

Contrato (ver spec para detalhe): `DimRowRaw`, `DrillComponente`, `DrillQualidade`, `DrillResult`, `EPSILON_MONETARIO=0.01`, `fontesDaLinha`, `aliasesDaLinha`, `drillLinha`. `round2(n)=Math.round((n+Number.EPSILON)*100)/100`.

- [ ] **Step 1: testes que falham** (criar o test file):

```ts
import { describe, it, expect } from 'vitest';
import {
  fontesDaLinha, aliasesDaLinha, drillLinha,
  type DimRowRaw,
} from '../orcamento-drill-helpers';

const row = (codigo: string, mes: number, valor: number, desc = codigo): DimRowRaw => ({
  categoria_codigo: codigo, categoria_descricao: desc, mes, valor,
});
const map = (codigo: string, dre_linha: string, company = '_default') => ({ omie_codigo: codigo, dre_linha, company });

describe('fontesDaLinha', () => {
  it('receitas → cr; despesas → cp; deducoes → cr+cp; derivada → []', () => {
    expect(fontesDaLinha('receita_bruta')).toEqual(['cr']);
    expect(fontesDaLinha('receitas_financeiras')).toEqual(['cr']);
    expect(fontesDaLinha('despesas_comerciais')).toEqual(['cp']);
    expect(fontesDaLinha('impostos')).toEqual(['cp']);
    expect(fontesDaLinha('deducoes')).toEqual(['cr', 'cp']);
    expect(fontesDaLinha('resultado_operacional')).toEqual([]);
    expect(fontesDaLinha('lucro_bruto')).toEqual([]);
  });
});

describe('aliasesDaLinha', () => {
  it('deducoes agrega sublinhas fiscais + das + impostos legado (ambos regimes)', () => {
    const esperado = ['deducoes','ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das','impostos'];
    expect(aliasesDaLinha('deducoes', 'simples').sort()).toEqual([...esperado].sort());
    expect(aliasesDaLinha('deducoes', 'presumido').sort()).toEqual([...esperado].sort());
  });
  it('impostos: simples vazio (DAS está em deducoes), presumido irpj+csll', () => {
    expect(aliasesDaLinha('impostos', 'simples')).toEqual([]);
    expect(aliasesDaLinha('impostos', 'presumido').sort()).toEqual(['csll','irpj']);
  });
  it('linha comum → alias literal', () => {
    expect(aliasesDaLinha('cmv', 'presumido')).toEqual(['cmv']);
    expect(aliasesDaLinha('despesas_comerciais', 'simples')).toEqual(['despesas_comerciais']);
  });
});

describe('drillLinha', () => {
  const base = {
    mesesFechados: [1, 2, 3],
    forecastRestante: 1000,
    varianciaAnual: -500,
    realizadoSnapshot: 300,
  };

  it('decompõe por código, ordena por |realizado_ytd| desc, calcula delta/peso e reconcilia ok', () => {
    const rowsAno = [
      row('2.01.01', 1, 100), row('2.01.01', 2, 100), // cat A = 200
      row('2.01.02', 1, 100),                          // cat B = 100
      row('2.01.99', 4, 999),                          // mês 4 (aberto) → ignorado
    ];
    const rowsAnoAnterior = [row('2.01.01', 1, 50), row('2.01.02', 1, 80)];
    const r = drillLinha({
      dreLinha: 'despesas_comerciais', regime: 'presumido',
      rowsAno, rowsAnoAnterior, mapping: [map('2.01.01','despesas_comerciais'), map('2.01.02','despesas_comerciais'), map('2.01.99','cmv')],
      ...base,
    });
    expect(r.fontes).toEqual(['cp']);
    expect(r.componentes.map(c => c.categoria_codigo)).toEqual(['2.01.01', '2.01.02']); // sort |realizado| desc
    expect(r.componentes[0].realizado_ytd).toBe(200);
    expect(r.componentes[0].realizado_ytd_ano_anterior).toBe(50);
    expect(r.componentes[0].delta).toBe(150);
    expect(r.componentes[0].delta_perc).toBeCloseTo(3, 5); // 150/50
    expect(r.componentes[0].peso_perc).toBeCloseTo(200 / 300, 5);
    expect(r.total_decomposto).toBe(300);
    expect(r.residuo).toBe(0);
    expect(r.qualidade).toBe('ok');
    expect(r.forecast_nao_decomposto).toBe(1000);
    expect(r.variancia_anual).toBe(-500);
  });

  it('mapping: company sobrescreve _default (código sai da linha-alvo)', () => {
    const rowsAno = [row('2.01.01', 1, 100)];
    const r = drillLinha({
      dreLinha: 'despesas_comerciais', regime: 'presumido',
      rowsAno, rowsAnoAnterior: [],
      mapping: [map('2.01.01','despesas_comerciais','_default'), map('2.01.01','cmv','oben')],
      ...base, realizadoSnapshot: 0,
    });
    expect(r.componentes).toHaveLength(0); // resolveu p/ cmv → não entra em despesas_comerciais
    expect(r.total_decomposto).toBe(0);
  });

  it('deducoes (simples) captura DAS lançado em CP', () => {
    const rowsAno = [row('1.05.01', 1, 500, 'DAS Simples')];
    const r = drillLinha({
      dreLinha: 'deducoes', regime: 'simples',
      rowsAno, rowsAnoAnterior: [], mapping: [map('1.05.01', 'das')],
      ...base, realizadoSnapshot: 500,
    });
    expect(r.fontes).toEqual(['cr', 'cp']);
    expect(r.componentes).toHaveLength(1);
    expect(r.componentes[0].categoria_descricao).toBe('DAS Simples');
    expect(r.componentes[0].realizado_ytd).toBe(500);
    expect(r.qualidade).toBe('ok');
  });

  it('impostos (simples) → vazio (alias []), reconcilia ok com snapshot 0', () => {
    const r = drillLinha({
      dreLinha: 'impostos', regime: 'simples',
      rowsAno: [row('1.06.01', 1, 999)], rowsAnoAnterior: [], mapping: [map('1.06.01','irpj')],
      ...base, realizadoSnapshot: 0,
    });
    expect(r.componentes).toHaveLength(0);
    expect(r.residuo_perc).toBeNull();
    expect(r.qualidade).toBe('ok'); // snapshot≈0 e decomposto≈0
  });

  it('label fallback p/ código só no ano-1; delta_perc denominador absoluto', () => {
    const r = drillLinha({
      dreLinha: 'despesas_administrativas', regime: 'presumido',
      rowsAno: [], rowsAnoAnterior: [row('3.01', 1, 200, 'Aluguel 2025')],
      mapping: [map('3.01','despesas_administrativas')],
      ...base, realizadoSnapshot: 0,
    });
    expect(r.componentes[0].categoria_descricao).toBe('Aluguel 2025');
    expect(r.componentes[0].realizado_ytd).toBe(0);
    expect(r.componentes[0].realizado_ytd_ano_anterior).toBe(200);
    expect(r.componentes[0].delta).toBe(-200);
    expect(r.componentes[0].delta_perc).toBeCloseTo(-1, 5); // -200/abs(200)
  });

  it('reconciliação: parcial (5-20%) e diagnostico (>20%)', () => {
    const mk = (snapshot: number) => drillLinha({
      dreLinha: 'cmv', regime: 'presumido',
      rowsAno: [row('4.01', 1, 100)], rowsAnoAnterior: [], mapping: [map('4.01','cmv')],
      mesesFechados: [1], forecastRestante: 0, varianciaAnual: 0, realizadoSnapshot: snapshot,
    });
    expect(mk(110).qualidade).toBe('parcial');     // residuo 10/110 ≈ 9%
    expect(mk(200).qualidade).toBe('diagnostico');  // residuo 100/200 = 50%
    expect(mk(101).qualidade).toBe('ok');           // residuo 1/101 ≈ 1% e ≤R$10k
  });

  it('snapshot≈0 mas decomposto≠0 → diagnostico', () => {
    const r = drillLinha({
      dreLinha: 'cmv', regime: 'presumido',
      rowsAno: [row('4.01', 1, 100)], rowsAnoAnterior: [], mapping: [map('4.01','cmv')],
      mesesFechados: [1], forecastRestante: 0, varianciaAnual: 0, realizadoSnapshot: 0,
    });
    expect(r.residuo_perc).toBeNull();
    expect(r.qualidade).toBe('diagnostico');
  });
});
```

- [ ] **Step 2: ver falhar** — `bunx vitest run src/lib/financeiro/__tests__/orcamento-drill-helpers.test.ts` (módulo não existe).
- [ ] **Step 3: implementar** `orcamento-drill-helpers.ts` conforme a "Lógica de drillLinha" do spec (resolução company>_default determinística; aggregação bruta; round só no fim; qualidade com bordas epsilon).
- [ ] **Step 4: ver passar** — suíte verde.
- [ ] **Step 5: commit** — `feat(orcamento): helper drill de variância por categoria (aliases fiscais, reconciliação) + testes`.

---

### Task 2: Service + página (expansão inline)

**Files:** Modify `src/services/financeiroV2Service.ts` + `src/pages/FinanceiroOrcamento.tsx`

- [ ] **Step 1: `getCategoriasDimensaoRaw`** no `financeiroV2Service.ts`:

```ts
import type { DimRowRaw } from '@/lib/financeiro/orcamento-drill-helpers';

export async function getCategoriasDimensaoRaw(
  tipo: 'cr' | 'cp', company: Company, ano: number
): Promise<DimRowRaw[]> {
  const rpc = tipo === 'cr' ? 'fin_analise_cr_dimensoes_rpc' : 'fin_analise_cp_dimensoes_rpc';
  const { data, error } = await supabase.rpc(rpc as never, { p_company: company, p_ano: ano, p_mes: null } as never);
  if (error) throw error;
  const rows = (data as unknown as Array<{ categoria_codigo: string | null; categoria_descricao: string | null; mes: number | null; total_documento: number | null }>) ?? [];
  return rows.map(r => ({ categoria_codigo: r.categoria_codigo, categoria_descricao: r.categoria_descricao, mes: r.mes, valor: r.total_documento ?? 0 }));
}
```

- [ ] **Step 2:** Na seção Forecast da página, tornar expansível cada linha com `fura_meta === true && fontesDaLinha(linha.dre_linha).length > 0`. Estado `expandedLinha: string | null`. `regime` via mapa `{ colacor:'presumido', oben:'presumido', colacor_sc:'simples' }`.
- [ ] **Step 3:** Ao expandir (lazy, `useQuery` chaveado `['drill-dim', tipo, company, ano]` por fonte+ano): buscar `getCategoriasDimensaoRaw` para cada fonte de `fontesDaLinha` (ano + ano-1), concatenar, buscar `getCategoryMappings(company)`, rodar `drillLinha`. Render: (a) faixa de contexto (variância anual + fura_meta); (b) tabela de componentes (descrição, realizado YTD, YoY ano-1, delta, peso); (c) bloco "forecast restante (não decomposto)"; (d) faixa de reconciliação (snapshot vs decomposto vs resíduo + badge de qualidade via `text-status-*`: ok=success, parcial=warning, diagnostico=error). Skeleton no loading.
- [ ] **Step 4:** Copy honesto (P2.10): "Principais componentes do realizado YTD" / "Maiores variações vs {ano-1}" — NUNCA "explicam o furo". Aviso quando `parcial`/`diagnostico`.
- [ ] **Step 5:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 6: commit** — `feat(orcamento): drill inline de variância por categoria na seção Forecast`.

---

### Task 3: Docs + validação + Codex adversarial + PR

- [ ] **Step 1:** atualizar a seção Orçamento no `docs/FINANCEIRO_CONFIABILIDADE.md` (drill entregue; limitações v1: mapping não-versionado, divergência view×snapshot exposta pelo resíduo, financeiras de movimentações).
- [ ] **Step 2: validação** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex ADVERSARIAL** no helper + integração: aliases fiscais corretos (DAS em deducoes no simples; irpj/csll em impostos só presumido)? mapping company>_default determinístico? reconciliação não fabrica resíduo de centavo? multi-source não duplica? bordas epsilon? algum NaN? Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (sem migration/deploy — client-side); auto-merge `--squash --auto`.

---

## Notas
- **Sem migration, sem edge function, sem deploy** (client-side; lê RPCs/serviços existentes).
- **`tsc --noEmit -p tsconfig.app.json`** é o typecheck que pega o `src`.
- Drill explica **realizado YTD**, não a variância anual (landing). Copy e UI impedem a leitura errada (Codex P1.2/P2.10).
