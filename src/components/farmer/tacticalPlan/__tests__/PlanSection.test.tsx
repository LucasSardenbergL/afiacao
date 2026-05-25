import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Target } from "lucide-react";
import { Section, MetricRow, CopyButton } from "../PlanSection";

describe("PlanSection primitives", () => {
  it("Section renderiza título e filhos", () => {
    render(<Section title="Diagnóstico" icon={Target}><span>conteúdo</span></Section>);
    expect(screen.getByText("Diagnóstico")).toBeTruthy();
    expect(screen.getByText("conteúdo")).toBeTruthy();
  });

  it("MetricRow renderiza label e valor", () => {
    render(<MetricRow label="Margem" value="12,5%" />);
    expect(screen.getByText("Margem")).toBeTruthy();
    expect(screen.getByText("12,5%")).toBeTruthy();
  });

  it("CopyButton dispara onCopy com o texto", () => {
    const onCopy = vi.fn();
    render(<CopyButton text="copiar isso" copied={false} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onCopy).toHaveBeenCalledWith("copiar isso");
  });
});
