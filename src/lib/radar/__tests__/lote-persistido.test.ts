import { describe, expect, it } from 'vitest';
import { parsearLote, serializarLote, itensPendentes, loteConcluido, type LotePersistido } from '../lote-persistido';

const lote: LotePersistido = {
  v: 1,
  iniciadoEm: '2026-10-18T12:00:00.000Z',
  itens: [
    { cnpj: '12345678000195', nome: 'A', estado: { status: 'ok', codigo: '1', jaExistia: false, recuperado: false } },
    { cnpj: '12345678000276', nome: 'B', estado: { status: 'falha', etapa: 'radar', erro: 'x', codigo: '2' } },
    { cnpj: '12345678000357', nome: 'C', estado: { status: 'aguardando' } },
  ],
};

describe('lote-persistido', () => {
  it('ida e volta preserva o lote', () => {
    expect(parsearLote(serializarLote(lote))).toEqual(lote);
  });
  it.each([
    ['null', null], ['vazio', ''], ['json quebrado', '{'], ['versão diferente', '{"v":2,"iniciadoEm":"x","itens":[]}'],
    ['cnpj inválido', '{"v":1,"iniciadoEm":"x","itens":[{"cnpj":"abc","estado":{"status":"ok"}}]}'],
    ['status desconhecido', '{"v":1,"iniciadoEm":"x","itens":[{"cnpj":"12345678000195","estado":{"status":"zzz"}}]}'],
  ])('%s → null, nunca lança', (_n, raw) => {
    expect(parsearLote(raw)).toBeNull();
  });
  it('pendentes = tudo que não é ok; concluído só quando não sobra nada', () => {
    expect(itensPendentes(lote).map((i) => i.cnpj)).toEqual(['12345678000276', '12345678000357']);
    expect(loteConcluido(lote)).toBe(false);
    expect(loteConcluido({ ...lote, itens: [lote.itens[0]] })).toBe(true);
  });
});
