import { describe, it, expect } from 'vitest';
import {
  contarMelhoriasNaoResolvidas,
  isMelhoriaNaoResolvida,
} from '../badge-helpers';
import type { MelhoriaStatus } from '../types';

const item = (status: MelhoriaStatus) => ({ status });

describe('isMelhoriaNaoResolvida', () => {
  it('conta aberto e em_andamento', () => {
    expect(isMelhoriaNaoResolvida('aberto')).toBe(true);
    expect(isMelhoriaNaoResolvida('em_andamento')).toBe(true);
  });
  it('NÃO conta resolvido nem descartado', () => {
    expect(isMelhoriaNaoResolvida('resolvido')).toBe(false);
    expect(isMelhoriaNaoResolvida('descartado')).toBe(false);
  });
});

describe('contarMelhoriasNaoResolvidas', () => {
  it('lista vazia => 0', () => {
    expect(contarMelhoriasNaoResolvidas([])).toBe(0);
  });
  it('soma só os não-resolvidos', () => {
    const itens = [
      item('aberto'),
      item('em_andamento'),
      item('aberto'),
      item('resolvido'),
      item('descartado'),
    ];
    expect(contarMelhoriasNaoResolvidas(itens)).toBe(3);
  });
  it('todos finalizados => 0 (não fabrica badge)', () => {
    expect(
      contarMelhoriasNaoResolvidas([item('resolvido'), item('descartado')]),
    ).toBe(0);
  });
});
