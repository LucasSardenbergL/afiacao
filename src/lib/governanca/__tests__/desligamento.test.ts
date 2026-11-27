import { describe, expect, it } from 'vitest';
import { impedimentoDoDesligamento, opcoesNovoDono, resumoDoDesligamento } from '../desligamento';

const equipe = [
  { user_id: 'f', name: 'Fernanda' },
  { user_id: 'b', name: 'Bruno' },
];

describe('opcoesNovoDono', () => {
  it('tira o desligado e inclui o master, ordenado por nome', () => {
    expect(opcoesNovoDono(equipe, 'f', { user_id: 'm', name: 'Lucas' }).map((m) => m.user_id)).toEqual(['b', 'm']);
  });
  it('não duplica o master que já está na equipe', () => {
    expect(opcoesNovoDono([...equipe, { user_id: 'm', name: 'Lucas' }], 'f', { user_id: 'm', name: 'Lucas' })).toHaveLength(2);
  });
  it('o desligado nunca aparece, nem como "eu"', () => {
    expect(opcoesNovoDono(equipe, 'f', { user_id: 'f', name: 'Fernanda' }).map((m) => m.user_id)).toEqual(['b']);
  });
});

describe('impedimentoDoDesligamento', () => {
  const ok = { nomeAlvo: 'Fernanda  Souza', confirmacao: ' fernanda souza ', motivo: 'Pediu demissão', novoDono: 'b' };
  it('libera com tudo preenchido (nome sem diferenciar caixa/espaço)', () => {
    expect(impedimentoDoDesligamento(ok)).toBeNull();
  });
  it('exige novo dono', () => {
    expect(impedimentoDoDesligamento({ ...ok, novoDono: null })).toBe('Escolha quem recebe a carteira.');
  });
  it('exige motivo', () => {
    expect(impedimentoDoDesligamento({ ...ok, motivo: ' a ' })).toBe('Escreva o motivo.');
  });
  it('exige o nome exato', () => {
    expect(impedimentoDoDesligamento({ ...ok, confirmacao: 'Fernanda' })).toBe('Digite o nome do funcionário para confirmar.');
  });
  it('sem nome do alvo, nunca libera', () => {
    expect(impedimentoDoDesligamento({ ...ok, nomeAlvo: null, confirmacao: '' })).toBe('Digite o nome do funcionário para confirmar.');
  });
});

describe('resumoDoDesligamento', () => {
  it('lista só o que mudou, com plural', () => {
    expect(resumoDoDesligamento({ carteira: 2866, vendedor_map: 1, cobranca: 0, tarefas: 1, hunter: 0 }))
      .toBe('2866 clientes, 1 código Omie, 1 tarefa aberta');
  });
  it('hunter e vazio', () => {
    expect(resumoDoDesligamento({ hunter: 1 })).toBe('fila de órfãos (hunter)');
    expect(resumoDoDesligamento(null)).toBe('');
    expect(resumoDoDesligamento({ carteira: null })).toBe('');
  });
});
