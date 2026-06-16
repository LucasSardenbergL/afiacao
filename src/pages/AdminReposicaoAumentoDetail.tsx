import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { ArrowLeft, Loader2, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Aumento, Item, Mapeamento, SkuAfetado } from "@/components/reposicao/aumentoDetail/types";
import { EMPRESA, ESTADOS_LABEL, diasEntre } from "@/components/reposicao/aumentoDetail/shared";
import { DetalhesTab } from "@/components/reposicao/aumentoDetail/DetalhesTab";
import { CategoriasTab } from "@/components/reposicao/aumentoDetail/CategoriasTab";
import { SkusAfetadosTab } from "@/components/reposicao/aumentoDetail/SkusAfetadosTab";
import { EstadoAcoesSidebar } from "@/components/reposicao/aumentoDetail/EstadoAcoesSidebar";

export default function AdminReposicaoAumentoDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isNew = !idParam || idParam === "novo";
  const aumentoId = isNew ? null : Number(idParam);

  // ============ FORM STATE (Detalhes) ============
  const [form, setForm] = useState<Partial<Aumento>>({
    empresa: EMPRESA,
    fornecedor_nome: "RENNER SAYERLACK S/A",
    nome: "",
    data_vigencia: "",
    data_anuncio: null,
    observacoes: "",
    estado: "rascunho",
  });

  // ============ QUERIES ============
  const { data: aumento, isLoading: loadingAumento } = useQuery({
    queryKey: ["aumento", aumentoId],
    enabled: !isNew && aumentoId !== null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_aumento_anunciado")
        .select("*")
        .eq("id", aumentoId!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Aumento;
    },
  });

  useEffect(() => {
    if (aumento) {
      setForm({
        ...aumento,
        observacoes: aumento.observacoes ?? "",
      });
    }
  }, [aumento]);

  const { data: itens = [], refetch: refetchItens } = useQuery({
    queryKey: ["aumento-itens", aumentoId],
    enabled: !isNew && aumentoId !== null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fornecedor_aumento_item")
        .select("*")
        .eq("aumento_id", aumentoId!)
        .eq("ativo", true)
        .order("categoria_fornecedor", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as Item[];
    },
  });

  const { data: mapeamentos = [], refetch: refetchMaps } = useQuery({
    queryKey: ["aumento-mapeamentos", aumentoId, itens.map((i) => i.id).join(",")],
    enabled: !isNew && itens.length > 0,
    queryFn: async () => {
      const ids = itens.map((i) => i.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from("categoria_aumento_familia_mapeamento")
        .select("id, aumento_item_id, familia_omie, sku_codigo_omie_especifico")
        .in("aumento_item_id", ids);
      if (error) throw error;
      return (data || []) as unknown as Mapeamento[];
    },
  });

  const { data: skusAfetados = [] } = useQuery({
    queryKey: ["aumento-skus-afetados", aumentoId, mapeamentos.length],
    enabled: !isNew && aumentoId !== null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_sku_aumento_vigente")
        .select(
          "sku_codigo_omie, sku_descricao, familia, categoria_fornecedor, data_vigencia_efetiva, aumento_perc",
        )
        .eq("aumento_id", aumentoId!)
        .order("familia", { ascending: true })
        .order("sku_descricao", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as SkuAfetado[];
    },
  });

  // Familias agrupadas por item
  const mapByItem = useMemo(() => {
    const m: Record<number, Mapeamento[]> = {};
    for (const map of mapeamentos) {
      if (!m[map.aumento_item_id]) m[map.aumento_item_id] = [];
      m[map.aumento_item_id].push(map);
    }
    return m;
  }, [mapeamentos]);

  const familiasUnicasPorItem = (itemId: number): number => {
    const set = new Set((mapByItem[itemId] || []).map((m) => m.familia_omie));
    return set.size;
  };

  // Estado de gating do botão "Ativar"
  const itensAtivos = itens.length;
  const itensConfirmados = itens.filter((i) => i.confirmado).length;
  const itensSemMapeamento = itens.filter(
    (i) => (mapByItem[i.id] || []).length === 0,
  ).length;
  const podeAtivar =
    itensAtivos > 0 &&
    itensConfirmados === itensAtivos &&
    itensAtivos - itensSemMapeamento > 0;

  // ============ MUTATIONS ============
  const saveDetalhes = useMutation({
    mutationFn: async () => {
      if (!form.nome?.trim()) throw new Error("Nome é obrigatório");
      if (!form.data_vigencia) throw new Error("Data de vigência é obrigatória");
      if (!form.fornecedor_nome?.trim())
        throw new Error("Fornecedor é obrigatório");

      const payload = {
        empresa: EMPRESA,
        nome: form.nome.trim(),
        fornecedor_nome: form.fornecedor_nome.trim(),
        data_vigencia: form.data_vigencia,
        data_anuncio: form.data_anuncio || null,
        observacoes: form.observacoes || null,
        atualizado_por: user?.email ?? null,
      };

      if (isNew) {
        const { data, error } = await supabase
          .from("fornecedor_aumento_anunciado")
          .insert({
            ...payload,
            estado: "rascunho",
            criado_por: user?.email ?? null,
          })
          .select("id")
          .single();
        if (error) throw error;
        return (data as { id: number }).id;
      }
      const { error } = await supabase
        .from("fornecedor_aumento_anunciado")
        .update(payload)
        .eq("id", aumentoId!);
      if (error) throw error;
      return aumentoId!;
    },
    onSuccess: (id) => {
      toast.success("Salvo");
      if (isNew) {
        navigate(`/admin/reposicao/aumentos/${id}`, { replace: true });
      } else {
        queryClient.invalidateQueries({ queryKey: ["aumento", aumentoId] });
      }
    },
    onError: (err: Error) => toast.error(err?.message || "Erro ao salvar"),
  });

  const updateEstado = useMutation({
    mutationFn: async (novoEstado: string) => {
      const { error } = await supabase
        .from("fornecedor_aumento_anunciado")
        .update({
          estado: novoEstado,
          atualizado_por: user?.email ?? null,
        })
        .eq("id", aumentoId!);
      if (error) throw error;
    },
    onSuccess: (_d, novoEstado) => {
      toast.success(`Estado: ${ESTADOS_LABEL[novoEstado]}`);
      if (novoEstado === "cancelado" || novoEstado === "expirado") {
        navigate("/admin/reposicao/aumentos");
      } else {
        queryClient.invalidateQueries({ queryKey: ["aumento", aumentoId] });
      }
    },
    onError: (err: Error) => toast.error(err?.message || "Erro ao alterar estado"),
  });

  const updateItem = useMutation({
    mutationFn: async (params: { id: number; patch: Partial<Item> }) => {
      const { error } = await supabase
        .from("fornecedor_aumento_item")
        .update(params.patch)
        .eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => {
      refetchItens();
    },
    onError: (err: Error) => toast.error(err?.message || "Erro ao atualizar item"),
  });

  const deleteItem = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase
        .from("fornecedor_aumento_item")
        .update({ ativo: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Categoria removida");
      refetchItens();
    },
    onError: (err: Error) => toast.error(err?.message || "Erro ao remover"),
  });

  const addItem = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("fornecedor_aumento_item")
        .insert({
          aumento_id: aumentoId!,
          categoria_fornecedor: "Nova categoria",
          aumento_perc: 0,
          ativo: true,
          confirmado: false,
        });
      if (error) throw error;
    },
    onSuccess: () => refetchItens(),
    onError: (err: Error) => toast.error(err?.message || "Erro ao adicionar"),
  });

  // ============ ARQUIVO ORIGINAL ============
  const openOriginalFile = async () => {
    if (!form.origem_arquivo_url) return;
    try {
      const { data, error } = await supabase.storage
        .from("promocoes")
        .createSignedUrl(form.origem_arquivo_url, 600);
      if (error) throw error;
      window.open(data.signedUrl, "_blank");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao abrir arquivo");
    }
  };

  if (!isNew && loadingAumento) {
    return (
      <div className="container mx-auto p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  const estadoAtual = (form.estado as string) ?? "rascunho";
  const diasParaVigencia =
    form.data_vigencia && estadoAtual === "ativo"
      ? diasEntre(form.data_vigencia)
      : null;
  const diasEmVigencia =
    form.data_vigencia && estadoAtual === "vigente"
      ? -diasEntre(form.data_vigencia)
      : null;

  return (
    <TooltipProvider>
      <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
        {/* Breadcrumb + Back */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/admin/reposicao/aumentos")}
            className="-ml-2"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Link to="/admin/reposicao/revisao" className="hover:underline">
            Reposição
          </Link>
          <span>›</span>
          <Link to="/admin/reposicao/aumentos" className="hover:underline">
            Aumentos
          </Link>
          <span>›</span>
          <span className="text-foreground font-medium truncate">
            {form.nome || (isNew ? "Novo aumento" : "—")}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          {/* Coluna principal */}
          <div className="min-w-0 space-y-4">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold truncate">
                {form.nome || (isNew ? "Novo aumento" : "—")}
              </h1>
            </div>

            <Tabs defaultValue="detalhes" className="w-full">
              <TabsList>
                <TabsTrigger value="detalhes">Detalhes</TabsTrigger>
                <TabsTrigger value="categorias" disabled={isNew}>
                  Categorias e mapeamento
                </TabsTrigger>
                <TabsTrigger value="skus" disabled={isNew}>
                  SKUs afetados
                </TabsTrigger>
              </TabsList>

              {/* TAB DETALHES */}
              <TabsContent value="detalhes" className="space-y-4">
                <DetalhesTab
                  form={form}
                  setForm={setForm}
                  onOpenOriginalFile={openOriginalFile}
                  onSave={() => saveDetalhes.mutate()}
                  saving={saveDetalhes.isPending}
                />
              </TabsContent>

              {/* TAB CATEGORIAS */}
              <TabsContent value="categorias" className="space-y-4">
                <CategoriasTab
                  itens={itens}
                  familiasUnicasPorItem={familiasUnicasPorItem}
                  onAddItem={() => addItem.mutate()}
                  onUpdateItem={(id, patch) => updateItem.mutate({ id, patch })}
                  onDeleteItem={(id) => deleteItem.mutate(id)}
                  onMapeamentoChanged={() => refetchMaps()}
                />
              </TabsContent>

              {/* TAB SKUS */}
              <TabsContent value="skus" className="space-y-4">
                <SkusAfetadosTab skusAfetados={skusAfetados} />
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar direita */}
          <div className="lg:sticky lg:top-4 self-start space-y-4">
            <EstadoAcoesSidebar
              isNew={isNew}
              estadoAtual={estadoAtual}
              itensAtivos={itensAtivos}
              itensConfirmados={itensConfirmados}
              itensSemMapeamento={itensSemMapeamento}
              skusAfetadosCount={skusAfetados.length}
              diasParaVigencia={diasParaVigencia}
              diasEmVigencia={diasEmVigencia}
              podeAtivar={podeAtivar}
              updating={updateEstado.isPending}
              onAtivar={() => updateEstado.mutate("ativo")}
              onCancelar={() => updateEstado.mutate("cancelado")}
              onExpirar={() => updateEstado.mutate("expirado")}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
