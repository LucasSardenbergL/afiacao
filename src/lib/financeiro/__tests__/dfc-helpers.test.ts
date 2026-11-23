import { describe, it, expect } from 'vitest';
import { montarDFC, mesesFechados, type LinhaViewDFC } from '../dfc-helpers';

const L = (mes: string, fluxo_linha: string, atividade: string, entradas: number, saidas: number, company = 'oben'): LinhaViewDFC =>
  ({ company, mes, fluxo_linha, atividade, entradas, saidas, liquido: entradas - saidas, lancamentos: 1 });

const MESES = ['2026-09-01', '2026-10-01'];

describe('montarDFC', () => {
  const rows = [
    L('2026-09-01', 'op_recebimento_clientes', 'operacional', 1000, 0),
    L('2026-09-01', 'op_fornecedores', 'operacional', 0, 600),
    L('2026-10-01', 'op_recebimento_clientes', 'operacional', 500, 0),
    L('2026-09-01', 'inv_imobilizado', 'investimento', 0, 100),
    L('2026-09-01', 'fin_amortizacao', 'financiamento', 0, 200),
    L('2026-09-01', 'fin_juros', 'financiamento', 0, 30),
    L('2026-09-01', 'transferencia_interna', 'transferencia_interna', 50, 50),
    L('2026-09-01', 'pendente_identidade', 'pendente_identidade', 40, 0),
    L('2026-10-01', 'nao_classificado', 'nao_classificado', 0, 20),
    L('2026-08-01', 'op_recebimento_clientes', 'operacional', 9999, 0), // fora da janela
  ];
  const d = montarDFC(rows, MESES);

  it('soma por atividade e por mês na ordem do demonstrativo', () => {
    const op = d.blocos.find((b) => b.atividade === 'operacional')!;
    expect(op.linhas.map((l) => l.linha)).toEqual(['op_recebimento_clientes', 'op_fornecedores']);
    expect(op.porMes).toEqual({ '2026-09-01': 400, '2026-10-01': 500 });
    expect(op.total).toBe(900);
    expect(d.blocos.find((b) => b.atividade === 'financiamento')!.total).toBe(-230);
  });

  it('variação = Σ das três atividades; mês fora da janela não entra', () => {
    expect(d.variacao.porMes).toEqual({ '2026-09-01': 70, '2026-10-01': 500 });
    expect(d.variacao.total).toBe(570);
  });

  it('transferência, pendente de identidade e não classificado ficam FORA das atividades e visíveis, na ordem', () => {
    expect(d.fora.map((f) => f.linha)).toEqual(['transferencia_interna', 'pendente_identidade', 'nao_classificado']);
    const F = (l: string) => d.fora.find((f) => f.linha === l)!;
    expect(F('transferencia_interna')).toMatchObject({ total: 0, entradas: 50, saidas: 50 });
    expect(F('pendente_identidade')).toMatchObject({ total: 40, entradas: 40 });
    expect(F('nao_classificado')).toMatchObject({ total: -20, saidas: 20 });
    // se o não classificado entrasse na operacional, outubro daria 480
    expect(d.blocos.find((b) => b.atividade === 'operacional')!.porMes['2026-10-01']).toBe(500);
  });

  it('mês sem movimento fica AUSENTE (a tela mostra "—"), não vira 0', () => {
    const inv = d.blocos.find((b) => b.atividade === 'investimento')!;
    expect('2026-10-01' in inv.porMes).toBe(false);
  });

  it('linha desconhecida da view entra na atividade com o código cru (nunca some)', () => {
    const x = montarDFC([L('2026-09-01', 'op_linha_nova', 'operacional', 0, 7)], MESES);
    expect(x.blocos[0].linhas).toEqual([{ linha: 'op_linha_nova', rotulo: 'op_linha_nova', porMes: { '2026-09-01': -7 }, total: -7 }]);
  });

  it('fora desconhecido (atividade fora das três) cai em nao_classificado, nunca some', () => {
    const x = montarDFC([L('2026-09-01', 'balde_novo', 'balde_novo', 0, 3), L('2026-09-01', 'equivalente_caixa', 'equivalente_caixa', 25, 0), L('2026-09-01', 'pendente_revisao', 'pendente_revisao', 60, 0)], MESES);
    expect(x.fora.map((f) => `${f.linha}=${f.total}`)).toEqual(['equivalente_caixa=25', 'pendente_revisao=60', 'nao_classificado=-3']);
    // só movimento fora das atividades: a variação das atividades não foi observada (null), não é 0
    expect(x.variacao.total).toBeNull();
    expect(x.temDados).toBe(true);
  });

  it('sem NENHUMA observação: totais null e temDados=false — nunca R$ 0 fabricado (Codex)', () => {
    const x = montarDFC([], MESES);
    expect(x.temDados).toBe(false);
    expect(x.variacao.total).toBeNull();
    expect(x.blocos.map((b) => b.total)).toEqual([null, null, null]);
    expect(d.temDados).toBe(true);
    expect(d.blocos.find((b) => b.atividade === 'investimento')!.total).toBe(-100);
  });

  it('consolidado de empresas é soma de exibição (mesma linha de CNPJs diferentes)', () => {
    const x = montarDFC([L('2026-09-01', 'fin_aporte', 'financiamento', 70, 0, 'oben'), L('2026-09-01', 'fin_aporte', 'financiamento', 30, 0, 'colacor')], MESES);
    expect(x.blocos[2].linhas[0].total).toBe(100);
  });

  it('centavos não acumulam erro de ponto flutuante', () => {
    const x = montarDFC([L('2026-09-01', 'op_despesas', 'operacional', 0, 0.1), L('2026-09-01', 'op_despesas', 'operacional', 0, 0.2)], MESES);
    expect(x.blocos[0].total).toBe(-0.3);
  });
});

describe('mesesFechados', () => {
  it('12 meses fechados antes do mês corrente, virando o ano', () => {
    const m = mesesFechados('2026-11-23', 12);
    expect(m[0]).toBe('2025-11-01');
    expect(m[11]).toBe('2026-10-01');
    expect(m).toHaveLength(12);
  });
  it('janeiro olha o ano anterior', () => {
    expect(mesesFechados('2027-01-05', 2)).toEqual(['2026-11-01', '2026-12-01']);
  });
});
