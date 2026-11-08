import { describe, it, expect } from 'vitest';
import { classificarErro, classificarResposta, motivoSeguro } from '../sensor-empurrado';

describe('motivoSeguro', () => {
  it('cabe no vocabulário do ledger (^[a-z0-9_]{1,40}$)', () => {
    expect(motivoSeguro('Erro de Rede!')).toBe('erro_de_rede');
    expect(motivoSeguro('  __x__ ')).toBe('x');
    expect(motivoSeguro('')).toBe('desconhecido');
    expect(motivoSeguro(null)).toBe('desconhecido');
    const longo = motivoSeguro('a'.repeat(39) + '_b');
    expect(longo).toMatch(/^[a-z0-9_]{1,40}$/);
    expect(longo.endsWith('_')).toBe(false);
  });
});

describe('classificarResposta', () => {
  it('ok do servidor = sucesso; registrado:false (idempotente) também é sucesso', () => {
    expect(classificarResposta({ ok: true, registrado: true }, null)).toEqual({ ok: true, registrado: true });
    expect(classificarResposta({ ok: true, registrado: false }, null)).toEqual({ ok: true, registrado: false });
  });
  it('ok:false do servidor = falha PERMANENTE com o motivo dele', () => {
    expect(classificarResposta({ ok: false, motivo: 'link_desconhecido' }, null)).toEqual({
      ok: false, motivo: 'link_desconhecido', transitorio: false,
    });
  });
  it('resposta fora da forma NÃO vira sucesso', () => {
    for (const d of [null, undefined, 'ok', [], { registrado: true }]) {
      expect(classificarResposta(d, null)).toEqual({ ok: false, motivo: 'resposta_fora_da_forma', transitorio: false });
    }
  });
  it('erro vence o data', () => {
    expect(classificarResposta({ ok: true }, { code: '42501' })).toEqual({ ok: false, motivo: 'sem_acesso', transitorio: false });
  });
});

describe('classificarErro', () => {
  it('gates e migration ausente são permanentes (tentar de novo não adianta)', () => {
    expect(classificarErro({ code: '42501' })).toEqual({ ok: false, motivo: 'sem_acesso', transitorio: false });
    expect(classificarErro({ code: '22023' })).toEqual({ ok: false, motivo: 'parametro_invalido', transitorio: false });
    expect(classificarErro({ code: 'PGRST202' })).toEqual({ ok: false, motivo: 'rpc_ausente', transitorio: false });
    expect(classificarErro({ code: 'P0001' })).toEqual({ ok: false, motivo: 'erro_p0001', transitorio: false });
  });
  it('banco indisponível e timeout são transitórios', () => {
    expect(classificarErro({ code: '57014' })).toEqual({ ok: false, motivo: 'banco_57014', transitorio: true });
    expect(classificarErro({ code: '08006' })).toEqual({ ok: false, motivo: 'banco_08006', transitorio: true });
    expect(classificarErro({ code: '53300' })).toEqual({ ok: false, motivo: 'banco_53300', transitorio: true });
  });
  it('sem código (fetch falhou) = rede, transitório; lente = permanente e marcada', () => {
    expect(classificarErro(new TypeError('Failed to fetch'))).toEqual({ ok: false, motivo: 'rede', transitorio: true });
    expect(classificarErro({ message: 'x', code: '' })).toEqual({ ok: false, motivo: 'rede', transitorio: true });
    const lente = Object.assign(new Error('bloqueado'), { name: 'LensReadOnlyError' });
    expect(classificarErro(lente)).toEqual({ ok: false, motivo: 'lente', transitorio: false });
  });
});
