import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EngineConfigCard } from "../EngineConfigCard";
import type { RecConfigs } from "../useAnalyticsSync";

const recConfigs = [
  { id: "1", key: "alpha", value: 0.5, description: "peso alpha" },
  { id: "2", key: "beta", value: 0.3, description: "peso beta" },
] as unknown as RecConfigs;

describe("EngineConfigCard", () => {
  it("mostra spinner quando isLoading", () => {
    const { container } = render(
      <EngineConfigCard isLoading recConfigs={recConfigs} editingConfig={{}} setEditingConfig={vi.fn()} onSave={vi.fn()} />,
    );
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("renderiza as chaves e descrições dos parâmetros", () => {
    render(
      <EngineConfigCard isLoading={false} recConfigs={recConfigs} editingConfig={{}} setEditingConfig={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("peso beta")).toBeTruthy();
  });

  it("mostra o botão Salvar somente para o parâmetro em edição e dispara onSave", () => {
    const onSave = vi.fn();
    render(
      <EngineConfigCard
        isLoading={false}
        recConfigs={recConfigs}
        editingConfig={{ "1": "0.9" }}
        setEditingConfig={vi.fn()}
        onSave={onSave}
      />,
    );
    const saveButtons = screen.getAllByRole("button");
    expect(saveButtons).toHaveLength(1); // só o parâmetro id "1" está em edição
    fireEvent.click(saveButtons[0]);
    expect(onSave).toHaveBeenCalledWith("1");
  });

  it("dispara setEditingConfig ao digitar num parâmetro", () => {
    const setEditingConfig = vi.fn();
    render(
      <EngineConfigCard
        isLoading={false}
        recConfigs={recConfigs}
        editingConfig={{}}
        setEditingConfig={setEditingConfig}
        onSave={vi.fn()}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton");
    fireEvent.change(inputs[0], { target: { value: "0.7" } });
    expect(setEditingConfig).toHaveBeenCalledTimes(1);
  });
});
