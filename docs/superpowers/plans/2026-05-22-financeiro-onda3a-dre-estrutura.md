# Onda 3a — DRE v2 Estrutural (regime-aware + caixa real + confiança) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir a estrutura da DRE do `omie-financeiro` para ser regime-aware (deduções indiretas vs IRPJ/CSLL; DAS único no Simples), bucketizar o regime caixa pela data real de recebimento/pagamento com fallback rotulado, classificar imposto via mapping explícito (não mais prefixo/keyword), e gravar um gate de confiança — tudo entregável e mergeável sem o motor de imposto teórico (que é a Onda 3b).

**Architecture:** Helper puro testável `src/lib/financeiro/dre-helpers.ts` (vitest) com a lógica de classificação, data caixa, montagem da DRE e confiança; espelhado verbatim no `calcularDRE` da edge function Deno `omie-financeiro`. Sub-linhas de imposto e confiança vão no `detalhamento` (jsonb) do snapshot — sem migration. UI lê os novos campos.

**Tech Stack:** TypeScript, vitest (`bun run test`), Deno edge function (deploy via chat do Lovable), React + TanStack Query.

---

## Contexto do código atual (leia antes de começar)

`supabase/functions/omie-financeiro/index.ts` linhas 862–1071: `calcularDRE(db, company, ano, mes, regime)`.
- Hoje bucketiza caixa por `data_vencimento` (`.gte/.lt` server-side); seleciona `valor_documento, valor_recebido/valor_pago, categoria_codigo, categoria_descricao`.
- `resolveCategoria(cod, desc, isReceita)`: match exato → prefixo → heurística keyword. Imposto cai no balde único `impostos` (linha 946). Sem noção de regime tributário.
- Snapshot tem `deducoes`, `impostos`, `qtd_categorias_sem_mapeamento`, `detalhamento {receitas, despesas, categorias_nao_mapeadas}`. Upsert on `company,ano,mes,regime`.

A tabela `fin_categoria_dre_mapping (omie_codigo, dre_linha, company)` guarda o mapeamento; `dre_linha` hoje usa baldes genéricos. Esta onda adiciona valores de `dre_linha` específicos de imposto.

O regime TRIBUTÁRIO (simples/presumido) **não existe no banco** — só no `CompanyContext` do frontend. Esta onda usa um mapa constante `REGIME_POR_EMPRESA` (Colacor/Oben presumido, Colacor SC simples) no helper. A config editável (`dre_tributario`) é da Onda 3b.

---

## File Structure

- **Create** `src/lib/financeiro/dre-helpers.ts` — funções puras: tipos `DreLinha`/`RegimeTributario`, `REGIME_POR_EMPRESA`, `classificarLinhaDRE`, `resolverDataCaixa`, `bucketizarCaixa`, `montarDRE`, `scoreConfianca`.
- **Create** `src/lib/financeiro/__tests__/dre-helpers.test.ts` — vitest.
- **Modify** `supabase/functions/omie-financeiro/index.ts` — reescreve `calcularDRE` usando os helpers (espelhados verbatim) + queries do caixa-real.
- **Modify** `src/hooks/useFinanceiro.ts` — tipos da DRE (sub-linhas + confiança + caixa_estimado).
- **Modify** `src/components/financeiro/FinanceiroCockpit.tsx` — sub-linhas regime-aware + banner de confiança + rótulo "caixa estimado".
- **Modify** `docs/FINANCEIRO_CONFIABILIDADE.md` — seção Onda 3a.

---

## Task 1: `classificarLinhaDRE` + taxonomia (TDD)

**Files:**
- Create: `src/lib/financeiro/dre-helpers.ts`
- Test: `src/lib/financeiro/__tests__/dre-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { classificarLinhaDRE, REGIME_POR_EMPRESA } from '../dre-helpers';

const M = (pairs: Array<[string, string]>) => new Map<string, string>(pairs);

describe('REGIME_POR_EMPRESA', () => {
  it('mapeia as 3 empresas', () => {
    expect(REGIME_POR_EMPRESA.colacor).toBe('presumido');
    expect(REGIME_POR_EMPRESA.oben).toBe('presumido');
    expect(REGIME_POR_EMPRESA.colacor_sc).toBe('simples');
  });
});

describe('classificarLinhaDRE — mapping explícito', () => {
  it('usa dre_linha de imposto do mapping (presumido: ICMS → ded_icms)', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.05', categoria_descricao: 'ICMS sobre vendas',
      isReceita: false, regime: 'presumido', mapping: M([['3.05', 'ded_icms']]),
    });
    expect(r.linha).toBe('ded_icms');
    expect(r.mapeado).toBe(true);
    expect(r.viaFallback).toBe(false);
  });

  it('prefix match', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '3.01.02.003', categoria_descricao: 'x',
      isReceita: false, regime: 'presumido', mapping: M([['3.01', 'cmv']]),
    });
    expect(r.linha).toBe('cmv');
    expect(r.mapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — fallback regime-aware de imposto', () => {
  it('presumido: keyword IRPJ não mapeado → irpj + viaFallback', () => {
    const r = classificarLinhaDRE({
      categoria_codigo: '9.99', categoria_descricao: 'IRPJ trimestral',
      isReceita: false, regime: 'presumido', mapping: M([]),
    });
    expect(r.linha).toBe('irpj');
    expect(r.mapeado).toBe(false);
    expect(r.viaFallback).toBe(true);
    expect(r.impostoNaoMapeado).toBe(true);
  });

  it('presumido: PIS → ded_pis; COFINS → ded_cofins; ISS → ded_iss; IPI → ded_ipi', () => {
    const reg = 'presumido' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'PIS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_pis');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'COFINS', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_cofins');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ISS retido', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_iss');
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'IPI', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('ded_ipi');
  });

  it('SIMPLES: qualquer imposto por keyword → das (linha única, nunca quebra)', () => {
    const reg = 'simples' as const;
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'DAS Simples Nacional', isReceita: false, regime: reg, mapping: M([]) }).linha).toBe('das');
    // mesmo um IRPJ/ICMS avulso no Simples vira das (com flag de imposto não mapeado)
    const r = classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'ICMS', isReceita: false, regime: reg, mapping: M([]) });
    expect(r.linha).toBe('das');
    expect(r.impostoNaoMapeado).toBe(true);
  });
});

describe('classificarLinhaDRE — não-imposto', () => {
  it('CMV por keyword', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Custo mercadoria vendida', isReceita: false, regime: 'presumido', mapping: M([]) }).linha).toBe('cmv');
  });
  it('receita: devolução → deducoes', () => {
    expect(classificarLinhaDRE({ categoria_codigo: '', categoria_descricao: 'Devolução de venda', isReceita: true, regime: 'presumido', mapping: M([]) }).linha).toBe('deducoes');
  });
  it('receita não mapeada → receita_bruta (fallback)', () => {
    const r = classificarLinhaDRE({ categoria_codigo: '1.99', categoria_descricao: 'Venda balcão', isReceita: true, regime: 'presumido', mapping: M([]) });
    expect(r.linha).toBe('receita_bruta');
    expect(r.viaFallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: FAIL — `classificarLinhaDRE`/`REGIME_POR_EMPRESA` não existem.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/financeiro/dre-helpers.ts
// Onda 3a — DRE v2 estrutural (regime-aware). Módulo puro, espelhado verbatim no
// engine Deno supabase/functions/omie-financeiro/index.ts (calcularDRE).

export type RegimeTributario = 'simples' | 'presumido';
export type RegimeApuracao = 'caixa' | 'competencia';

export const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = {
  colacor: 'presumido',
  oben: 'presumido',
  colacor_sc: 'simples',
};

// Linhas de imposto regime-aware + linhas estruturais. Deduções (sobre receita) ficam
// acima da receita líquida; das é linha própria (Simples); irpj/csll abaixo (presumido).
export type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'receitas_financeiras' | 'outras_receitas'
  | 'cmv' | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'outras_despesas'
  | 'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi'
  | 'das' | 'irpj' | 'csll';

const DRE_LINHAS_VALIDAS = new Set<string>([
  'receita_bruta', 'deducoes', 'receitas_financeiras', 'outras_receitas',
  'cmv', 'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
  'despesas_financeiras', 'outras_despesas',
  'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
  // baldes legados aceitos do mapping antigo:
  'impostos',
]);

export type ResultadoClassificacao = {
  linha: DreLinha;
  mapeado: boolean;        // veio do mapping explícito (exato ou prefixo)
  viaFallback: boolean;    // caiu na heurística de keyword
  impostoNaoMapeado: boolean; // imposto detectado só por keyword (sinal de confiança)
};

// Detecta o tipo de imposto pela keyword e devolve a linha regime-aware.
function impostoPorKeyword(upper: string, regime: RegimeTributario): DreLinha | null {
  const tem = (s: string) => upper.includes(s);
  // Simples: tudo é DAS (recolhimento unificado, LC 123) — nunca quebra.
  if (regime === 'simples') {
    if (tem('DAS') || tem('SIMPLES') || tem('IRPJ') || tem('CSLL') || tem('PIS') ||
        tem('COFINS') || tem('ISS') || tem('ICMS') || tem('IPI') || tem('IMPOST') || tem('TRIBUT')) {
      return 'das';
    }
    return null;
  }
  // Presumido: imposto específico.
  if (tem('IRPJ')) return 'irpj';
  if (tem('CSLL')) return 'csll';
  if (tem('COFINS')) return 'ded_cofins';
  if (tem('PIS')) return 'ded_pis';
  if (tem('ISS')) return 'ded_iss';
  if (tem('ICMS')) return 'ded_icms';
  if (tem('IPI')) return 'ded_ipi';
  if (tem('DAS') || tem('SIMPLES') || tem('IMPOST') || tem('TRIBUT')) return 'ded_icms'; // genérico → trata como dedução
  return null;
}

// Mapeia o balde legado 'impostos' para a linha regime-aware.
function normalizarImpostoLegado(linha: string, regime: RegimeTributario): DreLinha {
  if (linha !== 'impostos') return linha as DreLinha;
  return regime === 'simples' ? 'das' : 'ded_icms';
}

export function classificarLinhaDRE(input: {
  categoria_codigo: string;
  categoria_descricao: string;
  isReceita: boolean;
  regime: RegimeTributario;
  mapping: Map<string, string>;
}): ResultadoClassificacao {
  const { categoria_codigo: cod, categoria_descricao: desc, isReceita, regime, mapping } = input;

  // 1. Match exato
  if (cod && mapping.has(cod)) {
    const raw = mapping.get(cod)!;
    const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
    return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
  }
  // 2. Prefix match
  if (cod) {
    const parts = cod.split('.');
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (mapping.has(prefix)) {
        const raw = mapping.get(prefix)!;
        const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
        return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
      }
    }
  }
  // 3. Heurística por descrição (fallback)
  const upper = (desc + ' ' + cod).toUpperCase();
  if (isReceita) {
    if (upper.includes('DEVOL') || upper.includes('CANCEL')) return { linha: 'deducoes', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    if (upper.includes('FINANC') || upper.includes('REND') || upper.includes('JUROS REC')) return { linha: 'receitas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    return { linha: 'receita_bruta', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  }
  // despesa: imposto primeiro (regime-aware)
  const imp = impostoPorKeyword(upper, regime);
  if (imp) return { linha: imp, mapeado: false, viaFallback: true, impostoNaoMapeado: true };
  if (upper.includes('CMV') || upper.includes('CUSTO MERC') || upper.includes('CUSTO PROD') || upper.includes('MATÉRIA') || upper.includes('MATERIA')) return { linha: 'cmv', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('JUROS') || upper.includes('IOF') || upper.includes('TARIFA BANC') || upper.includes('DESC CONCED')) return { linha: 'despesas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('COMISS') || upper.includes('FRETE VEND') || upper.includes('MARKET') || upper.includes('PUBLICID') || upper.includes('PROPAGANDA') || upper.includes('VIAGEM') || upper.includes('REPRESENT')) return { linha: 'despesas_comerciais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('ALUGUE') || upper.includes('CONDOM') || upper.includes('SALÁR') || upper.includes('FOLHA') || upper.includes('ENCARGO') || upper.includes('FGTS') || upper.includes('INSS PATR') || upper.includes('CONTAB') || upper.includes('CONSULTORI') || upper.includes('SOFTWARE') || upper.includes('TELEFO') || upper.includes('INTERNET') || upper.includes('ENERGIA') || upper.includes('ÁGUA')) return { linha: 'despesas_administrativas', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  return { linha: 'despesas_operacionais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3a): classificarLinhaDRE regime-aware (TDD)"
```

---

## Task 2: `resolverDataCaixa` + `bucketizarCaixa` (TDD)

**Files:**
- Modify: `src/lib/financeiro/dre-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/dre-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { resolverDataCaixa, bucketizarCaixa } from '../dre-helpers';

describe('resolverDataCaixa', () => {
  it('usa data real quando presente', () => {
    expect(resolverDataCaixa({ data_real: '2026-03-10', data_vencimento: '2026-03-05' }))
      .toEqual({ data_efetiva: '2026-03-10', usou_fallback: false });
  });
  it('cai pro vencimento quando data real falta', () => {
    expect(resolverDataCaixa({ data_real: null, data_vencimento: '2026-03-05' }))
      .toEqual({ data_efetiva: '2026-03-05', usou_fallback: true });
  });
  it('sem nenhuma data → null', () => {
    expect(resolverDataCaixa({ data_real: null, data_vencimento: null }))
      .toEqual({ data_efetiva: null, usou_fallback: false });
  });
});

describe('bucketizarCaixa', () => {
  const titulos = [
    { valor: 100000, data_real: '2026-03-10', data_vencimento: '2026-03-01' }, // real, no mês
    { valor: 50000, data_real: null, data_vencimento: '2026-03-20' },          // fallback, no mês
    { valor: 999, data_real: '2026-02-10', data_vencimento: '2026-03-02' },    // real fora do mês
  ];
  it('soma só o que cai no mês pela data efetiva, e mede fallback_pct por valor', () => {
    const r = bucketizarCaixa(titulos, '2026-03-01', '2026-04-01');
    expect(r.total).toBe(150000);          // 100k real + 50k fallback
    expect(r.total_fallback).toBe(50000);
    expect(r.fallback_pct).toBeCloseTo(50000 / 150000, 5);
    expect(r.itens.length).toBe(2);
  });
  it('total 0 → fallback_pct 0', () => {
    expect(bucketizarCaixa([], '2026-03-01', '2026-04-01').fallback_pct).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: FAIL — funções não existem.

- [ ] **Step 3: Write minimal implementation** (append to `dre-helpers.ts`)

```ts
export function resolverDataCaixa(input: {
  data_real: string | null;
  data_vencimento: string | null;
}): { data_efetiva: string | null; usou_fallback: boolean } {
  if (input.data_real) return { data_efetiva: input.data_real, usou_fallback: false };
  if (input.data_vencimento) return { data_efetiva: input.data_vencimento, usou_fallback: true };
  return { data_efetiva: null, usou_fallback: false };
}

export type TituloCaixa = { valor: number; data_real: string | null; data_vencimento: string | null };

// Bucketiza por data EFETIVA dentro de [inicio, fim) (fim exclusivo, ISO yyyy-mm-dd).
// Mede o % de valor que usou fallback (vencimento) — alimenta a confiança.
export function bucketizarCaixa(
  titulos: TituloCaixa[],
  inicio: string,
  fim: string,
): { total: number; total_fallback: number; fallback_pct: number; itens: Array<{ valor: number; data_efetiva: string; usou_fallback: boolean }> } {
  let total = 0;
  let total_fallback = 0;
  const itens: Array<{ valor: number; data_efetiva: string; usou_fallback: boolean }> = [];
  for (const t of titulos) {
    const { data_efetiva, usou_fallback } = resolverDataCaixa(t);
    if (!data_efetiva) continue;
    if (data_efetiva < inicio || data_efetiva >= fim) continue;
    total += t.valor;
    if (usou_fallback) total_fallback += t.valor;
    itens.push({ valor: t.valor, data_efetiva, usou_fallback });
  }
  const fallback_pct = total > 0 ? total_fallback / total : 0;
  return { total, total_fallback, fallback_pct, itens };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3a): resolverDataCaixa + bucketizarCaixa (TDD)"
```

---

## Task 3: `montarDRE` — ladder regime-aware (TDD)

**Files:**
- Modify: `src/lib/financeiro/dre-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/dre-helpers.test.ts`

> `montarDRE` recebe os totais já classificados por `DreLinha` + o regime e devolve os campos do snapshot. Regra: deduções (devoluções + indiretos + DAS no Simples) reduzem a receita líquida; IRPJ/CSLL (presumido) ficam abaixo. No Simples, imposto sobre lucro = 0 (já está no DAS).

- [ ] **Step 1: Write the failing test**

```ts
import { montarDRE } from '../dre-helpers';

// helper: totais por linha
const tot = (o: Partial<Record<string, number>>) => o as Record<string, number>;

describe('montarDRE — presumido', () => {
  it('indiretos nas deduções, IRPJ/CSLL abaixo', () => {
    const r = montarDRE({
      regime: 'presumido',
      totais: tot({
        receita_bruta: 100000, deducoes: 2000,
        ded_icms: 12000, ded_pis: 650, ded_cofins: 3000,
        cmv: 40000, despesas_administrativas: 10000,
        irpj: 5000, csll: 3000,
      }),
    });
    // deduções = devoluções(2000) + indiretos(12000+650+3000=15650) = 17650
    expect(r.deducoes).toBe(17650);
    expect(r.receita_liquida).toBe(100000 - 17650);
    expect(r.lucro_bruto).toBe(100000 - 17650 - 40000);
    // impostos sobre lucro
    expect(r.impostos).toBe(8000);
    expect(r.resultado_liquido).toBe(r.resultado_antes_impostos - 8000);
    expect(r.detalhamento_impostos).toEqual({ ded_icms: 12000, ded_pis: 650, ded_cofins: 3000, irpj: 5000, csll: 3000 });
  });
});

describe('montarDRE — Simples', () => {
  it('DAS entra nas deduções (linha única), imposto sobre lucro = 0', () => {
    const r = montarDRE({
      regime: 'simples',
      totais: tot({ receita_bruta: 100000, deducoes: 1000, das: 6000, cmv: 30000, despesas_administrativas: 8000 }),
    });
    expect(r.deducoes).toBe(7000);           // devoluções(1000) + DAS(6000)
    expect(r.receita_liquida).toBe(93000);
    expect(r.impostos).toBe(0);              // não duplica
    expect(r.resultado_liquido).toBe(r.resultado_antes_impostos);
    expect(r.detalhamento_impostos).toEqual({ das: 6000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: FAIL — `montarDRE` não existe.

- [ ] **Step 3: Write minimal implementation** (append to `dre-helpers.ts`)

```ts
export type DRECalculada = {
  receita_bruta: number; deducoes: number; receita_liquida: number;
  cmv: number; lucro_bruto: number;
  despesas_operacionais: number; despesas_administrativas: number; despesas_comerciais: number;
  despesas_financeiras: number; receitas_financeiras: number;
  resultado_operacional: number; outras_receitas: number; outras_despesas: number;
  resultado_antes_impostos: number; impostos: number; resultado_liquido: number;
  detalhamento_impostos: Record<string, number>;
};

export function montarDRE(input: { regime: RegimeTributario; totais: Record<string, number> }): DRECalculada {
  const t = (k: string) => input.totais[k] ?? 0;
  const indiretos = t('ded_icms') + t('ded_iss') + t('ded_pis') + t('ded_cofins') + t('ded_ipi');
  const das = t('das');
  const impostoLucro = input.regime === 'simples' ? 0 : (t('irpj') + t('csll'));

  // Deduções = devoluções/descontos (balde 'deducoes') + indiretos (presumido) + DAS (Simples).
  const deducoes = t('deducoes') + indiretos + das;
  const receita_bruta = t('receita_bruta');
  const receita_liquida = receita_bruta - deducoes;
  const cmv = t('cmv');
  const lucro_bruto = receita_liquida - cmv;
  const despesas_operacionais = t('despesas_operacionais');
  const despesas_administrativas = t('despesas_administrativas');
  const despesas_comerciais = t('despesas_comerciais');
  const despesas_financeiras = t('despesas_financeiras');
  const receitas_financeiras = t('receitas_financeiras');
  const resultado_operacional = lucro_bruto - (despesas_operacionais + despesas_administrativas + despesas_comerciais) + receitas_financeiras - despesas_financeiras;
  const outras_receitas = t('outras_receitas');
  const outras_despesas = t('outras_despesas');
  const resultado_antes_impostos = resultado_operacional + outras_receitas - outras_despesas;
  const resultado_liquido = resultado_antes_impostos - impostoLucro;

  const detalhamento_impostos: Record<string, number> = {};
  for (const k of ['ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll']) {
    if (t(k) !== 0) detalhamento_impostos[k] = t(k);
  }

  return {
    receita_bruta, deducoes, receita_liquida, cmv, lucro_bruto,
    despesas_operacionais, despesas_administrativas, despesas_comerciais,
    despesas_financeiras, receitas_financeiras, resultado_operacional,
    outras_receitas, outras_despesas, resultado_antes_impostos,
    impostos: impostoLucro, resultado_liquido, detalhamento_impostos,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3a): montarDRE ladder regime-aware (TDD)"
```

---

## Task 4: `scoreConfianca` (TDD)

**Files:**
- Modify: `src/lib/financeiro/dre-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/dre-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { scoreConfianca } from '../dre-helpers';

describe('scoreConfianca', () => {
  it('tudo bom → alta', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.02, share_generico: 0.01, tem_imposto_nao_mapeado: false });
    expect(r.nivel).toBe('alta');
    expect(r.motivos).toEqual([]);
  });
  it('fallback alto rebaixa pra media (>10%) e baixa (>20%)', () => {
    expect(scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.15, share_generico: 0, tem_imposto_nao_mapeado: false }).nivel).toBe('media');
    expect(scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0.25, share_generico: 0, tem_imposto_nao_mapeado: false }).nivel).toBe('baixa');
  });
  it('pouco mapeado por valor rebaixa', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.7, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: false });
    expect(r.nivel).toBe('baixa');
    expect(r.motivos.some(m => m.includes('mapead'))).toBe(true);
  });
  it('imposto não mapeado vira motivo (rebaixa pra no máximo media)', () => {
    const r = scoreConfianca({ pct_mapeado_valor: 0.98, fallback_pct: 0, share_generico: 0, tem_imposto_nao_mapeado: true });
    expect(r.nivel).toBe('media');
    expect(r.motivos.some(m => m.toLowerCase().includes('imposto'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: FAIL — `scoreConfianca` não existe.

- [ ] **Step 3: Write minimal implementation** (append to `dre-helpers.ts`)

```ts
export type Confianca = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; pct_mapeado_valor: number; fallback_pct: number };

export function scoreConfianca(input: {
  pct_mapeado_valor: number;   // [0,1] receita+despesa mapeada por valor
  fallback_pct: number;        // [0,1] valor do caixa que usou fallback de vencimento
  share_generico: number;      // [0,1] categorias genéricas (outros/diversos/ajuste) por valor
  tem_imposto_nao_mapeado: boolean;
}): Confianca {
  const motivos: string[] = [];
  // 'alta' = 3, 'media' = 2, 'baixa' = 1 — pega o pior sinal.
  let nivel = 3;
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };

  if (input.pct_mapeado_valor < 0.8) rebaixar(1, `Só ${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor está mapeado por categoria.`);
  else if (input.pct_mapeado_valor < 0.9) rebaixar(2, `${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor mapeado (ideal ≥90%).`);

  if (input.fallback_pct > 0.2) rebaixar(1, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou data de vencimento (fallback) — direcional.`);
  else if (input.fallback_pct > 0.1) rebaixar(2, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou fallback de vencimento.`);

  if (input.share_generico > 0.15) rebaixar(2, `${(input.share_generico * 100).toFixed(0)}% em categorias genéricas (outros/diversos/ajuste).`);

  if (input.tem_imposto_nao_mapeado) rebaixar(2, 'Categoria de imposto classificada por heurística (não mapeada).');

  return {
    nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa',
    motivos,
    pct_mapeado_valor: input.pct_mapeado_valor,
    fallback_pct: input.fallback_pct,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/financeiro/__tests__/dre-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts
git commit -m "feat(financeiro onda3a): scoreConfianca (TDD)"
```

---

## Task 5: Espelhar no engine `omie-financeiro` (`calcularDRE`)

**Files:**
- Modify: `supabase/functions/omie-financeiro/index.ts`

> Não há vitest no Deno. Replique os tipos/funções de `dre-helpers.ts` VERBATIM no engine (logo antes de `calcularDRE`, perto da linha 862). Depois reescreva `calcularDRE` para usar `classificarLinhaDRE` + `bucketizarCaixa` + `montarDRE` + `scoreConfianca`.

- [ ] **Step 1: Colar o bloco de helpers no engine**

Inserir, imediatamente antes de `type Regime = "caixa" | "competencia";` (linha 863), o conteúdo COMPLETO de `src/lib/financeiro/dre-helpers.ts` a partir de `export type RegimeTributario` (remover a palavra `export` é opcional no Deno; pode manter). Não duplicar `type Regime`.

- [ ] **Step 2: Reescrever `calcularDRE` (linhas 865–1071)**

Substituir o corpo por (mantendo a assinatura):

```ts
async function calcularDRE(
  db: SupabaseClient,
  company: Company,
  ano: number,
  mes: number,
  regime: Regime = "caixa"
) {
  const inicioMes = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const fimMes = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
  const regimeTrib: RegimeTributario = REGIME_POR_EMPRESA[company] ?? 'presumido';

  // ── Buscar títulos ──
  // Competência: bucketiza por data_emissao (server-side). Caixa: precisamos da data
  // EFETIVA (recebimento/pagamento) com fallback p/ vencimento → buscamos um superset
  // (recebimento OU vencimento na janela) e bucketizamos client-side via bucketizarCaixa.
  async function buscarCR() {
    if (regime === 'competencia') {
      const { data } = await db.from('fin_contas_receber')
        .select('valor_documento, valor_recebido, data_recebimento, data_vencimento, categoria_codigo, categoria_descricao')
        .eq('company', company).neq('status_titulo', 'CANCELADO')
        .gte('data_emissao', inicioMes).lt('data_emissao', fimMes);
      return data ?? [];
    }
    const { data } = await db.from('fin_contas_receber')
      .select('valor_documento, valor_recebido, data_recebimento, data_vencimento, categoria_codigo, categoria_descricao')
      .eq('company', company).in('status_titulo', ['RECEBIDO', 'PARCIAL', 'LIQUIDADO'])
      .or(`and(data_recebimento.gte.${inicioMes},data_recebimento.lt.${fimMes}),and(data_recebimento.is.null,data_vencimento.gte.${inicioMes},data_vencimento.lt.${fimMes})`);
    return data ?? [];
  }
  async function buscarCP() {
    if (regime === 'competencia') {
      const { data } = await db.from('fin_contas_pagar')
        .select('valor_documento, valor_pago, data_pagamento, data_vencimento, categoria_codigo, categoria_descricao')
        .eq('company', company).neq('status_titulo', 'CANCELADO')
        .gte('data_emissao', inicioMes).lt('data_emissao', fimMes);
      return data ?? [];
    }
    const { data } = await db.from('fin_contas_pagar')
      .select('valor_documento, valor_pago, data_pagamento, data_vencimento, categoria_codigo, categoria_descricao')
      .eq('company', company).in('status_titulo', ['PAGO', 'PARCIAL', 'LIQUIDADO'])
      .or(`and(data_pagamento.gte.${inicioMes},data_pagamento.lt.${fimMes}),and(data_pagamento.is.null,data_vencimento.gte.${inicioMes},data_vencimento.lt.${fimMes})`);
    return data ?? [];
  }
  const receitas = await buscarCR();
  const despesas = await buscarCP();

  // ── Mapping ──
  const { data: mappings } = await db.from('fin_categoria_dre_mapping')
    .select('omie_codigo, dre_linha, company').in('company', [company, '_default']);
  const mapping = new Map<string, string>();
  const sorted = ((mappings ?? []) as Array<{ omie_codigo: string; dre_linha: string; company: string }>)
    .slice().sort((a, b) => (a.company === '_default' ? -1 : 1));
  for (const m of sorted) mapping.set(m.omie_codigo, m.dre_linha);

  // ── Classificar + bucketizar (caixa por data efetiva) ──
  const totais: Record<string, number> = {};
  const detalheReceitas: Record<string, number> = {};
  const detalheDespesas: Record<string, number> = {};
  const naoMapeadas: string[] = [];
  let valorTotal = 0, valorMapeado = 0, valorGenerico = 0;
  let temImpostoNaoMapeado = false;
  let fallbackValor = 0, caixaValor = 0;

  const GENERICOS = ['OUTROS', 'DIVERSOS', 'AJUSTE', 'TRANSFER'];

  function processar(rows: Array<Record<string, unknown>>, isReceita: boolean) {
    for (const row of rows) {
      const cod = (row.categoria_codigo as string) || '';
      const desc = (row.categoria_descricao as string) || cod || 'Sem categoria';
      // valor + data efetiva
      let val: number;
      let usouFallback = false;
      if (regime === 'competencia') {
        val = Number(row.valor_documento ?? 0);
      } else {
        const dataReal = isReceita ? (row.data_recebimento as string | null) : (row.data_pagamento as string | null);
        const venc = row.data_vencimento as string | null;
        const { data_efetiva, usou_fallback } = resolverDataCaixa({ data_real: dataReal, data_vencimento: venc });
        if (!data_efetiva || data_efetiva < inicioMes || data_efetiva >= fimMes) continue; // fora do mês pela data efetiva
        usouFallback = usou_fallback;
        val = isReceita ? Number(row.valor_recebido ?? row.valor_documento ?? 0) : Number(row.valor_pago ?? row.valor_documento ?? 0);
        caixaValor += val;
        if (usouFallback) fallbackValor += val;
      }
      (isReceita ? detalheReceitas : detalheDespesas)[desc] = ((isReceita ? detalheReceitas : detalheDespesas)[desc] || 0) + val;

      const c = classificarLinhaDRE({ categoria_codigo: cod, categoria_descricao: desc, isReceita, regime: regimeTrib, mapping });
      totais[c.linha] = (totais[c.linha] ?? 0) + val;
      valorTotal += val;
      if (c.mapeado) valorMapeado += val;
      if (c.impostoNaoMapeado) temImpostoNaoMapeado = true;
      if (!c.mapeado && cod) naoMapeadas.push(cod);
      const up = (desc + ' ' + cod).toUpperCase();
      if (GENERICOS.some((g) => up.includes(g))) valorGenerico += val;
    }
  }
  processar(receitas as Array<Record<string, unknown>>, true);
  processar(despesas as Array<Record<string, unknown>>, false);

  // ── Montar DRE (ladder regime-aware) ──
  const dre = montarDRE({ regime: regimeTrib, totais });

  // ── Confiança ──
  const fallback_pct = caixaValor > 0 ? fallbackValor / caixaValor : 0;
  const confianca = scoreConfianca({
    pct_mapeado_valor: valorTotal > 0 ? valorMapeado / valorTotal : 1,
    fallback_pct,
    share_generico: valorTotal > 0 ? valorGenerico / valorTotal : 0,
    tem_imposto_nao_mapeado: temImpostoNaoMapeado,
  });
  const unique = [...new Set(naoMapeadas)];
  const caixa_estimado = regime === 'caixa' && fallback_pct > 0.1;

  const snapshot = {
    company, ano, mes, regime,
    receita_bruta: dre.receita_bruta,
    deducoes: dre.deducoes,
    receita_liquida: dre.receita_liquida,
    cmv: dre.cmv,
    lucro_bruto: dre.lucro_bruto,
    despesas_operacionais: dre.despesas_operacionais,
    despesas_administrativas: dre.despesas_administrativas,
    despesas_comerciais: dre.despesas_comerciais,
    despesas_financeiras: dre.despesas_financeiras,
    receitas_financeiras: dre.receitas_financeiras,
    resultado_operacional: dre.resultado_operacional,
    outras_receitas: dre.outras_receitas,
    outras_despesas: dre.outras_despesas,
    resultado_antes_impostos: dre.resultado_antes_impostos,
    impostos: dre.impostos,
    resultado_liquido: dre.resultado_liquido,
    qtd_categorias_sem_mapeamento: unique.length,
    detalhamento: {
      receitas: detalheReceitas,
      despesas: detalheDespesas,
      categorias_nao_mapeadas: unique,
      impostos: dre.detalhamento_impostos,        // sub-linhas regime-aware
      regime_tributario: regimeTrib,
      caixa_estimado,                              // bool
      confianca,                                   // { nivel, motivos, pct_mapeado_valor, fallback_pct }
    },
    calculated_at: new Date().toISOString(),
  };

  const { error } = await db.from('fin_dre_snapshots')
    .upsert(snapshot, { onConflict: 'company,ano,mes,regime' });
  if (error) console.error(`[Fin][${company}] Erro DRE (${regime}):`, error.message);
  return snapshot;
}
```

- [ ] **Step 3: Conferir referências ao código antigo**

Garantir que o tipo `CategoriaDreMappingRow` e a função antiga `resolveCategoria` não são mais usados em `calcularDRE` (podem permanecer no arquivo se outros pontos usarem; senão, remover). Rodar busca: `grep -n "resolveCategoria" supabase/functions/omie-financeiro/index.ts` — se só aparecia em calcularDRE, deletar a função órfã.

- [ ] **Step 4: Entregar prompt de re-deploy pro chat do Lovable**

```
Edit the existing Supabase edge function `omie-financeiro`. Read the current file
from the repo at `supabase/functions/omie-financeiro/index.ts` (branch main após o
merge) and deploy it VERBATIM — do not reinterpret, refactor, rename or "improve"
anything. After deploy, confirm Active.
```

Confirmar Active no Lovable. (Não há como rodar o Deno localmente com o ambiente do Lovable; a validação de tipos é feita pelo `deno check` opcional + a suíte vitest do helper que é a fonte da verdade da lógica.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/omie-financeiro/index.ts
git commit -m "feat(financeiro onda3a): calcularDRE regime-aware + caixa real + confiança (espelho)"
```

---

## Task 6: Frontend — tipos + UI

**Files:**
- Modify: `src/hooks/useFinanceiro.ts`
- Modify: `src/components/financeiro/FinanceiroCockpit.tsx`

- [ ] **Step 1: Tipos do `detalhamento`**

Em `src/hooks/useFinanceiro.ts`, no tipo do snapshot de DRE (campo `detalhamento`), adicionar (sem quebrar o existente):

```ts
detalhamento?: {
  receitas?: Record<string, number>;
  despesas?: Record<string, number>;
  categorias_nao_mapeadas?: string[];
  impostos?: Partial<Record<'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi' | 'das' | 'irpj' | 'csll', number>>;
  regime_tributario?: 'simples' | 'presumido';
  caixa_estimado?: boolean;
  confianca?: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; pct_mapeado_valor: number; fallback_pct: number };
};
```

- [ ] **Step 2: UI — banner de confiança + rótulo caixa estimado**

Em `FinanceiroCockpit.tsx`, onde o snapshot de DRE é exibido, ler `dre.detalhamento?.confianca` e `dre.detalhamento?.caixa_estimado`. Adicionar, acima dos números:

```tsx
{dre.detalhamento?.caixa_estimado && (
  <span className="text-xs text-status-warning">caixa estimado</span>
)}
{dre.detalhamento?.confianca && dre.detalhamento.confianca.nivel !== 'alta' && (
  <div className="rounded-md border p-2 text-xs text-status-warning">
    Confiança <strong>{dre.detalhamento.confianca.nivel}</strong>:
    <ul className="list-disc ml-4">
      {dre.detalhamento.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}
    </ul>
  </div>
)}
```

- [ ] **Step 3: UI — sub-linhas de imposto regime-aware**

Onde a DRE lista as linhas, exibir as sub-linhas de imposto a partir de `dre.detalhamento?.impostos`, com rótulos:

```tsx
const IMPOSTO_LABEL: Record<string, string> = {
  ded_icms: 'ICMS', ded_iss: 'ISS', ded_pis: 'PIS', ded_cofins: 'COFINS', ded_ipi: 'IPI',
  das: 'DAS (Simples)', irpj: 'IRPJ', csll: 'CSLL',
};
// ...
{Object.entries(dre.detalhamento?.impostos ?? {}).map(([k, v]) => (
  <div key={k} className="flex justify-between text-sm">
    <span className="text-muted-foreground">{IMPOSTO_LABEL[k] ?? k}</span>
    <span className="tabular-nums">{formatBRL(v as number)}</span>
  </div>
))}
```
(Se a empresa for Simples, só aparece `DAS`; se presumido, indiretos + IRPJ/CSLL.)

- [ ] **Step 4: Build**

Run: `bun run build:dev`
Expected: sem erro de tipo.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useFinanceiro.ts src/components/financeiro/FinanceiroCockpit.tsx
git commit -m "feat(financeiro onda3a): UI DRE regime-aware + confiança + caixa estimado"
```

---

## Task 7: Docs + validação E2E

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Seção Onda 3a**

Adicionar (após a seção Onda 2) uma seção "Onda 3a — DRE v2 estrutural" explicando: estrutura regime-aware (deduções indiretas vs IRPJ/CSLL; DAS único no Simples nunca quebrado), caixa por data real + fallback rotulado "caixa estimado", mapping explícito no lugar do prefixo/keyword, gate de confiança. Regra de ouro: "imposto teórico (conferência) chega na Onda 3b; ainda direcional até fechamento contábil/CMV real/intercompany — deferidos".

- [ ] **Step 2: Suíte + lint + typecheck**

Run: `bun run test` → 100% verde.
Run: `bunx tsc --noEmit && bun run typecheck:strict` → sem erro novo (atenção: se `dre-helpers.ts` entrar no `tsconfig.strict.json`, garantir 0 `any`).
Run: `bunx eslint src/lib/financeiro/dre-helpers.ts src/lib/financeiro/__tests__/dre-helpers.test.ts src/hooks/useFinanceiro.ts src/components/financeiro/FinanceiroCockpit.tsx` → limpo.

- [ ] **Step 3: Validação funcional (pós-deploy, founder)**

Forçar recálculo da DRE (via sync do omie-financeiro ou chamada da função) e conferir, numa empresa presumido (Colacor/Oben) e na Simples (Colacor SC):
(a) presumido mostra indiretos nas deduções + IRPJ/CSLL abaixo; (b) Simples mostra só DAS (linha única, sem IRPJ/CSLL); (c) regime caixa traz rótulo "caixa estimado" quando há fallback; (d) banner de confiança aparece quando nível < alta.

- [ ] **Step 4: Commit**

```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro onda3a): seção DRE v2 estrutural em CONFIABILIDADE"
```

---

## Self-Review (feito)

**1. Cobertura do spec (seções A/C/E + mapping):** estrutura regime-aware (T1 classificar + T3 montarDRE), DAS único no Simples (T1 `impostoPorKeyword` simples→das; T3 das em deduções), indiretos vs IRPJ/CSLL (T3), caixa real + fallback + caixa_estimado (T2 + T5), mapping explícito substitui prefixo/keyword (T1, fallback keyword vira regime-aware + flag), confiança (T4 + T5), UI (T6), docs (T7). ✅ O **motor teórico (seção D)** é deliberadamente da Onda 3b — fora deste plano.

**2. Placeholders:** nenhum TBD; todo passo de código tem código completo. ✅

**3. Consistência de tipos:** `DreLinha`, `RegimeTributario`, `classificarLinhaDRE`/`resolverDataCaixa`/`bucketizarCaixa`/`montarDRE`/`scoreConfianca` — mesma assinatura no helper (T1–4) e espelhadas no engine (T5). `detalhamento.{impostos,confianca,caixa_estimado,regime_tributario}` definidos em T5 e lidos em T6. ✅

**4. Escopo/regime:** `REGIME_POR_EMPRESA` constante (sem migration) cobre 3a; a config editável `dre_tributario` só é necessária pro motor teórico (3b). ✅
