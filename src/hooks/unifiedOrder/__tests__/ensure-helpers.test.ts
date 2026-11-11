import { describe, it, expect } from 'vitest';
import {
  avisoFalhaAutoCadastro,
  desfechoAutoCadastro,
  deveCriarClienteNaConta,
  MARCA_RAZAO_MASCARADA,
  payloadAutoCadastro,
} from '@/hooks/unifiedOrder/ensure-helpers';
import type { OmieCustomer } from '@/hooks/unifiedOrder/types';

describe('deveCriarClienteNaConta (tri-state do auto-cadastro)', () => {
  it('cria quando ausência foi CONFIRMADA (lookup ok, sem código, com documento)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: true, lookupFalhou: false }),
    ).toBe(true);
  });

  it('NÃO cria quando o código já existe (found)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: 12345, temDocumento: true, lookupFalhou: false }),
    ).toBe(false);
  });

  it('NÃO cria quando o lookup FALHOU — ausência não confirmada (anti-duplicação no Omie)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: true, lookupFalhou: true }),
    ).toBe(false);
  });

  it('NÃO cria sem documento (não há como cadastrar)', () => {
    expect(
      deveCriarClienteNaConta({ codigoExistente: null, temDocumento: false, lookupFalhou: false }),
    ).toBe(false);
  });

  it('undefined conta como não-resolvido (mesma semântica do !codigo original)', () => {
    expect(
      deveCriarClienteNaConta({
        codigoExistente: undefined,
        temDocumento: true,
        lookupFalhou: false,
      }),
    ).toBe(true);
  });
});

/** O que o supabase-js devolve quando a edge responde não-2xx: `error.message` genérico e a
 *  Response real em `context` (FunctionsHttpError). */
function erroHttp(status: number, corpo: string) {
  return {
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(corpo, { status, headers: { 'Content-Type': 'application/json' } }),
  };
}

const MSG_RAZAO =
  'RAZAO_MASCARADA: a razão social chegou com o CPF mascarado e nenhuma outra conta Omie do grupo tem este documento para dar a razão fiscal. Cadastre o cliente no Omie com a razão completa';

describe('desfechoAutoCadastro (A1: o front não engole o erro do auto-cadastro)', () => {
  it('omie-vendas-sync 500 com RAZAO_MASCARADA no corpo → falha com o motivo da edge e a marca reconhecida', async () => {
    const d = await desfechoAutoCadastro('colacor', {
      data: null,
      error: erroHttp(500, JSON.stringify({ error: MSG_RAZAO })),
    });
    expect(d).toEqual({ ok: false, conta: 'colacor', motivo: MSG_RAZAO, razaoMascarada: true });
  });

  it('omie-sync 200 com success:false → falha com o motivo do corpo (não "sem código")', async () => {
    const motivo = 'OMIE_LOOKUP_DIVERGENTE: o ListarClientes devolveu um cliente com OUTRO documento';
    const d = await desfechoAutoCadastro('afiacao', { data: { success: false, error: motivo }, error: null });
    expect(d).toEqual({ ok: false, conta: 'afiacao', motivo, razaoMascarada: false });
  });

  it('omie-sync success:false com RAZAO_MASCARADA → marca reconhecida na Afiação', async () => {
    const d = await desfechoAutoCadastro('afiacao', { data: { success: false, error: MSG_RAZAO }, error: null });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.razaoMascarada).toBe(true);
    expect(d.motivo.startsWith(MARCA_RAZAO_MASCARADA)).toBe(true);
  });

  it('success:false sem texto de erro → motivo explícito, nunca string vazia', async () => {
    const d = await desfechoAutoCadastro('afiacao', { data: { success: false, error: '  ' }, error: null });
    expect(d).toEqual({
      ok: false, conta: 'afiacao', motivo: 'o Omie recusou o cadastro sem detalhe', razaoMascarada: false,
    });
  });

  it('sucesso com código válido → ok com código e vendedor', async () => {
    const d = await desfechoAutoCadastro('colacor', {
      data: { success: true, codigo_cliente: 987654, codigo_vendedor: 42, created: true },
      error: null,
    });
    expect(d).toEqual({ ok: true, codigoCliente: 987654, codigoVendedor: 42 });
  });

  it('sucesso sem vendedor → vendedor null (ausente ≠ zero)', async () => {
    const d = await desfechoAutoCadastro('afiacao', {
      data: { success: true, codigo_cliente: 123, codigo_vendedor: null },
      error: null,
    });
    expect(d).toEqual({ ok: true, codigoCliente: 123, codigoVendedor: null });
  });

  it.each([
    ['sem codigo_cliente', { success: true }],
    ['codigo_cliente 0', { success: true, codigo_cliente: 0 }],
    ['codigo_cliente string', { success: true, codigo_cliente: '987654' }],
    ['data null sem error', null],
  ])('"sucesso" %s → falha "não devolveu o código" (era silêncio)', async (_n, data) => {
    const d = await desfechoAutoCadastro('colacor', { data, error: null });
    expect(d).toEqual({
      ok: false, conta: 'colacor', motivo: 'o Omie não devolveu o código do cliente', razaoMascarada: false,
    });
  });

  it('erro com corpo não-JSON → cai no error.message do supabase-js', async () => {
    const d = await desfechoAutoCadastro('colacor', { data: null, error: erroHttp(502, '<html>Bad Gateway</html>') });
    expect(d).toEqual({
      ok: false, conta: 'colacor', motivo: 'Edge Function returned a non-2xx status code', razaoMascarada: false,
    });
  });

  it('corpo com error vazio → não engole o fallback (cai no error.message)', async () => {
    const d = await desfechoAutoCadastro('colacor', { data: null, error: erroHttp(500, JSON.stringify({ error: '   ' })) });
    expect(d).toEqual({
      ok: false, conta: 'colacor', motivo: 'Edge Function returned a non-2xx status code', razaoMascarada: false,
    });
  });

  it('erro sem context nem message → motivo explícito', async () => {
    const d = await desfechoAutoCadastro('afiacao', { data: null, error: {} });
    expect(d).toEqual({
      ok: false, conta: 'afiacao', motivo: 'a função de cadastro respondeu com erro sem detalhe', razaoMascarada: false,
    });
  });
});

describe('avisoFalhaAutoCadastro (texto do toast)', () => {
  it('RAZAO_MASCARADA → orienta selecionar pela busca do Omie, sem repetir o código técnico', () => {
    const a = avisoFalhaAutoCadastro({ ok: false, conta: 'colacor', motivo: MSG_RAZAO, razaoMascarada: true });
    expect(a.titulo).toBe('Cliente sem cadastro na Colacor: razão com CPF mascarado');
    expect(a.descricao).toContain('Selecione o cliente pela busca (digite o CPF/CNPJ');
    expect(a.descricao).toContain('cadastre-o no Omie com a razão completa antes de lançar itens da Colacor');
    expect(a.descricao).not.toContain(MARCA_RAZAO_MASCARADA);
  });

  it('outra falha → mostra o motivo real da edge e o efeito no pedido', () => {
    const a = avisoFalhaAutoCadastro({
      ok: false, conta: 'afiacao', motivo: 'OMIE_LOOKUP_AMBIGUO: 2 códigos para o documento', razaoMascarada: false,
    });
    expect(a.titulo).toBe('Não foi possível cadastrar o cliente na Afiação');
    expect(a.descricao).toBe(
      'OMIE_LOOKUP_AMBIGUO: 2 códigos para o documento. Pedido com itens da Afiação fica bloqueado até o app confirmar um código válido do cliente nessa conta.',
    );
  });
});

describe('payloadAutoCadastro (a única leitura de razao_fiscal no front)', () => {
  const base = {
    codigo_cliente: 1,
    nome_fantasia: 'PEDRO ***456789**',
    cnpj_cpf: '12345678000199',
    codigo_vendedor: null,
  };

  it('MEI vindo da busca ao vivo: a razão FISCAL vai ao cadastro no Omie, não a exibida', () => {
    const cust = { ...base, razao_social: 'PEDRO ***456789**', razao_fiscal: 'PEDRO 12345678901' } as OmieCustomer;
    expect(payloadAutoCadastro(cust).razao_social).toBe('PEDRO 12345678901');
  });

  it('sem razao_fiscal (cliente do perfil, build velho): segue a exibida e a edge resolve a fiscal', () => {
    const cust = { ...base, razao_social: 'PEDRO ***456789**' } as OmieCustomer;
    expect(payloadAutoCadastro(cust).razao_social).toBe('PEDRO ***456789**');
  });

  it('fantasia mascarada na tela (telefone, CPF): o original vai ao cadastro', () => {
    const cust = { ...base, razao_social: 'DISK LTDA', nome_fantasia: 'DISK ***999988**', fantasia_fiscal: 'DISK 31999998888' } as OmieCustomer;
    expect(payloadAutoCadastro(cust).nome_fantasia).toBe('DISK 31999998888');
  });

  it('o payload não carrega o campo razao_fiscal em si (só o valor, no lugar da razão)', () => {
    const cust = { ...base, razao_social: 'PEDRO ***456789**', razao_fiscal: 'PEDRO 12345678901' } as OmieCustomer;
    expect(Object.keys(payloadAutoCadastro(cust))).not.toContain('razao_fiscal');
    expect(Object.keys(payloadAutoCadastro(cust))).not.toContain('fantasia_fiscal');
    expect(payloadAutoCadastro(cust).document).toBe('12345678000199');
  });
});
