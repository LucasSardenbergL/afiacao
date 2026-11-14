import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Vínculo com cliente na LISTA: uma chamada `radar_vinculos_por_cnpjs` por página. O que importa provar aqui é a
 * borda: erro e forma inesperada viram 'falhou' (a linha mostra "vínculo?"), nunca 'ok' sem dado ("sem vínculo"); e a
 * página respondida marca como 'ok' até quem não veio na resposta (esse, sim, não tem vínculo). Que o servidor aplica
 * as mesmas regras da ficha é a prova PG17 `db/test-radar-vinculos-em-lote.sh`.
 */
type Resposta = { data: unknown; error: { message: string } | null };
const chamadas: { fn: string; args: unknown; range: unknown[] }[] = [];
let resposta: Resposta = { data: [], error: null };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      const c = { fn, args, range: [] as unknown[] };
      chamadas.push(c);
      return { range: (...r: unknown[]) => { c.range = r; return Promise.resolve(resposta); } };
    },
  },
}));
import { useRadarVinculosLista } from '../useRadarVinculosLista';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
const PAGINA = [{ cnpj: '11111111000101' }, { cnpj: '12222222000101' }];

beforeEach(() => { chamadas.length = 0; });

describe('useRadarVinculosLista', () => {
  it('página respondida: quem veio tem resumo; quem não veio é "ok" sem dado (sem vínculo)', async () => {
    resposta = {
      data: [{ cnpj: '11111111000101', forca: 'forte', clientes: 1, clientes_nomes: ['C1 ANTIGA LTDA'], clientes_situacoes: ['08'] }],
      error: null,
    };
    const { result } = renderHook(() => useRadarVinculosLista([PAGINA]), { wrapper });
    await waitFor(() => expect(result.current.estadoDe('11111111000101')).toBe('ok'));
    expect(result.current.dados.get('11111111000101')).toEqual({ forca: 'forte', clientes: 1, nomes: ['C1 ANTIGA LTDA'], situacoes: ['08'] });
    expect(result.current.estadoDe('12222222000101')).toBe('ok');
    expect(result.current.dados.has('12222222000101')).toBe(false);
    expect(chamadas).toEqual([{ fn: 'radar_vinculos_por_cnpjs', args: { p_cnpjs: ['11111111000101', '12222222000101'] }, range: [0, 199] }]);
  });

  it('erro da RPC → "falhou" para a página inteira, nunca "ok"', async () => {
    resposta = { data: null, error: { message: 'forbidden: radar_prospectar' } };
    const { result } = renderHook(() => useRadarVinculosLista([PAGINA]), { wrapper });
    await waitFor(() => expect(result.current.estadoDe('12222222000101')).toBe('falhou'));
    expect(result.current.estadoDe('11111111000101')).toBe('falhou');
    expect(result.current.dados.size).toBe(0);
  });

  it('forma inesperada (sinal de contrato quebrado) → "falhou", não some em silêncio', async () => {
    resposta = { data: [{ cnpj: '11111111000101', forca: 'veredito', clientes: 1, clientes_nomes: ['X'], clientes_situacoes: ['02'] }], error: null };
    const { result } = renderHook(() => useRadarVinculosLista([PAGINA]), { wrapper });
    await waitFor(() => expect(result.current.estadoDe('11111111000101')).toBe('falhou'));
  });

  it('CNPJ de página ainda não lida = "carregando"', () => {
    const { result } = renderHook(() => useRadarVinculosLista([]), { wrapper });
    expect(result.current.estadoDe('11111111000101')).toBe('carregando');
  });

  it('lead que sai da página (contato registrado): mesma chave, zero RPC nova e nenhum selo volta a "carregando"', async () => {
    resposta = { data: [], error: null };
    const TRES = [...PAGINA, { cnpj: '13333333000101' }];
    // Um QueryClient só para o teste inteiro (o `wrapper` acima cria um por render).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fixo = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ p }) => useRadarVinculosLista([p]), { wrapper: fixo, initialProps: { p: TRES } });
    await waitFor(() => expect(result.current.estadoDe('13333333000101')).toBe('ok'));
    expect(chamadas).toHaveLength(1);
    rerender({ p: TRES.filter((e) => e.cnpj !== '12222222000101') });
    expect(result.current.estadoDe('11111111000101')).toBe('ok');
    expect(result.current.estadoDe('13333333000101')).toBe('ok');
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas).toHaveLength(1);
    // Página com CNPJ que o cache não cobre: chave própria e uma RPC, como antes.
    rerender({ p: [...PAGINA, { cnpj: '14444444000101' }] });
    await waitFor(() => expect(chamadas).toHaveLength(2));
  });
});

