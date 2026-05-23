// Hook com a lógica de upload em lote de promoções (FileReader + pool de
// concorrência + retry + contadores). Extraído de src/pages/AdminReposicaoPromocoes.tsx.
import { useState, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MAX_CONCURRENT, EMPRESA, FORNECEDOR_DEFAULT, type UploadItem } from "./types";

/** `onProcessed` é chamado após cada rodada de processamento (para invalidar a lista). */
export function useUploadPromocoes(onProcessed: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [processando, setProcessando] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const novos: UploadItem[] = files.map((f) => ({
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      status: "aguardando",
    }));
    setItems((prev) => [...prev, ...novos]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removerItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const resetUpload = () => {
    setItems([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const updateItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const processarArquivo = useCallback(
    async (item: UploadItem): Promise<void> => {
      updateItem(item.id, { status: "processando", erro: undefined });
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const idx = result.indexOf(",");
            resolve(idx >= 0 ? result.slice(idx + 1) : result);
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(item.file);
        });

        const arquivo_tipo =
          item.file.type === "application/pdf" ? "pdf" : item.file.type;

        const { data, error } = await supabase.functions.invoke(
          "promocao-extrair-via-vision",
          {
            body: {
              empresa: EMPRESA,
              fornecedor_nome: FORNECEDOR_DEFAULT,
              arquivo_tipo,
              arquivo_base64: base64,
            },
          },
        );

        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        const campanhaId: number | undefined = data?.campanha_id;
        const itensExtraidos =
          data?.extracao?.items_extraidos ?? data?.items?.length ?? 0;
        const confianca: number | null =
          data?.extracao?.confianca ?? data?.confianca ?? null;

        // Confirma propagação para evitar race com a lista
        let nomeCampanha = "Campanha";
        if (campanhaId) {
          for (let i = 0; i < 6; i++) {
            const { data: row } = await supabase
              .from("promocao_campanha")
              .select("nome")
              .eq("id", campanhaId)
              .maybeSingle();
            const typedRow = row as { nome: string | null } | null;
            if (typedRow && typedRow.nome) {
              nomeCampanha = typedRow.nome;
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        }

        updateItem(item.id, {
          status: "concluido",
          campanhaId,
          nomeCampanha,
          itensExtraidos,
          confianca,
        });
      } catch (e) {
        updateItem(item.id, {
          status: "erro",
          erro: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [updateItem],
  );

  const iniciarProcessamento = async () => {
    const fila = items.filter((i) => i.status === "aguardando" || i.status === "erro");
    if (fila.length === 0) return;
    setProcessando(true);

    // Marca toda a fila como aguardando (caso haja "erro" sendo retentado)
    fila.forEach((it) => {
      if (it.status === "erro") updateItem(it.id, { status: "aguardando", erro: undefined });
    });

    // Pool de concorrência simples (até MAX_CONCURRENT em paralelo)
    let cursor = 0;
    const next = async (): Promise<void> => {
      const idx = cursor++;
      if (idx >= fila.length) return;
      await processarArquivo(fila[idx]);
      return next();
    };
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT, fila.length) },
      () => next(),
    );
    await Promise.all(workers);

    setProcessando(false);
    onProcessed();
  };

  const tentarNovamente = async (id: string) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setProcessando(true);
    await processarArquivo(it);
    setProcessando(false);
    onProcessed();
  };

  const totalItens = items.length;
  const concluidos = items.filter((i) => i.status === "concluido").length;
  const comErro = items.filter((i) => i.status === "erro").length;
  const aguardando = items.filter((i) => i.status === "aguardando").length;
  const emProcesso = items.filter((i) => i.status === "processando").length;
  const finalizados = concluidos + comErro;
  const progresso = totalItens > 0 ? Math.round((finalizados / totalItens) * 100) : 0;
  const todosFinalizados = totalItens > 0 && finalizados === totalItens && !processando;
  const podeIniciar = !processando && (aguardando > 0 || (comErro > 0 && emProcesso === 0));

  return {
    items, processando, fileInputRef,
    handleFileChange, removerItem, resetUpload, iniciarProcessamento, tentarNovamente,
    totalItens, concluidos, comErro, aguardando, emProcesso, finalizados, progresso, todosFinalizados, podeIniciar,
  };
}
