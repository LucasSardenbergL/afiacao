import { describe, expect, it } from 'vitest';
import {
  celulaMaturacao, montarLinhasMaturacao, normalizarCoorteMaturacao, pisoPct, type CoorteMaturacao,
} from '@/lib/financeiro/coorte-maturacao-helpers';

const linhaMadura = {
  company: 'oben', mes_vencimento: '2026-07-01', titulos: 9, valor_vencido_no_mes: 1800,
  valor_antecipado: 100, valor_pago_no_dia: 80, valor_pago_com_atraso: 1400, valor_pago_sem_data: 120, valor_em_aberto: 60,
  dias_antecipacao_pond: 5, dias_atraso_pond: 43.57,
  maduro_d15: true, maduro_d30: true, maduro_d60: true, pct_pago_d15: 0.2111, pct_pago_d30: 0.3778, pct_pago_d60: 0.6,
  mes_parcial: false,
};

describe('normalizarCoorteMaturacao', () => {
  it('lê a coorte madura com as massas separadas e os três pct', () => {
    const c = normalizarCoorteMaturacao(linhaMadura);
    expect(c).not.toBeNull();
    expect(c!.pct).toEqual({ 15: 0.2111, 30: 0.3778, 60: 0.6 });
    expect(c!.maduro).toEqual({ 15: true, 30: true, 60: true });
    expect(c!.valorAntecipado + c!.valorPagoNoDia + c!.valorPagoComAtraso + c!.valorPagoSemData).toBe(1700);
    expect(c!.diasAtrasoPond).toBe(43.57);
    expect(c!.mesParcial).toBe(false);
  });

  it('coorte imatura: pct nulo mesmo que o banco mande número (defesa em profundidade)', () => {
    const c = normalizarCoorteMaturacao({ ...linhaMadura, maduro_d30: false, maduro_d60: false, pct_pago_d30: 0.5, pct_pago_d60: null });
    expect(c!.pct).toEqual({ 15: 0.2111, 30: null, 60: null });
    expect(c!.maduro).toEqual({ 15: true, 30: false, 60: false });
  });

  it('flag ausente/ilegível = imatura (nunca madura por default); mes_parcial só quando true', () => {
    const c = normalizarCoorteMaturacao({ ...linhaMadura, maduro_d15: 'true', maduro_d30: null, maduro_d60: undefined, mes_parcial: 'sim' });
    expect(c!.maduro).toEqual({ 15: false, 30: false, 60: false });
    expect(c!.pct).toEqual({ 15: null, 30: null, 60: null });
    expect(c!.mesParcial).toBe(false);
    expect(normalizarCoorteMaturacao({ ...linhaMadura, mes_parcial: true })!.mesParcial).toBe(true);
  });

  it('pct fora de 0–1 ou ilegível vira null (não número fabricado)', () => {
    expect(normalizarCoorteMaturacao({ ...linhaMadura, pct_pago_d15: 1.2 })!.pct[15]).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, pct_pago_d60: 'NaN' })!.pct[60]).toBeNull();
  });

  it('linha sem chave, sem denominador, com massa ilegível ou negativa é descartada', () => {
    expect(normalizarCoorteMaturacao({ ...linhaMadura, company: null })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, mes_vencimento: '2026-7' })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_vencido_no_mes: 0 })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_em_aberto: null })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_pago_sem_data: 'x' })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_em_aberto: -5 })).toBeNull();
  });

  it('dias ponderados ausentes (massa vazia) ou negativos ficam null', () => {
    expect(normalizarCoorteMaturacao({ ...linhaMadura, dias_antecipacao_pond: null })!.diasAntecipacaoPond).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, dias_atraso_pond: -7 })!.diasAtrasoPond).toBeNull();
  });
});

describe('pisoPct', () => {
  it('nunca arredonda para cima: 0,99996 é 99,9 %, só 1 vira 100,0 %', () => {
    expect(pisoPct(0.99996)).toBe(99.9);
    expect(pisoPct(1)).toBe(100);
    expect(pisoPct(0.3778)).toBe(37.7);
    expect(pisoPct(0.6)).toBe(60);
    expect(pisoPct(0.29)).toBe(29);
    expect(pisoPct(0)).toBe(0);
  });
});

describe('montarLinhasMaturacao', () => {
  const madura = normalizarCoorteMaturacao(linhaMadura) as CoorteMaturacao;
  const jovem = normalizarCoorteMaturacao({
    ...linhaMadura, mes_vencimento: '2026-10-01', titulos: 1, valor_vencido_no_mes: 100, valor_antecipado: 0, valor_pago_no_dia: 100,
    valor_pago_com_atraso: 0, valor_pago_sem_data: 0, valor_em_aberto: 0, dias_antecipacao_pond: null, dias_atraso_pond: null,
    maduro_d15: false, maduro_d30: false, maduro_d60: false, pct_pago_d15: null, pct_pago_d30: null, pct_pago_d60: null,
    mes_parcial: true,
  }) as CoorteMaturacao;
  const outra = normalizarCoorteMaturacao({ ...linhaMadura, company: 'colacor' }) as CoorteMaturacao;

  it('filtra a empresa, ordena do mês mais recente ao mais antigo e converte para % por piso', () => {
    const linhas = montarLinhasMaturacao([madura, outra, jovem], 'oben');
    expect(linhas.map((l) => l.rotulo)).toEqual(['2026-10', '2026-07']);
    expect(linhas[1].pct).toEqual({ 15: 21.1, 30: 37.7, 60: 60 });
    expect(linhas[1].pctAntecipado).toBe(5.5);
    expect(linhas[1].pctEmAberto).toBe(3.3);
    expect(linhas[1].pctSemData).toBe(6.6);
    expect(linhas[1].temSemData).toBe(true);
    expect(linhas[1].parcial).toBe(false);
    expect(linhas[0].pct).toEqual({ 15: null, 30: null, 60: null });
    expect(linhas[0].maduro).toEqual({ 15: false, 30: false, 60: false });
    expect(linhas[0].temSemData).toBe(false);
    expect(linhas[0].parcial).toBe(true);
  });

  it('sem-data é marcado pelo valor BRUTO: R$ 40 em R$ 1 milhão exibe 0,0 % mas o piso continua marcado', () => {
    const quase = normalizarCoorteMaturacao({
      ...linhaMadura, valor_vencido_no_mes: 1_000_000, valor_pago_com_atraso: 999_960, valor_pago_sem_data: 40, valor_em_aberto: 0,
      valor_antecipado: 0, valor_pago_no_dia: 0, pct_pago_d15: 0.99996, pct_pago_d30: 0.99996, pct_pago_d60: 0.99996,
    }) as CoorteMaturacao;
    const [l] = montarLinhasMaturacao([quase], 'oben');
    expect(l.pctSemData).toBe(0);
    expect(l.temSemData).toBe(true);
    expect(l.pct[60]).toBe(99.9);
  });

  it('empresa sem coorte = lista vazia', () => {
    expect(montarLinhasMaturacao([madura], 'colacor_sc')).toEqual([]);
  });
});

describe('celulaMaturacao', () => {
  it('imatura mostra travessão, madura mostra % com 1 decimal', () => {
    expect(celulaMaturacao(null)).toBe('—');
    expect(celulaMaturacao(60)).toBe('60.0%');
  });
});
