import { describe, it, expect } from 'vitest';
import { diffVersions, decidirChangeType } from '@/lib/knowledge-base/version-diff';

const base = { rendimento_m2_por_litro: 10, catalisador_codigo: 'FC.1', substrato: ['mdf'], demaos_recomendadas: 2, validade_dias: 365 };

describe('diffVersions', () => {
  it('changed: campo que mudou de valor', () => {
    const d = diffVersions({ ...base }, { ...base, catalisador_codigo: 'FC.2' });
    expect(d).toContainEqual({ campo: 'catalisador_codigo', de: 'FC.1', para: 'FC.2', tipo: 'changed' });
  });
  it('removed: campo que sumiu (virou null)', () => {
    const d = diffVersions({ ...base }, { ...base, catalisador_codigo: null });
    expect(d).toContainEqual({ campo: 'catalisador_codigo', de: 'FC.1', para: null, tipo: 'removed' });
  });
  it('added: campo que era null e ganhou valor', () => {
    const d = diffVersions({ ...base, diluente_codigo: null }, { ...base, diluente_codigo: 'DF.1' });
    expect(d).toContainEqual({ campo: 'diluente_codigo', de: null, para: 'DF.1', tipo: 'added' });
  });
  it('array: compara por conteúdo (ordem-insensível)', () => {
    expect(diffVersions({ ...base, substrato: ['mdf','madeira'] }, { ...base, substrato: ['madeira','mdf'] })).toEqual([]);
  });
  it('sem mudança → []', () => { expect(diffVersions({ ...base }, { ...base })).toEqual([]); });
});

describe('decidirChangeType', () => {
  it('PDF novo (documento diferente) → bulletin_revision', () => {
    expect(decidirChangeType({ acao: 'novo_documento' })).toBe('bulletin_revision');
  });
  it('corrigir erro → correction', () => {
    expect(decidirChangeType({ acao: 'corrigir' })).toBe('correction');
  });
  it('completar dado faltante → data_completion', () => {
    expect(decidirChangeType({ acao: 'completar' })).toBe('data_completion');
  });
});
