import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ItemRaioX, DecisaoRow } from '@/lib/reposicao/raio-x/tipos';

/**
 * Aba Raio-X (somente leitura). Guards: erro NUNCA vira o empty state "nada parado" (P1), ausente ≠ zero
 * (sem custo / Colacor sem NF), Colacor SC fora, estoque defasado avisa, "distorce o DIO" separado do total.
 */

type Retorno = {
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  placar: Record<string, unknown>;
  syncedHoras: number | null;
  isLoading: boolean;
  erro: (Error & { code?: string }) | null;
};

const PLACAR = {
  total: 1000, decidido: 400, pendente: 600, porDestino: { trocar: 400 }, topTotal: 700, topDecidido: 400,
  semCustoN: 2, distorceDio: 5000,
};
let ret: Retorno;
let empresaCtx = 'OBEN';
const useRaioXMock = vi.fn((_e: unknown) => ret);

vi.mock('@/components/reposicao/raioX/useRaioX', () => ({
  useRaioX: (e: unknown) => useRaioXMock(e),
  useRaioXMedicao: () => ({ linhas: [], isLoading: false, erro: null }),
}));
vi.mock('@/contexts/ReposicaoEmpresaContext', () => ({
  useReposicaoEmpresa: () => ({ empresa: empresaCtx, setEmpresa: () => {} }),
}));
vi.mock('@/components/reposicao/baixoGiro/useBaixoGiro', () => ({
  useBaixoGiro: () => ({
    rows: [], total: 0, truncado: false, isLoading: false, error: null, refetch: vi.fn(),
    kpis: { capitalParado: 0, itensCauda: 0 },
    manterEmEstoque: { isPending: false, mutate: vi.fn() },
    descontinuar: { mutate: vi.fn() }, descontinuarLote: { mutate: vi.fn() }, sobEncomendaLote: { mutate: vi.fn() },
  }),
}));
vi.mock('@/components/reposicao/baixoGiro/useExcessoEstoque', () => ({
  useExcessoEstoque: () => ({ rows: [], kpis: { skusN: 0 }, isLoading: false, error: null }),
}));
vi.mock('@/components/reposicao/baixoGiro/BaixoGiroKpis', () => ({ BaixoGiroKpis: () => null }));
vi.mock('@/components/reposicao/baixoGiro/ExcessoKpis', () => ({ ExcessoKpis: () => null }));
vi.mock('@/components/reposicao/baixoGiro/DesovaMissaoDialog', () => ({ DesovaMissaoDialog: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import AdminReposicaoBaixoGiro from '../AdminReposicaoBaixoGiro';

const item = (p: Partial<ItemRaioX>): ItemRaioX => ({
  sku_codigo_omie: 1, codigo: 'C1', descricao: 'VERNIZ X', familia: null, tipo_produto: '00', ativo: true,
  saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: null, no_motor: true, tipo_reposicao: null,
  classe_abc: null, cadastro_em: null, ult_entrada: null, fornecedor: 'SAYERLACK', q12: 0, ncli: 0,
  ult_venda: null, preco_medio_12m: null, clientes: [{ nome: 'CLIENTE A', ult: '2026-01-01', qtd: 3 }],
  synced_at: null, habilitado_reposicao_automatica: true, valor: 50, cobertura: null,
  categoria: 'mercadoria', motivo_categoria: '', parado: true, destino_sugerido: 'liquidar',
  motivo_destino: '', top: true, ...p,
});

const abrirAba = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidar = vi.spyOn(qc, 'invalidateQueries');
  const arvore = () => <QueryClientProvider client={qc}><MemoryRouter><AdminReposicaoBaixoGiro /></MemoryRouter></QueryClientProvider>;
  const r = render(arvore());
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Raio-X' }), { button: 0 });
  return { invalidar, rerender: () => r.rerender(arvore()) };
};

beforeEach(() => {
  empresaCtx = 'OBEN';
  useRaioXMock.mockClear();
  ret = { itens: [item({})], decisoes: new Map(), placar: PLACAR, syncedHoras: 1, isLoading: false, erro: null };
});

describe('aba Raio-X', () => {
  it('DETECTOR: caminho feliz mostra o item e o placar', () => {
    abrirAba();
    expect(screen.getByText('VERNIZ X')).toBeTruthy();
    expect(screen.getByText(/sem custo — não avaliado/)).toBeTruthy();
  });

  it('(a) erro na RPC → "Não foi possível carregar o Raio-X", nunca o empty "nada parado"', () => {
    ret = { ...ret, itens: [], erro: new Error('boom') };
    abrirAba();
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível carregar o Raio-X/);
    expect(screen.queryByText(/nada parado/i)).toBeNull();
  });

  it('P1: 42501 → "sem permissão para ver custo"', () => {
    const e = Object.assign(new Error('x'), { code: '42501' });
    ret = { ...ret, itens: [], erro: e };
    abrirAba();
    expect(screen.getByRole('alert').textContent).toMatch(/sem permissão para ver custo/);
    expect(screen.queryByText(/nada parado/i)).toBeNull();
  });

  it('sem erro e sem itens parados → empty state legítimo', () => {
    ret = { ...ret, itens: [] };
    abrirAba();
    expect(screen.getByText(/nada parado/i)).toBeTruthy();
  });

  it('(b) colacor_sc → fora do Raio-X por ora, e o hook recebe null', () => {
    empresaCtx = 'COLACOR_SC';
    abrirAba();
    expect(screen.getByText(/fora do Raio-X por ora/)).toBeTruthy();
    expect(useRaioXMock).toHaveBeenLastCalledWith(null);
  });

  it('(c) syncedHoras=30 → aviso de defasagem; 1 h não avisa', () => {
    ret = { ...ret, syncedHoras: 30 };
    abrirAba();
    expect(screen.getByText(/estoque sincronizado há 30 h/)).toBeTruthy();
  });

  it('syncedHoras=1 não mostra aviso', () => {
    abrirAba();
    expect(screen.queryByText(/estoque sincronizado há/)).toBeNull();
  });

  it('(d) "distorce o DIO" aparece separado do total', () => {
    abrirAba();
    expect(screen.getByText(/distorce o DIO/)).toBeTruthy();
    expect(screen.getByTestId('placar-dio').textContent).toMatch(/5\.000/);
    expect(screen.getByTestId('placar-total').textContent).not.toMatch(/6\.000/);
    expect(screen.getByTestId('placar-total').textContent).toMatch(/1\.000/);
  });

  it('(e) item Colacor sem NF mostra "sem histórico de venda (NF)"', () => {
    empresaCtx = 'COLACOR';
    ret = { ...ret, itens: [item({ q12: null, ncli: null, clientes: null })] };
    abrirAba();
    expect(screen.getAllByText(/sem histórico de venda \(NF\)/).length).toBeGreaterThan(0);
  });

  it('valor null nunca vira R$ 0', () => {
    ret = { ...ret, itens: [item({ valor: null, cmc: null })] };
    abrirAba();
    expect(screen.getAllByText(/sem custo — não avaliado/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/R\$\s?0,00/)).toBeNull();
  });

  it('linha expande para os top 5 clientes', () => {
    ret = { ...ret, itens: [item({ clientes: Array.from({ length: 7 }, (_, i) => ({ nome: `CLI${i}`, ult: null, qtd: 7 - i })) })] };
    abrirAba();
    fireEvent.click(screen.getByRole('button', { name: /VERNIZ X/ }));
    expect(screen.getByText('CLI0')).toBeTruthy();
    expect(screen.getByText('CLI4')).toBeTruthy();
    expect(screen.queryByText('CLI5')).toBeNull();
  });

  it('segmento uso mostra qtd contada e diferença de decisão já gravada, com campo de contagem editável', () => {
    ret = {
      ...ret,
      itens: [item({ categoria: 'uso_consumo', parado: false, saldo: 10, cmc: 5, motivo_categoria: 'regra X' })],
      decisoes: new Map([[1, { qtd_contada: 8 } as DecisaoRow]]),
    };
    abrirAba();
    fireEvent.click(screen.getByRole('button', { name: /Uso e consumo/ }));
    expect(screen.getByText('regra X')).toBeTruthy();
    expect(screen.getByTestId('dif-un-1').textContent).toMatch(/-2/);
    expect((screen.getByRole('textbox', { name: 'Qtd contada C1' }) as HTMLInputElement).value).toBe('8');
  });

  it('(S4) filtro de destino oferece os 9 valores e filtra pelo destino DECIDIDO quando houver', () => {
    ret = {
      ...ret,
      itens: [
        item({ sku_codigo_omie: 1, codigo: 'C1', descricao: 'SUGERIDO LIQUIDAR', destino_sugerido: 'liquidar' }),
        item({ sku_codigo_omie: 2, codigo: 'C2', descricao: 'DECIDIDO TROCAR', destino_sugerido: 'liquidar' }),
        item({ sku_codigo_omie: 3, codigo: 'C3', descricao: 'REVISAR', destino_sugerido: 'revisar' }),
      ],
      decisoes: new Map([[2, { sku_codigo_omie: 2, destino: 'trocar' } as DecisaoRow]]),
    };
    abrirAba();
    const sel = screen.getByRole('combobox', { name: 'Destino' }) as HTMLSelectElement;
    expect(sel.options.length).toBe(10); // "Todos" + 9
    fireEvent.change(sel, { target: { value: 'liquidar' } });
    expect(screen.getByText('SUGERIDO LIQUIDAR')).toBeTruthy();
    expect(screen.queryByText('DECIDIDO TROCAR')).toBeNull();
    fireEvent.change(sel, { target: { value: 'trocar' } });
    expect(screen.getByText('DECIDIDO TROCAR')).toBeTruthy();
    expect(screen.queryByText('SUGERIDO LIQUIDAR')).toBeNull();
    fireEvent.change(sel, { target: { value: 'revisar' } });
    expect(screen.getByText('REVISAR')).toBeTruthy();
  });

  it('(S4) filtro de fornecedor usa o fornecedor informado quando houver', () => {
    ret = {
      ...ret,
      itens: [
        item({ sku_codigo_omie: 1, codigo: 'C1', descricao: 'DO CADASTRO', fornecedor: 'SAYERLACK' }),
        item({ sku_codigo_omie: 2, codigo: 'C2', descricao: 'INFORMADO', fornecedor: null }),
      ],
      decisoes: new Map([[2, { sku_codigo_omie: 2, destino: null, fornecedor_informado: 'ACRE' } as DecisaoRow]]),
    };
    abrirAba();
    const sel = screen.getByRole('combobox', { name: 'Fornecedor' }) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'ACRE', 'SAYERLACK']);
    fireEvent.change(sel, { target: { value: 'ACRE' } });
    expect(screen.getByText('INFORMADO')).toBeTruthy();
    expect(screen.queryByText('DO CADASTRO')).toBeNull();
  });

  it('(FI1) abrir o Sheet relê o servidor; decisão nova de outro operador → aviso e Salvar bloqueado', () => {
    const d0 = { sku_codigo_omie: 1, destino: 'liquidar', observacao: 'A', atualizado_em: '2026-10-18T10:00:00Z' } as DecisaoRow;
    ret = { ...ret, decisoes: new Map([[1, d0]]) };
    const { invalidar, rerender } = abrirAba();
    fireEvent.click(screen.getByRole('button', { name: 'Decidir C1' }));
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ['raio-x', 'oben'] });
    expect(screen.queryByText('Esta decisão mudou enquanto o painel estava aberto — recarregue')).toBeNull();
    // o refetch disparado pela invalidação traz o que o operador B gravou
    ret = { ...ret, decisoes: new Map([[1, { ...d0, observacao: 'gravado por B', atualizado_em: '2026-10-18T10:05:00Z' }]]) };
    rerender();
    expect(screen.getByText('Esta decisão mudou enquanto o painel estava aberto — recarregue')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Salvar decisão' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('botão "Decidir" da linha abre o Sheet do item', () => {
    abrirAba();
    fireEvent.click(screen.getByRole('button', { name: 'Decidir C1' }));
    expect(screen.getByRole('button', { name: 'Salvar decisão' })).toBeTruthy();
  });
});
