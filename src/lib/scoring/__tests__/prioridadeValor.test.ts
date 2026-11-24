import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  calcularPrioridade,
  explicarPrioridade,
  referenciaExposicao,
  type InsumosPrioridade,
} from '@/lib/scoring/prioridadeValor';

const K = referenciaExposicao(undefined); // o padrão (R$ 1.000), sem exportar a constante
const A = 180;
const nota = (i: InsumosPrioridade) => calcularPrioridade(i, K, A)?.nota ?? null;

// Gerador semeado (mulberry32): propriedade determinística, sem dependência nova.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ativoAleatorio(r: () => number): InsumosPrioridade {
  const intervalo = r() < 0.15 ? null : 1 + Math.floor(r() * 300);
  return { status: 'ativo', dias: Math.floor(r() * 181), intervalo, gastoMensal: Math.round(r() ** 3 * 120_000) };
}
function staleAleatorio(r: () => number): InsumosPrioridade {
  return { status: 'stale', dias: 181 + Math.floor(r() * 3500), intervalo: r() < 0.5 ? null : 1 + Math.floor(r() * 300), gastoMensal: 0 };
}
const N = 2000;

describe('prioridade por exposição ao atraso — propriedades', () => {
  it('RÉGUA: ativo atrasado na recompra fica ACIMA de qualquer inativo (inclusive há 3 anos)', () => {
    const r = rng(1);
    let comparados = 0;
    for (let n = 0; n < N; n++) {
      const a = ativoAleatorio(r);
      const s = staleAleatorio(r);
      const pa = calcularPrioridade(a, K, A);
      if (pa?.faixa !== 'atrasado') continue;
      comparados++;
      expect(pa.nota).toBeGreaterThan(nota(s)!);
    }
    expect(comparados).toBeGreaterThan(200); // a propriedade não pode passar vazia
  });

  it('faixas DISJUNTAS: atrasado [60,100) > em_dia [35,60) > sem_cadencia [30,35) > reativacao [0,30)', () => {
    const r = rng(2);
    const limites = { atrasado: [60, 100], em_dia: [35, 60], sem_cadencia: [30, 35], reativacao: [0, 30] } as const;
    const vistas = new Set<string>();
    for (let n = 0; n < N; n++) {
      const p = calcularPrioridade(r() < 0.5 ? ativoAleatorio(r) : staleAleatorio(r), K, A)!;
      const [lo, hi] = limites[p.faixa];
      expect(p.nota).toBeGreaterThanOrEqual(lo);
      expect(p.nota).toBeLessThan(hi);
      vistas.add(p.faixa);
    }
    expect([...vistas].sort()).toEqual(['atrasado', 'em_dia', 'reativacao', 'sem_cadencia']);
  });

  it('monotonia no atrasado: mais gasto OU mais dias além da cadência nunca baixa a nota', () => {
    const r = rng(3);
    for (let n = 0; n < N; n++) {
      const intervalo = 1 + Math.floor(r() * 200);
      const dias = intervalo + 1 + Math.floor(r() * 100);
      const gasto = 1 + Math.round(r() * 50_000);
      const base = nota({ status: 'ativo', dias, intervalo, gastoMensal: gasto })!;
      expect(nota({ status: 'ativo', dias, intervalo, gastoMensal: gasto * 2 })!).toBeGreaterThanOrEqual(base);
      expect(nota({ status: 'ativo', dias: dias + 5, intervalo, gastoMensal: gasto })!).toBeGreaterThanOrEqual(base);
    }
  });

  it('reativação: lapso mais recente pontua mais (decai com a recência)', () => {
    expect(nota({ status: 'stale', dias: 200, intervalo: null, gastoMensal: 0 })!).toBeGreaterThan(
      nota({ status: 'stale', dias: 1095, intervalo: null, gastoMensal: 0 })!,
    );
  });

  it('valores DISTINTOS: 2.000 ativos aleatórios não colapsam em poucas notas (era 52 em 707)', () => {
    const r = rng(4);
    const notas = new Set<number>();
    for (let n = 0; n < N; n++) notas.add(nota(ativoAleatorio(r))!);
    expect(notas.size).toBeGreaterThan(N / 2);
  });

  it('o comprador diário que comprou ontem NÃO é o topo (alternativa rejeitada no /codex)', () => {
    const diarioEmDia = calcularPrioridade({ status: 'ativo', dias: 1, intervalo: 1, gastoMensal: 104_000 }, K, A)!;
    const pequenoAtrasado = calcularPrioridade({ status: 'ativo', dias: 90, intervalo: 30, gastoMensal: 500 }, K, A)!;
    expect(diarioEmDia.faixa).toBe('em_dia');
    expect(pequenoAtrasado.faixa).toBe('atrasado');
    expect(pequenoAtrasado.nota).toBeGreaterThan(diarioEmDia.nota);
  });

  it('a ordem não depende do maior cliente do dia (curva logística, sem normalizar por máximo)', () => {
    const a = nota({ status: 'ativo', dias: 60, intervalo: 30, gastoMensal: 900 });
    // mesma entrada, nenhuma outra linha participa do cálculo: a função é por cliente.
    expect(nota({ status: 'ativo', dias: 60, intervalo: 30, gastoMensal: 900 })).toBe(a);
  });
});

describe('prioridade — ausente ≠ zero (marca de cada ramo)', () => {
  it('sem_historico e status desconhecido → null', () => {
    expect(calcularPrioridade({ status: 'sem_historico', dias: null, intervalo: null, gastoMensal: null }, K, A)).toBeNull();
    expect(calcularPrioridade({ status: null, dias: 10, intervalo: 5, gastoMensal: 100 }, K, A)).toBeNull();
  });
  it('ativo sem dias ou sem gasto medido → null (nunca a nota de "R$ 0")', () => {
    expect(calcularPrioridade({ status: 'ativo', dias: null, intervalo: 5, gastoMensal: 100 }, K, A)).toBeNull();
    expect(calcularPrioridade({ status: 'ativo', dias: 10, intervalo: 5, gastoMensal: null }, K, A)).toBeNull();
    expect(calcularPrioridade({ status: 'ativo', dias: 10, intervalo: 5, gastoMensal: Number.NaN }, K, A)).toBeNull();
  });
  it('stale sem dias → null', () => {
    expect(calcularPrioridade({ status: 'stale', dias: null, intervalo: null, gastoMensal: 0 }, K, A)).toBeNull();
  });
  it('intervalo 0 (resíduo do seed) é cadência DESCONHECIDA, não "vence todo dia"', () => {
    expect(calcularPrioridade({ status: 'ativo', dias: 10, intervalo: 0, gastoMensal: 100 }, K, A)!.faixa).toBe('sem_cadencia');
  });
  it('gasto 0 MEDIDO atrasado não entra na faixa de atrasado (exposição zero — achado /codex)', () => {
    const p = calcularPrioridade({ status: 'ativo', dias: 90, intervalo: 30, gastoMensal: 0 }, K, A)!;
    expect(p.faixa).toBe('em_dia');
    expect(p.nota).toBe(35);
  });
  it('a exposição e os dias além da cadência só existem na faixa atrasado', () => {
    const p = calcularPrioridade({ status: 'ativo', dias: 45, intervalo: 30, gastoMensal: 3000 }, K, A)!;
    expect(p).toMatchObject({ faixa: 'atrasado', exposicao: 1500, diasAlemDaCadencia: 15 });
    expect(calcularPrioridade({ status: 'ativo', dias: 10, intervalo: 30, gastoMensal: 3000 }, K, A)).toMatchObject({
      faixa: 'em_dia', exposicao: null, diasAlemDaCadencia: null,
    });
  });
  it('referência inválida cai no padrão (sem ela a curva vira degrau)', () => {
    expect(referenciaExposicao(undefined)).toBe(K);
    expect(referenciaExposicao(0)).toBe(K);
    expect(referenciaExposicao(-5)).toBe(K);
    expect(referenciaExposicao('abc')).toBe(K);
    expect(referenciaExposicao(2500)).toBe(2500);
  });
});

describe('explicarPrioridade — tooltip só explica a nota que a regra confirma', () => {
  const fmt = (v: number) => `R$ ${Math.round(v)}`;
  const base = { sales_history_status: 'ativo', days_since_last_purchase: 45, avg_repurchase_interval: 30, avg_monthly_spend_180d: 3000 };
  it('atrasado: 3 fatores — dias além da cadência, gasto, exposição', () => {
    expect(explicarPrioridade({ ...base, priority_score: 83.99 }, fmt)).toEqual([
      'Atrasado: 15 dias além da recompra habitual (a cada 30 dias)',
      'Compra R$ 3000/mês (últimos 180 dias)',
      '≈ R$ 1500 de compra em atraso (estimativa)',
    ]);
  });
  it('nota da FÓRMULA ANTIGA (edge ainda não recalculada) → null, não explica com a regra errada', () => {
    expect(explicarPrioridade({ ...base, priority_score: 41 }, fmt)).toBeNull();
  });
  it('inativo: fila de reativação', () => {
    const s = { sales_history_status: 'stale', days_since_last_purchase: 1095, avg_repurchase_interval: null, avg_monthly_spend_180d: 0 };
    expect(explicarPrioridade({ ...s, priority_score: 4.93 }, fmt)).toEqual([
      'Inativo: sem compra há 1095 dias',
      'Fila de reativação: abaixo de todo cliente ativo',
    ]);
  });
  it('sem nota ou sem histórico → null', () => {
    expect(explicarPrioridade({ ...base, priority_score: null }, fmt)).toBeNull();
    expect(explicarPrioridade({ ...base, sales_history_status: 'sem_historico', priority_score: 50 }, fmt)).toBeNull();
  });
});

// ── Paridade: Deno não importa de src/, então a edge carrega uma cópia VERBATIM ──
function blocoEspelho(s: string, rotulo: string): string {
  const m = s.match(new RegExp(`// MIRROR-START ${rotulo}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`));
  if (!m) throw new Error(`bloco // MIRROR-START ${rotulo}.../END não encontrado`);
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

describe('paridade TS ↔ edge (calculate-scores)', () => {
  const ts = readFileSync('src/lib/scoring/prioridadeValor.ts', 'utf8');
  const shared = readFileSync('supabase/functions/_shared/prioridade-valor.ts', 'utf8');
  const edge = readFileSync('supabase/functions/calculate-scores/index.ts', 'utf8');

  it('o bloco prioridade-valor é IDÊNTICO nos dois lados', () => {
    const doTs = blocoEspelho(ts, 'prioridade-valor');
    expect(doTs).toContain('function calcularPrioridade');
    expect(blocoEspelho(shared, 'prioridade-valor')).toBe(doTs);
  });

  it('a edge USA a regra nova e não recompõe mais a média ponderada da prioridade', () => {
    expect(edge).toContain('../_shared/prioridade-valor.ts');
    expect(edge).toMatch(/calcularPrioridade\s*\(/);
    expect(edge).toMatch(/referenciaExposicao\s*\(\s*config\['ps_referencia_exposicao'\]\s*\)/);
    expect(edge).not.toMatch(/ps_weight_/);
    expect(edge).not.toMatch(/priorityMedia/);
  });
});
