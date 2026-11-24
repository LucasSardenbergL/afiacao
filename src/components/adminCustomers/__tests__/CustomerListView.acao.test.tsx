// Onda C: agir pela lista (ligar/WhatsApp na linha), nome como link real e nota compacta no celular.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Customer, ClientScore } from '../types';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';

const usoMock = vi.fn();
vi.mock('@/lib/nav/sensor-clientes', async (original) => ({
  ...(await original<typeof import('@/lib/nav/sensor-clientes')>()),
  registrarUsoClientes: (u: unknown) => usoMock(u),
}));
let lente = false;
vi.mock('@/lib/impersonation/useLenteAtiva', () => ({ useLenteAtiva: () => lente }));
// O dialer real (WebRTC, lazy) fica de fora: o teste toca o invólucro da linha (sem importar a telefonia,
// que é outro módulo — fronteira), e é nele que mora o sensor da tentativa.
vi.mock('../useUltimoContato', () => ({ useUltimoContato: () => ({ porCliente: new Map(), estado: 'ok', estadoDe: () => 'ok' }) }));

import { CustomerListView } from '../CustomerListView';

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
});
beforeEach(() => { usoMock.mockClear(); lente = false; });

const cliente = (id: string, nome: string, phone: string | null = null): Customer => ({
  user_id: id, name: nome, email: null, phone, document: null,
  customer_type: null, created_at: '2026-03-01T00:00:00Z', requires_po: false,
});
const score = (id: string, prioridade: number): ClientScore => ({
  customer_user_id: id, health_score: 80, health_class: 'saudavel', churn_risk: 20, expansion_score: 5,
  priority_score: prioridade, avg_monthly_spend_180d: 1000, days_since_last_purchase: 10, category_count: 3,
  gross_margin_pct: 0.3, sales_history_status: 'ativo',
});

function setup(customers: Customer[] = [cliente('c1', 'Alfa', '(48) 99999-0001'), cliente('c2', 'Beta')]) {
  const onSelect = vi.fn();
  render(
    <ShortcutsRegistryProvider>
      <MemoryRouter initialEntries={['/admin/customers']}>
        <CustomerListView
          customers={customers}
          scores={new Map(customers.map((c, i) => [c.user_id, score(c.user_id, 70 - i)]))}
          loading={false} isError={false} onRetry={vi.fn()} total={2}
          isCarteira={false} filtroNoServidor
          onSelect={onSelect} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()}
        />
      </MemoryRouter>
    </ShortcutsRegistryProvider>,
  );
  return { onSelect };
}

describe('CustomerListView — linha acessível (onda C)', () => {
  it('o nome é um LINK real para a 360 e o clique abre UMA vez (a linha não repete)', () => {
    const { onSelect } = setup();
    const link = screen.getByRole('link', { name: 'Alfa' });
    expect(link.getAttribute('href')).toBe('/admin/customers/c1/360');
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].user_id).toBe('c1');
  });

  it('Ctrl/Cmd+clique fica com o navegador (nova aba): a SPA não navega', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole('link', { name: 'Alfa' }), { ctrlKey: true });
    fireEvent.click(screen.getByRole('link', { name: 'Alfa' }), { metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('o clique em qualquer lugar da linha segue abrindo (conveniência do mouse)', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText('Beta').closest('tr')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('J leva o foco ao 1º nome e K volta; com o foco na busca a letra é da busca', () => {
    setup();
    fireEvent.keyDown(window, { key: 'j' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Alfa' }));
    fireEvent.keyDown(window, { key: 'j' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Beta' }));
    fireEvent.keyDown(window, { key: 'k' });
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Alfa' }));
    const busca = screen.getByRole('textbox');
    busca.focus();
    fireEvent.keyDown(busca, { key: 'j' });
    expect(document.activeElement).toBe(busca);
  });
});

describe('CustomerListView — agir pela lista (onda C)', () => {
  it('telefone vira Ligar + WhatsApp na linha, sem abrir a ficha', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getAllByTestId('ligar-na-linha')[0]);
    const wa = screen.getByRole('link', { name: 'WhatsApp de Alfa' });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/55/);
    fireEvent.click(wa);
    expect(onSelect).not.toHaveBeenCalled();
    expect(usoMock).toHaveBeenCalledWith({ acao: 'ficha_acao', ficha: 'lista', tipo: 'ligar', fase: 'tentativa' });
    expect(usoMock).toHaveBeenCalledWith({ acao: 'ficha_acao', ficha: 'lista', tipo: 'whatsapp', fase: 'tentativa' });
  });

  it('sem telefone, nenhuma ação de contato na linha', () => {
    setup([cliente('c2', 'Beta')]);
    expect(screen.queryByTestId('ligar-na-linha')).toBeNull();
    expect(screen.queryByRole('link', { name: /WhatsApp/ })).toBeNull();
  });

  it('na lente "Ver como" o WhatsApp fica desligado (sai do app como o master)', () => {
    lente = true;
    setup();
    expect(screen.queryByRole('link', { name: 'WhatsApp de Alfa' })).toBeNull();
    expect((screen.getByRole('button', { name: /WhatsApp de Alfa/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('celular: a nota da prioridade aparece compacta na célula do nome (a coluna some < md)', () => {
    setup();
    const compactas = screen.getAllByTestId('prioridade-compacta');
    expect(compactas).toHaveLength(2);
    expect(compactas[0].className).toContain('md:hidden');
    expect(compactas[0].textContent).toMatch(/Prioridade\s*70/);
  });
});
