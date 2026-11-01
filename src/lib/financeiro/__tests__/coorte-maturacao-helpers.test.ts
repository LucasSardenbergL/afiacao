import { describe, expect, it } from 'vitest';
import {
  celulaMaturacao, montarLinhasMaturacao, normalizarCoorteMaturacao, type CoorteMaturacao,
} from '@/lib/financeiro/coorte-maturacao-helpers';

const linhaMadura = {
  company: 'oben', mes_vencimento: '2026-07-01', titulos: 9, valor_vencido_no_mes: 1800,
  valor_antecipado: 100, valor_pago_no_dia: 80, valor_pago_com_atraso: 1400, valor_pago_sem_data: 120, valor_em_aberto: 60,
  dias_antecipacao_pond: 5, dias_atraso_pond: 43.57,
  maduro_d15: true, maduro_d30: true, maduro_d60: true, pct_pago_d15: 0.2111, pct_pago_d30: 0.3778, pct_pago_d60: 0.6,
};

describe('normalizarCoorteMaturacao', () => {
  it('lê a coorte madura com as massas separadas e os três pct', () => {
    const c = normalizarCoorteMaturacao(linhaMadura);
    expect(c).not.toBeNull();
    expect(c!.pct).toEqual({ 15: 0.2111, 30: 0.3778, 60: 0.6 });
    expect(c!.maduro).toEqual({ 15: true, 30: true, 60: true });
    expect(c!.valorAntecipado + c!.valorPagoNoDia + c!.valorPagoComAtraso + c!.valorPagoSemData).toBe(1700);
    expect(c!.diasAtrasoPond).toBe(43.57);
  });

  it('coorte imatura: pct nulo mesmo que o banco mande número (defesa em profundidade)', () => {
    const c = normalizarCoorteMaturacao({ ...linhaMadura, maduro_d30: false, maduro_d60: false, pct_pago_d30: 0.5, pct_pago_d60: null });
    expect(c!.pct).toEqual({ 15: 0.2111, 30: null, 60: null });
    expect(c!.maduro).toEqual({ 15: true, 30: false, 60: false });
  });

  it('flag ausente/ilegível = imatura (nunca madura por default)', () => {
    const c = normalizarCoorteMaturacao({ ...linhaMadura, maduro_d15: 'true', maduro_d30: null, maduro_d60: undefined });
    expect(c!.maduro).toEqual({ 15: false, 30: false, 60: false });
    expect(c!.pct).toEqual({ 15: null, 30: null, 60: null });
  });

  it('pct fora de 0–1 ou ilegível vira null (não número fabricado)', () => {
    expect(normalizarCoorteMaturacao({ ...linhaMadura, pct_pago_d15: 1.2 })!.pct[15]).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, pct_pago_d60: 'NaN' })!.pct[60]).toBeNull();
  });

  it('linha sem chave, sem denominador ou com massa ilegível é descartada', () => {
    expect(normalizarCoorteMaturacao({ ...linhaMadura, company: null })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, mes_vencimento: '2026-7' })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_vencido_no_mes: 0 })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_em_aberto: null })).toBeNull();
    expect(normalizarCoorteMaturacao({ ...linhaMadura, valor_pago_sem_data: 'x' })).toBeNull();
  });

  it('dias ponderados ausentes (massa vazia) ficam null', () => {
    const c = normalizarCoorteMaturacao({ ...linhaMadura, dias_antecipacao_pond: null });
    expect(c!.diasAntecipacaoPond).toBeNull();
  });
});

describe('montarLinhasMaturacao', () => {
  const madura = normalizarCoorteMaturacao(linhaMadura) as CoorteMaturacao;
  const jovem = normalizarCoorteMaturacao({
    ...linhaMadura, mes_vencimento: '2026-10-01', titulos: 1, valor_vencido_no_mes: 100, valor_antecipado: 0, valor_pago_no_dia: 100,
    valor_pago_com_atraso: 0, valor_pago_sem_data: 0, valor_em_aberto: 0, dias_antecipacao_pond: null, dias_atraso_pond: null,
    maduro_d15: false, maduro_d30: false, maduro_d60: false, pct_pago_d15: null, pct_pago_d30: null, pct_pago_d60: null,
  }) as CoorteMaturacao;
  const outra = normalizarCoorteMaturacao({ ...linhaMadura, company: 'colacor' }) as CoorteMaturacao;

  it('filtra a empresa, ordena do mês mais recente ao mais antigo e converte para % com 1 decimal', () => {
    const linhas = montarLinhasMaturacao([madura, outra, jovem], 'oben');
    expect(linhas.map((l) => l.rotulo)).toEqual(['2026-10', '2026-07']);
    expect(linhas[1].pct).toEqual({ 15: 21.1, 30: 37.8, 60: 60 });
    expect(linhas[1].pctAntecipado).toBe(5.6);
    expect(linhas[1].pctEmAberto).toBe(3.3);
    expect(linhas[1].pctSemData).toBe(6.7);
    expect(linhas[0].pct).toEqual({ 15: null, 30: null, 60: null });
    expect(linhas[0].maduro).toEqual({ 15: false, 30: false, 60: false });
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
