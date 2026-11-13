import { describe, expect, it } from 'vitest';
import { lerAbertura, lerFichaDaUrl, lerTokenDoLink, linkFichaMeuDia } from '../resumo-link';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';

describe('link do resumo por e-mail', () => {
  it('token: só uuid (normalizado); o resto é null', () => {
    expect(lerTokenDoLink(ID.toUpperCase())).toBe(ID);
    expect(lerTokenDoLink(` ${ID} `)).toBe(ID);
    expect(lerTokenDoLink('abc')).toBeNull();
    expect(lerTokenDoLink(undefined)).toBeNull();
    expect(lerFichaDaUrl(`${ID}x`)).toBeNull();
  });

  it('destino é a ficha do comprador no Meu Dia', () => {
    expect(linkFichaMeuDia(ID)).toBe(`/meu-dia?ficha=${ID}`);
  });

  it('retorno da RPC: NULL e forma estranha → null; forma certa → comprador', () => {
    expect(lerAbertura(null)).toBeNull();
    expect(lerAbertura([])).toBeNull();
    expect(lerAbertura({ comprador_id: 'nao-uuid' })).toBeNull();
    expect(lerAbertura({ comprador_id: ID, registrado: true, do_destinatario: true, dia: '2026-11-13' }))
      .toEqual({ comprador_id: ID, registrado: true, do_destinatario: true });
    expect(lerAbertura({ comprador_id: ID })).toEqual({ comprador_id: ID, registrado: false, do_destinatario: false });
  });
});
