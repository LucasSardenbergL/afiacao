import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { componenteMeta, deriveSalesBase, finitoOuNulo, mediaAmplitudeMix, mediaGastoMedido, mediaPonderadaMedida, tetoGasto } from '../salesBase';

describe('deriveSalesBase (v1.8 — ausente é NULL, nunca o 999/R$0 sentinela)', () => {
  it('ausente (undefined/null = sem linha na RPC) → dias NULL, gasto NULL, categorias 0', () => {
    const esperado = { days_since_last_purchase: null, avg_monthly_spend_180d: null, category_count: 0 };
    expect(deriveSalesBase(undefined)).toEqual(esperado);
    expect(deriveSalesBase(null)).toEqual(esperado);
  });

  it('valores reais: days direto, spend = round(revenue_180d/6), category direto', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 12, revenue_180d: 600, category_count: 3 })).toEqual({
      days_since_last_purchase: 12,
      avg_monthly_spend_180d: 100, // 600/6
      category_count: 3,
    });
  });

  it('comprou hoje legítimo: days=0 preservado (NÃO vira null nem 999)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 0, revenue_180d: 1200, category_count: 2 }).days_since_last_purchase).toBe(0);
  });

  it('ZERO MEDIDO preservado: stale com linha e revenue_180d=0 → gasto 0, não null (850 em prod)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 183, revenue_180d: 0, category_count: 2 })).toEqual({
      days_since_last_purchase: 183,
      avg_monthly_spend_180d: 0,
      category_count: 2,
    });
  });

  it('999 MEDIDO preservado: os 2 stale de 2024-02-26 tinham 999 dias reais em 2026-11-21', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 999, revenue_180d: 0, category_count: 3 }).days_since_last_purchase).toBe(999);
  });

  it('pedido de item a preço zero hoje (sem_historico com linha): 0/0 medidos ficam (achado Codex)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 0, revenue_180d: 0, category_count: 1 })).toEqual({
      days_since_last_purchase: 0,
      avg_monthly_spend_180d: 0,
      category_count: 1,
    });
  });

  it('campos null na linha → dias/gasto NULL (não 999/0); categorias 0', () => {
    expect(deriveSalesBase({ days_since_last_purchase: null, revenue_180d: null, category_count: null })).toEqual({
      days_since_last_purchase: null,
      avg_monthly_spend_180d: null,
      category_count: 0,
    });
  });

  it('NaN / string vazia → NULL (Number("") é 0 e fabricaria "medi e deu zero")', () => {
    const nan = Number('xx');
    expect(deriveSalesBase({ days_since_last_purchase: nan, revenue_180d: nan, category_count: nan })).toEqual({
      days_since_last_purchase: null,
      avg_monthly_spend_180d: null,
      category_count: 0,
    });
    expect(deriveSalesBase({ days_since_last_purchase: '  ', revenue_180d: '', category_count: 1 })).toEqual({
      days_since_last_purchase: null,
      avg_monthly_spend_180d: null,
      category_count: 1,
    });
  });

  it('revenue numeric-string (como vem do PG) → parseado', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 5, revenue_180d: '900', category_count: '4' })).toEqual({
      days_since_last_purchase: 5,
      avg_monthly_spend_180d: 150, // 900/6
      category_count: 4,
    });
  });

  it('spend arredonda (round, não trunca)', () => {
    expect(deriveSalesBase({ days_since_last_purchase: 1, revenue_180d: 100, category_count: 1 }).avg_monthly_spend_180d).toBe(17);
  });
});

describe('finitoOuNulo', () => {
  it('só número finito ou string numérica não-vazia', () => {
    expect(finitoOuNulo(0)).toBe(0);
    expect(finitoOuNulo('12')).toBe(12);
    expect(finitoOuNulo(null)).toBeNull();
    expect(finitoOuNulo(undefined)).toBeNull();
    expect(finitoOuNulo('')).toBeNull();
    expect(finitoOuNulo(false)).toBeNull();
    expect(finitoOuNulo(Infinity)).toBeNull();
  });
});

describe('tetoGasto / componenteMeta (paridade com o v1.7 para todo gasto medido)', () => {
  it('teto = maior gasto medido, piso 1; o não medido não participa', () => {
    expect(tetoGasto([null, 0, 250, null, 1000])).toBe(1000);
    expect(tetoGasto([null, null])).toBe(1);
    expect(tetoGasto([0, 0.5])).toBe(1);
  });

  it('teto idêntico ao Math.max(...Number(x || 0), 1) do v1.7 quando o NULL substitui o 0 sentinela', () => {
    const v17 = (xs: number[]) => Math.max(...xs.map((x) => Number(x || 0)), 1);
    expect(tetoGasto([null, 0, 37, 4200])).toBe(v17([0, 0, 37, 4200]));
  });

  it('gasto não medido → componente null; 0 medido → 0; medido → proporção (cap 100)', () => {
    expect(componenteMeta(null, 1000)).toBeNull();
    expect(componenteMeta(0, 1000)).toBe(0);
    expect(componenteMeta(500, 1000)).toBe(50);
    expect(componenteMeta(2000, 1000)).toBe(100);
  });
});

// O edge não importa de src/ — o espelho é VERBATIM e pinado aqui (mesmo molde de frequencia.test.ts).
function bloco(texto: string, rotulo: string): string {
  const m = texto.match(new RegExp(`// MIRROR-START ${rotulo}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`));
  if (!m) throw new Error(`bloco // MIRROR-START ${rotulo}.../END não encontrado`);
  return m[1];
}

describe('paridade src ↔ edge (base de vendas v1.8)', () => {
  const ts = readFileSync('src/lib/scoring/salesBase.ts', 'utf8');
  const shared = readFileSync('supabase/functions/_shared/base-vendas.ts', 'utf8');
  const edge = readFileSync('supabase/functions/calculate-scores/index.ts', 'utf8');

  it('o bloco de _shared/base-vendas.ts é idêntico ao de src/lib/scoring/salesBase.ts', () => {
    expect(bloco(shared, 'base-vendas')).toBe(bloco(ts, 'base-vendas'));
  });

  it('a edge importa deriveSalesBase do _shared e não tem mais cópia inline', () => {
    expect(edge).toMatch(/import \{[^}]*\bderiveSalesBase\b[^}]*\} from "\.\.\/_shared\/base-vendas\.ts"/);
    expect(edge).not.toMatch(/function deriveSalesBase\(/);
  });

  it('o payload da edge não refabrica o sentinela (?? 999 / ?? 0 em dias e gasto)', () => {
    expect(edge).not.toMatch(/days_since_last_purchase\s*\?\?\s*999/);
    expect(edge).not.toMatch(/avg_monthly_spend_180d\s*\?\?\s*0\b/);
    expect(edge).not.toMatch(/days_since_last_purchase\s*\|\|\s*0/);
    expect(edge).not.toMatch(/avg_monthly_spend_180d\s*\|\|\s*0/);
  });
});

describe('mediaGastoMedido (LTV do IPF — base = gasto medido)', () => {
  it('NULL sai do numerador e do denominador; 0 medido conta', () => {
    expect(mediaGastoMedido([null, 400, null, 0, null])).toEqual({ media: 200, medidos: 2 });
  });
  it('nenhum medido → media null (não R$ 0)', () => {
    expect(mediaGastoMedido([null, undefined, ''])).toEqual({ media: null, medidos: 0 });
  });
  it('numeric-string do PostgREST é lido', () => {
    expect(mediaGastoMedido(['300', 100])).toEqual({ media: 200, medidos: 2 });
  });
});

describe('mediaAmplitudeMix (Amplitude de mix do IPF — famílias em 12m, só quem comprou na janela)', () => {
  const c = (id: string | null) => ({ customer_user_id: id });
  it('carteira mista: só quem tem linha na RPC (comprou nos 12m) entra; prospect e stale sem compra ficam fora', () => {
    // a1 ativo 4 · s1 stale que comprou na janela 2 · s2 stale sem compra (sem linha) · p1 prospect (sem linha)
    const fam = new Map<string, number | null>([['a1', 4], ['s1', 2]]);
    expect(mediaAmplitudeMix([c('a1'), c('s1'), c('s2'), c('p1')], fam)).toEqual({ media: 3, base: 2 });
  });
  it('familias null (itens sem família cadastrada) sai da base; linha de cliente de fora da carteira é ignorada', () => {
    const fam = new Map<string, number | null>([['a1', 6], ['a3', null], ['outro', 1]]);
    expect(mediaAmplitudeMix([c('a1'), c('a3'), c(null)], fam)).toEqual({ media: 6, base: 1 });
  });
  it('carteira só com quem nunca comprou → media null (nunca 0)', () => {
    expect(mediaAmplitudeMix([c('p1'), c('p2')], new Map())).toEqual({ media: null, base: 0 });
    expect(mediaAmplitudeMix([], new Map())).toEqual({ media: null, base: 0 });
  });
});

describe('mediaPonderadaMedida (IPF total renormalizado)', () => {
  it('componente null sai com o seu peso', () => {
    expect(mediaPonderadaMedida([{ valor: 100, peso: 0.25 }, { valor: null, peso: 0.75 }])).toBe(100);
    expect(mediaPonderadaMedida([{ valor: 100, peso: 0.5 }, { valor: 0, peso: 0.5 }])).toBe(50);
  });
  it('nada medido → null', () => {
    expect(mediaPonderadaMedida([{ valor: null, peso: 1 }])).toBeNull();
  });
});
