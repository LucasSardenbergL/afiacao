import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EstadoAcoesSidebar } from "../EstadoAcoesSidebar";

const baseProps = {
  estado: "rascunho",
  isNew: false,
  itensAtivos: 2,
  itensConfirmados: 2,
  podeAtivar: true,
  podeCancelar: true,
  podeEncerrar: false,
  transitioning: false,
  onTransition: vi.fn(),
  onOpenCancel: vi.fn(),
};

describe("EstadoAcoesSidebar", () => {
  it("mostra o badge do estado traduzido", () => {
    render(<EstadoAcoesSidebar {...baseProps} estado="rascunho" />);
    expect(screen.getByText("Rascunho")).toBeTruthy();
  });

  it("em rascunho com podeAtivar: Ativar habilitado e sem Encerrar", () => {
    render(
      <EstadoAcoesSidebar
        {...baseProps}
        estado="rascunho"
        podeAtivar
        podeEncerrar={false}
      />,
    );
    const ativar = screen.getByRole("button", { name: /Ativar campanha/i });
    expect((ativar as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.queryByRole("button", { name: /Encerrar agora/i }),
    ).toBeNull();
  });

  it("desabilita Ativar quando !podeAtivar", () => {
    render(<EstadoAcoesSidebar {...baseProps} podeAtivar={false} />);
    const ativar = screen.getByRole("button", { name: /Ativar campanha/i });
    expect((ativar as HTMLButtonElement).disabled).toBe(true);
  });

  it("estado ativa: mostra Encerrar e Cancelar, esconde Ativar", () => {
    render(
      <EstadoAcoesSidebar
        {...baseProps}
        estado="ativa"
        podeAtivar={false}
        podeEncerrar
        podeCancelar
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Ativar campanha/i }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Encerrar agora/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Cancelar campanha/i }),
    ).toBeTruthy();
  });

  it("isNew: não renderiza ações nem contadores", () => {
    const { container } = render(
      <EstadoAcoesSidebar {...baseProps} isNew />,
    );
    expect(
      screen.queryByRole("button", { name: /Ativar campanha/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Cancelar campanha/i }),
    ).toBeNull();
    expect(container.textContent).not.toContain("ativos");
  });

  it("pluraliza o contador de itens", () => {
    const { container, rerender } = render(
      <EstadoAcoesSidebar {...baseProps} itensAtivos={1} />,
    );
    expect(container.textContent).toContain("item ativo");
    rerender(<EstadoAcoesSidebar {...baseProps} itensAtivos={2} />);
    expect(container.textContent).toContain("itens ativos");
  });

  it("dispara onTransition('ativa') ao clicar Ativar", () => {
    const onTransition = vi.fn();
    render(
      <EstadoAcoesSidebar
        {...baseProps}
        estado="rascunho"
        podeAtivar
        onTransition={onTransition}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Ativar campanha/i }));
    expect(onTransition).toHaveBeenCalledWith("ativa");
  });

  it("dispara onTransition('encerrada') e onOpenCancel", () => {
    const onTransition = vi.fn();
    const onOpenCancel = vi.fn();
    render(
      <EstadoAcoesSidebar
        {...baseProps}
        estado="ativa"
        podeAtivar={false}
        podeEncerrar
        podeCancelar
        onTransition={onTransition}
        onOpenCancel={onOpenCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Encerrar agora/i }));
    expect(onTransition).toHaveBeenCalledWith("encerrada");
    fireEvent.click(
      screen.getByRole("button", { name: /Cancelar campanha/i }),
    );
    expect(onOpenCancel).toHaveBeenCalledTimes(1);
  });
});
