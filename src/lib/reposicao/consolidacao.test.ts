import { describe, it, expect } from 'vitest';
import { mensagemErroConsolidacao } from './consolidacao';

describe('mensagemErroConsolidacao', () => {
  it('mapeia auto-referência (ZR001)', () => {
    expect(mensagemErroConsolidacao({ code: 'ZR001' })).toMatch(/auto-referência/i);
  });
  it('mapeia cadeia (ZR002)', () => {
    expect(mensagemErroConsolidacao({ code: 'ZR002' })).toMatch(/cadeia/i);
  });
  it('mapeia não-numérico (ZR003)', () => {
    expect(mensagemErroConsolidacao({ code: 'ZR003' })).toMatch(/numérico/i);
  });
  it('mapeia destino não comprável (ZR004)', () => {
    expect(mensagemErroConsolidacao({ code: 'ZR004' })).toMatch(/comprável|habilite/i);
  });
  it('mapeia antigo sem parâmetros (ZR005)', () => {
    expect(mensagemErroConsolidacao({ code: 'ZR005' })).toMatch(/parâmetros/i);
  });
  it('mapeia sem permissão (42501)', () => {
    expect(mensagemErroConsolidacao({ code: '42501' })).toMatch(/permissão/i);
  });
  it('cai no message para code desconhecido', () => {
    expect(mensagemErroConsolidacao({ code: 'XX999', message: 'boom' })).toBe('boom');
  });
  it('mensagem padrão quando não há code nem message', () => {
    expect(mensagemErroConsolidacao(null)).toMatch(/falha/i);
    expect(mensagemErroConsolidacao({ code: 'YY000' })).toMatch(/falha/i);
  });
});
