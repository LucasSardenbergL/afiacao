import { describe, expect, it } from 'vitest';
import { parsearLote, serializarLote, itensPendentes, itensDivergentes, loteConcluido, type LotePersistido } from '../lote-persistido';

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
  // Codex ALTO 3 do bloco 5: conflito de vínculo é TERMINAL — não é retentável (a retomada releria o vínculo
  // antigo e o devolveria como "recuperado") e não conclui o lote (senão o storage o apagaria e a evidência sumiria).
  it('divergente: fora dos retentáveis, mas segura o lote até o descarte explícito', () => {
    const comConflito: LotePersistido = {
      ...lote,
      itens: [
        lote.itens[0],
        { cnpj: '12345678000438', nome: 'D', estado: { status: 'divergente', motivo: 'vinculo_divergente', erro: 'RADAR_VINCULO_DIVERGENTE: …', codigo: '9' } },
      ],
    };
    expect(itensPendentes(comConflito)).toEqual([]);
    expect(itensDivergentes(comConflito).map((i) => i.cnpj)).toEqual(['12345678000438']);
    expect(loteConcluido(comConflito)).toBe(false);
    expect(parsearLote(serializarLote(comConflito))).toEqual(comConflito);
  });
});
