import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { lerTodas } from '../useRadarConflitosCadastro';

// Codex, revisão do código 2026-10-27 (P2-4): o PostgREST capa em 1.000 linhas calado — um conflito ABERTO depois
// de 1.000 registros resolvidos virava "sem pendência". A leitura usa o fetchAllPages (até a página vazia; erro lança).
const linha = (id: number) => ({
  id, cnpj: '11111111000111', motivo: 'lookup_divergente', codigo_recebido: null, codigo_vinculado: null, cnpj_do_codigo: null,
  detalhe: 'x', ocorrencias: 1, versao: 1, ultima_em: '2026-10-27T15:00:00Z', resolvido_em: id <= 1000 ? '2026-10-27T16:00:00Z' : null,
  nota_resolucao: id <= 1000 ? 'ok' : null,
});

describe('lerTodas — sem recorte calado', () => {
  it('1.000 + 1 linhas → lê as duas páginas e o aberto da 2ª aparece', async () => {
    const pagina = vi.fn(async (de: number) => ({
      data: de === 0 ? Array.from({ length: 1000 }, (_v, i) => linha(i + 1)) : de === 1000 ? [linha(1001)] : [],
      error: null,
    }));
    const todas = await lerTodas(pagina, 'teste');
    expect(pagina.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(todas).toHaveLength(1001);
    expect(todas.filter((c) => c.resolvidoEm === null).map((c) => c.id)).toEqual([1001]);
  });
  it('erro na 2ª página LANÇA (nunca devolve a 1ª como se fosse tudo)', async () => {
    const pagina = vi.fn(async (de: number) => (de === 0
      ? { data: Array.from({ length: 1000 }, (_v, i) => linha(i + 1)), error: null }
      : { data: null, error: { message: 'boom' } }));
    await expect(lerTodas(pagina, 'teste')).rejects.toBeTruthy();
  });
  it('linha fora da forma → RADAR_RESPOSTA_INDETERMINADA', async () => {
    await expect(lerTodas(async (de: number) => ({ data: de === 0 ? [{ id: 'x' }] : [], error: null }), 'teste')).rejects.toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
  });
});
