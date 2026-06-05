import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

const captureException = vi.fn();
vi.mock('@/lib/analytics', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

function Boom(): JSX.Element { throw new Error('explodiu'); }

describe('ErrorBoundary', () => {
  beforeEach(() => captureException.mockClear());

  it('renderiza o fallback e reporta a exceção ao PostHog', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(getByText('Algo deu errado')).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0];
    expect((err as Error).message).toBe('explodiu');
    expect(ctx).toHaveProperty('rota');
    expect(ctx).toHaveProperty('componentStack');
    spy.mockRestore();
  });
});
