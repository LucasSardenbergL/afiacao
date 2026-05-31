import { describe, it, expect } from 'vitest';
import { montarCestaRecompra, mediana, medianaComTendencia } from './cesta-recompra';
import type { PedidoLine, CestaOpts } from './cesta-recompra';
import { addDaysIso } from './route-schedule';

const HOJE = '2026-03-25';
function line(sku: number, quantity: number, order_date: string, over: Partial<PedidoLine> = {}): PedidoLine {
  return { omie_codigo_produto: sku, quantity, unit_price: 10, order_date, account: 'oben', status: 'FATURADO', ...over };
}
const OPTS: CestaOpts = { account: 'oben', hoje: HOJE, statusValidos: ['FATURADO', 'CONCLUIDO'] };
const skus = (items: { omie_codigo_produto: number }[]) => items.map(i => i.omie_codigo_produto);

describe('mediana', () => {
  it('ímpar e par', () => {
    expect(mediana([3, 1, 2])).toBe(2);
    expect(mediana([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('medianaComTendencia', () => {
  it('estável → mediana', () => expect(medianaComTendencia([5, 5, 5])).toBe(5));
  it('crescente forte → puxa pra cima (mediana das últimas 3)', () => {
    expect(medianaComTendencia([2, 4, 6, 8])).toBe(6); // base 5; últimas3 [4,6,8] med 6
  });
  it('não-crescente → mediana base', () => expect(medianaComTendencia([3, 1, 4, 1])).toBe(2));
});

describe('montarCestaRecompra — filtros e degradação', () => {
  it('cliente com < 2 pedidos → cesta vazia, confiança baixa (não fabrica de 1 compra)', () => {
    const r = montarCestaRecompra([line(100, 5, '2026-03-01')], OPTS);
    expect(r.principal).toEqual([]);
    expect(r.secundarios).toEqual([]);
    expect(r.totalPedidos).toBe(1);
    expect(r.confianca).toBe('baixa');
  });
  it('filtra outra conta, status fora da whitelist e fora da janela', () => {
    const r = montarCestaRecompra([
      line(100, 5, '2026-03-01'),
      line(100, 5, '2026-02-01'),
      line(200, 1, '2026-03-01', { account: 'colacor' }),  // outra conta
      line(300, 1, '2026-03-01', { status: 'CANCELADO' }), // status inválido
      line(400, 1, '2025-01-01'),                          // fora da janela 180d
    ], OPTS);
    expect(r.totalPedidos).toBe(2);
    const all = skus([...r.principal, ...r.secundarios]);
    expect(all).toContain(100);
    expect(all).not.toContain(200);
    expect(all).not.toContain(300);
    expect(all).not.toContain(400);
  });
});

describe('montarCestaRecompra — recorrência (frac mínima) [codex Q1]', () => {
  it('SKU em 2 de 12 pedidos, não-due → excluído (ruído histórico)', () => {
    const lines: PedidoLine[] = [];
    for (let i = 0; i < 12; i++) lines.push(line(100, 3, addDaysIso(HOJE, -(i * 30 + 5)))); // frequente, 12 datas
    lines.push(line(999, 1, addDaysIso(HOJE, -15)));  // 2 compras recentes, não-due
    lines.push(line(999, 1, addDaysIso(HOJE, -43)));
    const r = montarCestaRecompra(lines, { ...OPTS, janelaDias: 420 });
    const all = skus([...r.principal, ...r.secundarios]);
    expect(all).toContain(100);     // frequente entra
    expect(all).not.toContain(999); // 2/12 + não-due → ruído, fora
  });
});

describe('montarCestaRecompra — principal vs secundário [codex Q3]', () => {
  // 5 datas distintas do cliente
  const D = ['2026-01-01', '2026-01-25', '2026-02-20', '2026-03-10', '2026-03-22'];
  const lines: PedidoLine[] = [
    ...D.map(d => line(10, 4, d)),               // FREQ: em todas as 5 (frac 1.0), não-due
    line(20, 2, '2026-01-01'), line(20, 2, '2026-01-25'), // DUE: 2 compras antigas → atrasado
    line(30, 1, '2026-03-10'), line(30, 1, '2026-03-22'), // SEC: 2 compras recentes → não-due, frac 0.4
  ];
  const r = montarCestaRecompra(lines, OPTS);
  it('frequente (≥50% dos pedidos) entra na principal mesmo sem due', () => {
    expect(skus(r.principal)).toContain(10);
  });
  it('atrasado (due alto) entra na principal e lidera a ordem', () => {
    expect(skus(r.principal)).toContain(20);
    expect(r.principal[0].omie_codigo_produto).toBe(20); // maior dueRatio primeiro
  });
  it('recorrente recente, não-due e infrequente → secundário ("também costuma levar")', () => {
    expect(skus(r.secundarios)).toContain(30);
    expect(skus(r.principal)).not.toContain(30);
  });
});

describe('montarCestaRecompra — cap da principal + overflow vira secundário', () => {
  it('10 SKUs due, cap 8 → principal tem 8 (top por due), resto secundário', () => {
    const lines: PedidoLine[] = [];
    for (let i = 0; i < 10; i++) {
      const last = addDaysIso(HOJE, -(25 + i));      // dueRatio = (25+i)/30, crescente, todos ≥0.8 e não-stale
      lines.push(line(100 + i, 2, last));
      lines.push(line(100 + i, 2, addDaysIso(last, -30)));
    }
    const r = montarCestaRecompra(lines, OPTS);
    expect(r.principal.length).toBe(8);
    expect(r.secundarios.length).toBeGreaterThanOrEqual(2);
    // o de menor due (i=0) não está na principal
    expect(skus(r.principal)).not.toContain(100);
  });
});

describe('montarCestaRecompra — stale, dedup mesmo-dia, fracionado [codex Q4/P2/UOM]', () => {
  it('SKU não comprado há > max(2.5×cadência, 90d) → excluído (stale)', () => {
    const r = montarCestaRecompra([
      line(100, 2, '2025-10-01'), line(100, 2, '2025-11-01'), // última há ~144d, cadência 31 → stale
      line(200, 2, '2026-02-20'), line(200, 2, '2026-03-15'), // válido recente
    ], OPTS);
    expect(skus([...r.principal, ...r.secundarios])).not.toContain(100);
    expect(skus([...r.principal, ...r.secundarios])).toContain(200);
  });
  it('2 pedidos no MESMO dia contam como 1 (cadência por dia canônico)', () => {
    const r = montarCestaRecompra([
      line(100, 2, '2026-02-01'), line(100, 3, '2026-02-01'), // mesmo dia
      line(100, 2, '2026-03-01'),
    ], OPTS);
    const item = [...r.principal, ...r.secundarios].find(i => i.omie_codigo_produto === 100);
    expect(item?.nPedidos).toBe(2); // 2 datas distintas, não 3
  });
  it('quantidade fracionada → confidence baixa (UOM não validável no helper)', () => {
    const r = montarCestaRecompra([
      line(100, 1.5, '2026-01-20'), line(100, 1.5, '2026-02-20'), line(100, 1.5, '2026-03-20'),
    ], OPTS);
    const item = [...r.principal, ...r.secundarios].find(i => i.omie_codigo_produto === 100);
    expect(item?.confidence).toBe('baixa');
  });
  it('ultimoPrecoRef presente só como referência (debug), não na decisão', () => {
    const r = montarCestaRecompra([
      line(100, 2, '2026-02-20', { unit_price: 12 }), line(100, 2, '2026-03-20', { unit_price: 15 }),
    ], OPTS);
    const item = [...r.principal, ...r.secundarios].find(i => i.omie_codigo_produto === 100);
    expect(item?.ultimoPrecoRef).toBe(15);
  });
});
