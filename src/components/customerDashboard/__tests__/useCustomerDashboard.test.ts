import { describe, it, expect } from 'vitest';
import { nomeExibicaoCliente } from '../useCustomerDashboard';
import type { Profile } from '../types';

// `displayName`: PJ mostra o nome inteiro (razão social), PF só o primeiro nome. A classificação era
// `replace(/\D/g,'').length === 14` — CNPJ alfanumérico (9 dígitos) virava "PF" e perdia a razão social.
const perfil = (document: string | null, name = 'Alfa Tintas Ltda'): Profile =>
  ({ document, name } as unknown as Profile);

describe('nomeExibicaoCliente (useCustomerDashboard.displayName)', () => {
  it('numérico: CNPJ → nome inteiro; CPF → primeiro nome; sem nome → "Cliente" (como antes)', () => {
    expect(nomeExibicaoCliente(perfil('11.222.333/0001-81'))).toBe('Alfa Tintas Ltda');
    expect(nomeExibicaoCliente(perfil('123.456.789-09', 'Maria Silva'))).toBe('Maria');
    expect(nomeExibicaoCliente(perfil('11222333000181', ''))).toBe('Cliente');
    expect(nomeExibicaoCliente(perfil(null, 'Maria Silva'))).toBe('Maria');
    expect(nomeExibicaoCliente(null)).toBe('Cliente');
  });
  it('CNPJ alfanumérico VÁLIDO (12.ABC.345/01DE-35) é PJ → nome inteiro', () => {
    expect(nomeExibicaoCliente(perfil('12.ABC.345/01DE-35'))).toBe('Alfa Tintas Ltda');
    expect(nomeExibicaoCliente(perfil('12ABC34501DE35'))).toBe('Alfa Tintas Ltda');
  });
  it('alfanumérico INVÁLIDO (…-36) NÃO é PJ → primeiro nome, como antes', () => {
    expect(nomeExibicaoCliente(perfil('12.ABC.345/01DE-36'))).toBe('Alfa');
  });
});
