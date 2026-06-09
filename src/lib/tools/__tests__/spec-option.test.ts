import { describe, it, expect } from 'vitest';
import { normalizarOpcaoSpec } from '@/lib/tools/spec-option';

describe('normalizarOpcaoSpec', () => {
  it('mantém medida válida', () => {
    expect(normalizarOpcaoSpec('290mm')).toBe('290mm');
  });

  it('faz trim e colapsa espaços internos', () => {
    expect(normalizarOpcaoSpec('  301   mm  ')).toBe('301 mm');
  });

  it('normaliza Unicode para NFC', () => {
    // 'e' + combining acute (U+0301) → 'é' (U+00E9)
    expect(normalizarOpcaoSpec('30́')).toBe('30́'.normalize('NFC'));
  });

  it('remove caracteres de controle, preservando imprimíveis', () => {
    expect(normalizarOpcaoSpec('29' + String.fromCharCode(7) + '0mm')).toBe('290mm');
    // anti-regressão: a regex não pode apagar espaço/parênteses/vírgula/aspas
    expect(normalizarOpcaoSpec('300mm (12")')).toBe('300mm (12")');
    expect(normalizarOpcaoSpec('25,4mm')).toBe('25,4mm');
  });

  it('retorna null para vazio ou só espaços', () => {
    expect(normalizarOpcaoSpec('')).toBeNull();
    expect(normalizarOpcaoSpec('   ')).toBeNull();
  });

  it('retorna null acima de 60 caracteres', () => {
    expect(normalizarOpcaoSpec('x'.repeat(60))).toBe('x'.repeat(60));
    expect(normalizarOpcaoSpec('x'.repeat(61))).toBeNull();
  });

  it('retorna null para valor reservado (qualquer caixa)', () => {
    expect(normalizarOpcaoSpec('__OUTROS__')).toBeNull();
    expect(normalizarOpcaoSpec('__outros__')).toBeNull();
  });
});
