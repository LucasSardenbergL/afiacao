import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { GamificationMini } from "../GamificationMini";
import type { useGamificationScore, getLevelInfo } from "@/hooks/useGamificationScore";

const gamScore = {
  total_score: 42,
  level: 3,
  level_name: "Profissional",
} as unknown as NonNullable<ReturnType<typeof useGamificationScore>["data"]>;

const levelInfo = {
  nextLevel: { min: 65, name: "Elite Técnica" },
} as unknown as ReturnType<typeof getLevelInfo>;

describe("GamificationMini", () => {
  it("renderiza nível, score e quanto falta", () => {
    const navigate = vi.fn();
    render(<GamificationMini gamScore={gamScore} levelInfo={levelInfo} navigate={navigate as unknown as NavigateFunction} />);
    expect(screen.getByText("Nível 3 — Profissional")).toBeTruthy();
    expect(screen.getByText("42/100 pts")).toBeTruthy();
    expect(screen.getByText("Faltam 23 para Elite Técnica")).toBeTruthy();
  });

  it("navega para gamificação ao clicar", () => {
    const navigate = vi.fn();
    render(<GamificationMini gamScore={gamScore} levelInfo={levelInfo} navigate={navigate as unknown as NavigateFunction} />);
    fireEvent.click(screen.getByText("Nível 3 — Profissional"));
    expect(navigate).toHaveBeenCalledWith("/gamification");
  });
});
