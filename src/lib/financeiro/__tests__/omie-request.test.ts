import { describe, it, expect } from 'vitest';
import { resolveCompanies, OmieRequestError } from '../omie-request';

const ALLOWED = ['oben', 'colacor', 'colacor_sc'] as const;

describe('resolveCompanies', () => {
  it('ausente (sem companies nem company) → todas as permitidas', () => {
    expect(resolveCompanies({ allowed: ALLOWED })).toEqual(['oben', 'colacor', 'colacor_sc']);
    expect(resolveCompanies({ companies: null, company: undefined, allowed: ALLOWED })).toEqual([
      'oben', 'colacor', 'colacor_sc',
    ]);
  });

  it('companies (array) válido → exatamente essas', () => {
    expect(resolveCompanies({ companies: ['oben', 'colacor'], allowed: ALLOWED })).toEqual(['oben', 'colacor']);
    expect(resolveCompanies({ companies: ['colacor_sc'], allowed: ALLOWED })).toEqual(['colacor_sc']);
  });

  it('company único válido → [company]', () => {
    expect(resolveCompanies({ company: 'colacor_sc', allowed: ALLOWED })).toEqual(['colacor_sc']);
  });

  it('companies (array) tem precedência sobre company', () => {
    expect(resolveCompanies({ companies: ['oben'], company: 'colacor', allowed: ALLOWED })).toEqual(['oben']);
  });

  it('empresa fora do allow-list → throw', () => {
    expect(() => resolveCompanies({ companies: ['oben', 'evil'], allowed: ALLOWED })).toThrow(OmieRequestError);
    expect(() => resolveCompanies({ company: 'dropTable', allowed: ALLOWED })).toThrow(OmieRequestError);
    expect(() => resolveCompanies({ company: 'colacor),or(1.eq.1', allowed: ALLOWED })).toThrow(OmieRequestError);
  });

  it('companies vazio ou não-array → throw', () => {
    expect(() => resolveCompanies({ companies: [], allowed: ALLOWED })).toThrow(OmieRequestError);
    expect(() => resolveCompanies({ companies: 'oben', allowed: ALLOWED })).toThrow(OmieRequestError);
  });

  it('company de tipo inválido → throw', () => {
    expect(() => resolveCompanies({ company: 123, allowed: ALLOWED })).toThrow(OmieRequestError);
    expect(() => resolveCompanies({ companies: [1, 2], allowed: ALLOWED })).toThrow(OmieRequestError);
  });
});
