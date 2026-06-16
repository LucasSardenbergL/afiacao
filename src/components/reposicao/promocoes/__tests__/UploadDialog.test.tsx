import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { UploadDialog } from "../UploadDialog";
import type { useUploadPromocoes } from "../useUploadPromocoes";
import type { UploadItem } from "../types";

type UploadState = ReturnType<typeof useUploadPromocoes>;

function mkUpload(over: Partial<UploadState> = {}): UploadState {
  return {
    items: [],
    processando: false,
    fileInputRef: createRef<HTMLInputElement>(),
    handleFileChange: vi.fn(),
    removerItem: vi.fn(),
    resetUpload: vi.fn(),
    iniciarProcessamento: vi.fn(),
    tentarNovamente: vi.fn(),
    totalItens: 0,
    concluidos: 0,
    comErro: 0,
    aguardando: 0,
    emProcesso: 0,
    finalizados: 0,
    progresso: 0,
    todosFinalizados: false,
    podeIniciar: false,
    ...over,
  } as unknown as UploadState;
}

const aguardandoItem: UploadItem = {
  id: "i1",
  file: new File(["x"], "promo.pdf", { type: "application/pdf" }),
  status: "aguardando",
};

function noop() { /* */ }

describe("UploadDialog", () => {
  it("vazio → input de arquivo e botão Processar (desabilitado)", () => {
    render(<UploadDialog open onOpenChange={noop} upload={mkUpload()} onIrParaLista={noop} onCancelar={noop} />);
    expect(screen.getByText("Upload de promoções (lote)")).toBeTruthy();
    expect(screen.getByText("Cancelar")).toBeTruthy();
  });

  it("com 1 aguardando → Processar habilita e dispara iniciarProcessamento; Cancelar chama onCancelar", () => {
    const iniciarProcessamento = vi.fn();
    const onCancelar = vi.fn();
    const upload = mkUpload({ items: [aguardandoItem], totalItens: 1, aguardando: 1, podeIniciar: true, iniciarProcessamento });
    render(<UploadDialog open onOpenChange={noop} upload={upload} onIrParaLista={noop} onCancelar={onCancelar} />);
    expect(screen.getByText("promo.pdf")).toBeTruthy();
    expect(screen.getByText("Aguardando")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Processar 1 arquivo/ }));
    expect(iniciarProcessamento).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancelar).toHaveBeenCalled();
  });

  it("todos finalizados → resumo e botão 'Ir para lista' dispara onIrParaLista", () => {
    const onIrParaLista = vi.fn();
    const upload = mkUpload({
      items: [{ ...aguardandoItem, status: "concluido", nomeCampanha: "Promo X", itensExtraidos: 4, confianca: 0.9 }],
      totalItens: 1, concluidos: 1, finalizados: 1, progresso: 100, todosFinalizados: true,
    });
    render(<UploadDialog open onOpenChange={noop} upload={upload} onIrParaLista={onIrParaLista} onCancelar={noop} />);
    expect(screen.getByText("Concluído")).toBeTruthy();
    expect(screen.getByText(/1 de 1 campanha criada com sucesso/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ir para lista" }));
    expect(onIrParaLista).toHaveBeenCalled();
  });
});
