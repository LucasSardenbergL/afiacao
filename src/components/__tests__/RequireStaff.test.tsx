import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireStaff } from '../RequireStaff';

const mockUseAuth = vi.fn();
const mockUseDisplayAccess = vi.fn();

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mockUseAuth() }));
// RequireStaff usa useDisplayAccess; sem lente display* === real
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => mockUseDisplayAccess() }));

function renderAtStaffRoute() {
  return render(
    <MemoryRouter initialEntries={['/staff']}>
      <Routes>
        <Route path="/" element={<div>HOME</div>} />
        <Route element={<RequireStaff />}>
          <Route path="/staff" element={<div>STAFF AREA</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireStaff', () => {
  it('loading → spinner (não mostra a área nem o home)', () => {
    mockUseAuth.mockReturnValue({ loading: true });
    mockUseDisplayAccess.mockReturnValue({ displayIsStaff: false, displayLoading: false });
    renderAtStaffRoute();
    expect(screen.queryByText('STAFF AREA')).toBeNull();
    expect(screen.queryByText('HOME')).toBeNull();
  });

  it('isStaff=true → renderiza a área (Outlet)', () => {
    mockUseAuth.mockReturnValue({ loading: false });
    mockUseDisplayAccess.mockReturnValue({ displayIsStaff: true, displayLoading: false });
    renderAtStaffRoute();
    expect(screen.getByText('STAFF AREA')).toBeTruthy();
  });

  it('isStaff=false (customer) → redireciona pra / (HOME)', () => {
    mockUseAuth.mockReturnValue({ loading: false });
    mockUseDisplayAccess.mockReturnValue({ displayIsStaff: false, displayLoading: false });
    renderAtStaffRoute();
    expect(screen.getByText('HOME')).toBeTruthy();
    expect(screen.queryByText('STAFF AREA')).toBeNull();
  });
});
