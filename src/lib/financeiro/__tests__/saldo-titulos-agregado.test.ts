import { describe, it, expect } from 'vitest';
import { comporSaldoTitulos, decimalParaCentavos, centavosParaReais } from '../saldo-titulos-agregado';
import { OPEN_TITLE_STATUSES } from '../titulo-status';

const ABERTOS = OPEN_TITLE_STATUSES;
const VENCIDOS = ['ATRASADO'] as const;

const g = (tabela: string, company: string, status_titulo: string, saldo: string | null, n_titulos = 1, n_saldo_nulo = 0) =>
  ({ tabela, company, status_titulo, n_titulos, n_saldo_nulo, saldo });
const env = (empresas: Array<[string, string]>, grupos: unknown[]) =>
  ({ versao: 1, empresas: empresas.map(([company, estado]) => ({ company, estado })), grupos });

describe('decimalParaCentavos / centavosParaReais', () => {
  it('converte sem arredondar e recusa o que não é decimal de até 2 casas', () => {
    expect(decimalParaCentavos('351.71')).toBe(35171n);
    expect(decimalParaCentavos('0.3')).toBe(30n);
    expect(decimalParaCentavos('-10.00')).toBe(-1000n);
    expect(decimalParaCentavos('12')).toBe(1200n);
    for (const ruim of ['1.234', '1e3', '', ' 1.00', 'NaN', '1,00']) {
      expect(() => decimalParaCentavos(ruim)).toThrow('saldo fora do formato decimal');
    }
  });
  it('só devolve number quando a conversão é exata', () => {
    expect(centavosParaReais(35171n)).toBe(351.71);
    expect(() => centavosParaReais(2n ** 53n)).toThrow('soma fora da faixa exata de number');
    // isSafeInteger aceita, mas /100 colapsaria ",90" em ",91": recusa em vez de exibir centavo errado.
    expect(() => centavosParaReais(9007199254740990n)).toThrow('soma fora da faixa exata de number');
    expect(centavosParaReais(-4005n)).toBe(-40.05);
    expect(centavosParaReais(1000000000003426n)).toBe(10000000000034.26);
  });
});

describe('comporSaldoTitulos', () => {
  const ok3: Array<[string, string]> = [['colacor', 'ok'], ['colacor_sc', 'ok'], ['oben', 'ok']];

  it('soma aberto e vencido por empresa e tabela, em centavos (mesmos números da prova PG17)', () => {
    const r = comporSaldoTitulos(env(ok3, [
      g('receber', 'oben', 'A VENCER', '300.60', 3), g('receber', 'oben', 'ATRASADO', '40.05', 2),
      g('receber', 'oben', 'VENCE HOJE', '4.40'), g('receber', 'oben', 'ABERTO', '1.11'),
      g('receber', 'oben', 'VENCIDO', '2.22'), g('receber', 'oben', 'PARCIAL', '3.33'),
      g('pagar', 'oben', 'A VENCER', '1000.00'), g('pagar', 'oben', 'ATRASADO', '250.50'),
      g('pagar', 'colacor_sc', 'A VENCER', '12.34'),
    ]), ['oben', 'colacor', 'colacor_sc'], ABERTOS, VENCIDOS);
    expect(r.oben).toEqual({ total_a_receber: 351.71, total_a_pagar: 1250.5, total_vencido_receber: 40.05, total_vencido_pagar: 250.5 });
    // empresa ok sem grupo = zero LEGÍTIMO (nenhum título nesses status)
    expect(r.colacor).toEqual({ total_a_receber: 0, total_a_pagar: 0, total_vencido_receber: 0, total_vencido_pagar: 0 });
    expect(r.colacor_sc.total_a_pagar).toBe(12.34);
  });

  it('é exata onde a soma em float erra (0.1 + 0.2)', () => {
    const r = comporSaldoTitulos(env([['oben', 'ok']], [
      g('receber', 'oben', 'A VENCER', '0.10'), g('receber', 'oben', 'ATRASADO', '0.20'),
    ]), ['oben'], ABERTOS, VENCIDOS);
    expect(r.oben.total_a_receber).toBe(0.3);
  });

  it('ignora grupo de status fora do conjunto pedido', () => {
    const r = comporSaldoTitulos(env([['oben', 'ok']], [
      g('receber', 'oben', 'RECEBIDO', '5000.00'), g('receber', 'oben', 'A VENCER', '1.00'),
    ]), ['oben'], ABERTOS, VENCIDOS);
    expect(r.oben.total_a_receber).toBe(1);
  });

  it.each([
    ['sem_acesso', 'saldo de títulos indisponível (colacor): sem_acesso'],
    ['desconhecida', 'saldo de títulos indisponível (colacor): desconhecida'],
  ])('empresa %s LANÇA — nunca R$ 0', (estado, msg) => {
    expect(() => comporSaldoTitulos(env([['oben', 'ok'], ['colacor', estado]], []), ['oben', 'colacor'], ABERTOS, VENCIDOS))
      .toThrow(msg);
  });

  it('empresa pedida ausente da resposta LANÇA', () => {
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], []), ['oben', 'colacor'], ABERTOS, VENCIDOS))
      .toThrow('saldo de títulos indisponível (colacor): ausente da resposta');
  });

  it('saldo NULL no conjunto LANÇA (nunca vira 0); fora do conjunto não atrapalha', () => {
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], [g('receber', 'oben', 'ATRASADO', '30.00', 2, 1)]), ['oben'], ABERTOS, VENCIDOS))
      .toThrow('1 título(s) de receber sem saldo em ATRASADO');
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], [g('pagar', 'oben', 'VENCE HOJE', null, 1, 1)]), ['oben'], ABERTOS, VENCIDOS))
      .toThrow('1 título(s) de pagar sem saldo em VENCE HOJE');
    const r = comporSaldoTitulos(env([['oben', 'ok']], [g('receber', 'oben', 'RECEBIDO', null, 1, 1)]), ['oben'], ABERTOS, VENCIDOS);
    expect(r.oben.total_a_receber).toBe(0);
  });

  it.each([
    ['array na raiz (404 [] normalizado)', []],
    ['null', null],
    ['versão desconhecida', { versao: 2, empresas: [], grupos: [] }],
    ['sem grupos', { versao: 1, empresas: [] }],
  ])('recusa resposta fora do envelope: %s', (_rot, resposta) => {
    expect(() => comporSaldoTitulos(resposta, ['oben'], ABERTOS, VENCIDOS)).toThrow('resposta da RPC fora do envelope versão 1');
  });

  it('recusa saldo numérico (perderia centavo) e null com título de saldo conhecido', () => {
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], [{ ...g('receber', 'oben', 'A VENCER', null), saldo: 1.5 }]), ['oben'], ABERTOS, VENCIDOS))
      .toThrow('grupo 0: saldo não é string decimal');
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], [g('receber', 'oben', 'A VENCER', null, 2, 1)]), ['oben'], ABERTOS, VENCIDOS))
      .toThrow('grupo 0: saldo null com título de saldo conhecido');
  });

  it('recusa conjunto vencido fora do conjunto pedido', () => {
    expect(() => comporSaldoTitulos(env([['oben', 'ok']], []), ['oben'], ['A VENCER'], VENCIDOS))
      .toThrow('status vencido "ATRASADO" fora do conjunto pedido à RPC');
  });
});
