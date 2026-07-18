import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmacaoDialog } from "../ConfirmacaoDialog";

function noop() { /* */ }

describe("ConfirmacaoDialog", () => {
  it("fechado (acaoConfirm=null) → não renderiza", () => {
    render(<ConfirmacaoDialog acaoConfirm={null} onClose={noop} selecionadosCount={0} justificativa="" setJustificativa={noop} onConfirm={noop} isPending={false} />);
    expect(screen.queryByText(/Confirmar/)).toBeNull();
  });

  it("lote → título, contagem e Confirmar dispara onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: true }}
        onClose={noop}
        selecionadosCount={4}
        justificativa=""
        setJustificativa={noop}
        onConfirm={onConfirm}
        isPending={false}
      />
    );
    expect(screen.getByText(/Marcar 4 alerta\(s\) como revisado\(s\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("individual → descreve revisão, sem prometer efeito no cálculo", () => {
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: false }}
        onClose={noop}
        selecionadosCount={0}
        justificativa=""
        setJustificativa={noop}
        onConfirm={noop}
        isPending={false}
      />
    );
    expect(screen.getByText(/permanece no cálculo/)).toBeTruthy();
  });

  // Guarda de regressão: a promessa falsa não pode voltar. Havia um teste VERDE
  // (`expect(getByText(/remove os eventos do cálculo estatístico/)).toBeTruthy()`)
  // que institucionalizava a mentira — a tela afirmava um efeito que o motor nunca viu.
  it("não promete remover do cálculo nem recálculo automático", () => {
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: true }}
        onClose={noop}
        selecionadosCount={2}
        justificativa=""
        setJustificativa={noop}
        onConfirm={noop}
        isPending={false}
      />
    );
    expect(screen.queryByText(/remove os eventos do cálculo/)).toBeNull();
    expect(screen.queryByText(/recálculo automático/)).toBeNull();
  });
});
