import { describe, it, expect } from 'vitest';
import {
  agruparEnviosPorDia,
  gerarDiasDaGrade,
  valorDoEnvio,
  dataLocalISO,
  type EnvioCalendario,
  type ItemEnvioCalendario,
} from './calendario';

const item = (over: Partial<ItemEnvioCalendario> = {}): ItemEnvioCalendario => ({
  quantidade: 2,
  preco_final: 10,
  account: 'oben',
  ...over,
});

const envio = (over: Partial<EnvioCalendario> = {}): EnvioCalendario => ({
  id: 'e1',
  pedido_programado_id: 'p1',
  numero_pedido_compra: '213294',
  data_envio: '2026-07-16',
  status: 'agendado',
  erro_motivo: null,
  itens: [item()],
  ...over,
});

describe('valorDoEnvio', () => {
  it('soma preco_final × quantidade', () => {
    expect(valorDoEnvio([item(), item({ quantidade: 3, preco_final: 5 })])).toBe(35);
  });
  it('envio sem itens → null (estado anômalo, não fabricar 0)', () => {
    expect(valorDoEnvio([])).toBeNull();
  });
  it('qualquer item sem preço → null (ausente ≠ zero)', () => {
    expect(valorDoEnvio([item(), item({ preco_final: null })])).toBeNull();
  });
  it('preço/quantidade inválidos (0, negativo, NaN) → null', () => {
    expect(valorDoEnvio([item({ preco_final: 0 })])).toBeNull();
    expect(valorDoEnvio([item({ quantidade: -1 })])).toBeNull();
    expect(valorDoEnvio([item({ preco_final: Number.NaN })])).toBeNull();
  });
});

describe('agruparEnviosPorDia', () => {
  it('agrupa por data_envio (string, sem Date)', () => {
    const mapa = agruparEnviosPorDia([
      envio({ id: 'a' }),
      envio({ id: 'b', itens: [item({ preco_final: 100, quantidade: 1 })] }),
      envio({ id: 'c', data_envio: '2026-07-23' }),
    ]);
    expect(mapa.get('2026-07-16')?.ativos).toBe(2);
    expect(mapa.get('2026-07-16')?.totalValor).toBe(120);
    expect(mapa.get('2026-07-23')?.ativos).toBe(1);
    expect(mapa.size).toBe(2);
  });
  it('valor null de um envio ativo propaga para o dia (ausente ≠ zero)', () => {
    const mapa = agruparEnviosPorDia([envio(), envio({ id: 'b', itens: [item({ preco_final: null })] })]);
    expect(mapa.get('2026-07-16')?.totalValor).toBeNull();
    expect(mapa.get('2026-07-16')?.ativos).toBe(2);
  });
  it('cancelado: fora de ativos/soma/dots, mas presente na lista do painel', () => {
    const mapa = agruparEnviosPorDia([envio(), envio({ id: 'b', status: 'cancelado', itens: [item({ preco_final: 999 })] })]);
    const dia = mapa.get('2026-07-16')!;
    expect(dia.ativos).toBe(1);
    expect(dia.totalValor).toBe(20);
    expect(dia.statusPresentes).toEqual(['agendado']);
    expect(dia.envios).toHaveLength(2);
  });
  it('dia com APENAS cancelados: ativos 0 e totalValor null (célula trata como vazio)', () => {
    const dia = agruparEnviosPorDia([envio({ status: 'cancelado' })]).get('2026-07-16')!;
    expect(dia.ativos).toBe(0);
    expect(dia.totalValor).toBeNull();
    expect(dia.statusPresentes).toEqual([]);
  });
  it('temErro quando há envio erro; dots em ordem fixa agendado→enviado→erro', () => {
    const dia = agruparEnviosPorDia([
      envio({ id: 'x', status: 'erro', erro_motivo: 'boom' }),
      envio({ id: 'y', status: 'enviado' }),
      envio({ id: 'z', status: 'agendado' }),
    ]).get('2026-07-16')!;
    expect(dia.temErro).toBe(true);
    expect(dia.statusPresentes).toEqual(['agendado', 'enviado', 'erro']);
  });
  it('empresas: set dos accounts dos itens; item sem mapa (account null) não quebra', () => {
    const dia = agruparEnviosPorDia([
      envio({ itens: [item(), item({ account: 'colacor' }), item({ account: null })] }),
    ]).get('2026-07-16')!;
    expect(dia.envios[0].empresas).toEqual(['oben', 'colacor']);
  });
  it('envio sem itens: semItens true e valor null', () => {
    const dia = agruparEnviosPorDia([envio({ itens: [] })]).get('2026-07-16')!;
    expect(dia.envios[0].semItens).toBe(true);
    expect(dia.envios[0].valor).toBeNull();
    expect(dia.totalValor).toBeNull();
  });
});

describe('gerarDiasDaGrade', () => {
  it('julho/2026 (1º cai na quarta): 42 células dom→sáb, começa 28/jun', () => {
    const dias = gerarDiasDaGrade('2026-07');
    expect(dias).toHaveLength(42);
    expect(dias[0]).toEqual({ data: '2026-06-28', diaDoMes: 28, foraDoMes: true });
    expect(dias[3]).toEqual({ data: '2026-07-01', diaDoMes: 1, foraDoMes: false });
    expect(dias[5].data).toBe('2026-07-03');
    expect(dias[41].data).toBe('2026-08-08');
  });
  it('fevereiro/2026 (1º é domingo): começa no próprio dia 1', () => {
    const dias = gerarDiasDaGrade('2026-02');
    expect(dias[0]).toEqual({ data: '2026-02-01', diaDoMes: 1, foraDoMes: false });
    expect(dias[27].data).toBe('2026-02-28');
    expect(dias[28]).toEqual({ data: '2026-03-01', diaDoMes: 1, foraDoMes: true });
  });
  it('janeiro/2026: vira o ano para trás sem shift de fuso', () => {
    expect(gerarDiasDaGrade('2026-01')[0].data).toBe('2025-12-28');
  });
});

describe('dataLocalISO', () => {
  it('formata Date local como YYYY-MM-DD com zero à esquerda', () => {
    expect(dataLocalISO(new Date(2026, 6, 3))).toBe('2026-07-03');
    expect(dataLocalISO(new Date(2026, 0, 9))).toBe('2026-01-09');
  });
});
