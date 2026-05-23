// src/lib/access/resolve-access.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAccessPersona, resolveGroupTag } from './resolve-access';

const base = { appRole: null, commercialRole: null, department: null, isSalesOnly: false } as const;

describe('resolveAccessPersona', () => {
  it('master (app_role) → gestao', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'master' })).toBe('gestao');
  });
  it('estrategico/super_admin → gestao', () => {
    expect(resolveAccessPersona({ ...base, commercialRole: 'estrategico' })).toBe('gestao');
    expect(resolveAccessPersona({ ...base, commercialRole: 'super_admin' })).toBe('gestao');
  });
  it('gerencial → gestor_comercial', () => {
    expect(resolveAccessPersona({ ...base, commercialRole: 'gerencial' })).toBe('gestor_comercial');
  });
  it('department gestao → gestor_comercial', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', department: 'gestao' })).toBe('gestor_comercial');
  });
  it('department financeiro → financeiro', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', department: 'financeiro' })).toBe('financeiro');
  });
  it('department separador/conferente/tintometrico → operacao', () => {
    for (const d of ['separador', 'conferente', 'tintometrico'] as const) {
      expect(resolveAccessPersona({ ...base, appRole: 'employee', department: d })).toBe('operacao');
    }
  });
  it('customer → cliente', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'customer' })).toBe('cliente');
  });
  it('vendas (operacional/farmer/hunter/closer) → vendedor', () => {
    for (const r of ['operacional', 'farmer', 'hunter', 'closer'] as const) {
      expect(resolveAccessPersona({ ...base, appRole: 'employee', commercialRole: r })).toBe('vendedor');
    }
  });
  it('sales-only → vendedor', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', isSalesOnly: true })).toBe('vendedor');
  });
  it('staff sem tag → vendedor (default)', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee' })).toBe('vendedor');
  });
  // Anti-escalação (codex review): restrições vencem sinais de privilégio residuais.
  it('customer com commercial_role residual NÃO escala — fica cliente', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'customer', commercialRole: 'super_admin' })).toBe('cliente');
    expect(resolveAccessPersona({ ...base, appRole: 'customer', commercialRole: 'gerencial' })).toBe('cliente');
  });
  it('sales-only com department privilegiado NÃO escala — fica vendedor', () => {
    expect(resolveAccessPersona({ ...base, appRole: 'employee', isSalesOnly: true, department: 'financeiro' })).toBe('vendedor');
    expect(resolveAccessPersona({ ...base, appRole: 'employee', isSalesOnly: true, commercialRole: 'gerencial' })).toBe('vendedor');
  });
});

describe('resolveGroupTag', () => {
  it('hunter/farmer/closer → o próprio', () => {
    expect(resolveGroupTag('hunter')).toBe('hunter');
    expect(resolveGroupTag('farmer')).toBe('farmer');
    expect(resolveGroupTag('closer')).toBe('closer');
  });
  it('demais → null', () => {
    expect(resolveGroupTag('operacional')).toBeNull();
    expect(resolveGroupTag(null)).toBeNull();
  });
});
