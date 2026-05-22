import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loader2,
  Save,
  ExternalLink,
  Plus,
  CheckCircle2,
  TrendingUp,
  Sparkles,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Aumento, Item, Mapeamento, SkuAfetado } from "@/components/reposicao/aumentoDetail/types";
import { EMPRESA, ESTADOS_LABEL, estadoBadgeClass, confiancaClass, diasEntre } from "@/components/reposicao/aumentoDetail/shared";
import { CancelarButton } from "@/components/reposicao/aumentoDetail/CancelarButton";
import { ItemRow } from "@/components/reposicao/aumentoDetail/ItemRow";

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
                {form.origem_arquivo_url && (
                  <Card className="border-primary/30 bg-primary/5">
                    <CardContent className="pt-6 space-y-3">
                      <div className="flex items-start gap-3">
                        <Sparkles className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">
                              Extraído via Vision
                            </span>
                            {form.extracao_confianca !== null &&
                              form.extracao_confianca !== undefined && (
                                <Badge
                                  variant="outline"
                                  className={confiancaClass(
                                    form.extracao_confianca,
                                  )}
                                >
                                  Confiança {Math.round(form.extracao_confianca * 100)}%
                                </Badge>
                              )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={openOriginalFile}
                            >
                              <ExternalLink className="h-4 w-4" /> Ver arquivo original
                            </Button>
                          </div>
                          {form.extracao_observacoes && (
                            <p className="text-sm italic text-muted-foreground">
                              {form.extracao_observacoes}
                            </p>
                          )}
                          {form.origem_email_remetente && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Mail className="h-3 w-3" />
                              <span>
                                De: {form.origem_email_remetente}
                                {form.origem_email_assunto &&
                                  ` · Assunto: ${form.origem_email_assunto}`}
                                {form.origem_email_data &&
                                  ` · Recebido: ${new Date(form.origem_email_data).toLocaleDateString("pt-BR")}`}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Dados do anúncio</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label htmlFor="nome">Nome *</Label>
                      <Input
                        id="nome"
                        value={form.nome ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, nome: e.target.value })
                        }
                        placeholder="Ex: Reajuste de Preços Maio 2026"
                      />
                    </div>

                    <div>
                      <Label htmlFor="fornecedor">Fornecedor</Label>
                      <Input
                        id="fornecedor"
                        value={form.fornecedor_nome ?? ""}
                        readOnly={!!form.origem_arquivo_url}
                        onChange={(e) =>
                          setForm({ ...form, fornecedor_nome: e.target.value })
                        }
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="data_vigencia">Data de vigência *</Label>
                        <Input
                          id="data_vigencia"
                          type="date"
                          value={form.data_vigencia ?? ""}
                          onChange={(e) =>
                            setForm({ ...form, data_vigencia: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="data_anuncio">Data do anúncio</Label>
                        <Input
                          id="data_anuncio"
                          type="date"
                          value={form.data_anuncio ?? ""}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              data_anuncio: e.target.value || null,
                            })
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="observacoes">Observações</Label>
                      <Textarea
                        id="observacoes"
                        rows={3}
                        value={form.observacoes ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, observacoes: e.target.value })
                        }
                      />
                    </div>

                    <Button
                      onClick={() => saveDetalhes.mutate()}
                      disabled={saveDetalhes.isPending}
                    >
                      {saveDetalhes.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Salvar alterações
                    </Button>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* TAB CATEGORIAS */}
              <TabsContent value="categorias" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2">
                    <CardTitle className="text-base">
                      Categorias do fornecedor
                    </CardTitle>
                    <Button size="sm" onClick={() => addItem.mutate()}>
                      <Plus className="h-4 w-4" /> Adicionar categoria
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Categoria</TableHead>
                            <TableHead className="w-[100px]">% aumento</TableHead>
                            <TableHead className="w-[150px]">Vig. específica</TableHead>
                            <TableHead className="w-[160px]">Mapeamento</TableHead>
                            <TableHead className="w-[100px] text-center">
                              Confirmado
                            </TableHead>
                            <TableHead className="w-[60px]"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {itens.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={6}
                                className="text-center text-muted-foreground py-8"
                              >
                                Nenhuma categoria. Clique em "Adicionar
                                categoria".
                              </TableCell>
                            </TableRow>
                          )}
                          {itens.map((item) => (
                            <ItemRow
                              key={item.id}
                              item={item}
                              numFamilias={familiasUnicasPorItem(item.id)}
                              onUpdate={(patch) =>
                                updateItem.mutate({ id: item.id, patch })
                              }
                              onDelete={() => deleteItem.mutate(item.id)}
                              onMapeamentoChanged={() => {
                                refetchMaps();
                              }}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* TAB SKUS */}
              <TabsContent value="skus" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      SKUs afetados ({skusAfetados.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>SKU</TableHead>
                            <TableHead>Descrição</TableHead>
                            <TableHead>Família</TableHead>
                            <TableHead>Categoria</TableHead>
                            <TableHead>Vigência</TableHead>
                            <TableHead className="text-right">% aumento</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {skusAfetados.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={6}
                                className="text-center text-muted-foreground py-8"
                              >
                                Nenhum SKU afetado. Configure mapeamentos na aba
                                anterior.
                              </TableCell>
                            </TableRow>
                          )}
                          {skusAfetados.map((sku) => (
                            <TableRow key={sku.sku_codigo_omie}>
                              <TableCell className="font-mono text-xs">
                                {sku.sku_codigo_omie}
                              </TableCell>
                              <TableCell className="text-sm">
                                {sku.sku_descricao}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {sku.familia}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {sku.categoria_fornecedor}
                              </TableCell>
                              <TableCell className="tabular-nums text-sm">
                                {sku.data_vigencia_efetiva}
                              </TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {Number(sku.aumento_perc).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* Sidebar direita */}
          <div className="lg:sticky lg:top-4 self-start space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Estado e ações</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Badge
                    variant="outline"
                    className={`text-base px-3 py-1 ${estadoBadgeClass(estadoAtual)}`}
                  >
                    {ESTADOS_LABEL[estadoAtual] ?? estadoAtual}
                  </Badge>
                </div>

                {!isNew && (
                  <>
                    <div className="text-sm space-y-1 border-t pt-3">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Categorias ativas</span>
                        <span className="font-medium tabular-nums">{itensAtivos}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Confirmadas</span>
                        <span className="font-medium tabular-nums">
                          {itensConfirmados}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Sem mapeamento</span>
                        <span
                          className={`font-medium tabular-nums ${
                            itensSemMapeamento > 0 ? "text-status-warning" : ""
                          }`}
                        >
                          {itensSemMapeamento}
                        </span>
                      </div>
                      <div className="flex justify-between border-t pt-2 mt-2">
                        <span className="text-muted-foreground">SKUs afetados</span>
                        <Badge variant="outline" className="tabular-nums">
                          {skusAfetados.length}
                        </Badge>
                      </div>
                    </div>

                    {diasParaVigencia !== null && (
                      <p className="text-xs text-muted-foreground italic">
                        {diasParaVigencia >= 0
                          ? `Entra em vigência em ${diasParaVigencia} dia${diasParaVigencia === 1 ? "" : "s"}`
                          : `Vigência iniciada há ${-diasParaVigencia} dia${-diasParaVigencia === 1 ? "" : "s"}`}
                      </p>
                    )}
                    {diasEmVigencia !== null && diasEmVigencia >= 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        Em vigência há {diasEmVigencia} dia
                        {diasEmVigencia === 1 ? "" : "s"}
                      </p>
                    )}

                    <div className="space-y-2 border-t pt-3">
                      {estadoAtual === "rascunho" && (
                        <>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block">
                                <Button
                                  className="w-full"
                                  disabled={!podeAtivar || updateEstado.isPending}
                                  onClick={() => updateEstado.mutate("ativo")}
                                >
                                  <CheckCircle2 className="h-4 w-4" /> Ativar anúncio
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {!podeAtivar && (
                              <TooltipContent>
                                {itensAtivos === 0
                                  ? "Adicione ao menos uma categoria"
                                  : itensConfirmados < itensAtivos
                                    ? "Confirme todas as categorias"
                                    : "Mapeie ao menos uma família"}
                              </TooltipContent>
                            )}
                          </Tooltip>
                          <CancelarButton
                            onConfirm={() => updateEstado.mutate("cancelado")}
                          />
                        </>
                      )}
                      {estadoAtual === "ativo" && (
                        <CancelarButton
                          onConfirm={() => updateEstado.mutate("cancelado")}
                        />
                      )}
                      {estadoAtual === "vigente" && (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => updateEstado.mutate("expirado")}
                          disabled={updateEstado.isPending}
                        >
                          Marcar como expirado
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
