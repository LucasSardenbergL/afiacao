import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DispatchButton } from "../DispatchButton";

describe("DispatchButton", () => {
  it("estado normal: label e habilitado", () => {
    render(<DispatchButton isPending={false} onDispatch={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Disparar agora/ })).toHaveProperty("disabled", false);
  });

  it("estado pendente: label e desabilitado", () => {
    render(<DispatchButton isPending onDispatch={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /Disparando/ });
    expect(btn).toHaveProperty("disabled", true);
  });

  it("confirma o disparo via AlertDialog", () => {
    const onDispatch = vi.fn();
    render(<DispatchButton isPending={false} onDispatch={onDispatch} />);
    fireEvent.click(screen.getByRole("button", { name: /Disparar agora/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Disparar$/ }));
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});
