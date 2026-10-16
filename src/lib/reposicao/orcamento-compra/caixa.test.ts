// src/lib/reposicao/orcamento-compra/caixa.test.ts
import { describe, expect, it } from 'vitest';
import { avaliarEstado, fluxosDeSemanaAgregada, trajetoriaDiaria, type Fluxo } from './caixa';
import { conciliarCompromissos, normalizarNf, projetarRitmo, provisaoContinuidade, ritmoPorDiaDoMes } from './camadas';

const f = (data: string, valor: number): Fluxo => ({ data, valor, camada: 'base_titulos' });

describe('trajetória diária e estado', () => {
  it('intrassemana: o fechamento semanal não mascara a violação (spec §8 teste 7)', () => {
    // seg 2026-10-19 saldo 230k; qua −40k; sex +80k; reserva 224k
    const t = trajetoriaDiaria(230_000, '2026-10-19', 7, [f('2026-10-21', -40_000), f('2026-10-23', 80_000)]);
    expect(t[t.length - 1].saldo).toBe(270_000);
    const e = avaliarEstado(t, 224_000, []);
    expect(e).toEqual({ tipo: 'inviavel', primeiraViolacao: '2026-10-21', deficitMax: 34_000 });
  });
  it('pagamento fora do horizonte estende a verificação (spec §8 teste 8)', () => {
    const t = trajetoriaDiaria(300_000, '2026-10-01', 91, [f('2026-01-01', 0), f('2027-01-04', -100_000)]);
    expect(t.length).toBe(96);
    expect(avaliarEstado(t, 224_000, []).tipo).toBe('inviavel');
  });
  it('remover uma camada muda o saldo exatamente pelo fluxo acumulado removido (spec §8 teste 9)', () => {
    const outros = [f('2026-10-02', -10_000), f('2026-10-05', 3_000)];
    const camada: Fluxo[] = [{ data: '2026-10-03', valor: -7_000, camada: 'saida_nao_sayerlack' }];
    const com = trajetoriaDiaria(100_000, '2026-10-01', 10, [...outros, ...camada]);
    const sem = trajetoriaDiaria(100_000, '2026-10-01', 10, outros);
    com.forEach((p, i) => expect(sem[i].saldo - p.saldo).toBe(p.data >= '2026-10-03' ? 7_000 : 0));
  });
  it('camada ausente → indeterminado, nomeando a camada', () => {
    const t = trajetoriaDiaria(900_000, '2026-10-01', 5, []);
    expect(avaliarEstado(t, 224_000, ['snapshot'])).toEqual({ tipo: 'indeterminado', camadas: ['snapshot'], piso: 900_000 });
  });
  it('viável reporta piso e data do piso', () => {
    const t = trajetoriaDiaria(300_000, '2026-10-01', 5, [f('2026-10-03', -50_000), f('2026-10-04', 20_000)]);
    expect(avaliarEstado(t, 224_000, [])).toEqual({ tipo: 'viavel', piso: 250_000, dataPiso: '2026-10-03' });
  });
  it('trajetória vazia → indeterminado fail-closed, nunca viável com piso Infinity', () => {
    expect(avaliarEstado([], 50, [])).toEqual({ tipo: 'indeterminado', camadas: ['trajetoria_vazia'], piso: null });
  });
  it('semana agregada: saídas no 1º dia, entradas no último (limite inferior)', () => {
    expect(fluxosDeSemanaAgregada('2026-10-19', '2026-10-25', 50, 30)).toEqual([
      { data: '2026-10-19', valor: -30, camada: 'base_titulos' },
      { data: '2026-10-25', valor: 50, camada: 'base_titulos' },
    ]);
  });
});

describe('conciliação pedido → NF → CP (spec §8 teste 3)', () => {
  it('normaliza zeros à esquerda', () => {
    expect(normalizarNf('000952221')).toBe(normalizarNf('952221'));
  });
  it('faturamento parcial: título 40k + resíduo 60k (nunca 140k nem 40k)', () => {
    const r = conciliarCompromissos(
      [{ pedidoId: 1, valorTotal: 100_000, dataPedido: '2026-10-01', nfs: ['123'] }],
      [{ nf: '000123', valor: 40_000 }], '2026-10-02', 3, 15,
    );
    expect(r.fluxos).toEqual([{ data: '2026-10-04', valor: -60_000, camada: 'compromisso_conciliado' }]);
    expect(r.naoConciliado).toBe(0);
  });
  it('muitos-para-muitos: 2 pedidos numa NF', () => {
    const r = conciliarCompromissos(
      [
        { pedidoId: 1, valorTotal: 30_000, dataPedido: '2026-10-01', nfs: ['9'] },
        { pedidoId: 2, valorTotal: 20_000, dataPedido: '2026-10-02', nfs: ['9'] },
      ],
      [{ nf: '9', valor: 45_000 }], '2026-10-01', 3, 15,
    );
    expect(r.fluxos.reduce((s, x) => s + x.valor, 0)).toBe(-5_000);
  });
  it('pedido sem NF entra inteiro e marcado não conciliado; data nunca antes do início', () => {
    const r = conciliarCompromissos([{ pedidoId: 3, valorTotal: 8_000, dataPedido: '2026-09-01', nfs: [] }], [], '2026-10-01', 3, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -8_000, camada: 'compromisso_nao_conciliado' }]);
    expect(r.naoConciliado).toBe(8_000);
  });
  it('NF vazia/zero não é coringa: pedidos sem NF válida ficam não conciliados', () => {
    const r = conciliarCompromissos(
      [
        // R28: pedidos com 30 dias (≥ 15) — sem NF válida e velhos o bastante para já terem faturado
        { pedidoId: 1, valorTotal: 30_000, dataPedido: '2026-09-01', nfs: ['0'] },
        { pedidoId: 2, valorTotal: 20_000, dataPedido: '2026-09-01', nfs: [''] },
      ],
      [{ nf: '', valor: 45_000 }], '2026-10-01', 0, 15,
    );
    expect(r.fluxos.reduce((s, x) => s + x.valor, 0)).toBe(-50_000);
    expect(r.fluxos.length).toBe(2);
    expect(r.naoConciliado).toBe(50_000);
  });
  it('NF informada sem título casado, pedido com 30 dias → não conciliado', () => {
    // R30: só a NF sem título com ≥ 15 dias é não conciliada (antes: dataPedido 10-01, idade 0)
    const r = conciliarCompromissos([{ pedidoId: 5, valorTotal: 10_000, dataPedido: '2026-09-01', nfs: ['77'] }], [], '2026-10-01', 3, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -10_000, camada: 'compromisso_nao_conciliado' }]);
    expect(r.naoConciliado).toBe(10_000);
  });
  it('união transitiva A-B-C por NFs compartilhadas vira um só componente', () => {
    const r = conciliarCompromissos(
      [
        { pedidoId: 1, valorTotal: 10_000, dataPedido: '2026-10-01', nfs: ['1'] },
        { pedidoId: 2, valorTotal: 10_000, dataPedido: '2026-10-01', nfs: ['1', '2'] },
        { pedidoId: 3, valorTotal: 10_000, dataPedido: '2026-10-01', nfs: ['2'] },
      ],
      [{ nf: '1', valor: 5_000 }, { nf: '2', valor: 5_000 }], '2026-10-01', 0, 15,
    );
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -20_000, camada: 'compromisso_conciliado' }]);
  });
  it('R28: pedido sem NF com 3 dias está a faturar — entra inteiro, mas não conta como não conciliado', () => {
    const r = conciliarCompromissos([{ pedidoId: 6, valorTotal: 8_000, dataPedido: '2026-09-28', nfs: [] }], [], '2026-10-01', 3, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -8_000, camada: 'compromisso_a_faturar' }]);
    expect(r.naoConciliado).toBe(0);
  });
  it('R28: pedido sem NF com 20 dias → não conciliado', () => {
    const r = conciliarCompromissos([{ pedidoId: 7, valorTotal: 8_000, dataPedido: '2026-09-11', nfs: [] }], [], '2026-10-01', 3, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -8_000, camada: 'compromisso_nao_conciliado' }]);
    expect(r.naoConciliado).toBe(8_000);
  });
  it('R28: fronteira — 14 dias a faturar, 15 dias não conciliado', () => {
    const idade = (dataPedido: string) =>
      conciliarCompromissos([{ pedidoId: 8, valorTotal: 1, dataPedido, nfs: [] }], [], '2026-10-01', 0, 15).fluxos[0].camada;
    expect(idade('2026-09-17')).toBe('compromisso_a_faturar');
    expect(idade('2026-09-16')).toBe('compromisso_nao_conciliado');
  });
  it('R30: NF 88 sem título com 5 dias está a faturar (nfs é a lista de hoje — look-ahead) — entra inteira, não conta', () => {
    const r = conciliarCompromissos([{ pedidoId: 9, valorTotal: 10_000, dataPedido: '2026-09-26', nfs: ['88'] }], [], '2026-10-01', 0, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -10_000, camada: 'compromisso_a_faturar' }]);
    expect(r.naoConciliado).toBe(0);
  });
  it('R30: NF 88 sem título com 20 dias → não conciliado', () => {
    const r = conciliarCompromissos([{ pedidoId: 9, valorTotal: 10_000, dataPedido: '2026-09-11', nfs: ['88'] }], [], '2026-10-01', 0, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -10_000, camada: 'compromisso_nao_conciliado' }]);
    expect(r.naoConciliado).toBe(10_000);
  });
  it('R30: NF com título parcial continua conciliado (resíduo), mesmo recente', () => {
    const r = conciliarCompromissos([{ pedidoId: 9, valorTotal: 10_000, dataPedido: '2026-09-30', nfs: ['88'] }], [{ nf: '88', valor: 4_000 }], '2026-10-01', 0, 15);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -6_000, camada: 'compromisso_conciliado' }]);
  });
  it('idadeLimiteDias inválida é rejeitada (fail-closed, mesmo sem pedidos)', () => {
    expect(() => conciliarCompromissos([], [], '2026-10-01', 0, Number.NaN)).toThrow('idadeLimiteDias inválida');
    expect(() => conciliarCompromissos([], [], '2026-10-01', 0, -1)).toThrow('idadeLimiteDias inválida');
  });
  it('título maior que o pedido não gera entrada', () => {
    const r = conciliarCompromissos([{ pedidoId: 4, valorTotal: 10, dataPedido: '2026-10-01', nfs: ['1'] }], [{ nf: '1', valor: 12 }], '2026-10-01', 0, 15);
    expect(r.fluxos).toEqual([]);
  });
});

describe('ritmo não-Sayerlack', () => {
  it('média mensal por dia do mês; projeção desconta o já titulado do mês', () => {
    const ritmo = ritmoPorDiaDoMes([{ data: '2026-08-05', valor: 600 }, { data: '2026-09-05', valor: 400 }], 2);
    expect(ritmo[5]).toBe(500);
    const fl = projetarRitmo('2026-10-01', 31, ritmo, { '2026-10': 200 });
    expect(fl).toEqual([{ data: '2026-10-05', valor: -300, camada: 'saida_nao_sayerlack' }]);
  });
  it('mês parcial: o desconto vale sobre o total da janela (dia 5 fora da janela)', () => {
    const ritmo = new Array(32).fill(0); ritmo[5] = 1000; ritmo[20] = 500;
    const fl = projetarRitmo('2026-10-15', 17, ritmo, { '2026-10': 100 });
    expect(fl.length).toBe(1);
    expect(fl[0].data).toBe('2026-10-20');
    expect(fl[0].camada).toBe('saida_nao_sayerlack');
    expect(fl[0].valor).toBeCloseTo(-400, 9);
  });
  it('ritmoPorDiaDoMes rejeita meses <= 0', () => {
    expect(() => ritmoPorDiaDoMes([], 0)).toThrow('meses deve ser > 0');
  });
  it('dia 31 em mês de 30 dias vai para o último dia', () => {
    const ritmo = new Array(32).fill(0); ritmo[31] = 100;
    expect(projetarRitmo('2026-11-01', 30, ritmo, {})).toEqual([{ data: '2026-11-30', valor: -100, camada: 'saida_nao_sayerlack' }]);
  });
});

describe('continuidade do motor', () => {
  it('início do laço em lag+1 (seg, lag 1 → primeira provisão qua 21)', () => {
    expect(provisaoContinuidade('2026-10-19', 4, 100, 1, 0)).toEqual([
      { data: '2026-10-21', valor: -100, camada: 'continuidade_motor' },
      { data: '2026-10-22', valor: -100, camada: 'continuidade_motor' },
    ]);
  });
  it('provisão em dia útil após o lag; a compra aceita consome a provisão mais cedo', () => {
    // início sex 2026-10-16, lag 2 → primeiro dia possível 2026-10-19 (seg)
    const fl = provisaoContinuidade('2026-10-16', 6, 100, 2, 150);
    expect(fl).toEqual([
      { data: '2026-10-20', valor: -50, camada: 'continuidade_motor' },
      { data: '2026-10-21', valor: -100, camada: 'continuidade_motor' },
    ]);
  });
});
