import { describe, it, expect } from 'vitest';
import { buildOmieCustomer } from '../build-omie-customer';

const UID = 'user-123';

describe('buildOmieCustomer', () => {
  it('monta OmieCustomer completo com profile + mapeamento omie', () => {
    const r = buildOmieCustomer(
      UID,
      { razao_social: 'ACME LTDA', name: 'Acme', document: '12345678000199' },
      { omie_codigo_cliente: 555, omie_codigo_vendedor: 42 },
    );
    expect(r).toEqual({
      codigo_cliente: 555,
      razao_social: 'ACME LTDA',
      nome_fantasia: 'Acme',
      cnpj_cpf: '12345678000199',
      codigo_vendedor: 42,
      local_user_id: UID,
    });
  });

  it('sem mapeamento omie → codigo_cliente=0 e vendedor null (cliente local)', () => {
    const r = buildOmieCustomer(
      UID,
      { razao_social: 'ACME LTDA', name: 'Acme', document: '123' },
      null,
    );
    expect(r?.codigo_cliente).toBe(0);
    expect(r?.codigo_vendedor).toBeNull();
    expect(r?.local_user_id).toBe(UID);
  });

  it('sem profile → null (não dá pra identificar)', () => {
    expect(buildOmieCustomer(UID, null, { omie_codigo_cliente: 555, omie_codigo_vendedor: 42 })).toBeNull();
  });

  it('razao_social ausente → cai pro name', () => {
    const r = buildOmieCustomer(UID, { razao_social: null, name: 'Acme', document: '123' }, null);
    expect(r?.razao_social).toBe('Acme');
  });

  it('document ausente → cnpj_cpf string vazia (tipo exige string)', () => {
    const r = buildOmieCustomer(UID, { razao_social: 'ACME', name: 'Acme', document: null }, null);
    expect(r?.cnpj_cpf).toBe('');
  });
});
