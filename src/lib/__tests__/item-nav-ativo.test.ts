import { describe, expect, it } from 'vitest';
import { casaPorSegmento, itemNavAtivo } from '@/lib/item-nav-ativo';

const PATHS = ['/', '/sales', '/sales/new', '/admin/customers'];

describe('itemNavAtivo', () => {
  it('em /sales/new só "Novo pedido" acende (vence o prefixo mais longo)', () => {
    expect(itemNavAtivo('/sales/new', '/sales/new', PATHS)).toBe(true);
    expect(itemNavAtivo('/sales/new', '/sales', PATHS)).toBe(false);
  });

  it('em /sales e /sales/:id "Pedidos" acende', () => {
    expect(itemNavAtivo('/sales', '/sales', PATHS)).toBe(true);
    expect(itemNavAtivo('/sales/abc-123', '/sales', PATHS)).toBe(true);
    expect(itemNavAtivo('/sales/abc-123', '/sales/new', PATHS)).toBe(false);
  });

  it('casa por segmento, não por prefixo de string', () => {
    expect(casaPorSegmento('/salesforce', '/sales')).toBe(false);
    expect(itemNavAtivo('/salesforce', '/sales', PATHS)).toBe(false);
  });

  it('"/" só acende na raiz', () => {
    expect(itemNavAtivo('/', '/', PATHS)).toBe(true);
    expect(itemNavAtivo('/sales', '/', PATHS)).toBe(false);
  });
});
