import { describe, it, expect } from 'vitest';
import { precoDeNascimento, type InsumosDoNascimento } from '../precoDeNascimento';

const HOJE = new Date('2026-11-26T12:00:00Z');
const vazio = (): InsumosDoNascimento => ({
  precos: { oben: {}, colacor: {} }, datas: { oben: {}, colacor: {} }, tierPorConta: null, multConfig: null,
});
const produto = { account: 'oben', omie_codigo_produto: 555, valor_unitario: 100 };

describe('precoDeNascimento — a mesma regra do Novo Pedido para a edição', () => {
  it('último praticado ≤180d vence a tabela', () => {
    const ins = vazio();
    ins.precos.oben[555] = 87.5;
    ins.datas.oben[555] = '2026-10-01';
    expect(precoDeNascimento(produto, ins, HOJE)).toBe(87.5);
  });

  it('praticado >180d cai para tabela × mult do tier', () => {
    const ins = vazio();
    ins.precos.oben[555] = 87.5;
    ins.datas.oben[555] = '2026-01-01';
    ins.tierPorConta = { oben: 'C', colacor: null };
    ins.multConfig = { oben: { C: 1.1 }, colacor: {} };
    expect(precoDeNascimento(produto, ins, HOJE)).toBeCloseTo(110, 10);
  });

  it('a conta do produto decide o mapa: praticado da Colacor não vaza no código igual da Oben', () => {
    const ins = vazio();
    ins.precos.colacor[555] = 50;
    expect(precoDeNascimento(produto, ins, HOJE)).toBe(100);
    expect(precoDeNascimento({ ...produto, account: 'colacor' }, ins, HOJE)).toBe(50);
  });

  it('sem praticado e sem tabela: null (preço não sabido), nunca 0', () => {
    expect(precoDeNascimento({ ...produto, valor_unitario: null }, vazio(), HOJE)).toBeNull();
    expect(precoDeNascimento({ ...produto, valor_unitario: 0 }, vazio(), HOJE)).toBeNull();
  });

  it('sem tabela mas com praticado: usa o praticado', () => {
    const ins = vazio();
    ins.precos.oben[555] = 42;
    expect(precoDeNascimento({ ...produto, valor_unitario: null }, ins, HOJE)).toBe(42);
  });
});
