import { describe, it, expect } from 'vitest';
import { emptyCapture, mergeCustomerCapture, captureFilledCount } from './merge';
import type { CustomerCapture } from '@/lib/spin/types';

describe('mergeCustomerCapture', () => {
  it('incoming null retorna buffer inalterado', () => {
    const buf = emptyCapture();
    buf.razao_social = 'Marcenaria X';
    const result = mergeCustomerCapture(buf, null);
    expect(result).toEqual(buf);
  });

  it('preenche campos vazios do buffer com valores do incoming', () => {
    const buf = emptyCapture();
    const incoming: CustomerCapture = { ...emptyCapture(), razao_social: 'Marcenaria X', cnpj: '12345' };
    const result = mergeCustomerCapture(buf, incoming);
    expect(result.razao_social).toBe('Marcenaria X');
    expect(result.cnpj).toBe('12345');
  });

  it('incoming sobrescreve scalar não-null do buffer (versão nova ganha)', () => {
    const buf = emptyCapture();
    buf.razao_social = 'Velho';
    buf.email = 'velho@x.com';
    const incoming: CustomerCapture = { ...emptyCapture(), razao_social: 'Novo' };
    const result = mergeCustomerCapture(buf, incoming);
    expect(result.razao_social).toBe('Novo'); // sobrescrito
    expect(result.email).toBe('velho@x.com'); // mantido (incoming era null)
  });

  it('arrays fazem union deduplicado case-insensitive', () => {
    const buf = emptyCapture();
    buf.produtos_interesse = ['PU 2K', 'verniz'];
    buf.tags_detectadas = ['alto_padrao'];
    const incoming: CustomerCapture = {
      ...emptyCapture(),
      produtos_interesse: ['pu 2k', 'primer'], // 'pu 2k' duplica com 'PU 2K'
      tags_detectadas: ['alto_padrao', 'cabine_pressurizada'],
    };
    const result = mergeCustomerCapture(buf, incoming);
    expect(result.produtos_interesse).toEqual(['PU 2K', 'verniz', 'primer']);
    expect(result.tags_detectadas).toEqual(['alto_padrao', 'cabine_pressurizada']);
  });

  it('string vazia em incoming NÃO sobrescreve buffer', () => {
    const buf = emptyCapture();
    buf.cidade = 'BH';
    const incoming: CustomerCapture = { ...emptyCapture(), cidade: '' };
    const result = mergeCustomerCapture(buf, incoming);
    expect(result.cidade).toBe('BH');
  });
});

describe('captureFilledCount', () => {
  it('empty retorna 0', () => {
    expect(captureFilledCount(emptyCapture())).toBe(0);
  });

  it('conta campos preenchidos', () => {
    const c = emptyCapture();
    c.razao_social = 'X';
    c.cnpj = '123';
    c.email = 'a@b.c';
    c.produtos_interesse = ['PU'];
    expect(captureFilledCount(c)).toBe(4);
  });

  it('array vazio não conta', () => {
    const c = emptyCapture();
    c.razao_social = 'X';
    c.produtos_interesse = [];
    expect(captureFilledCount(c)).toBe(1);
  });
});
