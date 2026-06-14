import { describe, it, expect } from 'vitest';
import { resolveOrigemFromUrl, sanitizeAtendimentoId, resolveBridgeMetadata, ORIGEM_LIGACAO } from './origem';

describe('resolveOrigemFromUrl', () => {
  it('aceita ligação da allowlist; ignora desconhecido; customer sempre web_customer', () => {
    expect(resolveOrigemFromUrl('ligacao_sainte', false)).toBe('ligacao_sainte');
    expect(resolveOrigemFromUrl('ligacao_entrante', false)).toBe('ligacao_entrante');
    expect(resolveOrigemFromUrl('hacker', false)).toBe('web_staff');
    expect(resolveOrigemFromUrl(null, false)).toBe('web_staff');
    expect(resolveOrigemFromUrl('ligacao_sainte', true)).toBe('web_customer');
  });
});
describe('sanitizeAtendimentoId', () => {
  it('aceita só UUID; rejeita lixo/null', () => {
    expect(sanitizeAtendimentoId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(sanitizeAtendimentoId('drop table')).toBeNull();
    expect(sanitizeAtendimentoId(null)).toBeNull();
  });
});
describe('resolveBridgeMetadata (congelamento + anti-troca-de-cliente)', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  it('URL-customer == selecionado → congela origem da ligação + atendimento', () => {
    expect(resolveBridgeMetadata({ urlCustomer:'cli-A', selectedCustomerUserId:'cli-A', urlOrigem:'ligacao_sainte', urlAtendimento:uuid, isCustomerMode:false }))
      .toEqual({ origem:'ligacao_sainte', atendimentoId:uuid });
  });
  it('URL-customer != selecionado (entrante de B no pedido de A) → web_staff + sem atendimento', () => {
    expect(resolveBridgeMetadata({ urlCustomer:'cli-B', selectedCustomerUserId:'cli-A', urlOrigem:'ligacao_entrante', urlAtendimento:uuid, isCustomerMode:false }))
      .toEqual({ origem:'web_staff', atendimentoId:null });
  });
  it('sem URL-customer → web_staff + null', () => {
    expect(resolveBridgeMetadata({ urlCustomer:null, selectedCustomerUserId:'cli-A', urlOrigem:'ligacao_sainte', urlAtendimento:uuid, isCustomerMode:false }))
      .toEqual({ origem:'web_staff', atendimentoId:null });
  });
  it('match mas atendimento malformado → origem ok, atendimento null', () => {
    expect(resolveBridgeMetadata({ urlCustomer:'cli-A', selectedCustomerUserId:'cli-A', urlOrigem:'ligacao_sainte', urlAtendimento:'lixo', isCustomerMode:false }))
      .toEqual({ origem:'ligacao_sainte', atendimentoId:null });
  });
  it('customer mode → web_customer + null mesmo com match', () => {
    expect(resolveBridgeMetadata({ urlCustomer:'cli-A', selectedCustomerUserId:'cli-A', urlOrigem:'ligacao_sainte', urlAtendimento:uuid, isCustomerMode:true }))
      .toEqual({ origem:'web_customer', atendimentoId:null });
  });
});

// Sanity: a allowlist exportada bate com o esperado (guarda contra alteração acidental).
describe('ORIGEM_LIGACAO', () => {
  it('contém exatamente as origens de ligação suportadas', () => {
    expect([...ORIGEM_LIGACAO].sort()).toEqual(['ligacao_entrante', 'ligacao_sainte']);
  });
});
