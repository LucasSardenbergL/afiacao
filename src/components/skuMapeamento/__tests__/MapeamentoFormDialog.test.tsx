import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapeamentoFormDialog } from "../MapeamentoFormDialog";
import { EMPTY_FORM } from "../config";

function setup(overrides: Partial<React.ComponentProps<typeof MapeamentoFormDialog>> = {}) {
  const props: React.ComponentProps<typeof MapeamentoFormDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    isEditing: false,
    form: EMPTY_FORM,
    setForm: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
    isSaving: false,
    ...overrides,
  };
  render(<MapeamentoFormDialog {...props} />);
  return props;
}

describe("MapeamentoFormDialog", () => {
  it("título Novo quando não editando; SKU Omie habilitado", () => {
    setup();
    expect(screen.getByText("Novo mapeamento")).toBeTruthy();
  });

  it("título Editar quando editando", () => {
    setup({ isEditing: true });
    expect(screen.getByText("Editar mapeamento")).toBeTruthy();
  });

  it("Salvar desabilitado sem sku_omie (EMPTY_FORM)", () => {
    setup();
    expect(screen.getByRole("button", { name: "Salvar" })).toHaveProperty("disabled", true);
  });

  it("Salvar habilitado e dispara onSave quando form completo", () => {
    const props = setup({ form: { ...EMPTY_FORM, sku_omie: "111" } });
    const btn = screen.getByRole("button", { name: "Salvar" });
    expect(btn).toHaveProperty("disabled", false);
    fireEvent.click(btn);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("dispara onCancel e atualiza setForm ao digitar empresa", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    const empresaInput = screen.getByDisplayValue("OBEN");
    fireEvent.change(empresaInput, { target: { value: "colacor" } });
    expect(props.setForm).toHaveBeenCalledWith(expect.objectContaining({ empresa: "COLACOR" }));
  });
});
