import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequireAccess } from '../RequireAccess';

const mockAccess = vi.fn();
vi.mock('@/hooks/useAccess', () => ({ useAccess: () => mockAccess() }));
vi.mock('react-router-dom', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
  Outlet: () => <div data-testid="outlet" />,
}));

describe('RequireAccess', () => {
  beforeEach(() => mockAccess.mockReset());

  it('loading → não redireciona nem mostra conteúdo (placeholder null)', () => {
    mockAccess.mockReturnValue({ loading: true, can: () => false });
    const { container } = render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(screen.queryByTestId('kid')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('sem acesso → redireciona pra /', () => {
    mockAccess.mockReturnValue({ loading: false, can: () => false });
    render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.getByTestId('redirect').getAttribute('data-to')).toBe('/');
  });

  it('com acesso → renderiza os filhos', () => {
    mockAccess.mockReturnValue({ loading: false, can: (s: string) => s === 'financeiro' });
    render(<RequireAccess section="financeiro"><div data-testid="kid" /></RequireAccess>);
    expect(screen.getByTestId('kid')).toBeInTheDocument();
  });

  it('sem children → renderiza <Outlet/> quando tem acesso', () => {
    mockAccess.mockReturnValue({ loading: false, can: () => true });
    render(<RequireAccess section="vendas" />);
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
