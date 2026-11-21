import { describe, it, expect } from 'vitest';
import { agruparPorDia, decodeHtml, EFEITO_DA_EXCLUSAO, podeExcluirPedido, statusDoPedido, statusLabels, type OrderFeedRow } from '../types';

describe('decodeHtml', () => {
  it('decodifica entidades HTML comuns', () => {
    expect(decodeHtml('Tintas &amp; Vernizes')).toBe('Tintas & Vernizes');
    expect(decodeHtml('&lt;b&gt;')).toBe('<b>');
    expect(decodeHtml('O&apos;Brien')).toBe("O'Brien");
    expect(decodeHtml('&quot;x&quot;')).toBe('"x"');
  });
  it('deixa texto sem entidades intacto', () => {
    expect(decodeHtml('ACME Ltda')).toBe('ACME Ltda');
  });
});

describe('statusLabels', () => {
  it('mapeia status conhecidos', () => {
    expect(statusLabels.enviado.label).toBe('Enviado ao Omie');
    expect(statusLabels.cancelado.variant).toBe('destructive');
  });
});

describe('statusDoPedido', () => {
  it('status gravados pelo sync do Omie ganham rótulo próprio (antes caíam no fallback "Rascunho")', () => {
    expect(statusDoPedido('importado').label).toBe('Importado');
    expect(statusDoPedido('separacao').label).toBe('Em separação');
  });

  it('status conhecidos preservados', () => {
    expect(statusDoPedido('rascunho').label).toBe('Rascunho');
    expect(statusDoPedido('faturado').label).toBe('Faturado');
  });

  it('status desconhecido → rótulo honesto derivado do próprio status, NUNCA "Rascunho"', () => {
    const s = statusDoPedido('aguardando_aprovacao');
    expect(s.label).toBe('Aguardando aprovacao');
    expect(s.label).not.toBe('Rascunho');
    expect(s.variant).toBe('outline');
  });

  it('status vazio → rótulo neutro', () => {
    expect(statusDoPedido('').label).toBe('Sem status');
  });
});

describe('podeExcluirPedido (espelho do contrato da edge excluir_pedido)', () => {
  const base = { origin: 'sales' as const, account: 'oben', status: 'rascunho', omie_pedido_id: null as number | null };
  it('rascunho do app sem PV: pode', () => expect(podeExcluirPedido(base)).toEqual({ ok: true }));
  it('já no Omie e cancelado lá (sync trouxe): pode', () =>
    expect(podeExcluirPedido({ ...base, status: 'cancelado', omie_pedido_id: 9 })).toEqual({ ok: true }));
  it('já no Omie e não cancelado: não pode', () =>
    expect(podeExcluirPedido({ ...base, status: 'faturado', omie_pedido_id: 9 }).ok).toBe(false));
  it('importado do Omie: nunca', () =>
    expect(podeExcluirPedido({ ...base, status: 'importado', omie_pedido_id: 9 }).ok).toBe(false));
  it('Colacor SC e conta desconhecida: não', () => {
    expect(podeExcluirPedido({ ...base, account: 'colacor_sc' }).ok).toBe(false);
    expect(podeExcluirPedido({ ...base, account: 'xpto' }).ok).toBe(false);
  });
  it('afiação: não', () => expect(podeExcluirPedido({ ...base, origin: 'afiacao' }).ok).toBe(false));
  it('o texto do efeito não promete mexer no Omie', () => expect(EFEITO_DA_EXCLUSAO).toMatch(/Nada é alterado no Omie/));
});

describe('agruparPorDia', () => {
  const row = (id: string, created_at: string) => ({ id, created_at }) as unknown as OrderFeedRow;
  it('data-pura e hora real intercaladas não abrem o mesmo dia duas vezes (chaves únicas)', () => {
    // Em São Paulo isto dava 21, 20, 21 com o agrupador por vizinhança.
    const grupos = agruparPorDia([
      row('a', '2026-11-21T12:00:00.000Z'),
      row('b', '2026-11-21T01:00:00.123Z'),
      row('c', '2026-11-21T00:00:00.000Z'),
    ]);
    const dias = grupos.map((g) => g.dia);
    expect(new Set(dias).size).toBe(dias.length);
    expect(grupos.flatMap((g) => g.pedidos.map((p) => p.id)).sort()).toEqual(['a', 'b', 'c']);
    expect([...dias].sort().reverse()).toEqual(dias); // dia DESC
  });
  it('data inválida vai para "Sem data", no fim', () => {
    const grupos = agruparPorDia([row('x', 'lixo'), row('a', '2026-11-21T12:00:00.000Z')]);
    expect(grupos.map((g) => g.rotulo).at(-1)).toBe('Sem data');
  });
});
