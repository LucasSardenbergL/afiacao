import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AiOpsHeader } from "../AiOpsHeader";

describe("AiOpsHeader", () => {
  it("renderiza título e botão; dispara onRunAgent", () => {
    const onRunAgent = vi.fn();
    render(
      <AiOpsHeader confidenceFilter="all" onConfidenceChange={vi.fn()} onRunAgent={onRunAgent} isRunningAgent={false} />,
    );
    expect(screen.getByText("AI Ops")).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Executar Agente/ });
    expect(btn).toHaveProperty("disabled", false);
    fireEvent.click(btn);
    expect(onRunAgent).toHaveBeenCalledTimes(1);
  });

  it("desabilita o botão durante execução", () => {
    render(
      <AiOpsHeader confidenceFilter="all" onConfidenceChange={vi.fn()} onRunAgent={vi.fn()} isRunningAgent />,
    );
    expect(screen.getByRole("button", { name: /Executar Agente/ })).toHaveProperty("disabled", true);
  });
});
