import { describe, it, expect } from 'vitest';
import { ehTerminalCiclo, particionarCicloHoje, STATUS_TERMINAIS_CICLO } from '../shared';

describe('ehTerminalCiclo', () => {
  it('true para os 3 estados terminais', () => {
    expect(ehTerminalCiclo({ status: 'cancelado' })).toBe(true);
    expect(ehTerminalCiclo({ status: 'cancelado_humano' })).toBe(true);
    expect(ehTerminalCiclo({ status: 'expirado_sem_aprovacao' })).toBe(true);
  });
  it('false para estados ativos/operacionais', () => {
    for (const s of [
      'pendente_aprovacao', 'aprovado_aguardando_disparo', 'bloqueado_guardrail',
      'disparado', 'disparado_simulado', 'falha_envio', 'concluido_recebido',
    ]) {
      expect(ehTerminalCiclo({ status: s })).toBe(false);
    }
  });
});

describe('particionarCicloHoje', () => {
  it('separa ativos de terminais preservando ordem', () => {
    const lista = [
      { id: 1, status: 'pendente_aprovacao' },
      { id: 2, status: 'cancelado' },
      { id: 3, status: 'disparado' },
      { id: 4, status: 'expirado_sem_aprovacao' },
      { id: 5, status: 'cancelado_humano' },
    ];
    const { ativos, historico } = particionarCicloHoje(lista);
    expect(ativos.map((p) => p.id)).toEqual([1, 3]);
    expect(historico.map((p) => p.id)).toEqual([2, 4, 5]);
  });
  it('lista vazia → ambos vazios', () => {
    expect(particionarCicloHoje([])).toEqual({ ativos: [], historico: [] });
  });
  it('STATUS_TERMINAIS_CICLO tem exatamente os 3 estados', () => {
    expect([...STATUS_TERMINAIS_CICLO].sort()).toEqual([
      'cancelado', 'cancelado_humano', 'expirado_sem_aprovacao',
    ]);
  });
});
