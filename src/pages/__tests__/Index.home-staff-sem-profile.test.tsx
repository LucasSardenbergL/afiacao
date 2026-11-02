import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Plano v4, lote 5 — C2 parte 1. O `useBasicProfile` só alimenta o CustomerDashboard; a home staff
// não o usa (aprovação vem do AuthContext). Antes o `isLoading` dele segurava o skeleton do staff
// — uma viagem a `profiles` no caminho crítico de quem nem lê o resultado.

let auth = { user: { id: 'u-staff' }, isStaff: true, loading: false };
let profileCarregando = true;
const chamadasProfile: Array<string | undefined> = [];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/queries/useProfile', () => ({
  useBasicProfile: (userId: string | undefined) => {
    chamadasProfile.push(userId);
    return profileCarregando
      ? { data: undefined, isLoading: true }
      : { data: { name: 'Cliente', customer_type: null, document: null }, isLoading: false };
  },
}));
vi.mock('@/queries/useOrders', () => ({ useCustomerPendingOrders: () => ({ data: [], isLoading: false }) }));
vi.mock('@/queries/useUserTools', () => ({ useUserToolsSummary: () => ({ data: [] }) }));
vi.mock('@/hooks/useMyCommercialRole', () => ({ useMyCommercialRole: () => ({ data: null, isLoading: false }) }));
vi.mock('@/hooks/useDisplayAccess', () => ({
  useDisplayAccess: () => ({ displayIsStaff: auth.isStaff, displayIsSalesOnly: false, displayLoading: false }),
}));
// Os dashboards são `lazy()` no Index. Mockar `@/components/dashboard/StaffDashboard` seria aresta
// deste teste (loja-afiacao) para o módulo farmer-inteligencia — vazamento de fronteira. Então o
// teste intercepta o `lazy` do React: nenhum dashboard real é carregado, e o stub diz QUAL o Index
// escolheu pelo alvo do loader. Sem `vi.mock` de módulo alheio.
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    lazy: (loader: () => Promise<unknown>) => {
      const alvo = /StaffDashboard/.test(String(loader)) ? 'cockpit-staff' : 'home-cliente';
      const Stub = ({ profile }: { profile?: { name: string } | null }) =>
        real.createElement('div', null, alvo === 'cockpit-staff' ? alvo : `${alvo}:${profile?.name ?? 'sem-profile'}`);
      return Stub;
    },
  };
});

import Index from '../Index';

function montar() {
  render(
    <MemoryRouter>
      <Index />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chamadasProfile.length = 0;
  profileCarregando = true;
  auth = { user: { id: 'u-staff' }, isStaff: true, loading: false };
});

describe('Index — home staff não espera o profile', () => {
  it('staff: renderiza o cockpit mesmo com o profile pendurado, e nem pede o profile', async () => {
    montar();
    expect(await screen.findByText('cockpit-staff')).toBeTruthy();
    expect(chamadasProfile.every((id) => id === undefined)).toBe(true);
  });
});

describe('Index — caminho do cliente igual', () => {
  beforeEach(() => {
    auth = { user: { id: 'u-cliente' }, isStaff: false, loading: false };
  });

  it('cliente: segura o skeleton enquanto o profile carrega', () => {
    montar();
    expect(chamadasProfile).toContain('u-cliente');
    expect(screen.queryByText(/home-cliente/)).toBeNull();
  });

  it('cliente: com o profile lido, a home recebe o profile', async () => {
    profileCarregando = false;
    montar();
    expect(await screen.findByText('home-cliente:Cliente')).toBeTruthy();
    expect(chamadasProfile).toContain('u-cliente');
  });
});
