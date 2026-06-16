// src/lib/tarefas/voz/__tests__/empresa.test.ts
import { describe, it, expect } from 'vitest';
import { empresaDeOmie } from '../empresa';

describe('empresaDeOmie', () => {
  it('oben → oben', () => expect(empresaDeOmie('oben')).toBe('oben'));
  it('vendas → oben (conta Omie da Oben)', () => expect(empresaDeOmie('vendas')).toBe('oben'));
  it('VENDAS → oben (case-insensitive)', () => expect(empresaDeOmie('VENDAS')).toBe('oben'));
  it('colacor → colacor', () => expect(empresaDeOmie('colacor')).toBe('colacor'));
  it('colacor_vendas → colacor', () => expect(empresaDeOmie('colacor_vendas')).toBe('colacor'));
  it('colacor_sc → colacor_sc', () => expect(empresaDeOmie('colacor_sc')).toBe('colacor_sc'));
  it('servicos → colacor_sc', () => expect(empresaDeOmie('servicos')).toBe('colacor_sc'));
  it('string vazia → null', () => expect(empresaDeOmie('')).toBeNull());
  it('valor desconhecido → null', () => expect(empresaDeOmie('xyz')).toBeNull());
  it('null → null', () => expect(empresaDeOmie(null)).toBeNull());
  it('undefined → null', () => expect(empresaDeOmie(undefined)).toBeNull());
});
