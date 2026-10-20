import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  classeSaude,
  componenteRecompra,
  intervaloRecompraConhecido,
  scoreFrequencia,
} from '../frequencia';
import {
  maximoMedido,
  mediaPonderadaRenormalizada,
} from '../../../../supabase/functions/_shared/score-ponderado';

// Venda por cliente, Fase 1a. Antes deste módulo `avg_repurchase_interval` não era calculado por
// ninguém: o seed gravava 0 e 140 linhas legadas tinham 30. Com o teto da base em 1.958, o 30 dava
// ~98 pontos de frequência — e um cliente morto, com margem/cross-sell/engajamento nulos e pesos
// renormalizados, ficava em "atenção" em vez de "crítico".

// Pesos DEFAULT do health em calculate-scores (hs_weight_*, /100).
const HS = { recency: 0.25, frequency: 0.2, margin: 0.2, diversity: 0.15, crosssell: 0.1, engagement: 0.1 };

/** A composição do health de calculate-scores, com os helpers reais (sem remontar a regra aqui). */
function saude(c: { recencia: number; intervalo: unknown; diversidade: number }, intervalosDaBase: unknown[]) {
  const max = maximoMedido(intervalosDaBase.map(intervaloRecompraConhecido));
  const freq = scoreFrequencia(intervaloRecompraConhecido(c.intervalo), max);
  const media = mediaPonderadaRenormalizada([
    { valor: c.recencia, peso: HS.recency },
    { valor: freq, peso: HS.frequency },
    { valor: null, peso: HS.margin },
    { valor: c.diversidade, peso: HS.diversity },
    { valor: null, peso: HS.crosssell },
    { valor: null, peso: HS.engagement },
  ]);
  return { freq, classe: classeSaude(Math.round(media ?? 0)) };
}

describe('intervaloRecompraConhecido — ausente ≠ zero', () => {
  it('null/undefined/NaN → null', () => {
    expect(intervaloRecompraConhecido(null)).toBeNull();
    expect(intervaloRecompraConhecido(undefined)).toBeNull();
    expect(intervaloRecompraConhecido(Number.NaN)).toBeNull();
  });

  it('0 é o resíduo do seed, não intervalo medido → null', () => {
    // A mediana dos gaps entre dias DISTINTOS é ≥ 1 por construção; 0 só existe como fabricação.
    expect(intervaloRecompraConhecido(0)).toBeNull();
    expect(intervaloRecompraConhecido('0')).toBeNull();
  });

  it('valor medido atravessa (inclusive como string numeric do PostgREST)', () => {
    expect(intervaloRecompraConhecido(17)).toBe(17);
    expect(intervaloRecompraConhecido('22.5')).toBe(22.5);
  });
});

describe('scoreFrequencia', () => {
  it('cliente com 2 pedidos (intervalo nulo) → frequência AUSENTE, não 0 nem 80', () => {
    expect(scoreFrequencia(intervaloRecompraConhecido(null), 1958)).toBeNull();
  });

  it('sem nenhum intervalo medido na base → null (teto fabricado não existe)', () => {
    expect(scoreFrequencia(20, null)).toBeNull();
  });

  it('intervalo 20 com teto 100 → 80 (mesma fórmula de antes: não regride)', () => {
    // Fórmula anterior: max(0, 100 − interval/maxInterval·100).
    expect(scoreFrequencia(20, 100)).toBe(80);
    expect(scoreFrequencia(100, 100)).toBe(0);
  });
});

describe('classe de saúde — o cliente morto deixa de ser "atenção"', () => {
  const base = [1958, 20, null, 0, 30];

  it('999 dias e intervalo null → critico', () => {
    expect(saude({ recencia: 0, intervalo: null, diversidade: 0 }, base).classe).toBe('critico');
  });

  it('o MESMO cliente com o resíduo 30 caía em atenção (o defeito que este módulo fecha)', () => {
    // Prova que o teste acima depende do intervalo, não de outro eixo.
    expect(saude({ recencia: 0, intervalo: 30, diversidade: 0 }, base).classe).toBe('atencao');
  });

  it('intervalo 20 e compra há 10 dias → freqScore igual ao de hoje', () => {
    const r = saude({ recencia: 100 - (10 / 180) * 100, intervalo: 20, diversidade: 50 }, base);
    expect(r.freq).toBeCloseTo(100 - (20 / 1958) * 100, 10);
  });

  it('limiares de classe preservados', () => {
    expect(classeSaude(75)).toBe('saudavel');
    expect(classeSaude(74)).toBe('estavel');
    expect(classeSaude(50)).toBe('estavel');
    expect(classeSaude(49)).toBe('atencao');
    expect(classeSaude(25)).toBe('atencao');
    expect(classeSaude(24)).toBe('critico');
  });
});

describe('componenteRecompra (priority) — sem intervalo, sem o 30 fabricado', () => {
  it('intervalo nulo → null (sai da média do priority, não assume cadência mensal)', () => {
    expect(componenteRecompra(30, null)).toBeNull();
  });

  it('intervalo medido → mesma fórmula de antes', () => {
    expect(componenteRecompra(20, 20)).toBe(100);
    expect(componenteRecompra(30, 20)).toBe(50);
    expect(componenteRecompra(999, 20)).toBe(0);
  });
});

// ── Paridade: Deno não importa de src/, então a edge carrega uma cópia VERBATIM ──
function blocoEspelho(s: string, rotulo: string): string {
  const m = s.match(new RegExp(`// MIRROR-START ${rotulo}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`));
  if (!m) throw new Error(`bloco // MIRROR-START ${rotulo}.../END não encontrado`);
  return m[1]
    .replace(/\bexport\s+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

describe('paridade TS ↔ edge (calculate-scores)', () => {
  const ts = readFileSync('src/lib/scoring/frequencia.ts', 'utf8');
  const shared = readFileSync('supabase/functions/_shared/frequencia-recompra.ts', 'utf8');
  const edge = readFileSync('supabase/functions/calculate-scores/index.ts', 'utf8');

  it('o bloco frequencia-recompra é IDÊNTICO nos dois lados', () => {
    const doTs = blocoEspelho(ts, 'frequencia-recompra');
    expect(doTs).toContain('function scoreFrequencia');
    expect(blocoEspelho(shared, 'frequencia-recompra')).toBe(doTs);
  });

  it('a edge USA o módulo nos dois scores e persiste o intervalo', () => {
    expect(edge).toContain('../_shared/frequencia-recompra.ts');
    expect(edge).toMatch(/scoreFrequencia\s*\(/);
    expect(edge).toMatch(/componenteRecompra\s*\(/);
    expect(edge).toMatch(/classeSaude\s*\(/);
    expect(edge).toContain('intervalo_mediano_dias');
    expect(edge).toMatch(/avg_repurchase_interval:\s*client\.avg_repurchase_interval/);
  });

  it('o 0/30 fabricado não volta (seed nem fallback)', () => {
    expect(edge).not.toMatch(/avg_repurchase_interval:\s*0\b/);
    expect(edge).not.toMatch(/avg_repurchase_interval\s*\|\|\s*(30|maxInterval)/);
  });
});
