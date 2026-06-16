// Hook de dados/estado dos aumentos anunciados.
// Extraído verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split):
// 2 queries (fornecedores + aumentos com agregação de itens), memos de agrupamento
// por mês e handlers do upload/extração via Gemini Vision.
import { useState, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { agruparPorMes, chavesUltimosNMeses } from "@/lib/agruparPorMes";
import { EMPRESA, FORNECEDOR_DEFAULT, ALL } from "./config";
import type { Aumento, AumentoComAgg, FornecedorRow, AumentoItemAgg } from "./types";

export function useAumentos() {
  const navigate = useNavigate();

  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [filtroEstado, setFiltroEstado] = useState<string>(ALL);
  const [busca, setBusca] = useState("");

  // Upload modal
  const [uploadOpen, setUploadOpen] = useState(false);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [extraindo, setExtraindo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ============ QUERIES ============
  const { data: fornecedores = [] } = useQuery({
    queryKey: ["aumentos-fornecedores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_aumento_anunciado")
        .select("fornecedor_nome")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const rows = (data || []) as unknown as FornecedorRow[];
      const uniq = Array.from(
        new Set(rows.map((r) => r.fornecedor_nome).filter((n): n is string => Boolean(n))),
      );
      return uniq.sort();
    },
  });

  const { data: aumentos = [], isLoading } = useQuery({
    queryKey: ["aumentos", filtroFornecedor, filtroEstado, busca],
    queryFn: async () => {
      let q = supabase
        .from("fornecedor_aumento_anunciado")
        .select(
          "id, nome, fornecedor_nome, data_vigencia, data_anuncio, estado, extracao_confianca, criado_em",
        )
        .eq("empresa", EMPRESA)
        .order("criado_em", { ascending: false });

      if (filtroFornecedor !== ALL) q = q.eq("fornecedor_nome", filtroFornecedor);
      if (filtroEstado !== ALL) {
        q = q.eq("estado", filtroEstado);
      } else {
        // default: todos exceto expirado
        q = q.neq("estado", "expirado");
      }
      if (busca.trim()) q = q.ilike("nome", `%${busca.trim()}%`);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as unknown as Aumento[];

      // Aggregate items: count + avg(perc) onde ativo=true e confirmado=true
      const ids = rows.map((r) => r.id);
      const counts: Record<number, number> = {};
      const sums: Record<number, { sum: number; n: number }> = {};
      if (ids.length > 0) {
        const { data: itens } = await supabase
          .from("fornecedor_aumento_item")
          .select("aumento_id, aumento_perc, ativo, confirmado")
          .in("aumento_id", ids)
          .eq("ativo", true);
        ((itens || []) as unknown as AumentoItemAgg[]).forEach((it) => {
          counts[it.aumento_id] = (counts[it.aumento_id] || 0) + 1;
          if (it.confirmado && typeof it.aumento_perc === "number") {
            const s = sums[it.aumento_id] || { sum: 0, n: 0 };
            s.sum += Number(it.aumento_perc);
            s.n += 1;
            sums[it.aumento_id] = s;
          }
        });
      }

      return rows.map<AumentoComAgg>((r) => ({
        ...r,
        num_categorias: counts[r.id] || 0,
        perc_medio: sums[r.id] ? sums[r.id].sum / sums[r.id].n : null,
      }));
    },
  });

  const ativosAguardando = useMemo(
    () => aumentos.filter((a) => a.estado === "ativo").length,
    [aumentos],
  );

  // Agrupa aumentos por mês (data_vigencia)
  const grupos = useMemo(
    () => agruparPorMes(aumentos, (a) => a.data_vigencia),
    [aumentos],
  );

  const [collapsedMeses, setCollapsedMeses] = useState<Record<string, boolean>>({});
  const ultimos3 = useMemo(() => chavesUltimosNMeses(3), []);
  const isCollapsed = useCallback(
    (chave: string) =>
      chave in collapsedMeses ? collapsedMeses[chave] : !ultimos3.has(chave),
    [collapsedMeses, ultimos3],
  );
  const toggleMes = useCallback((chave: string) => {
    setCollapsedMeses((prev) => ({ ...prev, [chave]: !(prev[chave] ?? false) }));
  }, []);

  // ============ HANDLERS ============
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setArquivo(file);
  };

  const resetUpload = () => {
    setArquivo(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleExtrair = async () => {
    if (!arquivo) return;
    setExtraindo(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const idx = result.indexOf(",");
          resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(arquivo);
      });

      const arquivo_tipo =
        arquivo.type === "application/pdf" ? "pdf" : arquivo.type;

      toast.info("Extraindo dados via Gemini Vision…");

      const { data, error } = await supabase.functions.invoke(
        "promocao-extrair-via-vision",
        {
          body: {
            tipo_documento: "aumento",
            empresa: EMPRESA,
            fornecedor_nome: FORNECEDOR_DEFAULT,
            arquivo_tipo,
            arquivo_base64: base64,
          },
        },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const cat = data?.extracao?.categorias_extraidas ?? 0;
      const conf = data?.extracao?.confianca;
      const confTxt =
        typeof conf === "number" ? ` · confiança ${Math.round(conf * 100)}%` : "";
      toast.success(
        `${cat} ${cat === 1 ? "categoria extraída" : "categorias extraídas"}${confTxt}`,
      );

      setUploadOpen(false);
      resetUpload();

      if (data?.aumento_id) {
        navigate(`/admin/reposicao/aumentos/${data.aumento_id}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Erro ao extrair aumento";
      toast.error(msg);
    } finally {
      setExtraindo(false);
    }
  };

  return {
    fornecedores,
    aumentos,
    isLoading,
    ativosAguardando,
    grupos,
    isCollapsed,
    toggleMes,
    filtroFornecedor,
    setFiltroFornecedor,
    filtroEstado,
    setFiltroEstado,
    busca,
    setBusca,
    uploadOpen,
    setUploadOpen,
    arquivo,
    extraindo,
    fileInputRef,
    handleFileChange,
    resetUpload,
    handleExtrair,
  };
}
