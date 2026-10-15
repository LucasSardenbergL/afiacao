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

test('listaTroca leva o fornecedor (informado vence o do cadastro) e ordena por fornecedor', () => {
  const itens = classificar({ meta: {}, itens: [
    base({ sku: 1, cmc: 9, fornecedor: 'SAPIRANGA' }),
    base({ sku: 2, cmc: 1, fornecedor: 'RENNER SAYERLACK S/A' }),
    base({ sku: 3, cmc: 5, fornecedor: null }),
  ] }, HOJE).itens;
  const l = listaTroca(itens, { 1: { destino: 'trocar' }, 2: { destino: 'trocar' }, 3: { destino: 'trocar', fornecedor_informado: 'ACRE' } });
  assert.deepEqual(l.map((x) => [x.fornecedor, x.sku]), [['ACRE', 3], ['RENNER SAYERLACK S/A', 2], ['SAPIRANGA', 1]]);
});

import { medir } from './logica.mjs';

const ret = (o) => ({ meta: { hoje: '2026-10-14' }, itens: [{ sku: 1, categoria: 'mercadoria', saldo: 10, cmc: 5, valor: 50, preco_medio_12m: 10, ...o }] });

test('medir limita vendido ao saldo do retrato', () => {
  const m = medir(ret(), {}, { 1: { saldo: 4, qtd_vendida: 30, receita: 300, compras: [] } });
  assert.equal(m.vendido, 30); // só o que saiu do saldo do retrato (10→4)
  assert.equal(m.liquidado, 0);
});
test('medir separa liquidado e margem sacrificada', () => {
  const m = medir(ret(), {}, { 1: { saldo: 6, qtd_vendida: 4, receita: 20, compras: [] } }); // 5/un < 90% de 10
  assert.equal(m.liquidado, 20);
  assert.equal(m.vendido, 0);
  assert.equal(m.margem_sacrificada, 4 * 10 - 20);
});
test('medir soma crédito de troca e não confunde com reclassificação', () => {
  const r = ret();
  r.itens.push({ sku: 2, categoria: 'nao_mercadoria', saldo: 1, cmc: 100, valor: 100 });
  const m = medir(r, { 1: { destino: 'trocar', credito_troca: 30 } }, { 1: { saldo: 10, qtd_vendida: 0, receita: 0, compras: [] } });
  assert.equal(m.trocado, 30);
  assert.equal(m.caixa_liberado, 30);
  assert.equal(m.reclassificado_nao_caixa, 100);
});
test('medir acusa recompra após decisão', () => {
  const m = medir(ret(), { 1: { destino: 'liquidar', decidido_em: '2026-10-20T10:00:00Z' } },
    { 1: { saldo: 10, qtd_vendida: 0, receita: 0, compras: ['2026-10-19T00:00:00Z', '2026-11-02T00:00:00Z'] } });
  assert.deepEqual(m.contradicoes, [{ sku: 1, destino: 'liquidar', pedido_em: '2026-11-02T00:00:00Z' }]);
});
test('medir: SKU ausente da medição atual não vira zero', () => {
  const m = medir(ret(), {}, {});
  assert.equal(m.vendido, 0);
  assert.equal(m.parado, 0);
  assert.equal(m.sem_medicao_valor, 50);
  assert.deepEqual(m.sem_medicao, [1]);
});

import { mesclarDecisao, lerNumero } from './logica.mjs';

test('I1: medir não conta como liberado o que foi recomprado', () => {
  const m = medir(ret(), {}, { 1: { saldo: 10, qtd_vendida: 10, receita: 100, compras: [] } });
  assert.equal(m.vendido, 0);
  assert.equal(m.caixa_liberado, 0);
  assert.equal(m.recomprado, 50);
  assert.equal(m.parado, 50);
});
test('I2: SKU ausente da medição ainda conta o crédito de troca informado', () => {
  const m = medir(ret(), { 1: { destino: 'trocar', credito_troca: 40 } }, {});
  assert.equal(m.trocado, 40);
  assert.equal(m.parado, 0);
});
test('I5b: contradição compara instante, não texto (offset -03)', () => {
  const m = medir(ret(), { 1: { destino: 'liquidar', decidido_em: '2026-10-20T16:00:00Z' } },
    { 1: { saldo: 10, qtd_vendida: 0, receita: 0, compras: ['2026-10-20T15:00:00-03:00'] } });
  assert.equal(m.contradicoes.length, 1);
});
test('I7: unidade de venda ≠ estoque vai para sem_medicao, sem número', () => {
  const m = medir(ret({ unidade_estoque: 'GL', unidades_venda: ['L'] }), {}, { 1: { saldo: 4, qtd_vendida: 6, receita: 60, compras: [] } });
  assert.equal(m.vendido, 0);
  assert.deepEqual(m.sem_medicao, [1]);
  assert.equal(m.sem_medicao_valor, 50);
});
test('I3/I5a: mesclarDecisao preserva campos e só carimba quem/quando ao mudar destino', () => {
  const a = mesclarDecisao({}, { observacao: 'nota' }, 'u1', '2026-10-15T10:00:00Z');
  assert.equal(a.decidido_em, undefined);
  const b = mesclarDecisao(a, { destino: 'trocar' }, 'u1', '2026-10-15T11:00:00Z');
  assert.deepEqual(b, { observacao: 'nota', destino: 'trocar', decidido_por: 'u1', decidido_em: '2026-10-15T11:00:00Z' });
  const c = mesclarDecisao(b, { credito_troca: 10 }, 'u2', '2026-10-16T09:00:00Z');
  assert.equal(c.decidido_em, '2026-10-15T11:00:00Z');
  assert.equal(c.decidido_por, 'u1');
  assert.equal(c.credito_troca, 10);
});
test('I4: lerNumero distingue vazio de inválido', () => {
  assert.deepEqual(lerNumero(''), { valor: null, erro: false });
  assert.deepEqual(lerNumero('12'), { valor: 12, erro: false });
  assert.deepEqual(lerNumero('12,5'), { valor: 12.5, erro: false });
  assert.equal(lerNumero('abc').erro, true);
  assert.equal(lerNumero('12.5').erro, true);
});

import { categoriaEfetiva, aplicarCategorias } from './logica.mjs';
test('categorizar usa o tipo do item do Omie: 07/01/03 → uso_consumo, 08 → nao_mercadoria, 00/04 seguem', () => {
  assert.equal(categorizar(base({ tipo_produto: '07', descricao: 'REBOLO AFIADORA UNIVERSAL' })).categoria, 'uso_consumo');
  assert.equal(categorizar(base({ tipo_produto: '01', descricao: 'SOLUCAO PRETA 1352' })).categoria, 'uso_consumo');
  assert.equal(categorizar(base({ tipo_produto: '03' })).categoria, 'uso_consumo');
  assert.equal(categorizar(base({ tipo_produto: '08', q12: 3 })).categoria, 'nao_mercadoria');
  assert.equal(categorizar(base({ tipo_produto: '04' })).categoria, 'mercadoria');
  assert.equal(categorizar(base({ tipo_produto: '00' })).categoria, 'mercadoria');
});
test('categoria informada na decisão vence a do retrato e sai do placar de mercadoria', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1, tipo_produto: '00' }), base({ sku: 2 })] }, HOJE).itens;
  const dec = { 1: { categoria_informada: 'uso_consumo' } };
  assert.equal(categoriaEfetiva(itens.find((i) => i.sku === 1), dec), 'uso_consumo');
  const ef = aplicarCategorias(itens, dec);
  assert.equal(ef.find((i) => i.sku === 1).categoria, 'uso_consumo');
  assert.equal(ef.find((i) => i.sku === 1).motivo_categoria, 'marcado como uso e consumo na página');
  assert.equal(placar(ef, dec).total, 50);
  assert.equal(itens.find((i) => i.sku === 1).categoria, 'mercadoria'); // não muta o retrato
});

import { valorVenda } from './logica.mjs';
test('valorVenda: preço praticado em 12m vence o de tabela; margem sobre o custo', () => {
  assert.deepEqual(valorVenda(base({ saldo: 10, cmc: 5, preco_medio_12m: 8, preco_tabela: 9 })), { valor: 80, fonte: 'praticado_12m', margem_pct: 37.5 });
  assert.deepEqual(valorVenda(base({ saldo: 10, cmc: 5, preco_medio_12m: null, preco_tabela: 10 })), { valor: 100, fonte: 'tabela', margem_pct: 50 });
});
test('valorVenda: sem preço nenhum é null (ausente ≠ zero)', () => {
  assert.equal(valorVenda(base({ preco_medio_12m: null, preco_tabela: null })), null);
  assert.equal(valorVenda(base({ preco_medio_12m: 0, preco_tabela: 0 })), null);
});
test('valorVenda: preço abaixo do custo dá margem negativa', () => {
  assert.equal(valorVenda(base({ saldo: 1, cmc: 10, preco_medio_12m: 8 })).margem_pct, -25);
});
