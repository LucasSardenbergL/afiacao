import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codigoObenDoBuscarCliente } from '../codigo-oben-busca';

// Codex retroativo do #3311: o pedido por IA (conta Oben) lia `data.codigo_cliente`, mas a action
// `buscar_cliente` devolve `{ success, cliente: { codigo_cliente, ... } }` — lookup certo virava 0.
describe('codigoObenDoBuscarCliente', () => {
  it('lookup bem-sucedido devolve o código aninhado em cliente', () => {
    const data = { success: true, cliente: { codigo_cliente: 777, codigo_vendedor: 12, razao_social: 'X', cnpj_cpf: '1' } };
    expect(codigoObenDoBuscarCliente({ data, error: null })).toBe(777);
  });

  it('ausência provada (cliente null) → null', () => {
    expect(codigoObenDoBuscarCliente({ data: { success: true, cliente: null }, error: null })).toBeNull();
  });

  it('erro do invoke (ex.: OMIE_LOOKUP_DIVERGENTE) → null, mesmo se vier data', () => {
    const error = new Error('OMIE_LOOKUP_DIVERGENTE (oben): outro documento');
    const data = { success: true, cliente: { codigo_cliente: 777 } };
    expect(codigoObenDoBuscarCliente({ data, error })).toBeNull();
  });

  it('código plano (formato do criar_cliente) NÃO é aceito como resposta do buscar_cliente', () => {
    expect(codigoObenDoBuscarCliente({ data: { success: true, codigo_cliente: 777 }, error: null })).toBeNull();
  });

  it.each([0, -1, 1.5, '777', null, Number.MAX_SAFE_INTEGER + 1])('código inválido %p → null', (codigo) => {
    expect(codigoObenDoBuscarCliente({ data: { cliente: { codigo_cliente: codigo } }, error: null })).toBeNull();
  });

  it('data ausente → null', () => {
    expect(codigoObenDoBuscarCliente({ data: null, error: null })).toBeNull();
  });
});

describe('amarração: hook e edge falam o mesmo contrato', () => {
  const raiz = resolve(__dirname, '../../../..');
  const hook = readFileSync(resolve(raiz, 'src/hooks/useUnifiedOrder.ts'), 'utf8');
  const edge = readFileSync(resolve(raiz, 'supabase/functions/omie-vendas-sync/index.ts'), 'utf8');

  it('handleAICustomerSelect deriva o código Oben pelo helper, a partir do invoke inteiro (data+error)', () => {
    const corpo = hook.slice(hook.indexOf('const handleAICustomerSelect'), hook.indexOf('const selectCustomerByUserId'));
    expect(corpo).toMatch(/const resposta = await supabase\.functions\.invoke\('omie-vendas-sync'/);
    expect(corpo).toContain('codigoCliente = codigoObenDoBuscarCliente(resposta);');
    expect(corpo).not.toMatch(/omieResult\?\.codigo_cliente/);
  });

  it('a action buscar_cliente devolve o cliente ANINHADO', () => {
    const caso = edge.slice(edge.indexOf('case "buscar_cliente": {'), edge.indexOf('case "criar_cliente": {'));
    expect(caso).toContain('result = { success: true, cliente };');
  });
});
