import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AtivosAguardandoBanner } from "../AtivosAguardandoBanner";

describe("AtivosAguardandoBanner", () => {
  it("usa singular quando count é 1", () => {
    render(<AtivosAguardandoBanner count={1} onVerAtivos={vi.fn()} />);
    expect(screen.getByText("1 aumento ativo aguardando vigência")).toBeTruthy();
  });

  it("usa plural quando count > 1", () => {
    render(<AtivosAguardandoBanner count={3} onVerAtivos={vi.fn()} />);
    expect(screen.getByText("3 aumentos ativos aguardando vigência")).toBeTruthy();
  });

  it("dispara onVerAtivos ao clicar em Ver ativos", () => {
    const onVerAtivos = vi.fn();
    render(<AtivosAguardandoBanner count={2} onVerAtivos={onVerAtivos} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver ativos" }));
    expect(onVerAtivos).toHaveBeenCalledTimes(1);
  });
});
