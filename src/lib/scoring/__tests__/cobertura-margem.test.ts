import { describe, it, expect } from 'vitest';
import { coberturaMargem, legendaCobertura } from '../margin';

// Uma média de margem que representa 16% da base e uma que representa 100% são números
// diferentes disfarçados do mesmo jeito. `mediaMargensConhecidas` (#1525) já faz a conta
// certa; o que falta é a tela DIZER que fatia ela cobre — senão quem lê assume "todos os
// clientes", que é a leitura errada agora que o #1495 gravou NULL em ~84% das linhas
// (money-path: no silent caps).

describe('coberturaMargem', () => {
  it('conta quantos têm margem conhecida e o total', () => {
    expect(coberturaMargem([40, 60, null, undefined])).toEqual({ comMargem: 2, total: 4 });
  });

  it('conta o 0 legítimo como conhecido (é veredito, não ausência)', () => {
    expect(coberturaMargem([0, null])).toEqual({ comMargem: 1, total: 2 });
  });

  it('não-finito não conta como conhecido', () => {
    expect(coberturaMargem([NaN, Infinity, 30])).toEqual({ comMargem: 1, total: 3 });
  });

  it('lista vazia → 0 de 0, sem divisão', () => {
    expect(coberturaMargem([])).toEqual({ comMargem: 0, total: 0 });
  });

  it('cenário real pós-#1495 (84% ausente)', () => {
    const valores = [
      ...Array.from({ length: 1053 }, () => 50),
      ...Array.from({ length: 5579 }, () => null),
    ];
    expect(coberturaMargem(valores)).toEqual({ comMargem: 1053, total: 6632 });
  });
});

describe('legendaCobertura', () => {
  it('declara que a média é parcial quando falta margem', () => {
    expect(legendaCobertura({ comMargem: 1053, total: 6632 })).toBe(
      'parcial — 1.053 de 6.632 clientes c/ margem',
    );
  });

  it('não diz "parcial" quando todos têm margem', () => {
    expect(legendaCobertura({ comMargem: 10, total: 10 })).toBe('10 clientes c/ margem');
  });

  it('nenhum com margem → diz isso, em vez de exibir cobertura 0', () => {
    expect(legendaCobertura({ comMargem: 0, total: 6632 })).toBe(
      'nenhum cliente c/ margem conhecida',
    );
  });

  it('base vazia não vira "0 de 0"', () => {
    expect(legendaCobertura({ comMargem: 0, total: 0 })).toBe('sem clientes');
  });
});
