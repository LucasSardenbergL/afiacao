import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — a RÉGUA DE MARGEM não pode sumir calada quando o cockpit não é lido.
 *
 * `usePrecoCockpit` LANÇA quando `get_preco_cockpit` falha (`if (error) throw error`), e os dois
 * consumidores desestruturavam só o `data`: `const { data: cockpitList } = usePrecoCockpit(...)`.
 * Com `data === undefined` some o badge de faixa, o `markup %`, a folga em R$ — e O PREÇO FICA
 * NA TELA. A ausência afirma "margem OK" exatamente onde o preço é decidido: 508 pedidos em 30
 * dias em `sales_orders` (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, item 1 da ordem
 * por dano). Classe: docs/agent/money-path.md §"A leitura que falha e vira silêncio afirmativo".
 *
 * O HOOK RODA DE VERDADE; só o supabase é mockado. Mockar `usePrecoCockpit` (como faz o
 * `CartItemList.priceGuard.test.tsx`, que devolve `{ data: undefined }` fixo) provaria apenas que
 * o componente renderiza um estado montado à mão — e o defeito mora justamente na tradução
 * "RPC falhou" → "data undefined" → "tela idêntica à da margem saudável".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta) },
}));
// Identidade real do usuário — o cockpit só a usa para isolar o cache por uid.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));
vi.mock('@/hooks/useUnifiedOrder', () => ({
  fmt: (v: number) => `R$ ${v}`,
  getToolName: () => 'Ferramenta',
}));
// Vizinhos do carrinho que puxam useQuery/useAuth próprios — mock vazio isola ESTA leitura.
vi.mock('@/hooks/useDefasagemCliente', () => ({
  useDefasagemCliente: () => ({ defasagemByKey: new Map(), isLoading: false }),
}));
vi.mock('@/hooks/useCustoPrazoRegua', () => ({
  useCustoPrazoRegua: () => ({ prazoDias: null, custoCapitalAnual: null }),
}));
vi.mock('@/hooks/useReguaPreco', () => ({
  useReguaPreco: () => ({ reguaByKey: new Map(), isLoading: false }),
}));
vi.mock('@/hooks/useReguaPrecoLog', () => ({
  useReguaPrecoLog: () => ({ marcarExibido: vi.fn(), marcarAplicado: vi.fn() }),
}));

import { CartItemList } from '../CartItemList';
import { ProductItemForm } from '../ProductItemForm';
import type { Product, ProductCartItem } from '@/hooks/unifiedOrder/types';

/** A frase do aviso — o que separa "não consegui ler" de "a margem está boa". */
const AVISO = /não quer dizer que está tudo certo/i;

const linha = (over: Record<string, unknown> = {}) => ({
  codigo: 1, empresa: 'oben', faixa: 'vermelho', motivo: 'abaixo do custo',
  tem_custo: true, tem_politica: true, calculated_at: '2026-09-06T00:00:00Z', tier: null,
  cmc: 8, markup_perc: 25, folga_reais: 2, piso_markup: 30, meta_markup: 40,
  proveniencia: 'cmc', frescor: 'fresco', ...over,
});

const produto: Product = {
  id: 'p1', codigo: 'C1', descricao: 'Lixa', unidade: 'UN', valor_unitario: 10,
  estoque: 5, ativo: true, omie_codigo_produto: 1, account: 'oben', is_tintometric: false,
};

function item(): ProductCartItem {
  return { type: 'product', product: produto, quantity: 1, unit_price: 10 } as unknown as ProductCartItem;
}

function novoQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function comQuery(ui: React.ReactElement, qc = novoQc()) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function renderCarrinho(qc?: QueryClient) {
  return comQuery(
    <CartItemList
      cart={{ length: 1 }}
      obenProductItems={[item()]}
      colacorProductItems={[]}
      serviceItems={[]}
      obenSubtotal={10}
      colacorProdSubtotal={0}
      serviceSubtotal={0}
      totalEstimated={10}
      deliveryOption="balcao"
      selectedTimeSlot=""
      onUpdateQuantity={vi.fn()}
      onUpdateProductPrice={vi.fn()}
      onRemoveFromCart={vi.fn()}
      getServicePrice={() => null}
      getCartIndex={() => 0}
      customerUserId="c1"
      customerName="Cliente"
    />,
    qc,
  );
}

function renderLista() {
  return comQuery(
    <ProductItemForm
      title="Oben"
      products={[produto]}
      prices={{}}
      loading={false}
      productSearch=""
      onSearchChange={vi.fn()}
      productItems={[]}
      onAddProduct={vi.fn()}
      customerUserId="c1"
    />,
  );
}

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('CartItemList — cockpit ilegível NÃO pode virar silêncio', () => {
  it('CONTROLE: leitura boa → a régua de margem aparece e NÃO há aviso', async () => {
    resposta = { data: [linha()], error: null };
    renderCarrinho();
    expect(await screen.findByText('Abaixo do custo')).toBeTruthy();
    expect(await screen.findByText(/25%/)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa — este é o defeito da classe (o preço fica, a régua some)', async () => {
    resposta = { data: null, error: { message: 'permission denied' } };
    renderCarrinho();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [linha()], error: null };
    renderCarrinho();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('DADO EM CACHE + offline no refetch: avisa SEM apagar a régua (o composto)', async () => {
    // Único ramo que `naoConsegui` não alcança: com dado já respondido o status é
    // 'success' (⇒ `estadoDeLeitura` = 'pronta') e só o `fetchStatus: 'paused'` denuncia
    // que a informação na tela é velha. Escolher entre a régua e o aviso seria trocar um
    // defeito por outro — o desenho mostra os DOIS (`estado-de-leitura.ts`, `desatualizado`).
    const qc = novoQc();
    resposta = { data: [linha()], error: null };
    renderCarrinho(qc);
    expect(await screen.findByText('Abaixo do custo')).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();

    onlineManager.setOnline(false);
    void qc.invalidateQueries();

    expect(await screen.findByText(AVISO)).toBeTruthy();
    // e a régua CONTINUA na tela, com o aviso ao lado
    expect(screen.getByText('Abaixo do custo')).toBeTruthy();
  });

  it('erro e faixa-neutra NÃO produzem a mesma tela (o colapso, medido)', async () => {
    // `neutro` é o silêncio LEGÍTIMO do cockpit: leu, e não há o que sinalizar.
    resposta = { data: [linha({ faixa: 'neutro' })], error: null };
    const neutra = renderCarrinho();
    await waitFor(() => expect(neutra.container.querySelector('[data-testid="aviso-cockpit-carrinho"]')).toBeNull());
    const telaNeutra = neutra.container.textContent;
    neutra.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderCarrinho();
    await screen.findByText(AVISO);
    expect(erro.container.textContent).not.toBe(telaNeutra);
  });
});

describe('ProductItemForm — cockpit ilegível NÃO pode virar silêncio', () => {
  it('CONTROLE: leitura boa → a faixa aparece na lista e NÃO há aviso', async () => {
    resposta = { data: [linha()], error: null };
    renderLista();
    expect(await screen.findByText('Abaixo do custo')).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa em vez de exibir o preço sem faixa nenhuma', async () => {
    resposta = { data: null, error: { message: 'permission denied' } };
    renderLista();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [linha()], error: null };
    renderLista();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });
});
