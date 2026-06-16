import { Component, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { expect, vi } from 'vitest';

interface BoundaryProps {
  onError: (error: Error) => void;
  children: ReactNode;
}

class CaptureBoundary extends Component<BoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/**
 * Renderiza `ui` que SABIDAMENTE lança no render (ex: consumir um Context fora
 * do seu Provider) e afirma a mensagem do erro — capturando via Error Boundary.
 *
 * Por que NÃO `expect(() => render(ui)).toThrow()`:
 * Quando um componente lança no render e a árvore NÃO tem um Error Boundary,
 * o React 18 (build dev) trata o erro como "uncaught" e o re-superficializa de
 * forma ASSÍNCRONA no handler global de `error` da window (pra DevTools/overlays
 * via o fake-event trick do `invokeGuardedCallbackDev`). O ambiente jsdom do
 * vitest converte qualquer erro de window em `process.uncaughtException` sempre
 * que nenhum listener de `error` do usuário está ativo naquele instante
 * (`catchWindowErrors` → `userErrorListenerCount === 0`), e atribui esse erro ao
 * teste que ESTIVER rodando no worker no momento. Como o disparo é assíncrono,
 * a vítima é um teste ALEATÓRIO e não-relacionado → falha flaky cross-test.
 *
 * Capturar o throw com um Error Boundary faz o React seguir o caminho
 * RECUPERÁVEL (`createClassErrorUpdate`), que NÃO chama `onUncaughtError` nem
 * re-superficializa o erro globalmente. O guard continua validado de forma
 * determinística, sem vazar pro resto do suite.
 */
export function expectRenderToThrow(ui: ReactElement, message: RegExp): void {
  const captured: { error: Error | null } = { error: null };
  // O React ainda loga o stack via console.error (logCapturedError) ao recuperar
  // de um boundary — silencia o ruído sem mascarar erros reais de outros testes.
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <CaptureBoundary
        onError={(e) => {
          captured.error = e;
        }}
      >
        {ui}
      </CaptureBoundary>
    );
  } finally {
    errSpy.mockRestore();
  }
  expect(captured.error).not.toBeNull();
  expect(captured.error?.message).toMatch(message);
}
