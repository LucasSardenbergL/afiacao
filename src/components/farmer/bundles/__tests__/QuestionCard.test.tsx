import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionCard } from "../QuestionCard";
import type { QuestionWithResponse } from "@/hooks/useDiagnosticQuestions";

const question = {
  type: "situacao",
  main: "Pergunta principal?",
  alt: "Pergunta alternativa?",
  rationale: "porque sim",
  useAlt: false,
} as unknown as QuestionWithResponse;

describe("QuestionCard", () => {
  it("renderiza o texto principal e a rationale", () => {
    render(<QuestionCard question={question} onSetResponse={vi.fn()} onToggleAlt={vi.fn()} />);
    expect(screen.getByText(/Pergunta principal\?/)).toBeTruthy();
    expect(screen.getByText(/porque sim/)).toBeTruthy();
  });

  it("dispara onSetResponse ao clicar em uma resposta", () => {
    const onSetResponse = vi.fn();
    render(<QuestionCard question={question} onSetResponse={onSetResponse} onToggleAlt={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Interesse/ }));
    expect(onSetResponse).toHaveBeenCalledWith("interesse", "");
  });

  it("dispara onToggleAlt no botão Alt", () => {
    const onToggleAlt = vi.fn();
    render(<QuestionCard question={question} onSetResponse={vi.fn()} onToggleAlt={onToggleAlt} />);
    fireEvent.click(screen.getByRole("button", { name: /Alt/ }));
    expect(onToggleAlt).toHaveBeenCalledTimes(1);
  });

  it("usa a variação alternativa quando useAlt é true", () => {
    render(
      <QuestionCard
        question={{ ...question, useAlt: true } as unknown as QuestionWithResponse}
        onSetResponse={vi.fn()}
        onToggleAlt={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pergunta alternativa\?/)).toBeTruthy();
  });
});
