import { describe, expect, it } from 'vitest';
import { empresaDaTarefa } from '../empresa-da-tarefa';

describe('empresaDaTarefa — nunca grava chute (onda B)', () => {
  it('uma conta comprovada → ela', () => {
    expect(empresaDaTarefa([{ account: 'colacor_sc' }])).toEqual({ tipo: 'unica', empresa: 'colacor_sc' });
  });
  it('mesma conta repetida continua única', () => {
    expect(empresaDaTarefa([{ account: 'colacor' }, { account: 'colacor' }])).toEqual({ tipo: 'unica', empresa: 'colacor' });
  });
  it('várias contas → ambígua, com as opções do cliente em ordem estável', () => {
    expect(empresaDaTarefa([{ account: 'colacor_sc' }, { account: 'oben' }])).toEqual({ tipo: 'ambigua', opcoes: ['oben', 'colacor_sc'] });
  });
  it('sem conta (ou só conta fora do vocabulário) → sem_dado, pergunta entre as 3', () => {
    expect(empresaDaTarefa([])).toEqual({ tipo: 'sem_dado', opcoes: ['oben', 'colacor', 'colacor_sc'] });
    expect(empresaDaTarefa([{ account: 'xpto' }]).tipo).toBe('sem_dado');
    expect(empresaDaTarefa(null).tipo).toBe('sem_dado');
  });
});
