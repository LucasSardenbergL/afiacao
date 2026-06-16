# Drill v2 — Concentração por Fornecedor/Cliente — Plano

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. **Codex em todas as etapas:** metodologia ✓ · spec ✓ (3 P1) · plano ← Codex antes de executar · código ← Codex adversarial (Task 3).

**Goal:** Toggle no painel do drill ("Por categoria | Por fornecedor·cliente") que re-agrega a linha por entidade (concentração YTD + aumento YoY), só em linhas puras. Client-side, sem migration. Spec: `docs/superpowers/specs/2026-05-27-orcamento-drill-fornecedor-design.md`.

---

### Task 1a: Extrair `codigosDaLinha` no v1 (`orcamento-drill-helpers.ts`)

**Files:** Modify `src/lib/financeiro/orcamento-drill-helpers.ts` + `__tests__/orcamento-drill-helpers.test.ts`

Pra reconciliação v2↔v1 fechar, **os DOIS** precisam usar o MESMO conjunto de códigos (Codex P1.5). Extrair a resolução que hoje está inline no `drillLinha`:

```ts
// resolve mapping (company sobrescreve _default, order-independent) + filtra códigos cuja linha ∈ aliasesDaLinha(dreLinha, regime). Deduplicado.
export function codigosDaLinha(
  mapping: { omie_codigo: string; dre_linha: string; company: string }[],
  dreLinha: string,
  regime: 'simples' | 'presumido',
): string[];
```

- [ ] **Step 1:** refatorar `drillLinha` pra computar `codigosAlvo` via `new Set(codigosDaLinha(mapping, dreLinha, regime))` (comportamento idêntico — as 15 specs atuais devem seguir verdes).
- [ ] **Step 2:** APPEND ao test file do v1:

```ts
import { codigosDaLinha } from '../orcamento-drill-helpers';
describe('codigosDaLinha', () => {
  const map = (c: string, l: string, company = '_default') => ({ omie_codigo: c, dre_linha: l, company });
  it('resolve company>_default order-independent; filtra por alias; dedup', () => {
    const ordemA = [map('1','despesas_comerciais','_default'), map('1','cmv','oben'), map('2','despesas_comerciais')];
    const ordemB = [...ordemA].reverse();
    expect(codigosDaLinha(ordemA,'cmv','presumido').sort()).toEqual(['1']);          // company(oben) vence
    expect(codigosDaLinha(ordemB,'cmv','presumido').sort()).toEqual(['1']);          // mesma resposta
    expect(codigosDaLinha(ordemA,'despesas_comerciais','presumido').sort()).toEqual(['2']);
  });
  it('aliases fiscais regime-aware: deducoes pega ded_*/das; impostos simples vazio', () => {
    const m = [map('a','ded_icms'), map('b','das'), map('c','irpj')];
    expect(codigosDaLinha(m,'deducoes','presumido').sort()).toEqual(['a','b']);
    expect(codigosDaLinha(m,'impostos','simples')).toEqual([]);
    expect(codigosDaLinha(m,'impostos','presumido')).toEqual(['c']);
  });
});
```

- [ ] **Step 3:** ver passar (todas as specs do v1 + as novas). **Commit:** `refactor(orcamento): extrai codigosDaLinha (reuso v1/v2) + testes`.

---

### Task 1b: Helpers do v2 `orcamento-entidade-helpers.ts` (TDD)

**Files:** Create `src/lib/financeiro/orcamento-entidade-helpers.ts` + `__tests__/orcamento-entidade-helpers.test.ts`

Contrato: `entidadeDaLinha`, `concentrarPorEntidade`, `coletarTitulosEntidade` (orquestrador puro, testável), `parseMesDataEmissao`, tipos. `EPSILON_MONETARIO=0.01`. `cnpjValido(s)`: dígitos `∈{11,14}` E não-todos-iguais (NÃO valida dígito verificador — só rejeita lixo/sentinela). `round2` padrão.

> ⚠️ **Fixtures usam dígitos NÃO-uniformes** (Codex P1.1: `11111111111111` é todos-iguais → rejeitado por `cnpjValido`).

- [ ] **Step 1: testes que falham:**

```ts
import { describe, it, expect } from 'vitest';
import { entidadeDaLinha, concentrarPorEntidade, coletarTitulosEntidade, type EntidadeRowRaw } from '../orcamento-entidade-helpers';

const r = (id: string | null, nome: string | null, mes: number, valor: number): EntidadeRowRaw =>
  ({ entidade_id: id, entidade_nome: nome, mes, valor });
const A = '11222333000144', B = '22333444000155', C = '33444555000166', Z = '99888777000166'; // CNPJs não-uniformes
const CPF = '11144477735'; // 11 dígitos não-uniformes

describe('entidadeDaLinha', () => {
  it('pina todas as linhas: despesas→cp/fornecedor, receitas→cr/cliente, fiscais/derivadas→null', () => {
    for (const l of ['cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais','despesas_financeiras','outras_despesas'])
      expect(entidadeDaLinha(l)).toEqual({ fonte: 'cp', rotulo: 'fornecedor' });
    for (const l of ['receita_bruta','receitas_financeiras','outras_receitas'])
      expect(entidadeDaLinha(l)).toEqual({ fonte: 'cr', rotulo: 'cliente' });
    for (const l of ['deducoes','impostos','resultado_operacional','lucro_bruto'])
      expect(entidadeDaLinha(l)).toBeNull();
  });
});

describe('concentrarPorEntidade', () => {
  it('agrega por cnpj, delta assinado, peso, ordena por delta desc; reconcilia total', () => {
    const rowsAno = [r(A,'A',1,300), r(A,'A',2,300), r(B,'B',1,100), r(C,'C',4,999)]; // C mês 4 → fora
    const rowsAnoAnterior = [r(A,'A',1,200), r(B,'B',1,100)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1,2,3], topN: 2 });
    expect(res.total_ano).toBe(700);
    expect(res.total_ano_anterior).toBe(300);
    expect(res.componentes[0].entidade_chave).toBe(A);      // maior delta (+400)
    expect(res.componentes[0].delta).toBe(400);
    expect(res.componentes[0].peso_perc).toBeCloseTo(600/700, 5);
    expect(res.componentes[0].classe).toBe('recorrente');
    expect(res.componentes.find(c => c.entidade_chave === B)!.delta).toBe(0);
  });

  it('aumento_bruto=Σmax(delta,0) sobre TODAS (não só topN); sumiu fora; não estoura 100%', () => {
    // deltas: A +100, B +50, C +25, D +25 → aumento_bruto=200; topN=2 → (100+50)/200=0.75
    const D = '44555666000177';
    const rowsAno = [r(A,'A',1,100), r(B,'B',1,50), r(C,'C',1,25), r(D,'D',1,25), r(Z,'Z',1,0)];
    const rowsAnoAnterior = [r(Z,'Z',1,300)]; // Z sumiu (−300), fora do aumento
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1], topN: 2 });
    expect(res.aumento_bruto).toBe(200);
    expect(res.top_n_peso_aumento_perc).toBeCloseTo(0.75, 5);
    expect(res.componentes.find(c => c.entidade_chave === A)!.classe).toBe('novo');
    expect(res.componentes.find(c => c.entidade_chave === Z)!.classe).toBe('sumiu');
  });

  it('Pareto de NÍVEL usa abs(realizado), não delta (estorno não esconde fornecedor material)', () => {
    // A: realizado 10, delta +10; B: realizado 1000, delta −100. topN=1 → nível pega B.
    const rowsAno = [r(A,'A',1,10), r(B,'B',1,1000)];
    const rowsAnoAnterior = [r(B,'B',1,1100)];
    const res = concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: [1], topN: 1 });
    expect(res.top_n_peso_nivel_perc).toBeCloseTo(1000/1010, 5); // B domina o nível
  });

  it('sem aumento (tudo caiu) → top_n_peso_aumento_perc null + sem_aumento_bruto', () => {
    const res = concentrarPorEntidade({ rowsAno: [r(A,'A',1,100)], rowsAnoAnterior: [r(A,'A',1,300)], mesesFechados: [1], topN: 3 });
    expect(res.aumento_bruto).toBe(0);
    expect(res.sem_aumento_bruto).toBe(true);
    expect(res.top_n_peso_aumento_perc).toBeNull();
  });

  it('identidade: cnpj sentinela/curto → nome normalizado; sem nome → sem_identificacao', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('00000000000000','Posto X',1,100), r('','  posto x ',2,50), r(null,null,1,30)],
      rowsAnoAnterior: [], mesesFechados: [1,2], topN: 3,
    });
    const posto = res.componentes.find(c => c.entidade_chave === 'POSTO X');
    expect(posto!.realizado_ytd).toBe(150); // sentinela + '' caem no nome 'POSTO X'
    expect(posto!.sem_id).toBe(true);
    expect(res.componentes.find(c => c.entidade_chave === 'sem_identificacao')!.realizado_ytd).toBe(30);
  });

  it('cnpj com máscara e CPF (11) viram dígitos limpos; mês null/fora ignorado; sem NaN', () => {
    const res = concentrarPorEntidade({
      rowsAno: [r('11.222.333/0001-44','A',1,100), r(CPF,'Pessoa',1,40), { entidade_id:'x', entidade_nome:'A', mes:null, valor:999 }],
      rowsAnoAnterior: [], mesesFechados: [1], topN: 3,
    });
    expect(res.componentes.find(c => c.entidade_chave === A)).toBeDefined(); // máscara → 11222333000144
    expect(res.componentes.find(c => c.entidade_chave === CPF)).toBeDefined();
    expect(res.total_ano).toBe(140); // mes null ignorado
    expect(res.componentes.every(c => Number.isFinite(c.peso_perc))).toBe(true);
  });

  it('truncado repassado; total zero → pesos 0 sem Infinity', () => {
    const res = concentrarPorEntidade({ rowsAno: [], rowsAnoAnterior: [], mesesFechados: [1], topN: 3, truncado: true });
    expect(res.truncado).toBe(true);
    expect(res.total_ano).toBe(0);
    expect(res.top_n_peso_nivel_perc).toBe(0);
  });
});

describe('parseMesDataEmissao', () => {
  it('YYYY-MM-DD → mês; malformado/null → null', () => {
    expect(parseMesDataEmissao('2026-03-15')).toBe(3);
    expect(parseMesDataEmissao('2026-12-01')).toBe(12);
    expect(parseMesDataEmissao(null)).toBeNull();
    expect(parseMesDataEmissao('lixo')).toBeNull();
  });
});

describe('coletarTitulosEntidade (orquestrador: chunk + página + teto)', () => {
  it('parte códigos em lotes, pagina por lote, acumula; truncado=false abaixo do teto', async () => {
    const calls: Array<{ lote: string[]; offset: number }> = [];
    const fake = async (lote: string[], offset: number, limit: number): Promise<EntidadeRowRaw[]> => {
      calls.push({ lote, offset });
      // lote ['x'] devolve 1 página de 2; demais vazio
      if (lote.includes('x') && offset === 0) return [r(A,'A',1,10), r(B,'B',1,20)];
      return [];
    };
    const res = await coletarTitulosEntidade({ codigos: ['x','y'], fetchPagina: fake, chunkCodigos: 1, pageSize: 1000, max: 20000 });
    expect(res.truncado).toBe(false);
    expect(res.rows).toHaveLength(2);
    expect(calls.some(c => c.lote.includes('x'))).toBe(true);
    expect(calls.some(c => c.lote.includes('y'))).toBe(true);
  });
  it('para no teto MAX e marca truncado (sai dos dois loops)', async () => {
    const fake = async (_lote: string[], offset: number): Promise<EntidadeRowRaw[]> =>
      offset === 0 ? [r(A,'A',1,1), r(B,'B',1,1), r(C,'C',1,1)] : [];
    const res = await coletarTitulosEntidade({ codigos: ['x','y','z'], fetchPagina: fake, chunkCodigos: 1, pageSize: 1000, max: 2 });
    expect(res.truncado).toBe(true);
    expect(res.rows).toHaveLength(2); // parou em MAX=2
  });
  it('códigos vazio → vazio sem chamar fetch', async () => {
    let chamou = false;
    const res = await coletarTitulosEntidade({ codigos: [], fetchPagina: async () => { chamou = true; return []; }, chunkCodigos: 1, pageSize: 1000, max: 20000 });
    expect(res.rows).toHaveLength(0); expect(chamou).toBe(false);
  });
});
```
(adicione `parseMesDataEmissao` ao import.)

- [ ] **Step 2:** ver falhar. **Step 3:** implementar (`concentrarPorEntidade` conforme spec; `coletarTitulosEntidade({codigos, fetchPagina, chunkCodigos, pageSize, max})` — for de chunks × for de páginas, acumula, `break` global ao `max` via flag `truncado`; `parseMesDataEmissao` regex `^\d{4}-(\d{2})-\d{2}` → Number ou null). **Step 4:** ver passar.
- [ ] **Step 5: commit** — `feat(orcamento): helpers concentração por entidade + orquestrador de coleta (TDD)`.

---

### Task 2: Service + toggle no painel

**Files:** Modify `src/services/financeiroV2Service.ts` + `src/components/financeiro/DrillVarianciaPanel.tsx` + `src/pages/FinanceiroOrcamento.tsx`

- [ ] **Step 1: `getTitulosEntidadeRaw`** no service — wira o supabase no orquestrador testável `coletarTitulosEntidade` (Codex P1.2/P1.3/P1.4: chunk+página+teto já testados no helper). Recebe `meses` e **limita server-side ao horizonte fechado** (P1.2: senão o ano-1 busca 12 meses, trunca no MAX e perde Jan–Abr):

```ts
import { coletarTitulosEntidade, type EntidadeRowRaw, parseMesDataEmissao } from '@/lib/financeiro/orcamento-entidade-helpers';

const MAX_TITULOS = 20000, CHUNK_CODIGOS = 100, PAGE = 1000;

export async function getTitulosEntidadeRaw(
  fonte: 'cp' | 'cr', company: Company, ano: number, meses: number[], codigos: string[],
): Promise<{ rows: EntidadeRowRaw[]; truncado: boolean }> {
  if (codigos.length === 0 || meses.length === 0) return { rows: [], truncado: false };
  const tabela = fonte === 'cp' ? 'fin_contas_pagar' : 'fin_contas_receber';
  const nomeCol = fonte === 'cp' ? 'nome_fornecedor' : 'nome_cliente';
  const maxMes = Math.max(...meses);
  const fimExcl = maxMes >= 12 ? `${ano + 1}-01-01` : `${ano}-${String(maxMes + 1).padStart(2, '0')}-01`; // horizonte fechado
  return coletarTitulosEntidade({
    codigos, chunkCodigos: CHUNK_CODIGOS, pageSize: PAGE, max: MAX_TITULOS,
    fetchPagina: async (lote, offset, limit) => {
      const { data, error } = await supabase
        .from(tabela)
        .select(`cnpj_cpf, ${nomeCol}, data_emissao, valor_documento`)
        .eq('company', company)
        .not('data_emissao', 'is', null)
        .gte('data_emissao', `${ano}-01-01`)
        .lt('data_emissao', fimExcl)
        .neq('status_titulo', 'CANCELADO')
        .in('categoria_codigo', lote)
        .order('id', { ascending: true })          // P1.3: paginação estável
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return (data ?? []).map((row: Record<string, unknown>) => ({
        entidade_id: (row.cnpj_cpf as string | null) ?? null,
        entidade_nome: (row[nomeCol] as string | null) ?? null,
        mes: parseMesDataEmissao(row.data_emissao as string | null),
        valor: (row.valor_documento as number | null) ?? 0,
      }));
    },
  });
}
```

- [ ] **Step 2:** no painel `DrillVarianciaPanel`, **toggle** `lente: 'categoria' | 'entidade'` (a aba entidade só aparece se `entidadeDaLinha(dre_linha) != null`). Props novas: `entidadeData` (`EntidadeConcentracaoResult | null`), `entidadeLoading/Error`, `entidadeRotulo` ('fornecedor'|'cliente'), `totalCategoriaV1` (= `result.total_decomposto`), `realizadoSnapshot` (contexto).
- [ ] **Step 3:** na página, quando a aba entidade está ativa: `info = entidadeDaLinha(linha)`; `codigos = codigosDaLinha(mapping, linha, regime)` (do drillBaseQuery.data.mapping — MESMO helper do v1 → reconcilia); `useQuery(['orcamento-drill-entidade', company, ano, mesesFechadosArr.join(','), linha, codigos.join(',')])` enabled quando aba ativa → `Promise.all([getTitulosEntidadeRaw(info.fonte, company, ano, mesesFechadosArr, codigos), getTitulosEntidadeRaw(info.fonte, company, ano-1, mesesFechadosArr, codigos)])` → `concentrarPorEntidade({ rowsAno, rowsAnoAnterior, mesesFechados: mesesFechadosArr, topN: 3, truncado: truncadoAno || truncadoAnoAnterior })` (P2.5 truncado combinado). Render: 2 cards + tabela + reconciliação (Σ entidades vs `total_decomposto` v1 vs diff + contexto snapshot); modo diagnóstico se `truncado`; copy honesto.
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
