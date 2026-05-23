import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmacaoDialog } from "../ConfirmacaoDialog";

function noop() { /* */ }

describe("ConfirmacaoDialog", () => {
  it("fechado (acaoConfirm=null) → não renderiza", () => {
    render(<ConfirmacaoDialog acaoConfirm={null} onClose={noop} selecionadosCount={0} justificativa="" setJustificativa={noop} onConfirm={noop} isPending={false} />);
    expect(screen.queryByText(/Confirmar/)).toBeNull();
  });

  it("excluir em lote → título, contagem, aviso e Confirmar dispara onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ tipo: "excluir", lote: true }}
        onClose={noop}
        selecionadosCount={4}
        justificativa=""
        setJustificativa={noop}
        onConfirm={onConfirm}
        isPending={false}
      />
    );
    expect(screen.getByText(/Confirmar exclusão/)).toBeTruthy();
    expect(screen.getByText(/Aplicar a 4 alerta\(s\)/)).toBeTruthy();
    expect(screen.getByText(/remove os eventos do cálculo estatístico/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("aceitar individual → título de aceitação, sem aviso de exclusão", () => {
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ tipo: "aceitar", lote: false }}
        onClose={noop}
        selecionadosCount={0}
        justificativa=""
        setJustificativa={noop}
        onConfirm={noop}
        isPending={false}
      />
    );
    expect(screen.getByText(/Confirmar aceitação/)).toBeTruthy();
    expect(screen.getByText(/Aplicar ao alerta selecionado/)).toBeTruthy();
    expect(screen.queryByText(/remove os eventos/)).toBeNull();
  });
});
