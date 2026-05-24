import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SyncEntitiesGrid } from "../SyncEntitiesGrid";
import type { SyncState } from "../types";

function setup(overrides: Partial<React.ComponentProps<typeof SyncEntitiesGrid>> = {}) {
  const props: React.ComponentProps<typeof SyncEntitiesGrid> = {
    selectedAccount: "vendas",
    getStateFor: () => undefined,
    formatDate: (d) => (d ? "20/05/2026" : "Nunca"),
    isRunning: false,
    onSync: vi.fn(),
    ...overrides,
  };
  render(<SyncEntitiesGrid {...props} />);
  return props;
}

describe("SyncEntitiesGrid", () => {
  it("renderiza os 4 cards de entidade", () => {
    setup();
    expect(screen.getByText("Clientes")).toBeTruthy();
    expect(screen.getByText("Produtos")).toBeTruthy();
    expect(screen.getByText("Pedidos")).toBeTruthy();
    expect(screen.getByText("Estoque")).toBeTruthy();
  });

  it("mostra status e registros do state quando presente", () => {
    const state = { entity_type: "customers", account: "vendas", status: "running", total_synced: 42, last_sync_at: "2026-05-20T10:00:00Z", error_message: null } as unknown as SyncState;
    setup({ getStateFor: (e) => (e === "customers" ? state : undefined) });
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("dispara onSync com a entidade ao clicar no botão", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar Clientes/ }));
    expect(props.onSync).toHaveBeenCalledWith("customers");
  });

  it("desabilita os botões quando isRunning", () => {
    setup({ isRunning: true });
    expect(screen.getByRole("button", { name: /Sincronizar Produtos/ })).toHaveProperty("disabled", true);
  });
});
