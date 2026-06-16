import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KpiCards } from "../KpiCards";

function noop() { /* */ }

describe("KpiCards", () => {
  it("renderiza economia, contagem e ciclo; clicar no badge dispara onGerarCiclo", () => {
    const onGerarCiclo = vi.fn();
    render(
      <KpiCards
        totalEconomia={1000}
        ganhoLiquidoPotencial={600}
        oportunidadesCount={5}
        totalSkusAtivos={50}
        dataLimiteMaisProxima="2026-01-20"
        diasAteLimite={3}
        cicloHoje={2}
        onGerarCiclo={onGerarCiclo}
      />
    );
    expect(screen.getByText("SKUs com oportunidade")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("de 50 SKUs ativos")).toBeTruthy();
    expect(screen.getByText("Ganho líquido potencial")).toBeTruthy();
    expect(screen.getByText(/600,00/)).toBeTruthy();
    expect(screen.getByText(/1\.000,00/)).toBeTruthy();
    expect(screen.getByText(/em 3 dias/)).toBeTruthy();
    expect(screen.getByText(/2 eventos encerra/)).toBeTruthy();
    fireEvent.click(screen.getByText("Gerar ciclo oportunidade"));
    expect(onGerarCiclo).toHaveBeenCalled();
  });

  it("sem data limite e sem ciclo → estados vazios", () => {
    render(
      <KpiCards
        totalEconomia={0}
        ganhoLiquidoPotencial={0}
        oportunidadesCount={0}
        totalSkusAtivos={0}
        dataLimiteMaisProxima={null}
        diasAteLimite={null}
        cicloHoje={0}
        onGerarCiclo={noop}
      />
    );
    expect(screen.getByText("Sem janelas ativas")).toBeTruthy();
    expect(screen.getByText("Sem ciclo hoje")).toBeTruthy();
  });
});
