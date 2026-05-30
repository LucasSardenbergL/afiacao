import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireStaff } from '../RequireStaff';
import { useAuth } from '@/contexts/AuthContext';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));

const mockUseAuth = vi.mocked(useAuth);

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route element={<RequireStaff />}>
          <Route path="/admin" element={<div>CONTEUDO STAFF</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireStaff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mostra spinner enquanto loading (não bloqueia antes do role resolver)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: true } as unknown as ReturnType<typeof useAuth>);
    const { container } = renderGuard();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO STAFF')).toBeNull();
    expect(screen.queryByText('Área restrita à equipe')).toBeNull();
  });

  it('bloqueia customer (loading=false, isStaff=false)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: false } as unknown as ReturnType<typeof useAuth>);
    renderGuard();
    expect(screen.getByText('Área restrita à equipe')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO STAFF')).toBeNull();
  });

  it('libera staff (loading=false, isStaff=true)', () => {
    mockUseAuth.mockReturnValue({ isStaff: true, loading: false } as unknown as ReturnType<typeof useAuth>);
    renderGuard();
    expect(screen.getByText('CONTEUDO STAFF')).toBeTruthy();
  });
});
