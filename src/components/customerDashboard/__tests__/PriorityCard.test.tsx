import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { FileText } from "lucide-react";
import { PriorityCard } from "../PriorityCard";
import type { PriorityAction } from "../types";

const priority: PriorityAction = {
  type: "quote",
  variant: "warning",
  icon: FileText,
  title: "Orçamento pendente de aprovação",
  description: "Revise e aprove.",
  buttonLabel: "Ver orçamento",
  path: "/orders/q1",
};

describe("PriorityCard", () => {
  it("renderiza título, descrição e botão", () => {
    const navigate = vi.fn();
    render(<PriorityCard priority={priority} navigate={navigate as unknown as NavigateFunction} />);
    expect(screen.getByText("Orçamento pendente de aprovação")).toBeTruthy();
    expect(screen.getByText("Revise e aprove.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ver orçamento/ }));
    expect(navigate).toHaveBeenCalledWith("/orders/q1");
  });

  it("não renderiza botão quando não há buttonLabel/path", () => {
    const navigate = vi.fn();
    render(
      <PriorityCard
        priority={{ type: "all_good", variant: "success", icon: FileText, title: "Tudo em dia!", description: "ok" }}
        navigate={navigate as unknown as NavigateFunction}
      />,
    );
    expect(screen.getByText("Tudo em dia!")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
