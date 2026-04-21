import { useState, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  TrendingUp,
  Search,
  Loader2,
  Upload,
  FilePlus,
  FileText,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { agruparPorMes, chavesUltimosNMeses } from "@/lib/agruparPorMes";
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

const EMPRESA = "OBEN";
const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";
const ALL = "__all__";

type Aumento = {
  id: number;
  nome: string;
  fornecedor_nome: string;
  data_vigencia: string;
  data_anuncio: string | null;
  estado: string;
  extracao_confianca: number | null;
  criado_em: string;
};

type AumentoComAgg = Aumento & {
  num_categorias: number;
  perc_medio: number | null;
};

const ESTADOS: Array<{ value: string; label: string }> = [
  { value: "rascunho", label: "Rascunho" },
  { value: "ativo", label: "Ativo" },
  { value: "vigente", label: "Vigente" },
  { value: "expirado", label: "Expirado" },
  { value: "cancelado", label: "Cancelado" },
];

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

function formatDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y.slice(2)}`;
}

export default function AdminReposicaoAumentos() {
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
        .from("fornecedor_aumento_anunciado" as any)
        .select("fornecedor_nome")
        .eq("empresa", EMPRESA);
      if (error) throw error;
      const uniq = Array.from(
        new Set(((data as any[]) || []).map((r) => r.fornecedor_nome).filter(Boolean)),
      ) as string[];
      return uniq.sort();
    },
  });

  const { data: aumentos = [], isLoading } = useQuery({
    queryKey: ["aumentos", filtroFornecedor, filtroEstado, busca],
    queryFn: async () => {
      let q = supabase
        .from("fornecedor_aumento_anunciado" as any)
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
          .from("fornecedor_aumento_item" as any)
          .select("aumento_id, aumento_perc, ativo, confirmado")
          .in("aumento_id", ids)
          .eq("ativo", true);
        ((itens || []) as any[]).forEach((it) => {
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
    } catch (e: any) {
      toast.error(e?.message || "Erro ao extrair aumento");
    } finally {
      setExtraindo(false);
    }
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Aumentos anunciados</h1>
            <p className="text-sm text-muted-foreground">
              Reajustes de preços anunciados pelos fornecedores
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" /> Upload PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/admin/reposicao/aumentos/novo")}
          >
            <FilePlus className="h-4 w-4" /> Novo aumento
          </Button>
        </div>
      </header>

      {ativosAguardando > 0 && filtroEstado !== "ativo" && (
        <Card className="border-blue-500/40 bg-blue-500/5">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <div>
                <p className="font-medium">
                  {ativosAguardando}{" "}
                  {ativosAguardando === 1
                    ? "aumento ativo aguardando vigência"
                    : "aumentos ativos aguardando vigência"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Confirmados, aguardando a data de início.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFiltroEstado("ativo")}
            >
              Ver ativos
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anúncios</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Select value={filtroFornecedor} onValueChange={setFiltroFornecedor}>
              <SelectTrigger>
                <SelectValue placeholder="Fornecedor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
                {fornecedores.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filtroEstado} onValueChange={setFiltroEstado}>
              <SelectTrigger>
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Ativos (exceto expirado)</SelectItem>
                {ESTADOS.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="md:col-span-2 relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome…"
                className="pl-9"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
          </div>

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
                    <TableHead>Vigência</TableHead>
                    <TableHead>Anúncio</TableHead>
                    <TableHead className="text-right">Categorias</TableHead>
                    <TableHead className="text-right">% médio</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aumentos.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-muted-foreground py-12"
                      >
                        Nenhum aumento encontrado.
                      </TableCell>
                    </TableRow>
                  )}
                  {aumentos.map((a) => (
                    <TableRow
                      key={a.id}
                      className="cursor-pointer"
                      onClick={() =>
                        navigate(`/admin/reposicao/aumentos/${a.id}`)
                      }
                    >
                      <TableCell className="font-medium">{a.nome}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.fornecedor_nome}
                      </TableCell>
                      <TableCell className="tabular-nums text-sm">
                        {formatDate(a.data_vigencia)}
                      </TableCell>
                      <TableCell className="tabular-nums text-sm text-muted-foreground">
                        {formatDate(a.data_anuncio)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {a.num_categorias}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {a.perc_medio !== null
                          ? `${a.perc_medio.toFixed(2)}%`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={estadoBadgeClass(a.estado)}
                        >
                          {ESTADOS.find((e) => e.value === a.estado)?.label ?? a.estado}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={uploadOpen}
        onOpenChange={(o) => {
          if (!extraindo) {
            setUploadOpen(o);
            if (!o) resetUpload();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload de anúncio de aumento</DialogTitle>
            <DialogDescription>
              Selecione um PDF ou imagem do comunicado. A IA vai extrair nome,
              data de vigência e categorias com percentual de aumento.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              onChange={handleFileChange}
              disabled={extraindo}
            />
            {arquivo && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{arquivo.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(arquivo.size / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setUploadOpen(false);
                resetUpload();
              }}
              disabled={extraindo}
            >
              Cancelar
            </Button>
            <Button onClick={handleExtrair} disabled={!arquivo || extraindo}>
              {extraindo && <Loader2 className="h-4 w-4 animate-spin" />}
              Extrair
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
