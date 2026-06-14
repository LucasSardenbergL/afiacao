import { describe, it, expect } from 'vitest';
import { buildPedidoIntegrationCode } from '../pedido-integration-code';
describe('buildPedidoIntegrationCode', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  it('determinístico', () => { expect(buildPedidoIntegrationCode(id)).toBe(buildPedidoIntegrationCode(id)); });
  it('formato PV_<uuid> sem timestamp', () => { expect(buildPedidoIntegrationCode(id)).toBe(`PV_${id}`); });
  it('cabe em 60 chars (limite Omie)', () => { expect(buildPedidoIntegrationCode(id).length).toBeLessThan(60); });
});
