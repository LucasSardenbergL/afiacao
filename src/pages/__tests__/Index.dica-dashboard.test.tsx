import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CHAVE_DICA_DASHBOARD } from '@/pages/home/dashboards-home';

// Plano v5, lote 6b. O chunk do dashboard pode baixar antes do auth (pela dica), mas QUEM
// renderiza continua sendo o Index, atrás do auth e do papel. E o Index grava a dica do
// próximo boot a partir da MESMA decisão que usa para renderizar.

type Estado = {
  auth: { user: { id: string } | null; isStaff: boolean; loading: boolean };
  cargo: { data: string | null; isLoading: boolean };
  display: { displayIsStaff: boolean; displayIsSalesOnly: boolean; displayLoading: boolean };
};
const e = vi.hoisted(() => ({ atual: null as unknown as Estado }));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => e.atual.auth }));
vi.mock('@/queries/useProfile', () => ({ useBasicProfile: () => ({ data: null, isLoading: false }) }));
vi.mock('@/queries/useOrders', () => ({ useCustomerPendingOrders: () => ({ data: [], isLoading: false }) }));
vi.mock('@/queries/useUserTools', () => ({ useUserToolsSummary: () => ({ data: [] }) }));
vi.mock('@/hooks/useMyCommercialRole', () => ({ useMyCommercialRole: () => e.atual.cargo }));
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => e.atual.display }));
// Stubs nos carregadores do mesmo módulo (sem aresta para farmer-inteligencia). Os contadores
// provam que o chunk do staff não é pedido por render quando o Index não escolhe o staff.
const pedidos = vi.hoisted(() => ({ staff: 0, cliente: 0 }));
vi.mock('@/pages/home/dashboards-home', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/pages/home/dashboards-home')>();
  return {
    ...real,
    carregarStaffDashboard: () => {
      pedidos.staff += 1;
      return Promise.resolve({ default: () => <div>cockpit-staff</div> });
    },
    carregarCustomerDashboard: () => {
      pedidos.cliente += 1;
      return Promise.resolve({ default: () => <div>home-cliente</div> });
    },
  };
});

import Index from '../Index';

const esperar = () => new Promise((r) => setTimeout(r, 20));

function montar() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/meu-dia" element={<div>meu-dia</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const master = (): Estado => ({
  auth: { user: { id: 'u-master' }, isStaff: true, loading: false },
  cargo: { data: null, isLoading: false },
  display: { displayIsStaff: true, displayIsSalesOnly: false, displayLoading: false },
});

beforeEach(() => {
  localStorage.clear();
  pedidos.staff = 0;
  pedidos.cliente = 0;
  e.atual = master();
});

describe('Index: o dashboard só renderiza depois do auth e do papel', () => {
  it('auth carregando: skeleton, nenhum chunk pedido pelo render, dica intacta', async () => {
    localStorage.setItem(CHAVE_DICA_DASHBOARD, 'cliente');
    e.atual.auth = { user: null, isStaff: false, loading: true };
    montar();
    await esperar();
    expect(screen.queryByText('cockpit-staff')).toBeNull();
    expect(screen.queryByText('home-cliente')).toBeNull();
    expect(pedidos).toEqual({ staff: 0, cliente: 0 });
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBe('cliente');
  });

  it('staff com o cargo comercial carregando: skeleton, sem cockpit e sem mexer na dica', async () => {
    localStorage.setItem(CHAVE_DICA_DASHBOARD, 'staff');
    e.atual.cargo = { data: null, isLoading: true };
    montar();
    await esperar();
    expect(screen.queryByText('cockpit-staff')).toBeNull();
    expect(pedidos.staff).toBe(0);
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBe('staff');
  });

  it('não-staff, mesmo com dica staff: home do cliente, nunca o cockpit, e a dica vira cliente', async () => {
    localStorage.setItem(CHAVE_DICA_DASHBOARD, 'staff');
    e.atual.auth = { user: { id: 'u-cliente' }, isStaff: false, loading: false };
    e.atual.display = { displayIsStaff: false, displayIsSalesOnly: false, displayLoading: false };
    montar();
    expect(await screen.findByText('home-cliente')).toBeTruthy();
    expect(screen.queryByText('cockpit-staff')).toBeNull();
    expect(pedidos.staff).toBe(0);
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBe('cliente');
  });

  it('master: cockpit, e a dica do próximo boot vira staff', async () => {
    montar();
    expect(await screen.findByText('cockpit-staff')).toBeTruthy();
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBe('staff');
  });

  it('vendedora: redireciona para /meu-dia, não pede o cockpit e remove a dica', async () => {
    localStorage.setItem(CHAVE_DICA_DASHBOARD, 'staff');
    e.atual.cargo = { data: 'farmer', isLoading: false };
    montar();
    expect(await screen.findByText('meu-dia')).toBeTruthy();
    expect(pedidos.staff).toBe(0);
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBeNull();
  });

  it('lente "Ver como" master→cliente: o Index segue o papel REAL (cockpit) e a dica é staff', async () => {
    e.atual.display = { displayIsStaff: false, displayIsSalesOnly: false, displayLoading: false };
    montar();
    expect(await screen.findByText('cockpit-staff')).toBeTruthy();
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBe('staff');
  });
});
