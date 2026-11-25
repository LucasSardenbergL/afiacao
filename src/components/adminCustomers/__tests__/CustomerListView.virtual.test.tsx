// Onda E, fatia 2: a lista é virtualizada pela janela. Só as linhas perto da tela existem no DOM, mas o
// leitor de tela, o teclado (J/K, Tab) e o link da linha continuam enxergando a lista INTEIRA.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { Customer, ClientScore } from '../types';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';

const usoMock = vi.fn();
vi.mock('@/lib/nav/sensor-clientes', async (original) => ({
  ...(await original<typeof import('@/lib/nav/sensor-clientes')>()),
  registrarUsoClientes: (u: unknown) => usoMock(u),
}));
vi.mock('@/lib/impersonation/useLenteAtiva', () => ({ useLenteAtiva: () => false }));
vi.mock('../useUltimoContato', () => ({
  useUltimoContato: () => ({
    porCliente: new Map(), estado: 'ok', estadoDe: () => 'ok', contexto: { escopoSemRegistro: false, soOsProprios: false },
  }),
}));

import { CustomerListView } from '../CustomerListView';

const ALTURA = 76;
const TOTAL = 2000;
let alturaOriginal: PropertyDescriptor | undefined;
let scrollToOriginal: typeof window.scrollTo;
let rectOriginal: typeof Element.prototype.getBoundingClientRect;

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom não faz layout: toda linha mede 0 e o virtualizer montaria tudo. Aqui cada linha mede 76px.
  alturaOriginal = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => ALTURA });
  // A rolagem da janela: `scrollTo` move o scrollY e avisa, como o navegador.
  // E o layout: no navegador o topo de um elemento SOBE ao rolar (rect.top = posição − scrollY). Sem
  // isto o jsdom diz topo 0 sempre, e a margem do corpo viraria o próprio scrollY.
  rectOriginal = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const top = -window.scrollY;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  // A altura do documento (o virtualizer limita a rolagem por ela): a lista inteira + folga.
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: () => (TOTAL + 20) * ALTURA });
  scrollToOriginal = window.scrollTo;
  window.scrollTo = ((arg: ScrollToOptions | number, y?: number) => {
    const topo = typeof arg === 'number' ? (y ?? 0) : (arg.top ?? 0);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: topo });
    window.dispatchEvent(new Event('scroll'));
  }) as typeof window.scrollTo;
});
afterAll(() => {
  if (alturaOriginal) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', alturaOriginal);
  window.scrollTo = scrollToOriginal;
  Element.prototype.getBoundingClientRect = rectOriginal;
  delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight;
  vi.unstubAllGlobals();
});
beforeEach(() => {
  usoMock.mockClear();
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

const cliente = (i: number): Customer => ({
  user_id: `c${i}`, name: `CLIENTE ${String(i).padStart(4, '0')}`, email: null, phone: null, document: null,
  customer_type: null, created_at: '2026-03-01T00:00:00Z', requires_po: false,
});
const score = (id: string): ClientScore => ({
  customer_user_id: id, health_score: 80, health_class: 'saudavel', churn_risk: 20, expansion_score: 5,
  priority_score: 50, avg_monthly_spend_180d: 1000, days_since_last_purchase: 10, category_count: 3,
  gross_margin_pct: 0.3, sales_history_status: 'ativo',
});

function setup() {
  const customers = Array.from({ length: TOTAL }, (_, i) => cliente(i));
  const onSelect = vi.fn();
  render(
    <ShortcutsRegistryProvider>
      <MemoryRouter initialEntries={['/admin/customers']}>
        <CustomerListView
          customers={customers}
          scores={new Map(customers.map((c) => [c.user_id, score(c.user_id)]))}
          loading={false} isError={false} onRetry={vi.fn()} total={TOTAL}
          isCarteira filtroNoServidor={false}
          onSelect={onSelect} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()}
        />
      </MemoryRouter>
    </ShortcutsRegistryProvider>,
  );
  return { onSelect };
}

const linhas = () => document.querySelectorAll('tbody tr[data-index]');
const focado = () => (document.activeElement as HTMLElement | null)?.dataset.indice;

describe('CustomerListView — lista virtualizada (onda E)', () => {
  it('monta só as linhas perto da tela, e diz ao leitor de tela o tamanho real', () => {
    setup();
    const n = linhas().length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(40); // antes: 2.000 <tr>
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', String(TOTAL + 1));
    expect(linhas()[0]).toHaveAttribute('aria-rowindex', '2');
    // A altura total segue no DOM (espaçador aria-hidden): barra de rolagem e scrollTo valem.
    const fim = document.querySelector('tbody tr[aria-hidden="true"] td') as HTMLElement;
    expect(parseInt(fim.style.height, 10)).toBeGreaterThan((TOTAL - 40) * ALTURA);
  });

  it('rolar troca as linhas montadas; o link e a posição do sensor são os da linha real', async () => {
    const { onSelect } = setup();
    act(() => { window.scrollTo({ top: 1000 * ALTURA }); });
    await waitFor(() => expect(screen.getByRole('link', { name: 'CLIENTE 1000' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'CLIENTE 0000' })).toBeNull();
    const link = screen.getByRole('link', { name: 'CLIENTE 1000' });
    expect(link).toHaveAttribute('href', '/admin/customers/c1000/360');
    expect(link.closest('tr')).toHaveAttribute('aria-rowindex', '1002');
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'c1000' }));
    expect(usoMock).toHaveBeenCalledWith(expect.objectContaining({ acao: 'cliente_aberto', posicao: 1001 }));
  });

  it('K sem foco vai ao ÚLTIMO da lista inteira (fora do DOM): rola até ele e foca', async () => {
    setup();
    expect(screen.queryByRole('link', { name: 'CLIENTE 1999' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => expect(focado()).toBe(String(TOTAL - 1)));
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => expect(focado()).toBe(String(TOTAL - 2)));
  });

  it('a linha com foco não desmonta quando sai da tela (o foco não cai no body)', async () => {
    setup();
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(focado()).toBe('0'));
    act(() => { window.scrollTo({ top: 1500 * ALTURA }); });
    await waitFor(() => expect(screen.getByRole('link', { name: 'CLIENTE 1500' })).toBeInTheDocument());
    expect(focado()).toBe('0');
    expect(screen.getByRole('link', { name: 'CLIENTE 0000' })).toBeInTheDocument();
    // J continua do focado (índice 1), não do topo da tela.
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(focado()).toBe('1'));
  });
});
