import { describe, it, expect } from 'vitest';
import { decideSalesOrderAction } from '../idempotency';

describe('decideSalesOrderAction', () => {
  it('linha inexistente → insert', () => {
    expect(decideSalesOrderAction(null)).toBe('insert');
  });
  it('já tem omie_pedido_id → skip (no Omie; não reenviar)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: 12345 })).toBe('skip');
  });
  it('omie_pedido_id null → reuse (rascunho de tentativa que não chegou no Omie)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: null })).toBe('reuse');
  });
});
