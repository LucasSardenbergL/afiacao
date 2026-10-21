import { describe, expect, it } from 'vitest';
import { comNulo } from '@/lib/rpc-args';

// O valor do helper é de TIPO: as linhas `@ts-expect-error` abaixo são checadas pelo
// `bun run typecheck` (se a checagem afrouxar, o comentário vira erro "unused"). O `it` só
// prova que, em runtime, o objeto passa intacto (NULL explícito chega como NULL).
describe('comNulo', () => {
  it('devolve o mesmo objeto, com o NULL explícito preservado', () => {
    const args = comNulo<'farmer_geracao_registrar', 'p_motivo' | 'p_head_visto'>({
      p_motor: 'bundle',
      p_farmer_id: 'f',
      p_run_id: 'r',
      p_resultado: 'vazio',
      p_linhas_geradas: 0,
      p_motivo: null,
      p_head_visto: null,
    });
    expect(args).toEqual(expect.objectContaining({ p_motivo: null, p_head_visto: null }));
  });

  it('só as chaves nomeadas aceitam NULL; o resto segue checado contra o types.ts', () => {
    const base = { p_motor: 'bundle', p_farmer_id: 'f', p_run_id: 'r', p_resultado: 'vazio', p_linhas_geradas: 0 };
    // @ts-expect-error — `p_run_id` não foi reaberto para NULL.
    comNulo<'farmer_geracao_registrar', 'p_motivo'>({ ...base, p_run_id: null, p_motivo: null });
    // @ts-expect-error — chave inexistente na RPC.
    comNulo<'farmer_geracao_registrar', 'p_motivo'>({ ...base, p_motivo: null, p_inventada: 1 });
    // @ts-expect-error — chave nomeada é obrigatória: o call-site diz o NULL, não o omite.
    comNulo<'farmer_geracao_registrar', 'p_motivo'>({ ...base });
    expect(true).toBe(true);
  });
});
