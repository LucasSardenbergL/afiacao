import { describe, it, expect } from 'vitest';
import { calcApprovalSuggestion, type ApprovalInput } from '../approvalSuggestion';

function base(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    num_skus: 5,
    valor_total: 100,
    pedido_anterior_valor: 100,
    status: 'pendente_aprovacao',
    aprovado_em: null,
    cancelado_em: null,
    ...over,
  };
}

describe('calcApprovalSuggestion', () => {
  it('caminho limpo → auto, sem razões', () => {
    const r = calcApprovalSuggestion(base());
    expect(r).toEqual({ mode: 'auto', reasons: [] });
  });

  it('quantidade inválida → review', () => {
    const r = calcApprovalSuggestion(base({ num_skus: 0 }));
    expect(r.mode).toBe('review');
    expect(r.reasons).toContain('Quantidade sugerida inválida');
  });

  it('status não-pendente (aprovado_em setado) → review', () => {
    const r = calcApprovalSuggestion(base({ aprovado_em: '2026-05-01T00:00:00Z' }));
    expect(r.mode).toBe('review');
    expect(r.reasons).toContain('Confiança baixa/média — verificar status');
  });

  it('primeiro pedido (sem valor anterior) → review', () => {
    const r = calcApprovalSuggestion(base({ pedido_anterior_valor: 0 }));
    expect(r.mode).toBe('review');
    expect(r.reasons).toContain('Primeiro pedido — sem referência histórica');
  });

  it('variação > 30% → review com a razão de variação', () => {
    const r = calcApprovalSuggestion(base({ valor_total: 200, pedido_anterior_valor: 100 }));
    expect(r.mode).toBe('review');
    expect(r.reasons.some((x) => x.includes('Valor varia 100.0%'))).toBe(true);
  });

  it('variação exatamente 30% (boundary, não > 0.3) → auto', () => {
    const r = calcApprovalSuggestion(base({ valor_total: 130, pedido_anterior_valor: 100 }));
    expect(r).toEqual({ mode: 'auto', reasons: [] });
  });

  it('acumula razões (qtd inválida + primeiro pedido)', () => {
    const r = calcApprovalSuggestion(base({ num_skus: 0, pedido_anterior_valor: null }));
    expect(r.mode).toBe('review');
    expect(r.reasons).toContain('Quantidade sugerida inválida');
    expect(r.reasons).toContain('Primeiro pedido — sem referência histórica');
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
