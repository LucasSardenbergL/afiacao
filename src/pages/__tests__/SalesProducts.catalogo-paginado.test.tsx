import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// M-12: o catálogo de vendas lia `omie_products` num `select('*')` single-shot — o PostgREST capa
// em 1.000 linhas SEM erro, e com 3.715 SKUs (Oben) a tela listava 1.000 e dizia "1000 produtos".
// E a falha só ia pro console: a lista da conta ANTERIOR ficava na tela sob a aba nova.
//
// O mock pagina DE VERDADE pelo `.range(de, ate)` que recebe: devolver tudo de uma vez esconderia
// justamente o defeito (uma leitura sem `.range` ganharia o catálogo inteiro do mock).

type Linha = { id: string; codigo: string; descricao: string; unidade: string; valor_unitario: number; estoque: number; ativo: boolean; metadata: Record<string, unknown> };
type Chamada = { conta: unknown; range: [number, number] | null; ordem: Array<[string, boolean]> };

const CAPA_POSTGREST = 1000;
let catalogo: Record<string, Linha[]> = {};
let falhaNaPagina: number | null = null;
let chamadas: Chamada[] = [];
// Simula o sync gravando ENTRE duas páginas: roda depois que a 1ª página foi servida.
let aposPagina0: (() => void) | null = null;

// O mock aplica a ordem que recebeu, como o Postgres: ordenar por coluna MUTÁVEL é o que desloca
// linhas entre páginas quando alguém escreve no meio da leitura.
function ordenar(linhas: Linha[], ordem: Array<[string, boolean]>): Linha[] {
  return [...linhas].sort((a, b) => {
    for (const [col, asc] of ordem) {
      const va = a[col as keyof Linha] as string | boolean;
      const vb = b[col as keyof Linha] as string | boolean;
      if (va === vb) continue;
      return (va < vb ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
}

const sku = (conta: string, i: number): Linha => ({
  id: `${conta}-${String(i).padStart(5, '0')}`,
  codigo: `${conta.toUpperCase()}${i}`,
  descricao: `Produto ${conta} ${i}`,
  unidade: 'UN',
  valor_unitario: 10,
  estoque: 5,
  ativo: true,
  metadata: {},
});

function chain(): unknown {
  const registro: Chamada = { conta: undefined, range: null, ordem: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'not']) c[m] = () => c;
  c.order = (col: string, opts?: { ascending?: boolean }) => {
    registro.ordem.push([col, opts?.ascending !== false]);
    return c;
  };
  c.eq = (col: string, v: unknown) => {
    if (col === 'account') registro.conta = v;
    return c;
  };
  c.range = (de: number, ate: number) => {
    registro.range = [de, ate];
    return c;
  };
  c.then = (resolve: (v: unknown) => void) => {
    const linhas = ordenar(catalogo[String(registro.conta)] ?? [], registro.ordem);
    if (registro.range === null) return resolve({ data: linhas.slice(0, CAPA_POSTGREST), error: null });
    const [de, ate] = registro.range;
    if (falhaNaPagina !== null && de / CAPA_POSTGREST === falhaNaPagina) {
      return resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } });
    }
    resolve({ data: linhas.slice(de, Math.min(ate + 1, de + CAPA_POSTGREST)), error: null });
    if (de === 0 && aposPagina0) {
      aposPagina0();
      aposPagina0 = null;
    }
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => chain(), functions: { invoke: vi.fn() } },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isStaff: true, loading: false, role: 'employee' }),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import SalesProducts from '../SalesProducts';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SalesProducts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  catalogo = {
    oben: Array.from({ length: CAPA_POSTGREST + 1 }, (_, i) => sku('oben', i)),
    colacor: [sku('colacor', 1), sku('colacor', 2)],
  };
  falhaNaPagina = null;
  chamadas = [];
  aposPagina0 = null;
});

describe('SalesProducts — o catálogo inteiro da conta, não as 1.000 primeiras', () => {
  it('1.001 SKUs: a tela lista e conta TODOS (o 1.001º inclusive), lidos em 2 páginas', async () => {
    montar();
    expect(await screen.findByText('1001 produtos')).toBeTruthy();
    expect(screen.getByText('Produto oben 1000')).toBeTruthy();
    expect(chamadas.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('o sync INATIVA um produto entre as páginas: nenhum SKU some e nenhum aparece duas vezes', async () => {
    // Na ordem de exibição (ativos, descrição) "Produto oben 0" é o 1º e "Produto oben 999" o
    // 1.001º (ordem de texto). Paginar NESSA ordem: o 0 inativado salta pro fim, é relido na 2ª
    // página e o 999 cai na fronteira e nunca é lido — 1.001 linhas, 1.000 SKUs, sem erro.
    aposPagina0 = () => {
      catalogo.oben[0] = { ...catalogo.oben[0], ativo: false };
    };
    montar();
    expect(await screen.findByText('1001 produtos')).toBeTruthy();
    expect(screen.getByText('Produto oben 999')).toBeTruthy();
    expect(screen.getAllByText('Produto oben 0')).toHaveLength(1);
  });

  it('a 2ª página FALHA: aviso de leitura, sem contador e sem "Nenhum produto" — nunca as 1.000 como se fossem tudo', async () => {
    falhaNaPagina = 1;
    montar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(aviso.textContent).toContain('o catálogo da Oben');
    expect(screen.queryByText(/\d+ produtos/)).toBeNull();
    expect(screen.queryByText('Produto oben 0')).toBeNull();
    expect(screen.queryByText(/Nenhum produto/)).toBeNull();
  });

  it('trocar de aba mostra o catálogo da OUTRA conta — nunca a lista anterior sob a aba nova', async () => {
    montar();
    expect(await screen.findByText('1001 produtos')).toBeTruthy();

    const aba = screen.getByRole('tab', { name: /Colacor/ });
    fireEvent.mouseDown(aba, { button: 0 });
    fireEvent.click(aba);

    expect(await screen.findByText('2 produtos')).toBeTruthy();
    expect(screen.getByText('Produto colacor 1')).toBeTruthy();
    expect(screen.queryByText('Produto oben 0')).toBeNull();
    await waitFor(() => expect(chamadas.some((c) => c.conta === 'colacor')).toBe(true));
  });

  it('a falha na conta nova NÃO deixa a lista da conta anterior na tela', async () => {
    montar();
    expect(await screen.findByText('1001 produtos')).toBeTruthy();

    falhaNaPagina = 0;
    const aba = screen.getByRole('tab', { name: /Colacor/ });
    fireEvent.mouseDown(aba, { button: 0 });
    fireEvent.click(aba);

    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.textContent).toContain('o catálogo da Colacor');
    expect(screen.queryByText('Produto oben 0')).toBeNull();
    expect(screen.queryByText(/\d+ produtos/)).toBeNull();
  });
});
