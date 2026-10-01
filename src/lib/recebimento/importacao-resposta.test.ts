import { describe, it, expect } from 'vitest';
import { interpretarImportacaoPorChave } from './importacao-resposta';

/** Forma do `FunctionsHttpError` do supabase-js: `context` é a Response crua (corpo ainda não lido). */
function erroHttp(status: number, corpo: unknown) {
  return {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } }),
  };
}

describe('interpretarImportacaoPorChave — só status da allowlist com itens contados é sucesso', () => {
  it('importada com itens é sucesso e fecha o diálogo', async () => {
    const v = await interpretarImportacaoPorChave({
      data: { status: 'importada', nfe_recebimento_id: 'nfe-1', itens: 12 },
      error: null,
    });
    expect(v).toStrictEqual({ tipo: 'sucesso', mensagem: 'NF-e importada — 12 itens', fecharDialogo: true });
  });

  it('já importada COM itens é informativo; SEM itens é aviso (a importação antiga falhou)', async () => {
    const com = await interpretarImportacaoPorChave({ data: { status: 'ja_importada', itens: 1 }, error: null });
    expect(com).toStrictEqual({ tipo: 'info', mensagem: 'Esta NF-e já foi importada (1 item)', fecharDialogo: true });

    const sem = await interpretarImportacaoPorChave({ data: { status: 'ja_importada', itens: 0 }, error: null });
    expect(sem.tipo).toBe('aviso');
    expect(sem.mensagem).toContain('SEM itens');
  });

  it('2xx sem o sinal (status desconhecido, itens ausente) é FALHA — ausência de sinal não é sucesso', async () => {
    for (const data of [{ status: 'importada' }, { status: 'outra_coisa', itens: 3 }, null, 'ok']) {
      const v = await interpretarImportacaoPorChave({ data, error: null });
      expect(v.tipo, JSON.stringify(data)).toBe('falha');
      expect(v.fecharDialogo).toBe(false);
    }
  });

  it('Omie ocupado (429 da edge) é aviso com o motivo da edge, e mantém o diálogo aberto', async () => {
    const v = await interpretarImportacaoPorChave({
      data: null,
      error: erroHttp(429, { status: 'omie_ocupado', error: 'O Omie pediu para aguardar 37 s antes de consultar de novo.' }),
    });
    expect(v).toStrictEqual({
      tipo: 'aviso',
      mensagem: 'O Omie pediu para aguardar 37 s antes de consultar de novo.',
      fecharDialogo: false,
    });
  });

  it('recusa da edge (≠2xx) mostra o motivo REAL do corpo, não a frase genérica do transporte', async () => {
    const v = await interpretarImportacaoPorChave({
      data: null,
      error: erroHttp(409, { status: 'ja_recebida_no_omie', error: 'a NF-e já foi recebida no Omie — não há conferência a fazer no app' }),
    });
    expect(v.tipo).toBe('falha');
    expect(v.mensagem).toBe('a NF-e já foi recebida no Omie — não há conferência a fazer no app');
    expect(v.mensagem).not.toContain('non-2xx');
  });

  it('erro sem corpo legível cai na mensagem do próprio erro', async () => {
    const v = await interpretarImportacaoPorChave({ data: null, error: new Error('Failed to fetch') });
    expect(v).toStrictEqual({ tipo: 'falha', mensagem: 'Failed to fetch', fecharDialogo: false });
  });
});
