import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const contar = vi.fn();
vi.mock("../api", () => ({ contarForaDoMotor: (...a: unknown[]) => contar(...a) }));

const navigate = vi.fn();
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

const track = vi.fn();
vi.mock("@/lib/analytics", () => ({ track: (...a: unknown[]) => track(...a) }));

import { ForaDoMotorBadge, ROTA_FORA_DO_MOTOR } from "../ForaDoMotorBadge";

function renderBadge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForaDoMotorBadge />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("ForaDoMotorBadge", () => {
  it("com SKUs fora do motor: mostra a contagem e leva à Revisão filtrada", async () => {
    contar.mockResolvedValue(4);
    renderBadge();
    const botao = await screen.findByRole("button", { name: /fora do motor/i });
    expect(botao.textContent).toContain("4 SKUs");
    expect(contar).toHaveBeenCalledWith("OBEN");
    fireEvent.click(botao);
    expect(navigate).toHaveBeenCalledWith(ROTA_FORA_DO_MOTOR);
    expect(ROTA_FORA_DO_MOTOR).toBe("/admin/reposicao/sessao/parametros?tab=ajuste&filtro=fora_do_motor");
    expect(track).toHaveBeenCalledWith("reposicao.fora_do_motor_aberto", { skus: 4 });
  });

  it("singular com 1 SKU", async () => {
    contar.mockResolvedValue(1);
    renderBadge();
    const botao = await screen.findByRole("button", { name: /fora do motor/i });
    expect(botao.textContent).toContain("1 SKU vende");
  });

  it("zero: não mostra nada", async () => {
    contar.mockResolvedValue(0);
    const { container } = renderBadge();
    await vi.waitFor(() => expect(contar).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("sensor falhou: DIZ que não conseguiu consultar (sumir calado é o bug que isto fecha)", async () => {
    contar.mockRejectedValue(new Error("permission denied"));
    renderBadge();
    const botao = await screen.findByRole("button", { name: /fora do motor/i });
    expect(botao.textContent).toMatch(/não consegui consultar/i);
    fireEvent.click(botao);
    expect(navigate).toHaveBeenCalledWith(ROTA_FORA_DO_MOTOR);
  });
});
