import { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { Loader2, ChevronRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EMPRESA,
  FORNECEDOR_DEFAULT,
  ESTADO_LABEL,
  type Campanha,
  type ItemRow,
  type ItemEfetivo,
  type Evento,
  type NovoEventoForm,
} from "@/components/reposicao/promocaoDetail/types";
import { CancelCampanhaDialog } from "@/components/reposicao/promocaoDetail/CancelCampanhaDialog";
import { EventoDialog } from "@/components/reposicao/promocaoDetail/EventoDialog";
import { EstadoAcoesSidebar } from "@/components/reposicao/promocaoDetail/EstadoAcoesSidebar";
import { NegociacaoTab } from "@/components/reposicao/promocaoDetail/NegociacaoTab";
import { DetalhesTab } from "@/components/reposicao/promocaoDetail/DetalhesTab";
import { ItensTab } from "@/components/reposicao/promocaoDetail/ItensTab";

// ========== PÁGINA PRINCIPAL ==========
export default function AdminReposicaoPromocaoDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const userEmail = user?.email || "sistema";

  const isNew = !id || id === "novo";
  const tipoNovo = (searchParams.get("tipo") || "fornecedor_impoe") as
    | "fornecedor_impoe"
    | "negociacao_cliente";

  // ============ QUERIES ============
  const { data: campanha, isLoading: loadingCampanha } = useQuery({
    queryKey: ["promocao-campanha", id],
    queryFn: async () => {
      if (isNew) return null;
      const { data, error } = await supabase
        .from("promocao_campanha")
        .select("*")
        .eq("id", Number(id))
        .single();
      if (error) throw error;
      return data as unknown as Campanha;
    },
    enabled: !isNew,
  });

  const { data: itens = [], isLoading: loadingItens } = useQuery({
    queryKey: ["promocao-itens", id],
    queryFn: async () => {
      if (isNew) return [];
      const { data, error } = await supabase
        .from("promocao_item")
        .select("*")
        .eq("campanha_id", Number(id))
        .eq("ativo", true)
        .order("sku_codigo_fornecedor");
      if (error) throw error;
      return (data as unknown as ItemRow[]) || [];
    },
    enabled: !isNew,
  });

  const itemIds = useMemo(() => itens.map((i) => i.id), [itens]);
  const { data: itensEfetivos = [] } = useQuery({
    queryKey: ["promocao-itens-efetivos", itemIds],
    queryFn: async () => {
      if (itemIds.length === 0) return [];
      const { data, error } = await supabase
        .from("v_promocao_item_efetivo")
        .select("id, desconto_efetivo")
        .in("id", itemIds);
      if (error) throw error;
      return (data as unknown as ItemEfetivo[]) || [];
    },
    enabled: itemIds.length > 0,
  });
  const efetivoMap = useMemo(() => {
    const m: Record<number, number> = {};
    itensEfetivos.forEach((e) => (m[e.id] = e.desconto_efetivo));
    return m;
  }, [itensEfetivos]);

  const { data: eventos = [] } = useQuery({
    queryKey: ["promocao-eventos", id],
    queryFn: async () => {
      if (isNew) return [];
      const { data, error } = await supabase
        .from("promocao_negociacao_evento")
        .select("*")
        .eq("campanha_id", Number(id))
        .order("data_evento", { ascending: false });
      if (error) throw error;
      return (data as unknown as Evento[]) || [];
    },
    enabled: !isNew && campanha?.tipo_origem === "negociacao_cliente",
  });

  // ============ FORM STATE ============
  const [formNome, setFormNome] = useState("");
  const [formInicio, setFormInicio] = useState("");
  const [formFim, setFormFim] = useState("");
  const [formObs, setFormObs] = useState("");
  const [signedUrl, setSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (campanha) {
      setFormNome(campanha.nome);
      setFormInicio(campanha.data_inicio);
      setFormFim(campanha.data_fim);
      setFormObs(campanha.observacoes || "");
    } else if (isNew) {
      const today = new Date().toISOString().slice(0, 10);
      setFormNome("");
      setFormInicio(today);
      setFormFim(today);
      setFormObs("");
    }
  }, [campanha, isNew]);

  // Signed URL pro arquivo original
  useEffect(() => {
    let cancelled = false;
    if (campanha?.origem_arquivo_url) {
      supabase.storage
        .from("promocoes")
        .createSignedUrl(campanha.origem_arquivo_url, 3600)
        .then(({ data }) => {
          if (!cancelled) setSignedUrl(data?.signedUrl || null);
        });
    } else {
      setSignedUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [campanha?.origem_arquivo_url]);

  // ============ MUTATIONS ============
  const saveCampanhaMut = useMutation({
    mutationFn: async () => {
      if (formFim < formInicio) {
        throw new Error("Data fim deve ser maior ou igual à data início");
      }
      if (!formNome.trim()) throw new Error("Nome obrigatório");

      if (isNew) {
        const estadoInicial =
          tipoNovo === "negociacao_cliente" ? "negociando" : "rascunho";
        const { data, error } = await supabase
          .from("promocao_campanha")
          .insert({
            empresa: EMPRESA,
            fornecedor_nome: FORNECEDOR_DEFAULT,
            nome: formNome.trim(),
            tipo_origem: tipoNovo,
            data_inicio: formInicio,
            data_fim: formFim,
            estado: estadoInicial,
            observacoes: formObs || null,
            criado_por: userEmail,
          })
          .select("id")
          .single();
        if (error) throw error;
        return (data as { id: number }).id;
      } else {
        const { error } = await supabase
          .from("promocao_campanha")
          .update({
            nome: formNome.trim(),
            data_inicio: formInicio,
            data_fim: formFim,
            observacoes: formObs || null,
            atualizado_por: userEmail,
          })
          .eq("id", Number(id));
        if (error) throw error;
        return Number(id);
      }
    },
    onSuccess: (newId) => {
      toast.success("Campanha salva");
      qc.invalidateQueries({ queryKey: ["promocao-campanha"] });
      qc.invalidateQueries({ queryKey: ["promocao-campanhas"] });
      if (isNew) navigate(`/admin/reposicao/promocoes/${newId}`);
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao salvar"),
  });

  const updateItemMut = useMutation({
    mutationFn: async ({
      itemId,
      changes,
    }: {
      itemId: number;
      changes: Partial<ItemRow>;
    }) => {
      const { error } = await supabase
        .from("promocao_item")
        .update(changes as never)
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
      qc.invalidateQueries({ queryKey: ["promocao-itens-efetivos"] });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao atualizar item"),
  });

  const deleteItemMut = useMutation({
    mutationFn: async (itemId: number) => {
      const { error } = await supabase
        .from("promocao_item")
        .update({ ativo: false })
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Item removido");
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao remover"),
  });

  const transicionarEstadoMut = useMutation({
    mutationFn: async (novoEstado: string) => {
      const updates: Record<string, string | null> = {
        estado: novoEstado,
        atualizado_por: userEmail,
      };
      if (novoEstado === "encerrada") {
        updates.data_fim = new Date().toISOString().slice(0, 10);
      }
      const { error } = await supabase
        .from("promocao_campanha")
        .update(updates as never)
        .eq("id", Number(id));
      if (error) throw error;
      return novoEstado;
    },
    onSuccess: (novoEstado) => {
      toast.success(`Campanha ${ESTADO_LABEL[novoEstado].toLowerCase()}`);
      if (novoEstado === "cancelada" || novoEstado === "encerrada") {
        navigate("/admin/reposicao/promocoes");
      } else {
        qc.invalidateQueries({ queryKey: ["promocao-campanha", id] });
      }
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao mudar estado"),
  });

  // ============ ADD ITEM (inline row) ============
  const [addingItem, setAddingItem] = useState(false);
  const [novoCodFornecedor, setNovoCodFornecedor] = useState("");
  const [novoDesconto, setNovoDesconto] = useState("");
  const [novoVolume, setNovoVolume] = useState("");
  const [savingNovoItem, setSavingNovoItem] = useState(false);

  const handleAddItem = async () => {
    if (!novoCodFornecedor.trim() || !novoDesconto.trim()) {
      toast.error("Código e desconto obrigatórios");
      return;
    }
    const desc = parseFloat(novoDesconto);
    if (isNaN(desc) || desc <= 0 || desc > 100) {
      toast.error("Desconto deve ser entre 0 e 100%");
      return;
    }
    const vol = novoVolume.trim() ? parseFloat(novoVolume) : null;

    setSavingNovoItem(true);
    try {
      const { data: inserted, error: insertErr } = await supabase
        .from("promocao_item")
        .insert({
          campanha_id: Number(id),
          sku_codigo_fornecedor: novoCodFornecedor.trim(),
          desconto_perc: desc,
          volume_minimo: vol,
          ativo: true,
          confirmado: false,
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;

      const novoId = (inserted as { id: number }).id;
      // Chama RPC de expansão
      const { error: rpcErr } = await supabase.rpc(
        "expandir_promocao_item" as never,
        { p_item_id: novoId } as never,
      );
      if (rpcErr) throw rpcErr;

      toast.success("Item adicionado");
      setAddingItem(false);
      setNovoCodFornecedor("");
      setNovoDesconto("");
      setNovoVolume("");
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao adicionar item");
    } finally {
      setSavingNovoItem(false);
    }
  };

  // ============ EVENTO MODAL ============
  const [eventoOpen, setEventoOpen] = useState(false);
  const [novoEvento, setNovoEvento] = useState<NovoEventoForm>({
    tipo_evento: "nota",
    desconto_perc_proposto: "",
    volume_minimo_proposto: "",
    data_evento: new Date().toISOString().slice(0, 16),
    email_referencia: "",
    conteudo: "",
  });

  const addEventoMut = useMutation({
    mutationFn: async () => {
      const tipo = novoEvento.tipo_evento;
      if (
        (tipo === "proposta_enviada" || tipo === "contraproposta_recebida") &&
        !novoEvento.desconto_perc_proposto.trim()
      ) {
        throw new Error("Desconto obrigatório para este tipo de evento");
      }
      const { error } = await supabase
        .from("promocao_negociacao_evento")
        .insert({
          campanha_id: Number(id),
          tipo_evento: tipo,
          desconto_perc_proposto: novoEvento.desconto_perc_proposto.trim()
            ? parseFloat(novoEvento.desconto_perc_proposto)
            : null,
          volume_minimo_proposto: novoEvento.volume_minimo_proposto.trim()
            ? parseFloat(novoEvento.volume_minimo_proposto)
            : null,
          data_evento: new Date(novoEvento.data_evento).toISOString(),
          email_referencia: novoEvento.email_referencia.trim() || null,
          conteudo: novoEvento.conteudo.trim() || null,
          registrado_por: userEmail,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Evento registrado");
      setEventoOpen(false);
      setNovoEvento({
        tipo_evento: "nota",
        desconto_perc_proposto: "",
        volume_minimo_proposto: "",
        data_evento: new Date().toISOString().slice(0, 16),
        email_referencia: "",
        conteudo: "",
      });
      qc.invalidateQueries({ queryKey: ["promocao-eventos", id] });
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao registrar"),
  });

  // ============ COUNTERS ============
  const itensAtivos = itens.length;
  const itensConfirmados = itens.filter((i) => i.confirmado).length;
  const todosConfirmados = itensAtivos > 0 && itensConfirmados === itensAtivos;

  const estado = isNew
    ? tipoNovo === "negociacao_cliente"
      ? "negociando"
      : "rascunho"
    : campanha?.estado || "rascunho";
  const tipoOrigem = isNew ? tipoNovo : campanha?.tipo_origem;
  const podeAtivar =
    (estado === "rascunho" || estado === "negociando") && todosConfirmados;
  const podeCancelar =
    estado === "rascunho" || estado === "negociando" || estado === "ativa";
  const podeEncerrar = estado === "ativa";

  // ============ CANCEL DIALOG ============
  const [cancelOpen, setCancelOpen] = useState(false);

  if (loadingCampanha && !isNew) {
    return (
      <div className="container mx-auto p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  if (!isNew && !campanha) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-sm text-muted-foreground">Campanha não encontrada.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
      {/* Breadcrumb */}
      <nav className="text-sm text-muted-foreground mb-4 flex items-center gap-1 flex-wrap">
        <span>Reposição</span>
        <ChevronRight className="h-3 w-3" />
        <Link
          to="/admin/reposicao/promocoes"
          className="hover:text-foreground transition-colors"
        >
          Promoções
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground font-medium truncate">
          {isNew ? "Nova campanha" : campanha?.nome}
        </span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* ========== CONTEÚDO PRINCIPAL ========== */}
        <div>
          <Tabs defaultValue="detalhes">
            <TabsList>
              <TabsTrigger value="detalhes">Detalhes</TabsTrigger>
              <TabsTrigger value="itens" disabled={isNew}>
                Itens {itensAtivos > 0 && `(${itensAtivos})`}
              </TabsTrigger>
              {tipoOrigem === "negociacao_cliente" && (
                <TabsTrigger value="negociacao" disabled={isNew}>
                  Negociação {eventos.length > 0 && `(${eventos.length})`}
                </TabsTrigger>
              )}
            </TabsList>

            {/* ========== TAB DETALHES ========== */}
            <DetalhesTab
              campanha={campanha}
              signedUrl={signedUrl}
              formNome={formNome}
              setFormNome={setFormNome}
              formInicio={formInicio}
              setFormInicio={setFormInicio}
              formFim={formFim}
              setFormFim={setFormFim}
              formObs={formObs}
              setFormObs={setFormObs}
              tipoOrigem={tipoOrigem}
              isNew={isNew}
              onSave={() => saveCampanhaMut.mutate()}
              saving={saveCampanhaMut.isPending}
            />

            {/* ========== TAB ITENS ========== */}
            <ItensTab
              itens={itens}
              loadingItens={loadingItens}
              efetivoMap={efetivoMap}
              userEmail={userEmail}
              addingItem={addingItem}
              setAddingItem={setAddingItem}
              novoCodFornecedor={novoCodFornecedor}
              setNovoCodFornecedor={setNovoCodFornecedor}
              novoDesconto={novoDesconto}
              setNovoDesconto={setNovoDesconto}
              novoVolume={novoVolume}
              setNovoVolume={setNovoVolume}
              savingNovoItem={savingNovoItem}
              onAddItem={handleAddItem}
              onUpdateItem={(args) => updateItemMut.mutate(args)}
              onDeleteItem={(itemId) => deleteItemMut.mutate(itemId)}
              onCancelAdd={() => {
                setAddingItem(false);
                setNovoCodFornecedor("");
                setNovoDesconto("");
                setNovoVolume("");
              }}
            />

            {/* ========== TAB NEGOCIAÇÃO ========== */}
            {tipoOrigem === "negociacao_cliente" && (
              <NegociacaoTab
                eventos={eventos}
                onOpenEvento={() => setEventoOpen(true)}
              />
            )}
          </Tabs>
        </div>

        {/* ========== SIDEBAR DIREITA ========== */}
        <div>
          <EstadoAcoesSidebar
            estado={estado}
            isNew={isNew}
            itensAtivos={itensAtivos}
            itensConfirmados={itensConfirmados}
            podeAtivar={podeAtivar}
            podeCancelar={podeCancelar}
            podeEncerrar={podeEncerrar}
            transitioning={transicionarEstadoMut.isPending}
            onTransition={(novoEstado) =>
              transicionarEstadoMut.mutate(novoEstado)
            }
            onOpenCancel={() => setCancelOpen(true)}
          />
        </div>
      </div>

      {/* ========== DIALOG NOVO EVENTO ========== */}
      <EventoDialog
        open={eventoOpen}
        onOpenChange={setEventoOpen}
        value={novoEvento}
        onChange={setNovoEvento}
        userEmail={userEmail}
        onSubmit={() => addEventoMut.mutate()}
        submitting={addEventoMut.isPending}
      />

      {/* ========== ALERT DIALOG CANCELAR ========== */}
      <CancelCampanhaDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={() => transicionarEstadoMut.mutate("cancelada")}
      />
    </div>
  );
}
