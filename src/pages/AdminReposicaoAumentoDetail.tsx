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
  Trash2,
  ExternalLink,
  Plus,
  CheckCircle2,
  XCircle,
  Layers,
  TrendingUp,
  Sparkles,
  Mail,
  Search as SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const EMPRESA = "OBEN";

type Aumento = {
  id: number;
  empresa: string;
  nome: string;
  fornecedor_nome: string;
  data_vigencia: string;
  data_anuncio: string | null;
  estado: string;
  observacoes: string | null;
  origem_arquivo_url: string | null;
  origem_arquivo_tipo: string | null;
  origem_email_assunto: string | null;
  origem_email_remetente: string | null;
  origem_email_data: string | null;
  extracao_confianca: number | null;
  extracao_observacoes: string | null;
};

type Item = {
  id: number;
  aumento_id: number;
  categoria_fornecedor: string;
  aumento_perc: number;
  data_vigencia_especifica: string | null;
  confirmado: boolean;
  ativo: boolean;
  observacoes: string | null;
};

type Mapeamento = {
  id: number;
  aumento_item_id: number;
  familia_omie: string;
  sku_codigo_omie_especifico: number | null;
};

type SkuAfetado = {
  sku_codigo_omie: number;
  sku_descricao: string | null;
  familia: string | null;
  categoria_fornecedor: string;
  data_vigencia_efetiva: string;
  aumento_perc: number;
};

const ESTADOS_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  ativo: "Ativo",
  vigente: "Vigente",
  expirado: "Expirado",
  cancelado: "Cancelado",
};

function estadoBadgeClass(estado: string): string {
  switch (estado) {
    case "rascunho":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
    case "ativo":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
    case "vigente":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
    case "expirado":
      return "bg-muted text-muted-foreground border-border";
    case "cancelado":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "";
  }
}

function confiancaClass(c: number | null): string {
  if (c === null) return "";
  if (c < 0.5) return "bg-destructive/15 text-destructive border-destructive/30";
  if (c <= 0.8)
    return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
}

function diasEntre(data: string): number {
  const target = new Date(data + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

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
        .from("fornecedor_aumento_anunciado" as any)
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
        .from("fornecedor_aumento_item" as any)
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
        .from("categoria_aumento_familia_mapeamento" as any)
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
        .from("v_sku_aumento_vigente" as any)
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
          .from("fornecedor_aumento_anunciado" as any)
          .insert({
            ...payload,
            estado: "rascunho",
            criado_por: user?.email ?? null,
          })
          .select("id")
          .single();
        if (error) throw error;
        return (data as any).id as number;
      }
      const { error } = await supabase
        .from("fornecedor_aumento_anunciado" as any)
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
    onError: (err: any) => toast.error(err?.message || "Erro ao salvar"),
  });

  const updateEstado = useMutation({
    mutationFn: async (novoEstado: string) => {
      const { error } = await supabase
        .from("fornecedor_aumento_anunciado" as any)
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
    onError: (err: any) => toast.error(err?.message || "Erro ao alterar estado"),
  });

  const updateItem = useMutation({
    mutationFn: async (params: { id: number; patch: Partial<Item> }) => {
      const { error } = await supabase
        .from("fornecedor_aumento_item" as any)
        .update(params.patch)
        .eq("id", params.id);
      if (error) throw error;
    },
    onSuccess: () => {
      refetchItens();
    },
    onError: (err: any) => toast.error(err?.message || "Erro ao atualizar item"),
  });

  const deleteItem = useMutation({
    mutationFn: async (id: number) => {
      const { error } = await supabase
        .from("fornecedor_aumento_item" as any)
        .update({ ativo: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Categoria removida");
      refetchItens();
    },
    onError: (err: any) => toast.error(err?.message || "Erro ao remover"),
  });

  const addItem = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("fornecedor_aumento_item" as any)
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
    onError: (err: any) => toast.error(err?.message || "Erro ao adicionar"),
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
    } catch (e: any) {
      toast.error(e?.message || "Falha ao abrir arquivo");
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
                            itensSemMapeamento > 0 ? "text-amber-600" : ""
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

// ============= SUB-COMPONENTS =============

function CancelarButton({ onConfirm }: { onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="w-full text-destructive">
          <XCircle className="h-4 w-4" /> Cancelar
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancelar anúncio de aumento?</AlertDialogTitle>
          <AlertDialogDescription>
            Esta ação não pode ser desfeita. O anúncio ficará marcado como
            cancelado.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Voltar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Confirmar cancelamento
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ItemRow({
  item,
  numFamilias,
  onUpdate,
  onDelete,
  onMapeamentoChanged,
}: {
  item: Item;
  numFamilias: number;
  onUpdate: (patch: Partial<Item>) => void;
  onDelete: () => void;
  onMapeamentoChanged: () => void;
}) {
  const [categoria, setCategoria] = useState(item.categoria_fornecedor);
  const [perc, setPerc] = useState(String(item.aumento_perc));
  const [vig, setVig] = useState(item.data_vigencia_especifica ?? "");
  const [mapDialogOpen, setMapDialogOpen] = useState(false);

  useEffect(() => {
    setCategoria(item.categoria_fornecedor);
    setPerc(String(item.aumento_perc));
    setVig(item.data_vigencia_especifica ?? "");
  }, [item]);

  return (
    <>
      <TableRow>
        <TableCell>
          <Input
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            onBlur={() => {
              if (categoria !== item.categoria_fornecedor) {
                onUpdate({ categoria_fornecedor: categoria });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Input
            type="number"
            step="0.01"
            value={perc}
            onChange={(e) => setPerc(e.target.value)}
            onBlur={() => {
              const n = Number(perc);
              if (!isNaN(n) && n !== item.aumento_perc) {
                onUpdate({ aumento_perc: n });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Input
            type="date"
            value={vig}
            onChange={(e) => setVig(e.target.value)}
            onBlur={() => {
              const v = vig || null;
              if (v !== item.data_vigencia_especifica) {
                onUpdate({ data_vigencia_especifica: v });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMapDialogOpen(true)}
            className="w-full justify-start"
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="text-xs">
              {numFamilias > 0
                ? `${numFamilias} ${numFamilias === 1 ? "família" : "famílias"}`
                : "Mapear"}
            </span>
          </Button>
        </TableCell>
        <TableCell className="text-center">
          <Checkbox
            checked={item.confirmado}
            onCheckedChange={(c) => onUpdate({ confirmado: c === true })}
          />
        </TableCell>
        <TableCell>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remover categoria?</AlertDialogTitle>
                <AlertDialogDescription>
                  A categoria "{item.categoria_fornecedor}" será desativada.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Voltar</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>
                  Remover
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      </TableRow>

      <MapeamentoDialog
        open={mapDialogOpen}
        onOpenChange={setMapDialogOpen}
        item={item}
        onSaved={() => {
          setMapDialogOpen(false);
          onMapeamentoChanged();
        }}
      />
    </>
  );
}

// ============= MAPEAMENTO DIALOG =============

type FamiliaSelecionada = {
  familia: string;
  apenasEspecificos: boolean;
  skusEspecificos: number[];
};

function MapeamentoDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: Item;
  onSaved: () => void;
}) {
  const [busca, setBusca] = useState("");
  const [selecionadas, setSelecionadas] = useState<FamiliaSelecionada[]>([]);
  const [skuPickerFor, setSkuPickerFor] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Lista de famílias do Omie
  const { data: familiasOmie = [] } = useQuery({
    queryKey: ["omie-familias-aumento"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("omie_products")
        .select("familia")
        .ilike("account", "oben")
        .not("familia", "is", null)
        .limit(5000);
      if (error) throw error;
      const set = new Set<string>();
      ((data || []) as any[]).forEach((r) => r.familia && set.add(r.familia));
      return Array.from(set).sort();
    },
  });

  // Mapeamentos existentes para este item
  const { data: existentes = [] } = useQuery({
    queryKey: ["mapeamentos-item", item.id, open],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("categoria_aumento_familia_mapeamento" as any)
        .select("familia_omie, sku_codigo_omie_especifico")
        .eq("aumento_item_id", item.id);
      if (error) throw error;
      return (data || []) as unknown as Array<{
        familia_omie: string;
        sku_codigo_omie_especifico: number | null;
      }>;
    },
  });

  // Hidrata estado quando abre
  useEffect(() => {
    if (!open) return;
    const grouped: Record<string, FamiliaSelecionada> = {};
    for (const e of existentes) {
      if (!grouped[e.familia_omie]) {
        grouped[e.familia_omie] = {
          familia: e.familia_omie,
          apenasEspecificos: false,
          skusEspecificos: [],
        };
      }
      if (e.sku_codigo_omie_especifico !== null) {
        grouped[e.familia_omie].apenasEspecificos = true;
        grouped[e.familia_omie].skusEspecificos.push(
          e.sku_codigo_omie_especifico,
        );
      }
    }
    setSelecionadas(Object.values(grouped));
  }, [open, existentes]);

  const familiasFiltradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return familiasOmie.slice(0, 30);
    return familiasOmie.filter((f) => f.toLowerCase().includes(q)).slice(0, 50);
  }, [busca, familiasOmie]);

  const adicionarFamilia = (familia: string) => {
    if (selecionadas.find((s) => s.familia === familia)) return;
    setSelecionadas([
      ...selecionadas,
      { familia, apenasEspecificos: false, skusEspecificos: [] },
    ]);
    setBusca("");
  };

  const removerFamilia = (familia: string) => {
    setSelecionadas(selecionadas.filter((s) => s.familia !== familia));
  };

  const toggleEspecificos = (familia: string, valor: boolean) => {
    setSelecionadas(
      selecionadas.map((s) =>
        s.familia === familia
          ? { ...s, apenasEspecificos: valor, skusEspecificos: valor ? s.skusEspecificos : [] }
          : s,
      ),
    );
    if (valor) setSkuPickerFor(familia);
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      // DELETE existentes
      const { error: delErr } = await supabase
        .from("categoria_aumento_familia_mapeamento" as any)
        .delete()
        .eq("aumento_item_id", item.id);
      if (delErr) throw delErr;

      // INSERT novos
      const inserts: Array<{
        aumento_item_id: number;
        familia_omie: string;
        sku_codigo_omie_especifico: number | null;
      }> = [];
      for (const s of selecionadas) {
        if (s.apenasEspecificos && s.skusEspecificos.length > 0) {
          for (const sku of s.skusEspecificos) {
            inserts.push({
              aumento_item_id: item.id,
              familia_omie: s.familia,
              sku_codigo_omie_especifico: sku,
            });
          }
        } else {
          inserts.push({
            aumento_item_id: item.id,
            familia_omie: s.familia,
            sku_codigo_omie_especifico: null,
          });
        }
      }
      if (inserts.length > 0) {
        const { error: insErr } = await supabase
          .from("categoria_aumento_familia_mapeamento" as any)
          .insert(inserts);
        if (insErr) throw insErr;
      }
      toast.success("Mapeamento salvo");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar mapeamento");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mapear "{item.categoria_fornecedor}"</DialogTitle>
          <DialogDescription>
            Selecione as famílias do Omie afetadas por este aumento.
            Opcionalmente restrinja a SKUs específicos por família.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Buscador */}
          <div>
            <Label>Adicionar família</Label>
            <div className="relative mt-1.5">
              <SearchIcon className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar família…"
                className="pl-9"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
            {busca.trim() && familiasFiltradas.length > 0 && (
              <div className="mt-2 border rounded-md max-h-48 overflow-y-auto">
                {familiasFiltradas.map((f) => (
                  <button
                    key={f}
                    onClick={() => adicionarFamilia(f)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                    disabled={!!selecionadas.find((s) => s.familia === f)}
                  >
                    {f}
                    {selecionadas.find((s) => s.familia === f) && (
                      <span className="text-xs text-muted-foreground ml-2">
                        (já adicionada)
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Lista de famílias selecionadas */}
          <div className="space-y-2">
            <Label>Famílias mapeadas ({selecionadas.length})</Label>
            {selecionadas.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                Nenhuma família mapeada.
              </p>
            )}
            {selecionadas.map((s) => {
              const aplicaFamiliaInteira = !s.apenasEspecificos;
              return (
                <Card key={s.familia}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm">{s.familia}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removerFamilia(s.familia)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>

                    {/* Toggle principal — default = família inteira */}
                    <div
                      className={`flex items-start gap-2 rounded-md border p-2.5 ${
                        aplicaFamiliaInteira
                          ? "border-primary/40 bg-primary/5"
                          : "border-border"
                      }`}
                    >
                      <Checkbox
                        id={`fam-${s.familia}`}
                        checked={aplicaFamiliaInteira}
                        onCheckedChange={(c) =>
                          toggleEspecificos(s.familia, !(c === true))
                        }
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <Label
                          htmlFor={`fam-${s.familia}`}
                          className="text-sm font-medium cursor-pointer"
                        >
                          Aplicar a TODA a família (todos os SKUs)
                        </Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Salva uma única linha no banco. Desmarque para escolher SKUs específicos.
                        </p>
                      </div>
                    </div>

                    {!aplicaFamiliaInteira && (
                      <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">
                          {s.skusEspecificos.length} SKU
                          {s.skusEspecificos.length === 1 ? "" : "s"} selecionado
                          {s.skusEspecificos.length === 1 ? "" : "s"}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSkuPickerFor(s.familia)}
                        >
                          Selecionar SKUs
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={salvando}>
            {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar mapeamento
          </Button>
        </DialogFooter>

        {/* Sub-dialog: picker de SKUs */}
        {skuPickerFor && (
          <SkuPickerDialog
            familia={skuPickerFor}
            initialSelected={
              selecionadas.find((s) => s.familia === skuPickerFor)?.skusEspecificos ?? []
            }
            onClose={() => setSkuPickerFor(null)}
            onConfirm={(skus) => {
              setSelecionadas(
                selecionadas.map((s) =>
                  s.familia === skuPickerFor
                    ? { ...s, skusEspecificos: skus }
                    : s,
                ),
              );
              setSkuPickerFor(null);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SkuPickerDialog({
  familia,
  initialSelected,
  onClose,
  onConfirm,
}: {
  familia: string;
  initialSelected: number[];
  onClose: () => void;
  onConfirm: (skus: number[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(
    new Set(initialSelected),
  );
  const [busca, setBusca] = useState("");

  const { data: skus = [], isLoading } = useQuery({
    queryKey: ["skus-familia", familia],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("omie_products")
        .select("omie_codigo_produto, descricao")
        .ilike("account", "oben")
        .eq("familia", familia)
        .order("descricao", { ascending: true })
        .limit(2000);
      if (error) throw error;
      return (data || []) as Array<{
        omie_codigo_produto: number;
        descricao: string | null;
      }>;
    },
  });

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter(
      (s) =>
        (s.descricao ?? "").toLowerCase().includes(q) ||
        String(s.omie_codigo_produto).includes(q),
    );
  }, [skus, busca]);

  const toggle = (codigo: number) => {
    const next = new Set(selected);
    if (next.has(codigo)) next.delete(codigo);
    else next.add(codigo);
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>SKUs de "{familia}"</DialogTitle>
          <DialogDescription>
            Selecione os SKUs específicos que recebem o aumento.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por código ou descrição…"
            className="pl-9"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <div className="border rounded-md max-h-[400px] overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : filtrados.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              Nenhum SKU encontrado.
            </div>
          ) : (
            filtrados.map((sku) => (
              <label
                key={sku.omie_codigo_produto}
                className="flex items-center gap-2 px-3 py-2 hover:bg-muted text-sm cursor-pointer border-b last:border-b-0"
              >
                <Checkbox
                  checked={selected.has(sku.omie_codigo_produto)}
                  onCheckedChange={() => toggle(sku.omie_codigo_produto)}
                />
                <span className="font-mono text-xs text-muted-foreground w-20 shrink-0">
                  {sku.omie_codigo_produto}
                </span>
                <span className="truncate">{sku.descricao}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <p className="text-sm text-muted-foreground mr-auto">
            {selected.size} selecionado{selected.size === 1 ? "" : "s"}
          </p>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => onConfirm(Array.from(selected))}>
            Confirmar seleção
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
