import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: vi.fn() } } }));

import { revelarClienteSelecionado } from '../revelar-cliente';
import type { OmieCustomer } from '../types';

const MASCARADO = {
  codigo_cliente: 42,
  razao_social: 'MARCENARIA X LTDA',
  nome_fantasia: 'X',
  cnpj_cpf: null as unknown as string,
  codigo_vendedor: 7,
  cidade: 'JOINVILLE',
  estado: 'SC',
  contato_visivel: false,
  local_user_id: 'u-1',
} satisfies OmieCustomer;

describe('revelarClienteSelecionado (onda D 4b-3)', () => {
  it('na carteira ou edge antiga: devolve o mesmo cliente sem chamar a edge', async () => {
    const invocar = vi.fn();
    const naCarteira = { ...MASCARADO, cnpj_cpf: '12345678000190', contato_visivel: true };
    expect(await revelarClienteSelecionado(naCarteira, invocar)).toBe(naCarteira);
    const { contato_visivel: _c, ...antigo } = naCarteira;
    expect(await revelarClienteSelecionado(antigo, invocar)).toBe(antigo);
    expect(invocar).not.toHaveBeenCalled();
  });

  it('fora da carteira: pede revelar_cliente pelo código e devolve o cadastro inteiro', async () => {
    const invocar = vi.fn().mockResolvedValue({
      data: { cliente: { codigo_cliente: 42, cnpj_cpf: '12.345.678/0001-90', telefone: '(47) 9', contato_visivel: true } },
      error: null,
    });
    const r = await revelarClienteSelecionado(MASCARADO, invocar);
    expect(invocar).toHaveBeenCalledWith({ action: 'revelar_cliente', codigo_cliente: 42 });
    expect(r.cnpj_cpf).toBe('12.345.678/0001-90');
    expect(r.contato_visivel).toBe(true);
    expect(r.local_user_id).toBe('u-1');
  });

  it('erro da edge LANÇA com a mensagem do servidor', async () => {
    const corpo = new Response(JSON.stringify({ error: '[revelar_cliente] limite diário' }));
    const invocar = vi.fn().mockResolvedValue({ data: null, error: { context: corpo } });
    await expect(revelarClienteSelecionado(MASCARADO, invocar)).rejects.toThrow('[revelar_cliente] limite diário');
  });

  it('resposta de OUTRO código ou ainda mascarada LANÇA (nunca segue com cadastro mascarado)', async () => {
    const outro = vi.fn().mockResolvedValue({ data: { cliente: { codigo_cliente: 43, contato_visivel: true } }, error: null });
    await expect(revelarClienteSelecionado(MASCARADO, outro)).rejects.toThrow('Não consegui abrir o cadastro deste cliente.');
    const fechado = vi.fn().mockResolvedValue({ data: { cliente: { codigo_cliente: 42, contato_visivel: false } }, error: null });
    await expect(revelarClienteSelecionado(MASCARADO, fechado)).rejects.toThrow('Não consegui abrir o cadastro deste cliente.');
    const vazio = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(revelarClienteSelecionado(MASCARADO, vazio)).rejects.toThrow('Não consegui abrir o cadastro deste cliente.');
  });
});
