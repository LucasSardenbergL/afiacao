import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUploadPromocoes } from "../useUploadPromocoes";

function fileEvent(files: File[]) {
  return { target: { files } } as unknown as React.ChangeEvent<HTMLInputElement>;
}

describe("useUploadPromocoes", () => {
  it("estado inicial vazio e podeIniciar=false", () => {
    const { result } = renderHook(() => useUploadPromocoes(vi.fn()));
    expect(result.current.items).toEqual([]);
    expect(result.current.totalItens).toBe(0);
    expect(result.current.podeIniciar).toBe(false);
    expect(result.current.todosFinalizados).toBe(false);
  });

  it("handleFileChange adiciona itens aguardando e habilita podeIniciar", () => {
    const { result } = renderHook(() => useUploadPromocoes(vi.fn()));
    const f = new File(["x"], "promo.pdf", { type: "application/pdf" });
    act(() => result.current.handleFileChange(fileEvent([f])));
    expect(result.current.totalItens).toBe(1);
    expect(result.current.aguardando).toBe(1);
    expect(result.current.items[0].status).toBe("aguardando");
    expect(result.current.podeIniciar).toBe(true);
  });

  it("removerItem e resetUpload limpam a fila", () => {
    const { result } = renderHook(() => useUploadPromocoes(vi.fn()));
    const f1 = new File(["a"], "a.pdf", { type: "application/pdf" });
    const f2 = new File(["b"], "b.pdf", { type: "application/pdf" });
    act(() => result.current.handleFileChange(fileEvent([f1, f2])));
    expect(result.current.totalItens).toBe(2);
    const id0 = result.current.items[0].id;
    act(() => result.current.removerItem(id0));
    expect(result.current.totalItens).toBe(1);
    act(() => result.current.resetUpload());
    expect(result.current.totalItens).toBe(0);
  });
});
