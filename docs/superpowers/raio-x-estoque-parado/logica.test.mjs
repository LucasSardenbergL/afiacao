import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizar, cobertura, sugerirDestino, classificar, placar,
  listaTroca, vendaDirigidaPorCliente, diffContagem, parseValorBR, TOP_N,
} from './logica.mjs';

const HOJE = '2026-10-14';
const base = (o = {}) => ({
  sku: 1, codigo: 'X1', descricao: 'PRODUTO', familia: 'Cola Branca', ativo: true,
  cadastro_em: '2026-04-01', unidade_estoque: 'UN', unidades_venda: ['UN'],
  fornecedor: null, ult_entrada: null, saldo: 10, cmc: 5, motor: false, classe_abc: null,
  ult_venda: null, q12: 0, ncli: 0, preco_medio_12m: null, clientes: [], ...o,
});

test('categorizar: Imobilizado sempre é nao_mercadoria', () => {
  assert.equal(categorizar(base({ familia: 'Imobilizado', q12: 5 })).categoria, 'nao_mercadoria');
});
test('categorizar: CARTELA sem venda é nao_mercadoria; com venda é mercadoria', () => {
  assert.equal(categorizar(base({ descricao: 'CAIXA MOSTRUARIO' })).categoria, 'nao_mercadoria');
  assert.equal(categorizar(base({ descricao: 'CARTELA DE 720 CORES', q12: 3 })).categoria, 'mercadoria');
});
test('categorizar: ATL/ATP de Concentrados LC é insumo; resto da LC é mercadoria', () => {
  assert.equal(categorizar(base({ familia: 'Concentrados LC', descricao: 'ATL233-POLIESTER' })).categoria, 'insumo_maquina');
  assert.equal(categorizar(base({ familia: 'Concentrados LC', descricao: 'VERNIZ PU 5:1' })).categoria, 'mercadoria');
  assert.equal(categorizar(base({ familia: 'Concentrados MixMachine' })).categoria, 'insumo_maquina');
});
test('categorizar: granel 1000 KG', () => {
  assert.equal(categorizar(base({ descricao: 'COLA BRANCA PVA EXTRA 1000KG' })).categoria, 'granel');
  assert.equal(categorizar(base({ descricao: 'COLA AMARELA 1000 KG' })).categoria, 'granel');
});

test('cobertura: null sem venda; dias quando vende', () => {
  assert.equal(cobertura(base()), null);
  assert.equal(cobertura(base({ saldo: 365, q12: 365 })), 365);
});

test('sugerirDestino: ordem das regras', () => {
  assert.equal(sugerirDestino(base({ cadastro_em: '2026-09-01' }), HOJE).destino, 'novo_aguarde');
  assert.equal(sugerirDestino(base({ ult_entrada: '2026-10-02' }), HOJE).destino, 'novo_aguarde');
  assert.equal(sugerirDestino(base({ unidades_venda: ['UN', 'GL'] }), HOJE).destino, 'revisar');
  assert.equal(sugerirDestino(base({ fornecedor: 'RENNER SAYERLACK S/A' }), HOJE).destino, 'trocar');
  assert.equal(sugerirDestino(base({ fornecedor: 'marca: SAYERLACK' }), HOJE).destino, 'trocar');
  assert.equal(sugerirDestino(base({ q12: 1, saldo: 10 }), HOJE).destino, 'venda_dirigida'); // 3650 d
  assert.equal(sugerirDestino(base({ q12: 10, saldo: 7 }), HOJE).destino, 'manter_suspender_recompra'); // 255,5 d
  assert.equal(sugerirDestino(base({ fornecedor: 'ACRE CAXIAS' }), HOJE).destino, 'liquidar');
  assert.equal(sugerirDestino(base({ q12: 100, saldo: 10 }), HOJE).destino, 'revisar'); // fora do motor, 36,5 d
});

test('classificar: valor, top só em mercadoria e por valor', () => {
  const itens = [
    base({ sku: 1, saldo: 1, cmc: 100 }),
    base({ sku: 2, saldo: 1, cmc: 999, familia: 'Imobilizado' }),
    base({ sku: 3, saldo: 1, cmc: 50 }),
  ];
  const r = classificar({ meta: {}, itens }, HOJE);
  const by = Object.fromEntries(r.itens.map((i) => [i.sku, i]));
  assert.equal(by[1].valor, 100);
  assert.equal(by[2].top, false);
  assert.equal(by[1].top, true);
  assert.equal(r.itens[0].sku, 2); // ordenado por valor desc
  assert.ok(TOP_N === 61);
});

test('placar ignora doc só com observacao', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1 }), base({ sku: 2 })] }, HOJE).itens;
  const p = placar(itens, { 1: { observacao: 'ver depois' }, 2: { destino: 'trocar' } });
  assert.equal(p.total, 100);
  assert.equal(p.decidido, 50);
  assert.equal(p.porDestino.trocar, 50);
});
test('placar só conta mercadoria', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1, familia: 'Imobilizado' })] }, HOJE).itens;
  assert.equal(placar(itens, {}).total, 0);
});

test('listaTroca: só decididos trocar, por valor desc', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1, cmc: 1 }), base({ sku: 2, cmc: 9 }), base({ sku: 3 })] }, HOJE).itens;
  const l = listaTroca(itens, { 1: { destino: 'trocar' }, 2: { destino: 'trocar' }, 3: { destino: 'liquidar' } });
  assert.deepEqual(l.map((x) => x.sku), [2, 1]);
});

test('vendaDirigidaPorCliente agrupa sem comprador', () => {
  const itens = classificar({ meta: {}, itens: [
    base({ sku: 1, q12: 1, clientes: [{ nome: 'ACME', ult: '2026-09-01', qtd: 1 }, { nome: 'BETA', ult: '2026-08-01', qtd: 2 }] }),
    base({ sku: 2 }),
  ] }, HOJE).itens;
  const g = vendaDirigidaPorCliente(itens, { 1: { destino: 'venda_dirigida' }, 2: { destino: 'venda_dirigida' } });
  const nomes = g.map((x) => x.cliente).sort();
  assert.deepEqual(nomes, ['ACME', 'BETA', 'sem comprador em 12m']);
});

test('diffContagem', () => {
  assert.equal(diffContagem(base({ saldo: 10, cmc: 5 }), null), null);
  assert.equal(diffContagem(base({ saldo: 10, cmc: 5 }), ''), null);
  assert.deepEqual(diffContagem(base({ saldo: 10, cmc: 5 }), 4), { dif_un: -6, dif_valor: -30 });
});

test('parseValorBR', () => {
  assert.equal(parseValorBR('1.234,56'), 1234.56);
  assert.equal(parseValorBR('300'), 300);
  assert.equal(parseValorBR(' R$ 12,5 '), 12.5);
  assert.equal(parseValorBR('abc'), null);
  assert.equal(parseValorBR(''), null);
  assert.equal(parseValorBR(null), null);
  assert.equal(parseValorBR(42), 42);
});
