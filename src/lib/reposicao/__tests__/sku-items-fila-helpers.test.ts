import { describe, it, expect } from 'vitest';
import {
  skuItemsBackoffMs,
  skuItemsElegivel,
  skuItemsCompararFila,
  type SkuItemsFilaControle,
} from '../sku-items-fila-helpers';

const H = 3_600_000;
const AGORA = Date.parse('2026-07-14T21:00:00Z');
const isoHorasAtras = (h: number) => new Date(AGORA - h * H).toISOString();

describe('skuItemsBackoffMs — escada 6h/24h/72h', () => {
  it('virgem (0 ou negativo) não espera', () => {
    expect(skuItemsBackoffMs(0)).toBe(0);
    expect(skuItemsBackoffMs(-1)).toBe(0);
  });

  it('1ª falha re-tenta em 6h, 2ª em 24h, 3ª+ em 72h (cap)', () => {
    expect(skuItemsBackoffMs(1)).toBe(6 * H);
    expect(skuItemsBackoffMs(2)).toBe(24 * H);
    expect(skuItemsBackoffMs(3)).toBe(72 * H);
    expect(skuItemsBackoffMs(15)).toBe(72 * H);
  });
});

describe('skuItemsElegivel — quem entra na fila do run', () => {
  const c = (tentativas: number, ultimaHorasAtras: number | null): SkuItemsFilaControle => ({
    tentativas,
    ultima_tentativa: ultimaHorasAtras === null ? null : isoHorasAtras(ultimaHorasAtras),
  });

  it('sem controle (NFe virgem) → sempre elegível', () => {
    expect(skuItemsElegivel(undefined, AGORA)).toBe(true);
  });

  it('controle degradado (tentativas 0 / sem timestamp / timestamp ilegível) → elegível (fail-open)', () => {
    expect(skuItemsElegivel(c(0, 5), AGORA)).toBe(true);
    expect(skuItemsElegivel(c(2, null), AGORA)).toBe(true);
    expect(skuItemsElegivel({ tentativas: 2, ultima_tentativa: 'not-a-date' }, AGORA)).toBe(true);
  });

  it('1 tentativa: bloqueada até 6h, liberada depois', () => {
    expect(skuItemsElegivel(c(1, 5), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(1, 6), AGORA)).toBe(true);
  });

  it('2 tentativas: bloqueada até 24h, liberada depois', () => {
    expect(skuItemsElegivel(c(2, 23), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(2, 25), AGORA)).toBe(true);
  });

  it('3+ tentativas (poison): bloqueada até 72h, liberada depois — nunca abandonada', () => {
    expect(skuItemsElegivel(c(3, 71), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(3, 73), AGORA)).toBe(true);
    expect(skuItemsElegivel(c(9, 71), AGORA)).toBe(false);
    expect(skuItemsElegivel(c(9, 73), AGORA)).toBe(true);
  });
});

describe('skuItemsCompararFila — nunca-tentadas primeiro, poison pro fim', () => {
  it('menos tentativas vence, mesmo com faturamento mais recente do outro lado', () => {
    const virgemAntiga = { tentativas: 0, t2: '2026-06-15T00:00:00+00:00' };
    const poisonRecente = { tentativas: 5, t2: '2026-07-14T00:00:00+00:00' };
    expect(skuItemsCompararFila(virgemAntiga, poisonRecente)).toBeLessThan(0);
    expect(skuItemsCompararFila(poisonRecente, virgemAntiga)).toBeGreaterThan(0);
  });

  it('empate em tentativas → earliest-deadline-first (a mais ANTIGA vai primeiro)', () => {
    // A antiga é a de menor folga: está prestes a sair da janela de `dias` e some
    // sem virar leadtime. A recente volta na próxima janela.
    const recente = { tentativas: 0, t2: '2026-07-14T00:00:00+00:00' };
    const antiga = { tentativas: 0, t2: '2026-07-01T00:00:00+00:00' };
    expect(skuItemsCompararFila(antiga, recente)).toBeLessThan(0);
    expect(skuItemsCompararFila(recente, antiga)).toBeGreaterThan(0);
    expect(skuItemsCompararFila(antiga, antiga)).toBe(0);
  });

  it('forma do incidente: poison sai da frente e a prestes-a-expirar vai primeiro', () => {
    // Poison = NFe já consultada várias vezes que sempre responde 0 itens; ela era
    // re-consultada em todo run e comia o guard, deixando as órfãs virgens antigas
    // inalcançáveis. Com a fila nova: virgens antes do poison e, entre elas, a mais
    // antiga (a primeira a expirar da janela) lidera.
    const fila = [
      { id: 'poison', tentativas: 5, t2: '2026-07-14T00:00:00+00:00' },
      { id: 'virgem-antiga', tentativas: 0, t2: '2026-06-15T00:00:00+00:00' },
      { id: 'virgem-recente', tentativas: 0, t2: '2026-07-10T00:00:00+00:00' },
      { id: 'tentada-1x', tentativas: 1, t2: '2026-07-08T00:00:00+00:00' },
    ].sort(skuItemsCompararFila);
    expect(fila.map((f) => f.id)).toEqual([
      'virgem-antiga',
      'virgem-recente',
      'tentada-1x',
      'poison',
    ]);
  });
});
