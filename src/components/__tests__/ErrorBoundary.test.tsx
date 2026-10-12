import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { ErrorBoundary } from '../ErrorBoundary';
import { AppShellLayout } from '../AppShellLayout';

const captureException = vi.fn();
vi.mock('@/lib/analytics', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

// O shell real arrasta auth/telefonia/sidebar; aqui só importa que ele seja IRMÃO do conteúdo
// da rota — é o que o M-30 promete manter de pé quando a tela quebra.
vi.mock('../AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div>
      <nav>
        <Link to="/quebrada">ir quebrada</Link>
        <Link to="/boa">ir boa</Link>
      </nav>
      {children}
    </div>
  ),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isStaff: false }) }));

function Boom(): JSX.Element { throw new Error('explodiu'); }

describe('ErrorBoundary', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    captureException.mockClear();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('renderiza o fallback e reporta a exceção ao PostHog', () => {
    const { getByText } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(getByText('Algo deu errado')).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0];
    expect((err as Error).message).toBe('explodiu');
    expect(ctx).toHaveProperty('rota');
    expect(ctx).toHaveProperty('componentStack');
    expect(ctx).toHaveProperty('escopo', 'app');
  });

  it('escopo="rota" usa o fallback inline e marca o escopo no PostHog', () => {
    const { getByText, queryByText } = render(<ErrorBoundary escopo="rota"><Boom /></ErrorBoundary>);
    expect(getByText('Esta tela encontrou um erro')).toBeTruthy();
    expect(queryByText('Algo deu errado')).toBeNull();
    expect(captureException.mock.calls[0][1]).toHaveProperty('escopo', 'rota');
  });
});

describe('AppShellLayout — tela quebrada não derruba o shell (M-30)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    captureException.mockClear();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  function montar(inicial: string) {
    return render(
      <MemoryRouter initialEntries={[inicial]}>
        <Routes>
          <Route element={<AppShellLayout />}>
            <Route path="/quebrada" element={<Boom />} />
            <Route path="/boa" element={<p>tela boa</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it('o menu segue de pé e o erro fica contido no conteúdo', () => {
    const { getByText, queryByText } = montar('/quebrada');
    expect(getByText('Esta tela encontrou um erro')).toBeTruthy();
    expect(getByText('ir boa')).toBeTruthy();
    expect(queryByText('Algo deu errado')).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('navegar para outra rota limpa o erro (key = pathname)', () => {
    const { getByText, queryByText } = montar('/quebrada');
    fireEvent.click(getByText('ir boa'));
    expect(getByText('tela boa')).toBeTruthy();
    expect(queryByText('Esta tela encontrou um erro')).toBeNull();
  });
});
