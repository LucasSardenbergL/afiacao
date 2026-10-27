import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { lerTodas } from '../useRadarConflitosCadastro';

// Codex, revisão do código 2026-10-27 (P2-4): o PostgREST capa em 1.000 linhas calado — um conflito ABERTO depois
// de 1.000 registros resolvidos virava "sem pendência". A leitura pagina até a página curta e RECUSA passar do teto.
const linha = (id: number) => ({
  id, cnpj: '11111111000111', motivo: 'lookup_divergente', codigo_recebido: null, codigo_vinculado: null, cnpj_do_codigo: null,
  detalhe: 'x', ocorrencias: 1, versao: 1, ultima_em: '2026-10-27T15:00:00Z', resolvido_em: id <= 1000 ? '2026-10-27T16:00:00Z' : null,
  nota_resolucao: id <= 1000 ? 'ok' : null,
});

describe('lerTodas — sem recorte calado', () => {
  it('1.000 + 1 linhas → lê as duas páginas e o aberto da 2ª aparece', async () => {
    const pagina = vi.fn(async (de: number) => ({
      data: de === 0 ? Array.from({ length: 1000 }, (_v, i) => linha(i + 1)) : [linha(1001)],
      error: null,
    }));
    const todas = await lerTodas(pagina);
    expect(pagina).toHaveBeenCalledTimes(2);
    expect(todas).toHaveLength(1001);
    expect(todas.filter((c) => c.resolvidoEm === null).map((c) => c.id)).toEqual([1001]);
  });
  it('página sempre cheia além do teto → LANÇA (nunca devolve parcial)', async () => {
    const pagina = vi.fn(async (de: number) => ({ data: Array.from({ length: 1000 }, (_v, i) => linha(de + i + 1)), error: null }));
    await expect(lerTodas(pagina)).rejects.toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
  });
  it('erro de uma página propaga', async () => {
    await expect(lerTodas(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toEqual({ message: 'boom' });
  });
});
