import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preVoo, resumo } from './gerar.mjs';

const agora = new Date('2026-10-14T23:00:00Z');
test('preVoo: sync velho falha', () => {
  const f = preVoo({ meta: { synced_at_max: '2026-10-13T20:00:00Z' }, itens: [{ sku: 1 }] }, agora);
  assert.ok(f.some((x) => x.includes('synced_at')));
});
test('preVoo: sync ausente falha (ausente ≠ fresco)', () => {
  assert.ok(preVoo({ meta: { synced_at_max: null }, itens: [{ sku: 1 }] }, agora).length > 0);
});
test('preVoo: zero itens falha', () => {
  assert.ok(preVoo({ meta: { synced_at_max: '2026-10-14T22:00:00Z' }, itens: [] }, agora).some((x) => x.includes('itens')));
});
test('preVoo: ok', () => {
  assert.deepEqual(preVoo({ meta: { synced_at_max: '2026-10-14T22:00:00Z' }, itens: [{ sku: 1 }] }, agora), []);
});
test('resumo soma por categoria', () => {
  const r = resumo({ itens: [{ categoria: 'mercadoria', valor: 10 }, { categoria: 'mercadoria', valor: 5 }, { categoria: 'granel', valor: 1 }] });
  assert.deepEqual(r.porCategoria.mercadoria, { n: 2, valor: 15 });
  assert.equal(r.n, 3);
  assert.equal(r.valor, 16);
});
