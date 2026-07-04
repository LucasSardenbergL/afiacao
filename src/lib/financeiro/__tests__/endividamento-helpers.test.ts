import { describe, it, expect } from 'vitest';
import {
  servicoDivida,
  dscrCaixa,
  saldoDevedorEmAberto,
  pctCurtoPrazo,
  dscrEbitda,
  dividaLiquidaEbitda,
} from '../endividamento-helpers';
import type { Divida, Parcela } from '../endividamento-types';

const divida = (over: Partial<Divida>): Divida => ({
  id: 'd1',
  company: 'oben',
  credor: 'Banco X',
  tipo: 'financiamento',
  principal_contratado: 100000,
  saldo_devedor_informado: null,
  saldo_devedor_data_base: null,
  cp_inclusion_status: 'nao',
  cp_inclusion_ate: null,
  data_contratacao: '2025-01-01',
  cet_aa: null,
  indexador: null,
  coobrigada_por: null,
  garantias: null,
  observacao: null,
  ativo: true,
  ...over,
});
const parc = (over: Partial<Parcela>): Parcela => ({
  id: 'p1',
  divida_id: 'd1',
  numero_parcela: 1,
  data_vencimento: '2026-08-01',
  valor_amortizacao: 900,
  valor_juros: 100,
  valor_total: 1000,
  estimado: false,
  pago: false,
  ...over,
});

describe('servicoDivida', () => {
  const hoje = '2026-07-04';
  const fim = '2026-10-03'; // ~13 semanas

  it('separa vencido (antes de hoje) de a-vencer (dentro do horizonte)', () => {
    const d = [divida({ id: 'd1' })];
    const ps = [
      parc({ id: 'a', data_vencimento: '2026-06-01', valor_total: 500 }), // vencido
      parc({ id: 'b', data_vencimento: '2026-08-01', valor_total: 1000 }), // a vencer
      parc({ id: 'c', data_vencimento: '2027-01-01', valor_total: 9999 }), // fora do horizonte
    ];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 500, aVencer: 1000, total: 1500 });
  });

  it('ignora parcela paga', () => {
    const d = [divida({ id: 'd1' })];
    const ps = [parc({ data_vencimento: '2026-08-01', valor_total: 1000, pago: true })];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 0, aVencer: 0, total: 0 });
  });

  it('exclui antecipacao_recorrente do serviço', () => {
    const d = [divida({ id: 'd1', tipo: 'antecipacao_recorrente' })];
    const ps = [parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 })];
    expect(servicoDivida(d, ps, hoje, fim)).toEqual({ vencido: 0, aVencer: 0, total: 0 });
  });
});

describe('dscrCaixa', () => {
  const hoje = '2026-07-04';
  const fim = '2026-10-03';
  const base = (over: Partial<Divida>) => divida({ id: 'd1', cp_inclusion_status: 'sim', ...over });
  const parcela = parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 });

  it('não publica sem gate de completude (inconclusivo)', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({})], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: false });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('não publica quando alguma dívida ativa é nao_sei', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'nao_sei' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('add-back: dívida no CP soma o serviço de volta ao numerador', () => {
    // geração A1 = 5000 (já deduziu a parcela de 1000 do CP); add-back devolve → num 6000; den 1000 → DSCR 6
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'sim' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r.motivo).toBe('ok');
    expect(r.valor).toBeCloseTo(6, 9);
  });

  it('dívida fora do CP (nao): sem add-back → num 5000; den 1000 → DSCR 5', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'nao' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r.valor).toBeCloseTo(5, 9);
  });

  it('sem dívida no horizonte (parcelas todas fora) → null/sem_divida', () => {
    const foraDoHorizonte = parc({ divida_id: 'd1', data_vencimento: '2027-06-01', valor_total: 1000 });
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({})], parcelas: [foraDoHorizonte], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'sem_divida' });
  });

  it('geração ausente → null/sem_geracao, nunca 0', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: null, dividas: [base({})], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'sem_geracao' });
  });

  it('P1-1 Codex: cp_inclusion_status=parcial bloqueia (add-back seria arbitrário)', () => {
    const r = dscrCaixa({ geracaoOperacionalA1: 5000, dividas: [base({ cp_inclusion_status: 'parcial' })], parcelas: [parcela], hojeISO: hoje, fimISO: fim, completo: true });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('P1-2 Codex: dívida ativa relevante sem parcelas → inconclusivo (não sem_divida)', () => {
    // d1 tem parcela; d2 (ativa, financiamento) não tem nenhuma → agenda incompleta
    const r = dscrCaixa({
      geracaoOperacionalA1: 5000,
      dividas: [base({ id: 'd1' }), base({ id: 'd2' })],
      parcelas: [parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 })],
      hojeISO: hoje, fimISO: fim, completo: true,
    });
    expect(r).toEqual({ valor: null, motivo: 'inconclusivo' });
  });

  it('antecipacao_recorrente sem parcelas NÃO bloqueia (não entra no serviço)', () => {
    const r = dscrCaixa({
      geracaoOperacionalA1: 5000,
      dividas: [base({ id: 'd1' }), base({ id: 'd2', tipo: 'antecipacao_recorrente' })],
      parcelas: [parc({ divida_id: 'd1', data_vencimento: '2026-08-01', valor_total: 1000 })],
      hojeISO: hoje, fimISO: fim, completo: true,
    });
    expect(r.motivo).toBe('ok');
  });
});

describe('saldoDevedorEmAberto', () => {
  it('usa saldo_devedor_informado quando presente', () => {
    const d = divida({ id: 'd1', saldo_devedor_informado: 42000 });
    expect(saldoDevedorEmAberto(d, [])).toBe(42000);
  });
  it('deriva da amortização não paga quando ausente', () => {
    const d = divida({ id: 'd1', saldo_devedor_informado: null });
    const ps = [
      parc({ divida_id: 'd1', valor_amortizacao: 900, pago: false }),
      parc({ id: 'p2', divida_id: 'd1', valor_amortizacao: 900, pago: true }), // paga não conta
    ];
    expect(saldoDevedorEmAberto(d, ps)).toBe(900);
  });
});

describe('pctCurtoPrazo', () => {
  const ate12m = '2027-07-04';
  it('amortização até 12m (inclui vencido) ÷ saldo em aberto', () => {
    const d = [divida({ id: 'd1', saldo_devedor_informado: 10000 })];
    const ps = [
      parc({ id: 'a', divida_id: 'd1', data_vencimento: '2026-05-01', valor_amortizacao: 1000 }), // vencido
      parc({ id: 'b', divida_id: 'd1', data_vencimento: '2027-01-01', valor_amortizacao: 2000 }), // <=12m
      parc({ id: 'c', divida_id: 'd1', data_vencimento: '2028-01-01', valor_amortizacao: 5000 }), // >12m
    ];
    expect(pctCurtoPrazo(d, ps, ate12m)).toBeCloseTo(0.3, 9); // (1000+2000)/10000
  });
  it('saldo total 0 → null (não divide por zero)', () => {
    expect(pctCurtoPrazo([divida({ saldo_devedor_informado: 0 })], [], ate12m)).toBeNull();
  });
});

describe('indicadores EBITDA (degradam sem D&A)', () => {
  it('dscrEbitda: EBITDA null → null/falta_ebitda (nunca 0)', () => {
    expect(dscrEbitda(null, 12000)).toEqual({ valor: null, motivo: 'falta_ebitda' });
  });
  it('dscrEbitda: caso feliz', () => {
    expect(dscrEbitda(120000, 60000).valor).toBeCloseTo(2, 9);
  });
  it('dividaLiquidaEbitda: EBITDA 0 → null (não fabrica ∞)', () => {
    expect(dividaLiquidaEbitda(500000, 100000, 0)).toEqual({ valor: null, motivo: 'falta_ebitda' });
  });
  it('dividaLiquidaEbitda: (bruta − caixa)/ebitda', () => {
    expect(dividaLiquidaEbitda(500000, 100000, 200000).valor).toBeCloseTo(2, 9);
  });
});
