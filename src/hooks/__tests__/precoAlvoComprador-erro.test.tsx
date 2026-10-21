import { describe, it, expect, vi } from 'vitest';

// Simula o React Query depois de uma revalidação que FALHOU: o cache ainda tem o alvo antigo.
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: [{ empresa: 'oben', omieCodigoProduto: 10, ultimoPreco: 200, precoAlvo: 230, faixaMargem: 'verde', validoAte: '2026-12-31' }],
    isLoading: false,
    isError: true,
  }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { usePrecoAlvoComprador } from '@/hooks/usePrecoAlvoComprador';

describe('usePrecoAlvoComprador', () => {
  it('erro na revalidação não devolve o alvo do cache (repasse revogado sairia da RPC, mas seguiria na tela)', () => {
    const r = usePrecoAlvoComprador('c1', true);
    expect(r.erro).toBe(true);
    expect(r.alvos).toBeNull();
  });
});
