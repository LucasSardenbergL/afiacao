import { describe, it, expect } from 'vitest';
import { parseBloqueioAtp, mensagemRecusasAtp } from '../atp';

describe('parseBloqueioAtp', () => {
  it('payload sem blocked:"atp" → null (não é bloqueio ATP)', () => {
    expect(parseBloqueioAtp(null)).toBeNull();
    expect(parseBloqueioAtp(undefined)).toBeNull();
    expect(parseBloqueioAtp({})).toBeNull();
    expect(parseBloqueioAtp({ blocked: 'credito' })).toBeNull();
    expect(parseBloqueioAtp({ omie_numero_pedido: '999' })).toBeNull();
  });

  it('blocked:"atp" com recusas → tipo "recusa" com recusas normalizadas', () => {
    const b = parseBloqueioAtp({
      success: false, blocked: 'atp', contexto: 'criacao',
      recusas: [
        { omie_codigo_produto: 111, motivo: 'saldo_insuficiente', solicitado: 5, disponivel: 2 },
        { omie_codigo_produto: 222, motivo: 'saldo_indisponivel', solicitado: 1, disponivel: null },
      ],
    });
    expect(b).toEqual({
      tipo: 'recusa',
      recusas: [
        { omie_codigo_produto: 111, motivo: 'saldo_insuficiente', solicitado: 5, disponivel: 2 },
        { omie_codigo_produto: 222, motivo: 'saldo_indisponivel', solicitado: 1, disponivel: null },
      ],
      semOverride: false,
      detalhe: null,
    });
  });

  it('disponivel null PRESERVADO (ausente ≠ zero) e nunca coagido a 0', () => {
    const b = parseBloqueioAtp({
      blocked: 'atp',
      recusas: [{ omie_codigo_produto: 1, motivo: 'saldo_indisponivel', solicitado: 2, disponivel: null }],
    });
    expect(b?.recusas[0].disponivel).toBeNull();
    expect(b?.recusas[0].disponivel).not.toBe(0);
  });

  it('verificacao_indisponivel → tipo próprio, com sem_override e detalhe', () => {
    const b = parseBloqueioAtp({
      success: false, blocked: 'atp', recusas: [],
      verificacao_indisponivel: true, sem_override: true, detalhe: 'item invalido',
    });
    expect(b).toEqual({ tipo: 'verificacao_indisponivel', recusas: [], semOverride: true, detalhe: 'item invalido' });
  });

  it('recusa malformada é FILTRADA (nunca vira linha com undefined), bloqueio permanece', () => {
    const b = parseBloqueioAtp({
      blocked: 'atp',
      recusas: [
        { motivo: 'saldo_insuficiente' },                            // sem sku
        { omie_codigo_produto: 111, motivo: 'saldo_insuficiente', solicitado: 3, disponivel: 1 },
        'lixo',
      ],
    });
    expect(b?.tipo).toBe('recusa');
    expect(b?.recusas).toEqual([
      { omie_codigo_produto: 111, motivo: 'saldo_insuficiente', solicitado: 3, disponivel: 1 },
    ]);
  });

  it('blocked:"atp" com recusas ilegíveis por inteiro → bloqueio genérico (nunca sucesso)', () => {
    const b = parseBloqueioAtp({ blocked: 'atp', recusas: 'x' });
    expect(b?.tipo).toBe('recusa');
    expect(b?.recusas).toEqual([]);
  });
});

describe('mensagemRecusasAtp', () => {
  const porSku = new Map([[111, 'Lixa G80'], [222, 'Disco flap']]);

  it('nomeia o produto, solicitado e disponível', () => {
    const msg = mensagemRecusasAtp(
      [{ omie_codigo_produto: 111, motivo: 'saldo_insuficiente', solicitado: 5, disponivel: 2 }],
      porSku,
    );
    expect(msg).toContain('Lixa G80');
    expect(msg).toContain('5');
    expect(msg).toContain('2');
  });

  it('saldo_indisponivel exibe "—" (indisponível), nunca "0"', () => {
    const msg = mensagemRecusasAtp(
      [{ omie_codigo_produto: 222, motivo: 'saldo_indisponivel', solicitado: 3, disponivel: null }],
      porSku,
    );
    expect(msg).toContain('Disco flap');
    expect(msg).not.toMatch(/dispon[ií]vel[^\d]*0/i);
  });

  it('SKU fora do mapa cai no código numérico (não quebra)', () => {
    const msg = mensagemRecusasAtp(
      [{ omie_codigo_produto: 999, motivo: 'saldo_insuficiente', solicitado: 1, disponivel: 0 }],
      porSku,
    );
    expect(msg).toContain('999');
  });
});
