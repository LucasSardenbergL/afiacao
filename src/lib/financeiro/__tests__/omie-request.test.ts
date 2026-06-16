import { describe, it, expect } from 'vitest';
import { resolveCompanies, hasFinanceiroAccess, OmieRequestError } from '../omie-request';

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

describe('hasFinanceiroAccess', () => {
  it('master (user_roles) → true', () => {
    expect(hasFinanceiroAccess({ userRoles: [{ role: 'master' }], commercialRoles: [] })).toBe(true);
  });

  it('gestor comercial (gerencial/estrategico/super_admin) → true', () => {
    expect(hasFinanceiroAccess({ userRoles: [], commercialRoles: [{ commercial_role: 'gerencial' }] })).toBe(true);
    expect(hasFinanceiroAccess({ userRoles: [], commercialRoles: [{ commercial_role: 'estrategico' }] })).toBe(true);
    expect(hasFinanceiroAccess({ userRoles: [], commercialRoles: [{ commercial_role: 'super_admin' }] })).toBe(true);
  });

  it('master vence mesmo com commercial_role não-gestor', () => {
    expect(hasFinanceiroAccess({ userRoles: [{ role: 'master' }], commercialRoles: [{ commercial_role: 'vendedor' }] })).toBe(true);
  });

  it('employee comum (sem master, sem gestor) → false', () => {
    expect(hasFinanceiroAccess({ userRoles: [{ role: 'employee' }], commercialRoles: [] })).toBe(false);
  });

  it('vendedor (commercial_role não-gestor) → false', () => {
    expect(hasFinanceiroAccess({ userRoles: [{ role: 'employee' }], commercialRoles: [{ commercial_role: 'vendedor' }] })).toBe(false);
  });

  it('null/undefined/vazio → false (deny by default)', () => {
    expect(hasFinanceiroAccess({ userRoles: null, commercialRoles: null })).toBe(false);
    expect(hasFinanceiroAccess({ userRoles: undefined, commercialRoles: undefined })).toBe(false);
    expect(hasFinanceiroAccess({ userRoles: [], commercialRoles: [] })).toBe(false);
  });
});
