import { useState, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Percent,
  Search,
  Loader2,
  Upload,
  FilePlus,
  Handshake,
  AlertTriangle,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const MAX_CONCURRENT = 3;

type UploadStatus = "aguardando" | "processando" | "concluido" | "erro";

type UploadItem = {
  id: string;
  file: File;
  status: UploadStatus;
  campanhaId?: number;
  nomeCampanha?: string;
  itensExtraidos?: number;
  confianca?: number | null;
  erro?: string;
};

const EMPRESA = "OBEN";
const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";
const ALL = "__all__";

type Campanha = {
  id: number;
  nome: string;
  fornecedor_nome: string;
  tipo_origem: string;
  data_inicio: string;
  data_fim: string;
  estado: string;
  extracao_confianca: number | null;
  criado_em: string;
};

type CampanhaComContagem = Campanha & { num_itens: number };

const ESTADOS: Array<{ value: string; label: string }> = [
  { value: "rascunho", label: "Rascunho" },
  { value: "negociando", label: "Negociando" },
  { value: "ativa", label: "Ativa" },
  { value: "encerrada", label: "Encerrada" },
  { value: "cancelada", label: "Cancelada" },
];

function estadoBadgeClass(estado: string): string {
  switch (estado) {
    case "rascunho":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
    case "negociando":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
    case "ativa":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
    case "encerrada":
      return "bg-muted text-muted-foreground border-border";
    case "cancelada":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "";
  }
}

function confiancaBadge(c: number | null) {
  if (c === null || c === undefined) return null;
  let cls = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (c < 0.5) cls = "bg-destructive/15 text-destructive border-destructive/30";
  else if (c <= 0.8) cls = "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return (
    <Badge variant="outline" className={cls}>
      {Math.round(c * 100)}%
    </Badge>
  );
}

function formatPeriodo(inicio: string, fim: string): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y.slice(2)}`;
  };
  return `${fmt(inicio)} – ${fmt(fim)}`;
}

export default function AdminReposicaoPromocoes() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [filtroEstado, setFiltroEstado] = useState<string>(ALL);
  const [filtroFornecedor, setFiltroFornecedor] = useState<string>(ALL);
  const [busca, setBusca] = useState("");



  // Upload modal — múltiplos arquivos
  const [uploadOpen, setUploadOpen] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [processando, setProcessando] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ============ QUERIES ============
  const { data: campanhas = [], isLoading } = useQuery({
    queryKey: ["promocao-campanhas", filtroEstado, busca],
    queryFn: async () => {
      let q = supabase
        .from("promocao_campanha" as any)
        .select(
          "id, nome, fornecedor_nome, tipo_origem, data_inicio, data_fim, estado, extracao_confianca, criado_em",
        )
        .eq("empresa", EMPRESA)
        .eq("fornecedor_nome", FORNECEDOR_DEFAULT)
        .order("criado_em", { ascending: false });

      if (filtroEstado !== ALL) q = q.eq("estado", filtroEstado);
      if (busca.trim()) q = q.ilike("nome", `%${busca.trim()}%`);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data || []) as unknown as Campanha[];

      // Buscar contagem de itens em batch
      const ids = rows.map((c) => c.id);
      const counts: Record<number, number> = {};
      if (ids.length > 0) {
        const { data: itens } = await supabase
          .from("promocao_item" as any)
          .select("campanha_id")
          .in("campanha_id", ids);
        ((itens || []) as any[]).forEach((it) => {
          counts[it.campanha_id] = (counts[it.campanha_id] || 0) + 1;
        });
      }

      return rows.map<CampanhaComContagem>((c) => ({
        ...c,
        num_itens: counts[c.id] || 0,
      }));
    },
  });

  const aguardandoRevisao = useMemo(
    () => campanhas.filter((c) => c.estado === "rascunho").length,
    [campanhas],
  );

  // ============ UPLOAD MULTIPLO ============
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
              .from("promocao_campanha" as any)
              .select("nome")
              .eq("id", campanhaId)
              .maybeSingle();
            if (row && (row as any).nome) {
              nomeCampanha = (row as any).nome as string;
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
      } catch (e: any) {
        updateItem(item.id, {
          status: "erro",
          erro: e?.message || "Falha desconhecida",
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
    qc.invalidateQueries({ queryKey: ["promocao-campanhas"] });
  };

  const tentarNovamente = async (id: string) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setProcessando(true);
    await processarArquivo(it);
    setProcessando(false);
    qc.invalidateQueries({ queryKey: ["promocao-campanhas"] });
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

  const fecharModal = () => {
    if (processando) return;
    setUploadOpen(false);
    resetUpload();
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Percent className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Promoções</h1>
            <p className="text-sm text-muted-foreground">
              Campanhas promocionais de fornecedores e negociações com clientes
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" /> Upload PDF/imagem
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate("/admin/reposicao/promocoes/novo?tipo=fornecedor_impoe")
            }
          >
            <FilePlus className="h-4 w-4" /> Cadastro manual
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate("/admin/reposicao/promocoes/novo?tipo=negociacao_cliente")
            }
          >
            <Handshake className="h-4 w-4" /> Nova negociação
          </Button>
        </div>
      </header>

      {/* Alerta de campanhas aguardando revisão */}
      {aguardandoRevisao > 0 && filtroEstado !== "rascunho" && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium">
                  {aguardandoRevisao}{" "}
                  {aguardandoRevisao === 1
                    ? "campanha aguardando revisão"
                    : "campanhas aguardando revisão"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Itens em rascunho precisam de confirmação de SKU antes de ativar.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFiltroEstado("rascunho")}
            >
              Ver rascunhos
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Campanhas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filtros */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Select value={filtroEstado} onValueChange={setFiltroEstado}>
              <SelectTrigger>
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os estados</SelectItem>
                {ESTADOS.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="md:col-span-3 relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome…"
                className="pl-9"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
          </div>

          {/* Tabela */}
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Período</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-right">Itens</TableHead>
                    <TableHead>Confiança</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campanhas.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-muted-foreground py-12"
                      >
                        Nenhuma campanha encontrada.
                      </TableCell>
                    </TableRow>
                  )}
                  {campanhas.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() =>
                        navigate(`/admin/reposicao/promocoes/${c.id}`)
                      }
                    >
                      <TableCell className="font-medium">{c.nome}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.fornecedor_nome}
                      </TableCell>
                      <TableCell>
                        {c.tipo_origem === "negociacao_cliente" ? (
                          <Badge variant="outline" className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30">
                            Negociação
                          </Badge>
                        ) : (
                          <Badge variant="outline">Fornecedor</Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums text-sm">
                        {formatPeriodo(c.data_inicio, c.data_fim)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={estadoBadgeClass(c.estado)}>
                          {ESTADOS.find((e) => e.value === c.estado)?.label ?? c.estado}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {c.num_itens}
                      </TableCell>
                      <TableCell>{confiancaBadge(c.extracao_confianca)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal de Upload — múltiplos arquivos */}
      <Dialog open={uploadOpen} onOpenChange={(o) => (o ? setUploadOpen(true) : fecharModal())}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload de promoções (lote)</DialogTitle>
            <DialogDescription>
              Selecione um ou mais PDFs/imagens da promoção do fornecedor. A IA extrai
              nome, datas e itens automaticamente. Cada arquivo gera uma campanha em rascunho.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              onChange={handleFileChange}
              disabled={processando}
            />

            {totalItens > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {finalizados} de {totalItens} processados
                    {emProcesso > 0 && ` · ${emProcesso} em andamento`}
                  </span>
                  <span className="font-medium tabular-nums">{progresso}%</span>
                </div>
                <Progress value={progresso} className="h-2" />
              </div>
            )}

            {totalItens > 0 && (
              <TooltipProvider>
                <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
                  {items.map((it) => (
                    <div key={it.id} className="flex items-center gap-2 p-2 text-sm">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{it.file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(it.file.size / 1024).toFixed(1)} KB
                          {it.status === "concluido" && it.nomeCampanha && (
                            <> · {it.nomeCampanha} · {it.itensExtraidos} {it.itensExtraidos === 1 ? "item" : "itens"}</>
                          )}
                          {it.status === "erro" && it.erro && (
                            <span className="text-destructive"> · Extração falhou: {it.erro}</span>
                          )}
                        </p>
                      </div>

                      {it.status === "aguardando" && (
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" /> Aguardando
                        </Badge>
                      )}
                      {it.status === "processando" && (
                        <Badge variant="outline" className="gap-1 bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30">
                          <Loader2 className="h-3 w-3 animate-spin" /> Processando
                        </Badge>
                      )}
                      {it.status === "concluido" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className={cn(
                                "gap-1 cursor-help",
                                "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
                              )}
                            >
                              <CheckCircle2 className="h-3 w-3" /> Concluído
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {it.confianca !== null && it.confianca !== undefined
                              ? `Confiança Gemini: ${Math.round(it.confianca * 100)}%`
                              : "Confiança não informada"}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {it.status === "erro" && (
                        <Badge variant="outline" className="gap-1 bg-destructive/15 text-destructive border-destructive/30">
                          <XCircle className="h-3 w-3" /> Erro
                        </Badge>
                      )}

                      {it.status === "erro" && !processando && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => tentarNovamente(it.id)}
                          title="Tentar novamente"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(it.status === "aguardando" || it.status === "erro") && !processando && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => removerItem(it.id)}
                          title="Remover"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </TooltipProvider>
            )}

            {todosFinalizados && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p className="font-medium">
                  {concluidos} de {totalItens}{" "}
                  {totalItens === 1 ? "campanha criada" : "campanhas criadas"} com sucesso.
                  {comErro > 0 && (
                    <span className="text-destructive">
                      {" "}{comErro} {comErro === 1 ? "campanha" : "campanhas"} com erro.
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  As campanhas ficam em rascunho. Acesse a lista para revisar e ativar.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            {todosFinalizados ? (
              <Button
                onClick={() => {
                  if (concluidos > 0) {
                    toast.success(
                      `${concluidos} ${concluidos === 1 ? "campanha criada" : "campanhas criadas"}`,
                    );
                  }
                  setUploadOpen(false);
                  resetUpload();
                  qc.invalidateQueries({ queryKey: ["promocao-campanhas"] });
                }}
              >
                Ir para lista
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={fecharModal} disabled={processando}>
                  {processando ? "Processando…" : "Cancelar"}
                </Button>
                <Button onClick={iniciarProcessamento} disabled={!podeIniciar}>
                  {processando && <Loader2 className="h-4 w-4 animate-spin" />}
                  {comErro > 0 && aguardando === 0
                    ? `Tentar novamente (${comErro})`
                    : `Processar ${aguardando + comErro} ${aguardando + comErro === 1 ? "arquivo" : "arquivos"}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
