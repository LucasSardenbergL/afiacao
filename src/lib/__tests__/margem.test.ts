import { describe, it, expect } from 'vitest';
import { lerMargemPct, formatarMargemPct } from '@/lib/margem';

/**
 * Os casos abaixo separam o certo do ERRADO ESPECÍFICO que este helper existe para
 * impedir. Um assert que só checasse "não é nulo" passaria em todas as versões quebradas.
 */
describe('lerMargemPct — escala 0–100, sem adivinhação', () => {
  it('preserva a escala 0–100 da RPC (o `* 100` do Customer360View daria 5347)', () => {
    expect(lerMargemPct(53.47)).toBe(53.47);
  });

  it('NÃO normaliza valores abaixo de 1 — margem real de 0,8% continua 0,8', () => {
    // A heurística `v > 1 ? v : v * 100` do formatPctMaybe transformaria isto em 80.
    expect(lerMargemPct(0.8)).toBe(0.8);
    expect(lerMargemPct(0.15)).toBe(0.15);
  });

  it('aceita string numérica (PostgREST devolve numeric como string)', () => {
    expect(lerMargemPct('53.47')).toBe(53.47);
    expect(lerMargemPct('-143.22')).toBe(-143.22);
  });

  it('preserva margem negativa — prejuízo é dado real, não erro', () => {
    expect(lerMargemPct(-143.22)).toBe(-143.22);
  });

  it('distingue zero-veredito de ausência: 0 é 0, ausente é null', () => {
    expect(lerMargemPct(0)).toBe(0);
    expect(lerMargemPct('0')).toBe(0);
  });
});

describe('lerMargemPct — ausente ≠ zero (fail-closed)', () => {
  it('null e undefined viram null, JAMAIS 0', () => {
    expect(lerMargemPct(null)).toBeNull();
    expect(lerMargemPct(undefined)).toBeNull();
  });

  it('string vazia vira null — Number("") === 0 fabricaria margem zero', () => {
    expect(lerMargemPct('')).toBeNull();
    expect(lerMargemPct('   ')).toBeNull();
  });

  it('NaN e Infinity viram null', () => {
    expect(lerMargemPct(NaN)).toBeNull();
    expect(lerMargemPct(Infinity)).toBeNull();
    expect(lerMargemPct('NaN')).toBeNull();
  });

  it('tipos não-numéricos viram null — Number([]) === 0 fabricaria', () => {
    expect(lerMargemPct([])).toBeNull();
    expect(lerMargemPct({})).toBeNull();
    expect(lerMargemPct(true)).toBeNull();
    expect(lerMargemPct('abc')).toBeNull();
  });
});

describe('formatarMargemPct', () => {
  it('formata em pt-BR na escala certa', () => {
    expect(formatarMargemPct(53.47)).toBe('53,5%');
    expect(formatarMargemPct(88.33)).toBe('88,3%');
  });

  it('margem de 0,8% exibe "0,8%" e não "80%"', () => {
    expect(formatarMargemPct(0.8)).toBe('0,8%');
  });

  it('inteiro sai sem casa decimal', () => {
    expect(formatarMargemPct(30)).toBe('30%');
    expect(formatarMargemPct(0)).toBe('0%');
  });

  it('negativo é exibido como negativo', () => {
    expect(formatarMargemPct(-143.22)).toBe('-143,2%');
  });

  it('ausente vira travessão — nunca "0%", que o leitor lê como "não dá margem"', () => {
    expect(formatarMargemPct(null)).toBe('—');
    expect(formatarMargemPct(undefined)).toBe('—');
    expect(formatarMargemPct('')).toBe('—');
  });
});
