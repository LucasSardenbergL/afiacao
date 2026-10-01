import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClienteAPositivar } from '@/lib/positivacao/types';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { ClientesAPositivarCard } from '../ClientesAPositivarCard';

/**
 * O cabeçalho conta a CARTEIRA, não a lista. A RPC corta `a_positivar` em 200, e o cabeçalho
 * dizia "{clientes.length} clientes … sem pedido": os 3 farmers liam 200 com 1.179–2.388 sem
 * pedido (medido em 2026-09-30). Em /farmer/calls ele fica logo abaixo do placar — os dois
 * números tinham de bater. Ver docs/historico/positivacao-win-back-era-novos.md.
 */

const lista = (n: number): ClienteAPositivar[] =>
  Array.from({ length: n }, (_, i) => ({
    customer_user_id: `c-${i}`, nome: `Cliente ${i}`, revenue_potential: null, churn_risk: 50,
    recover_score: null, days_since_last_purchase: 300, priority_score: 46,
  }));

function montar(clientes: ClienteAPositivar[], total: number) {
  render(<MemoryRouter><ClientesAPositivarCard clientes={clientes} total={total} /></MemoryRouter>);
}

const COMEMORACAO = 'Toda a carteira elegível já comprou este mês. 🎯';

afterEach(cleanup);

describe('ClientesAPositivarCard — o total vem da carteira, não da lista cortada', () => {
  it('cabeçalho com o total sem pedido; a lista segue nos 30 primeiros', () => {
    montar(lista(200), 2388);
    expect(screen.getByText(/^2388 clientes da sua carteira ainda sem pedido/)).toBeTruthy();
    expect(screen.queryByText(/^200 clientes/)).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(30);
  });

  it('total 0: a carteira inteira comprou', () => {
    montar([], 0);
    expect(screen.getByText(COMEMORACAO)).toBeTruthy();
  });

  it('lista vazia com cliente sem pedido NÃO comemora — falta prioridade, não falta cliente', () => {
    montar([], 18);
    expect(screen.queryByText(COMEMORACAO)).toBeNull();
    expect(screen.getByText(/^18 clientes da sua carteira ainda sem pedido/)).toBeTruthy();
  });
});
