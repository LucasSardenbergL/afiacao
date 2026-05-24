import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AplicacaoHeader } from "../AplicacaoHeader";

function setup(overrides: Partial<React.ComponentProps<typeof AplicacaoHeader>> = {}) {
  const props: React.ComponentProps<typeof AplicacaoHeader> = {
    ultimoSync: null,
    syncDesatualizado: false,
    onSincronizar: vi.fn(),
    sincronizarPending: false,
    onGerarFila: vi.fn(),
    gerarFilaPending: false,
    ...overrides,
  };
  render(<AplicacaoHeader {...props} />);
  return props;
}

describe("AplicacaoHeader", () => {
  it("mostra título e 'nunca' quando não há sync", () => {
    setup();
    expect(screen.getByText("Aplicação no Omie")).toBeTruthy();
    expect(screen.getByText("nunca")).toBeTruthy();
  });

  it("dispara onSincronizar e onGerarFila", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar agora/ }));
    fireEvent.click(screen.getByRole("button", { name: /Gerar fila/ }));
    expect(props.onSincronizar).toHaveBeenCalledTimes(1);
    expect(props.onGerarFila).toHaveBeenCalledTimes(1);
  });

  it("desabilita botões quando pending", () => {
    setup({ sincronizarPending: true, gerarFilaPending: true });
    expect(screen.getByRole("button", { name: /Sincronizar agora/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Gerar fila/ })).toHaveProperty("disabled", true);
  });
});
