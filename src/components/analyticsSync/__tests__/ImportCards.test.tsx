import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Caption isolada: os cards são componentes burros; a UltimaExecucao (query real) tem teste próprio.
vi.mock("@/components/execucoes/UltimaExecucao", () => ({
  UltimaExecucao: () => null,
}));

import { ImportClientesCard, ImportEnderecosCard, ImportPedidosCard } from "../ImportCards";

describe("ImportClientesCard", () => {
  it("renderiza título e dispara onImport", () => {
    const onImport = vi.fn();
    render(<ImportClientesCard isRunning={false} pending={false} progress={null} onImport={onImport} />);
    expect(screen.getByText("Importar Clientes (3 Contas Omie)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Importar Todos/ }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("mostra o progresso quando presente", () => {
    render(<ImportClientesCard isRunning pending progress="Conta 1/3 — página 2..." onImport={() => {}} />);
    expect(screen.getByText("Conta 1/3 — página 2...")).toBeTruthy();
  });
});

describe("ImportEnderecosCard", () => {
  it("renderiza título e dispara onSync", () => {
    const onSync = vi.fn();
    render(<ImportEnderecosCard isRunning={false} pending={false} progress={null} onSync={onSync} />);
    expect(screen.getByText("Sincronizar Endereços do Omie")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar Endereços/ }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });
});

describe("ImportPedidosCard", () => {
  it("dispara onImportRecent e onImportAll separadamente", () => {
    const onImportRecent = vi.fn();
    const onImportAll = vi.fn();
    render(
      <ImportPedidosCard
        isRunning={false}
        recentPending={false}
        bulkPending={false}
        progress={null}
        onImportRecent={onImportRecent}
        onImportAll={onImportAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Importar Recentes/ }));
    fireEvent.click(screen.getByRole("button", { name: /Importar Todos/ }));
    expect(onImportRecent).toHaveBeenCalledTimes(1);
    expect(onImportAll).toHaveBeenCalledTimes(1);
  });

  it("desabilita os botões quando isRunning", () => {
    render(
      <ImportPedidosCard
        isRunning
        recentPending={false}
        bulkPending={false}
        progress={null}
        onImportRecent={() => {}}
        onImportAll={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Importar Recentes/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Importar Todos/ })).toHaveProperty("disabled", true);
  });
});
