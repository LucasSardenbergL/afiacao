import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from './datas';
import { dataPagamentoPrevista, quebrarEmEmbalagens, passoDaLinha, type LinhaMotor } from './embalagens';

const base: LinhaMotor = {
  pedidoId: 10, pedidoRaizId: 10, sku: '123', qtdeFinal: 12, fatorEmbalagem: 0.25,
  precoUnitario: 10, precoVendaMedio: 15, estoqueEfetivo: 0, pontoPedido: 5, precoCheioPromocao: null,
};

describe('datas', () => {
  it('soma e diferença de dias em UTC sem fuso', () => {
    expect(addDias('2026-10-30', 3)).toBe('2026-11-02');
    expect(diffDias('2026-10-30', '2026-11-02')).toBe(3);
  });
  it('dia útil = seg..sex', () => {
    expect(ehDiaUtil('2026-10-16')).toBe(true); // sexta
    expect(ehDiaUtil('2026-10-17')).toBe(false); // sábado
  });
});

describe('quebrarEmEmbalagens', () => {
  it('passo = 1/fator do portal (fator 0,25 → 4 unidades por embalagem)', () => {
    expect(passoDaLinha(base)).toBe(4);
    const e = quebrarEmEmbalagens(base, { fretePerc: 0.025, dataPagamento: '2026-10-20' });
    expect(e.map((x) => x.k)).toEqual([1, 2, 3]);
    expect(e.every((x) => x.qtde === 4)).toBe(true);
    expect(e[0].desembolso).toBeCloseTo(4 * 10 * 1.025, 9);
  });
  it('sem fator → passo 1', () => {
    expect(passoDaLinha({ ...base, fatorEmbalagem: null })).toBe(1);
  });
  it('qtde não-múltiplo (ajuste humano): última embalagem leva o resto e a soma fecha', () => {
    const e = quebrarEmEmbalagens({ ...base, qtdeFinal: 10 }, { fretePerc: 0, dataPagamento: '2026-10-20' });
    expect(e.map((x) => x.qtde)).toEqual([4, 4, 2]);
    expect(e.reduce((s, x) => s + x.qtde, 0)).toBe(10);
  });
  it('preço ausente → desembolso null (nunca 0)', () => {
    const e = quebrarEmEmbalagens({ ...base, precoUnitario: null }, { fretePerc: 0.025, dataPagamento: '2026-10-20' });
    expect(e[0].desembolso).toBeNull();
  });
  it('qtde 0 → nenhuma embalagem', () => {
    expect(quebrarEmEmbalagens({ ...base, qtdeFinal: 0 }, { fretePerc: 0, dataPagamento: '2026-10-20' })).toEqual([]);
  });
});

describe('dataPagamentoPrevista', () => {
  it('pedido + p10 faturamento + p10 vencimento; não depende da chegada', () => {
    expect(dataPagamentoPrevista('2026-10-01', { faturamentoP10: 2, vencimentoP10: 1 })).toBe('2026-10-04');
  });
});
