// src/lib/melhorias/__tests__/triagem-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { validarTriagem } from '../triagem-helpers';

const base = {
  tipo: 'problema',
  urgencia: 'alta',
  modulo: 'estoque',
  titulo: 'Picking trava ao bipar duas vezes',
  resposta_ao_funcionario: 'Entendi: problema no picking. Vai pra fila do Lucas.',
  avaliacao_founder: 'Provável replay do evento de scan sem guard de idempotência.',
};

describe('validarTriagem', () => {
  it('aceita payload válido e devolve normalizado', () => {
    const r = validarTriagem(base);
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.modulo).toBe('estoque');
  });

  it('normaliza caixa/espaços nos enums', () => {
    const r = validarTriagem({ ...base, tipo: ' Problema ', urgencia: 'ALTA', modulo: 'Estoque' });
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.urgencia).toBe('alta');
    expect(r!.modulo).toBe('estoque');
  });

  it('módulo desconhecido vira "outro" (lista evolui, não rejeita)', () => {
    const r = validarTriagem({ ...base, modulo: 'modulo-inventado' });
    expect(r).not.toBeNull();
    expect(r!.modulo).toBe('outro');
  });

  it('rejeita tipo fora do enum', () => {
    expect(validarTriagem({ ...base, tipo: 'reclamacao' })).toBeNull();
  });

  it('rejeita urgência fora do enum', () => {
    expect(validarTriagem({ ...base, urgencia: 'urgentissima' })).toBeNull();
  });

  it('rejeita título vazio e resposta vazia', () => {
    expect(validarTriagem({ ...base, titulo: '  ' })).toBeNull();
    expect(validarTriagem({ ...base, resposta_ao_funcionario: '' })).toBeNull();
  });

  it('trunca título em 120 chars', () => {
    const r = validarTriagem({ ...base, titulo: 'x'.repeat(300) });
    expect(r!.titulo.length).toBe(120);
  });

  it('avaliacao_founder ausente vira string vazia (não rejeita — campo pro founder é best-effort)', () => {
    const r = validarTriagem({ ...base, avaliacao_founder: undefined });
    expect(r).not.toBeNull();
    expect(r!.avaliacao_founder).toBe('');
  });

  it('rejeita não-objeto', () => {
    expect(validarTriagem(null)).toBeNull();
    expect(validarTriagem('texto')).toBeNull();
    expect(validarTriagem(42)).toBeNull();
  });
});
