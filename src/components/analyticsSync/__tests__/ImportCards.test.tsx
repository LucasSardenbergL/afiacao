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
  const base = {
    isRunning: false,
    recentPending: false,
    bulkPending: false,
    importandoEmAndamento: false,
    janelas: [],
    onImportRecent: () => {},
    onImportAll: () => {},
  };

  it("dispara onImportRecent e onImportAll separadamente", () => {
    const onImportRecent = vi.fn();
    const onImportAll = vi.fn();
    render(<ImportPedidosCard {...base} onImportRecent={onImportRecent} onImportAll={onImportAll} />);
    fireEvent.click(screen.getByRole("button", { name: /Importar Recentes/ }));
    fireEvent.click(screen.getByRole("button", { name: /Importar Todos/ }));
    expect(onImportRecent).toHaveBeenCalledTimes(1);
    expect(onImportAll).toHaveBeenCalledTimes(1);
  });

  it("desabilita os botões quando isRunning", () => {
    render(<ImportPedidosCard {...base} isRunning />);
    expect(screen.getByRole("button", { name: /Importar Recentes/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Importar Todos/ })).toHaveProperty("disabled", true);
  });

  it("desabilita os botões enquanto o servidor importa (janela aberta)", () => {
    render(<ImportPedidosCard {...base} importandoEmAndamento />);
    expect(screen.getByRole("button", { name: /Importar Recentes/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Importar Todos/ })).toHaveProperty("disabled", true);
  });

  it("copy honesta: descreve o segundo plano no servidor, sem o '~2 min' histórico", () => {
    render(<ImportPedidosCard {...base} />);
    expect(screen.getByText(/pode fechar a aba/)).toBeTruthy();
    expect(screen.getByText(/~40–60 min no servidor/)).toBeTruthy();
    expect(screen.queryByText(/~2 min/)).toBeNull();
  });

  it("mostra as janelas do cursor e o aviso de importação em segundo plano", () => {
    render(
      <ImportPedidosCard
        {...base}
        importandoEmAndamento
        janelas={[
          { account: "oben", janela: "22/01/2026 → 21/07/2026", estado: "rodando", descricao: "importando — página 12" },
          { account: "colacor", janela: "22/01/2026 → 21/07/2026", estado: "concluida", descricao: "concluída 21/07/2026 14:32" },
        ]}
      />,
    );
    expect(screen.getByText("Importando no servidor — pode fechar esta aba.")).toBeTruthy();
    expect(screen.getByText("oben")).toBeTruthy();
    expect(screen.getByText(/importando — página 12/)).toBeTruthy();
    expect(screen.getByText(/concluída 21\/07\/2026 14:32/)).toBeTruthy();
  });
});
