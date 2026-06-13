import { describe, it, expect } from 'vitest';
import { deveCriarClienteNaConta } from '@/hooks/unifiedOrder/ensure-helpers';

describe('deveCriarClienteNaConta (tri-state do auto-cadastro)', () => {
  it('cria quando ausência foi CONFIRMADA (lookup ok, sem código, com documento)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: true, lookupFalhou: false }),
    ).toBe(true);
  });

  it('NÃO cria quando o código já existe (found)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: 12345, temDocumento: true, lookupFalhou: false }),
    ).toBe(false);
  });

  it('NÃO cria quando o lookup FALHOU — ausência não confirmada (anti-duplicação no Omie)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: true, lookupFalhou: true }),
    ).toBe(false);
  });

  it('NÃO cria sem documento (não há como cadastrar)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: false, lookupFalhou: false }),
    ).toBe(false);
  });

  it('undefined conta como não-resolvido (mesma semântica do !codigo original)', () => {
    expect(
      deveCriarClienteNaConta({
        codigoExistente: undefined,
        temDocumento: true,
        lookupFalhou: false,
      }),
    ).toBe(true);
  });
});
