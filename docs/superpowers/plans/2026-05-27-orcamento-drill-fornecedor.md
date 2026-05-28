# Drill v2 — Concentração por Fornecedor/Cliente — Plano

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. **Codex em todas as etapas:** metodologia ✓ · spec ✓ (3 P1) · plano ← Codex antes de executar · código ← Codex adversarial (Task 3).

**Goal:** Toggle no painel do drill ("Por categoria | Por fornecedor·cliente") que re-agrega a linha por entidade (concentração YTD + aumento YoY), só em linhas puras. Client-side, sem migration. Spec: `docs/superpowers/specs/2026-05-27-orcamento-drill-fornecedor-design.md`.

---

### Task 1: Helper `orcamento-entidade-helpers.ts` (TDD)

**Files:** Create `src/lib/financeiro/orcamento-entidade-helpers.ts` + `__tests__/orcamento-entidade-helpers.test.ts`

Contrato: `entidadeDaLinha`, `concentrarPorEntidade`, tipos `EntidadeRowRaw`/`EntidadeComponente`/`EntidadeClasse`/`EntidadeConcentracaoResult`, `EPSILON_MONETARIO=0.01`. `round2(n)=Math.round((n+Number.EPSILON)*100)/100`.

- [ ] **Step 1: testes que falham:**

```ts
import { describe, it, expect } from 'vitest';
import { entidadeDaLinha, concentrarPorEntidade, type EntidadeRowRaw } from '../orcamento-entidade-helpers';

const r = (id: string | null, nome: string | null, mes: number, valor: number): EntidadeRowRaw =>
  ({ entidade_id: id, entidade_nome: nome, mes, valor });

describe('entidadeDaLinha', () => {
  it('despesas → fornecedor (cp); receitas → cliente (cr); deducoes/impostos/derivada → null', () => {
    expect(entidadeDaLinha('despesas_comerciais')).toEqual({ fonte: 'cp', rotulo: 'fornecedor' });
    expect(entidadeDaLinha('cmv')).toEqual({ fonte: 'cp', rotulo: 'fornecedor' });
    expect(entidadeDaLinha('receita_bruta')).toEqual({ fonte: 'cr', rotulo: 'cliente' });
    expect(entidadeDaLinha('receitas_financeiras')).toEqual({ fonte: 'cr', rotulo: 'cliente' });
    expect(entidadeDaLinha('deducoes')).toBeNull();
    expect(entidadeDaLinha('impostos')).toBeNull();
    expect(entidadeDaLinha('resultado_operacional')).toBeNull();
  });
});

describe('concentrarPorEntidade', () => {
  const base = { mesesFechados: [1, 2, 3], topN: 2 };

  it('agrega por cnpj, delta assinado, peso, ordena por delta desc; reconcilia total', () => {
    const rowsAno = [
      r('11111111111111', 'Fornecedor A', 1, 300), r('11111111111111', 'Fornecedor A', 2, 300), // A=600
      r('22222222222222', 'Fornecedor B', 1, 100),                                                 // B=100
      r('33333333333333', 'Fornecedor C', 4, 999),                                                 // mês aberto → fora
    ];
    const rowsAnoAnterior = [r('11111111111111', 'Fornecedor A', 1, 200), r('22222222222222', 'Fornecedor B', 1, 100)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, ...base });
    expect(res.total_ano).toBe(700);
    expect(res.total_ano_anterior).toBe(300);
    expect(res.componentes[0].entidade_chave).toBe('11111111111111'); // maior delta (+400)
    expect(res.componentes[0].delta).toBe(400);
    expect(res.componentes[0].peso_perc).toBeCloseTo(600 / 700, 5);
    expect(res.componentes[0].classe).toBe('recorrente');
    expect(res.componentes.find(c => c.entidade_chave === '22222222222222')!.delta).toBe(0);
  });

  it('aumento_bruto = Σ max(delta,0); top_n_peso_aumento não estoura 100%; sumiu fora do aumento', () => {
    const rowsAno = [r('11111111111111', 'A', 1, 500)]; // A novo (+500)
    const rowsAnoAnterior = [r('99999999999999', 'Z', 1, 800)]; // Z sumiu (−800)
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1], topN: 3 });
    expect(res.aumento_bruto).toBe(500); // só o +500 do A; Z (sumiu) não entra
    expect(res.top_n_peso_aumento_perc).toBeCloseTo(1, 5); // A = 100% do aumento
    expect(res.componentes.find(c => c.entidade_chave === '11111111111111')!.classe).toBe('novo');
    expect(res.componentes.find(c => c.entidade_chave === '99999999999999')!.classe).toBe('sumiu');
  });

  it('sem aumento (tudo caiu) → top_n_peso_aumento_perc null + sem_aumento_bruto', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('11111111111111', 'A', 1, 100)],
      rowsAnoAnterior: [r('11111111111111', 'A', 1, 300)],
      mesesFechados: [1], topN: 3,
    });
    expect(res.aumento_bruto).toBe(0);
    expect(res.sem_aumento_bruto).toBe(true);
    expect(res.top_n_peso_aumento_perc).toBeNull();
  });

  it('identidade: cnpj sentinela/curto → cai no nome normalizado; sem nome → sem_identificacao', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('00000000000000', 'Posto X', 1, 100), r('', '  posto x ', 2, 50), r(null, null, 1, 30)],
      rowsAnoAnterior: [], mesesFechados: [1, 2], topN: 3,
    });
    // '00000000000000' (sentinela) e '' caem no nome normalizado 'POSTO X' → mesma entidade (100+50=150)
    const posto = res.componentes.find(c => c.entidade_chave === 'POSTO X');
    expect(posto).toBeDefined();
    expect(posto!.realizado_ytd).toBe(150);
    expect(posto!.sem_id).toBe(true);
    // sem cnpj e sem nome → sem_identificacao
    expect(res.componentes.find(c => c.entidade_chave === 'sem_identificacao')!.realizado_ytd).toBe(30);
  });

  it('cnpj válido (14) e cpf válido (11) viram chave; mês null/fora ignorado; sem NaN', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('11.222.333/0001-44', 'A', 1, 100), { entidade_id: 'x', entidade_nome: 'A', mes: null, valor: 999 }],
      rowsAnoAnterior: [], mesesFechados: [1], topN: 3,
    });
    expect(res.componentes.find(c => c.entidade_chave === '11222333000144')).toBeDefined(); // dígitos limpos
    expect(res.total_ano).toBe(100); // mes null ignorado
    expect(res.componentes.every(c => Number.isFinite(c.peso_perc))).toBe(true);
  });

  it('truncado repassado; total zero → pesos 0 sem Infinity', () => {
    const res = concentrarPorEntidade({ rowsAno: [], rowsAnoAnterior: [], mesesFechados: [1], topN: 3, truncado: true });
    expect(res.truncado).toBe(true);
    expect(res.total_ano).toBe(0);
    expect(res.top_n_peso_nivel_perc).toBe(0);
  });
});
```

- [ ] **Step 2:** ver falhar (`bunx vitest run src/lib/financeiro/__tests__/orcamento-entidade-helpers.test.ts`).
- [ ] **Step 3:** implementar conforme a "Lógica" do spec (chave cnpjValido→nome→sem_identificacao; agg bruto; `aumento_bruto=Σmax(delta,0)`; nível por abs; aumento clamp+null; round no fim; mês null/fora ignorado).
- [ ] **Step 4:** ver passar.
- [ ] **Step 5: commit** — `feat(orcamento): helper concentração por fornecedor/cliente (Pareto nível+aumento) + testes`.

---

### Task 2: Service + toggle no painel

**Files:** Modify `src/services/financeiroV2Service.ts` + `src/components/financeiro/DrillVarianciaPanel.tsx` + `src/pages/FinanceiroOrcamento.tsx`

- [ ] **Step 1: `getTitulosEntidadeRaw`** no service:

```ts
import type { EntidadeRowRaw } from '@/lib/financeiro/orcamento-entidade-helpers';

const MAX_TITULOS = 20000;
const CHUNK_CODIGOS = 100;

export async function getTitulosEntidadeRaw(
  fonte: 'cp' | 'cr', company: Company, ano: number, codigos: string[],
): Promise<{ rows: EntidadeRowRaw[]; truncado: boolean }> {
  if (codigos.length === 0) return { rows: [], truncado: false };
  const tabela = fonte === 'cp' ? 'fin_contas_pagar' : 'fin_contas_receber';
  const nomeCol = fonte === 'cp' ? 'nome_fornecedor' : 'nome_cliente';
  const out: EntidadeRowRaw[] = [];
  let truncado = false;
  for (let i = 0; i < codigos.length && !truncado; i += CHUNK_CODIGOS) {
    const lote = codigos.slice(i, i + CHUNK_CODIGOS);
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await supabase
        .from(tabela)
        .select(`cnpj_cpf, ${nomeCol}, data_emissao, valor_documento`)
        .eq('company', company)
        .not('data_emissao', 'is', null)
        .gte('data_emissao', `${ano}-01-01`)
        .lt('data_emissao', `${ano + 1}-01-01`)
        .neq('status_titulo', 'CANCELADO')
        .in('categoria_codigo', lote)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const de = row.data_emissao as string | null;
        out.push({
          entidade_id: (row.cnpj_cpf as string | null) ?? null,
          entidade_nome: (row[nomeCol] as string | null) ?? null,
          mes: de ? Number(de.slice(5, 7)) : null,
          valor: (row.valor_documento as number | null) ?? 0,
        });
        if (out.length >= MAX_TITULOS) { truncado = true; break; }
      }
      if (truncado || rows.length < PAGE) break;
      from += PAGE;
    }
  }
  return { rows: out, truncado };
}
```

- [ ] **Step 2:** no painel `DrillVarianciaPanel`, adicionar **toggle** `lente: 'categoria' | 'entidade'` (a aba entidade só aparece se `entidadeDaLinha(dre_linha) != null`). Passar pro painel: `entidadeData` (resultado de `concentrarPorEntidade`), `entidadeLoading/Error`, `entidadeInfo` (rótulo fornecedor/cliente), `totalCategoriaV1` (= `result.total_decomposto`, alvo de reconciliação).
- [ ] **Step 3:** na página, quando `lente==='entidade'`: derivar `codigos` (mapping resolvido + `aliasesDaLinha(linha, regime)` — extrair um helper `codigosDaLinha(mapping, linha, regime)` exportado do `orcamento-drill-helpers.ts` e reusar no `drillLinha`), `useQuery(['orcamento-drill-entidade', company, ano, linha])` enabled quando a aba entidade ativa → `getTitulosEntidadeRaw(fonte, company, ano, codigos)` (ano + ano-1 via Promise.all) → `concentrarPorEntidade`. Render: 2 cards + tabela + reconciliação (Σ entidades vs `total_decomposto` v1 vs diff + contexto snapshot `realizado_fechado`); modo diagnóstico se `truncado`; copy honesto.
- [ ] **Step 4:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 5: commit** — `feat(orcamento): toggle "Por fornecedor·cliente" no drill (concentração + aumento YoY)`.

---

### Task 3: Docs + validação + Codex adversarial + PR

- [ ] **Step 1:** seção no `FINANCEIRO_CONFIABILIDADE.md` (drill v2 entregue; reconcilia contra total-categoria do v1, não o snapshot; limitações nome/filial, truncado).
- [ ] **Step 2: validação** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex ADVERSARIAL** no helper + integração: Pareto não estoura? identidade não funde indevido? reconciliação contra v1 (não snapshot)? chunked .in correto? truncado→diagnóstico? NaN? Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (sem migration/deploy); auto-merge `--squash --auto`.

---

## Notas
- **Sem migration/edge/deploy** (client-side).
- Reconciliação do v2 = contra o total-por-categoria do v1 (mesma base viva), NÃO o snapshot (Codex P1.1).
- `tsc --noEmit -p tsconfig.app.json` é o typecheck do `src`.
