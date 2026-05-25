import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { UploadDialog } from "../UploadDialog";

function setup(overrides: Partial<React.ComponentProps<typeof UploadDialog>> = {}) {
  const props: React.ComponentProps<typeof UploadDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    arquivo: null,
    onFileChange: vi.fn(),
    onCancel: vi.fn(),
    onExtrair: vi.fn(),
    extraindo: false,
    fileInputRef: createRef<HTMLInputElement>(),
    ...overrides,
  };
  render(<UploadDialog {...props} />);
  return props;
}

describe("UploadDialog", () => {
  it("não renderiza conteúdo quando fechado", () => {
    setup({ open: false });
    expect(screen.queryByText("Upload de anúncio de aumento")).toBeNull();
  });

  it("Extrair desabilitado sem arquivo", () => {
    setup();
    expect(screen.getByRole("button", { name: /Extrair/ })).toHaveProperty("disabled", true);
  });

  it("mostra o arquivo selecionado e habilita Extrair", () => {
    const arquivo = new File(["x".repeat(2048)], "anuncio.pdf", { type: "application/pdf" });
    setup({ arquivo });
    expect(screen.getByText("anuncio.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Extrair/ })).toHaveProperty("disabled", false);
  });

  it("dispara onExtrair e onCancel", () => {
    const arquivo = new File(["x".repeat(2048)], "anuncio.pdf", { type: "application/pdf" });
    const props = setup({ arquivo });
    fireEvent.click(screen.getByRole("button", { name: /Extrair/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.onExtrair).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("desabilita botões durante extração", () => {
    const arquivo = new File(["x".repeat(2048)], "anuncio.pdf", { type: "application/pdf" });
    setup({ arquivo, extraindo: true });
    expect(screen.getByRole("button", { name: /Extrair/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveProperty("disabled", true);
  });
});
