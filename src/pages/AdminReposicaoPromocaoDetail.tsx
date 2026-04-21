import { useState, useMemo, useEffect } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import {
  Loader2,
  Save,
  ChevronRight,
  FileText,
  ExternalLink,
  Mail,
  Plus,
  Trash2,
  Check,
  X,
  Send,
  Reply,
  AlertCircle,
  StickyNote,
  Sparkles,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
} from "@/components/ui/alert-dialog";

const EMPRESA = "OBEN";
const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";

type Campanha = {
  id: number;
  empresa: string;
  nome: string;
  fornecedor_nome: string;
  tipo_origem: string;
  data_inicio: string;
  data_fim: string;
  estado: string;
  observacoes: string | null;
  origem_arquivo_url: string | null;
  origem_arquivo_tipo: string | null;
  origem_email_assunto: string | null;
  origem_email_remetente: string | null;
  origem_email_data: string | null;
  extracao_confianca: number | null;
  extracao_observacoes: string | null;
  extraido_em: string | null;
  criado_em: string;
};

type ItemRow = {
  id: number;
  campanha_id: number;
  sku_codigo_fornecedor: string;
  descricao_produto_fornecedor: string | null;
  sku_codigo_omie: number | null;
  mapeamento_qualidade: string | null;
  mapeamento_candidatos: any;
  desconto_perc: number;
  volume_minimo: number | null;
  confirmado: boolean;
  ativo: boolean;
  desconto_extra_perc: number | null;
  desconto_extra_observacoes: string | null;
  desconto_extra_negociado_por: string | null;
  desconto_extra_negociado_em: string | null;
  desconto_extra_email_referencia: string | null;
};

type ItemEfetivo = {
  id: number;
  desconto_efetivo: number;
};

type Evento = {
  id: number;
  campanha_id: number;
  tipo_evento: string;
  desconto_perc_proposto: number | null;
  volume_minimo_proposto: number | null;
  data_evento: string;
  email_referencia: string | null;
  conteudo: string | null;
  registrado_por: string | null;
  registrado_em: string;
};

const TIPO_EVENTO_LABELS: Record<string, string> = {
  proposta_enviada: "Proposta enviada",
  contraproposta_recebida: "Contra-proposta recebida",
  aceite_lucas: "Aceite (Lucas)",
  aceite_gerente: "Aceite (Gerente)",
  recusa_gerente: "Recusa (Gerente)",
  abandono: "Abandono",
  nota: "Nota",
};

function tipoEventoIcon(tipo: string) {
  switch (tipo) {
    case "proposta_enviada":
      return Send;
    case "contraproposta_recebida":
      return Reply;
    case "aceite_lucas":
    case "aceite_gerente":
      return Check;
    case "recusa_gerente":
      return X;
    case "abandono":
      return AlertCircle;
    case "nota":
    default:
      return StickyNote;
  }
}

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

const ESTADO_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  negociando: "Negociando",
  ativa: "Ativa",
  encerrada: "Encerrada",
  cancelada: "Cancelada",
};

function confiancaBadge(c: number | null) {
  if (c === null || c === undefined) return null;
  let cls =
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (c < 0.5) cls = "bg-destructive/15 text-destructive border-destructive/30";
  else if (c <= 0.8)
    cls =
      "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return (
    <Badge variant="outline" className={cls}>
      Confiança {Math.round(c * 100)}%
    </Badge>
  );
}

function formatDateTimeBR(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "hoje";
  if (diffDays === 1) return "há 1 dia";
  if (diffDays < 30) return `há ${diffDays} dias`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return "há 1 mês";
  return `há ${diffMonths} meses`;
}

// ========== STATUS BADGE DO MAPEAMENTO ==========
function MapeamentoStatusCell({
  item,
  onUpdate,
}: {
  item: ItemRow;
  onUpdate: (changes: Partial<ItemRow>) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ omie_codigo_produto: number; descricao: string; codigo: string }>
  >([]);
  const [searching, setSearching] = useState(false);

  // Busca debounced
  useEffect(() => {
    if (!searchOpen || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      const { data, error } = await supabase
        .from("omie_products" as any)
        .select("omie_codigo_produto, descricao, codigo")
        .eq("account", EMPRESA)
        .ilike("descricao", `%${searchQuery.trim()}%`)
        .limit(20);
      setSearching(false);
      if (!error) setSearchResults((data as any) || []);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, searchOpen]);

  const q = item.mapeamento_qualidade;
  const isConfirmed = item.confirmado;

  // ========== unico + confirmado ==========
  if (q === "unico" && isConfirmed) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 cursor-default"
            >
              <Check className="h-3 w-3 mr-1" /> OK
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-1 text-xs">
              <div className="font-mono">{item.sku_codigo_omie}</div>
              <div>{item.descricao_produto_fornecedor || "—"}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ========== expandido_automatico + confirmado ==========
  if (q === "expandido_automatico" && isConfirmed) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 cursor-default"
            >
              <Sparkles className="h-3 w-3 mr-1" /> Variante
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-1 text-xs">
              <div className="font-mono">{item.sku_codigo_omie}</div>
              <div>{item.descricao_produto_fornecedor || "—"}</div>
              <div className="text-muted-foreground italic">
                Expandido automaticamente de {item.sku_codigo_fornecedor}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ========== similaridade (precisa revisão) ==========
  if (
    (q === "unico_por_similaridade" || q === "expandido_por_similaridade") &&
    !isConfirmed
  ) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Badge
            variant="outline"
            className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 cursor-pointer"
          >
            Revisar — similaridade
          </Badge>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <div className="space-y-3">
            <div>
              <div className="text-xs text-muted-foreground">SKU Omie</div>
              <div className="font-mono text-sm">{item.sku_codigo_omie}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Descrição</div>
              <div className="text-sm">
                {item.descricao_produto_fornecedor || "—"}
              </div>
            </div>
            <p className="text-xs italic text-muted-foreground">
              Resolvido por busca aproximada. Confirme se está correto.
            </p>
            <Button
              size="sm"
              className="w-full"
              onClick={() => onUpdate({ confirmado: true })}
            >
              <Check className="h-4 w-4" /> Confirmar
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // ========== manual_confirmado ==========
  if (q === "manual_confirmado" && isConfirmed) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 cursor-default"
            >
              Manual
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-1 text-xs">
              <div className="font-mono">{item.sku_codigo_omie}</div>
              <div>{item.descricao_produto_fornecedor || "—"}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ========== nao_encontrado (ou null) — busca manual ==========
  return (
    <Popover open={searchOpen} onOpenChange={setSearchOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          className="bg-destructive/15 text-destructive border-destructive/30 cursor-pointer"
        >
          {q === "nao_encontrado" ? "Não encontrado" : "Pendente"}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Buscar produto Omie</Label>
            <div className="relative mt-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Digite parte da descrição…"
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {searching && (
              <div className="text-xs text-muted-foreground flex items-center gap-2 p-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Buscando…
              </div>
            )}
            {!searching && searchQuery.length >= 2 && searchResults.length === 0 && (
              <div className="text-xs text-muted-foreground p-2">
                Nenhum produto encontrado
              </div>
            )}
            {searchResults.map((p) => (
              <button
                key={p.omie_codigo_produto}
                className="w-full text-left p-2 rounded hover:bg-accent transition-colors"
                onClick={() => {
                  onUpdate({
                    sku_codigo_omie: p.omie_codigo_produto,
                    descricao_produto_fornecedor: p.descricao,
                    mapeamento_qualidade: "manual_confirmado",
                    confirmado: true,
                  });
                  setSearchOpen(false);
                }}
              >
                <div className="text-xs font-mono text-muted-foreground">
                  {p.codigo} · {p.omie_codigo_produto}
                </div>
                <div className="text-sm">{p.descricao}</div>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ========== POPOVER DESCONTO EXTRA ==========
function DescontoExtraCell({
  item,
  onSave,
  userEmail,
}: {
  item: ItemRow;
  onSave: (changes: Partial<ItemRow>) => void;
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [perc, setPerc] = useState<string>(
    item.desconto_extra_perc?.toString() || "",
  );
  const [obs, setObs] = useState(item.desconto_extra_observacoes || "");
  const [emailRef, setEmailRef] = useState(item.desconto_extra_email_referencia || "");

  useEffect(() => {
    if (open) {
      setPerc(item.desconto_extra_perc?.toString() || "");
      setObs(item.desconto_extra_observacoes || "");
      setEmailRef(item.desconto_extra_email_referencia || "");
    }
  }, [open, item]);

  const handleSave = () => {
    const num = parseFloat(perc);
    if (isNaN(num) || num <= 0 || num > 50) {
      toast.error("Desconto extra deve ser entre 0 e 50%");
      return;
    }
    onSave({
      desconto_extra_perc: num,
      desconto_extra_observacoes: obs || null,
      desconto_extra_email_referencia: emailRef || null,
      desconto_extra_negociado_por: userEmail,
      desconto_extra_negociado_em: new Date().toISOString(),
    });
    setOpen(false);
  };

  const handleRemove = () => {
    onSave({
      desconto_extra_perc: null,
      desconto_extra_observacoes: null,
      desconto_extra_email_referencia: null,
      desconto_extra_negociado_por: null,
      desconto_extra_negociado_em: null,
    });
    setOpen(false);
  };

  const tem = item.desconto_extra_perc !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {tem ? (
          <Badge
            variant="outline"
            className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 cursor-pointer"
          >
            base + {item.desconto_extra_perc}%
          </Badge>
        ) : (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
            <Plus className="h-3 w-3" /> extra
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-3">
          <div className="font-medium text-sm">Desconto extra negociado</div>
          <div>
            <Label className="text-xs">Percentual extra (%)</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="50"
              value={perc}
              onChange={(e) => setPerc(e.target.value)}
              placeholder="Ex: 5"
            />
          </div>
          <div>
            <Label className="text-xs">Observações</Label>
            <Textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              placeholder="Negociado com [nome] em [data]"
              rows={2}
            />
          </div>
          <div>
            <Label className="text-xs">Referência de email (opcional)</Label>
            <Input
              value={emailRef}
              onChange={(e) => setEmailRef(e.target.value)}
              placeholder="Assunto ou link"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} className="flex-1">
              Salvar
            </Button>
            {tem && (
              <Button
                size="sm"
                variant="destructive"
                onClick={handleRemove}
              >
                Remover
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
        .from("promocao_campanha" as any)
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
        .from("promocao_item" as any)
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
        .from("v_promocao_item_efetivo" as any)
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
        .from("promocao_negociacao_evento" as any)
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
          .from("promocao_campanha" as any)
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
        return (data as any).id as number;
      } else {
        const { error } = await supabase
          .from("promocao_campanha" as any)
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
    onError: (e: any) => toast.error(e.message || "Erro ao salvar"),
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
        .from("promocao_item" as any)
        .update(changes as any)
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
      qc.invalidateQueries({ queryKey: ["promocao-itens-efetivos"] });
    },
    onError: (e: any) => toast.error(e.message || "Erro ao atualizar item"),
  });

  const deleteItemMut = useMutation({
    mutationFn: async (itemId: number) => {
      const { error } = await supabase
        .from("promocao_item" as any)
        .update({ ativo: false })
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Item removido");
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
    },
    onError: (e: any) => toast.error(e.message || "Erro ao remover"),
  });

  const transicionarEstadoMut = useMutation({
    mutationFn: async (novoEstado: string) => {
      const updates: any = {
        estado: novoEstado,
        atualizado_por: userEmail,
      };
      if (novoEstado === "encerrada") {
        updates.data_fim = new Date().toISOString().slice(0, 10);
      }
      const { error } = await supabase
        .from("promocao_campanha" as any)
        .update(updates)
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
    onError: (e: any) => toast.error(e.message || "Erro ao mudar estado"),
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
        .from("promocao_item" as any)
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

      const novoId = (inserted as any).id;
      // Chama RPC de expansão
      const { error: rpcErr } = await supabase.rpc(
        "expandir_promocao_item" as any,
        { p_item_id: novoId },
      );
      if (rpcErr) throw rpcErr;

      toast.success("Item adicionado");
      setAddingItem(false);
      setNovoCodFornecedor("");
      setNovoDesconto("");
      setNovoVolume("");
      qc.invalidateQueries({ queryKey: ["promocao-itens", id] });
    } catch (e: any) {
      toast.error(e.message || "Erro ao adicionar item");
    } finally {
      setSavingNovoItem(false);
    }
  };

  // ============ EVENTO MODAL ============
  const [eventoOpen, setEventoOpen] = useState(false);
  const [novoEvento, setNovoEvento] = useState({
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
        .from("promocao_negociacao_evento" as any)
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
    onError: (e: any) => toast.error(e.message || "Erro ao registrar"),
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
            <TabsContent value="detalhes" className="space-y-4">
              {/* Painel de extração Vision */}
              {campanha?.origem_arquivo_url && (
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Extração via IA
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {confiancaBadge(campanha.extracao_confianca)}
                      {campanha.extraido_em && (
                        <span className="text-xs text-muted-foreground">
                          {formatDateTimeBR(campanha.extraido_em)}
                        </span>
                      )}
                    </div>
                    {campanha.extracao_observacoes && (
                      <p className="text-sm italic text-muted-foreground">
                        {campanha.extracao_observacoes}
                      </p>
                    )}
                    {campanha.origem_email_remetente && (
                      <div className="flex items-start gap-2 text-xs text-muted-foreground">
                        <Mail className="h-3 w-3 mt-0.5 shrink-0" />
                        <div>
                          De: {campanha.origem_email_remetente}
                          {campanha.origem_email_assunto && (
                            <>
                              {" "}
                              · Assunto:{" "}
                              <span className="italic">
                                {campanha.origem_email_assunto}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    {signedUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                      >
                        <a
                          href={signedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <FileText className="h-4 w-4" /> Ver arquivo original
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Formulário */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Dados da campanha</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>Nome</Label>
                    <Input
                      value={formNome}
                      onChange={(e) => setFormNome(e.target.value)}
                      placeholder="Ex: DES Promo Abril 2ª Quinzena 2026"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Fornecedor</Label>
                      <Input
                        value="Renner Sayerlack S/A"
                        disabled
                        className="bg-muted"
                      />
                    </div>
                    <div>
                      <Label>Tipo de origem</Label>
                      <div className="h-10 flex items-center">
                        {tipoOrigem === "negociacao_cliente" ? (
                          <Badge
                            variant="outline"
                            className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30"
                          >
                            Negociação
                          </Badge>
                        ) : (
                          <Badge variant="outline">Fornecedor</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Data início</Label>
                      <Input
                        type="date"
                        value={formInicio}
                        onChange={(e) => setFormInicio(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Data fim</Label>
                      <Input
                        type="date"
                        value={formFim}
                        onChange={(e) => setFormFim(e.target.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Observações</Label>
                    <Textarea
                      value={formObs}
                      onChange={(e) => setFormObs(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <Button
                    onClick={() => saveCampanhaMut.mutate()}
                    disabled={saveCampanhaMut.isPending}
                  >
                    {saveCampanhaMut.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    <Save className="h-4 w-4" />{" "}
                    {isNew ? "Criar campanha" : "Salvar alterações"}
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ========== TAB ITENS ========== */}
            <TabsContent value="itens" className="space-y-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">
                    Itens da campanha
                  </CardTitle>
                  <Button
                    size="sm"
                    onClick={() => setAddingItem(true)}
                    disabled={addingItem}
                  >
                    <Plus className="h-4 w-4" /> Adicionar item
                  </Button>
                </CardHeader>
                <CardContent>
                  {loadingItens ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                      <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Cód. fornecedor</TableHead>
                            <TableHead>Descrição</TableHead>
                            <TableHead className="text-right">Desc.%</TableHead>
                            <TableHead>Extra</TableHead>
                            <TableHead className="text-right">
                              Vol. mín.
                            </TableHead>
                            <TableHead>SKU Omie</TableHead>
                            <TableHead className="w-12"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {itens.length === 0 && !addingItem && (
                            <TableRow>
                              <TableCell
                                colSpan={7}
                                className="text-center text-muted-foreground py-8"
                              >
                                Nenhum item nesta campanha.
                              </TableCell>
                            </TableRow>
                          )}
                          {itens.map((item) => {
                            const efetivo = efetivoMap[item.id];
                            return (
                              <TableRow key={item.id}>
                                <TableCell>
                                  {item.confirmado ? (
                                    <span className="font-mono text-sm">
                                      {item.sku_codigo_fornecedor}
                                    </span>
                                  ) : (
                                    <Input
                                      className="h-8 font-mono text-sm"
                                      defaultValue={item.sku_codigo_fornecedor}
                                      onBlur={(e) => {
                                        if (
                                          e.target.value !==
                                          item.sku_codigo_fornecedor
                                        ) {
                                          updateItemMut.mutate({
                                            itemId: item.id,
                                            changes: {
                                              sku_codigo_fornecedor:
                                                e.target.value,
                                            },
                                          });
                                        }
                                      }}
                                    />
                                  )}
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                                  {item.descricao_produto_fornecedor || "—"}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Input
                                    type="number"
                                    step="0.1"
                                    className="h-8 w-20 text-right tabular-nums"
                                    defaultValue={item.desconto_perc}
                                    onBlur={(e) => {
                                      const v = parseFloat(e.target.value);
                                      if (!isNaN(v) && v !== item.desconto_perc) {
                                        updateItemMut.mutate({
                                          itemId: item.id,
                                          changes: { desconto_perc: v },
                                        });
                                      }
                                    }}
                                  />
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-col gap-0.5">
                                    <DescontoExtraCell
                                      item={item}
                                      userEmail={userEmail}
                                      onSave={(changes) =>
                                        updateItemMut.mutate({
                                          itemId: item.id,
                                          changes,
                                        })
                                      }
                                    />
                                    {efetivo !== undefined && (
                                      <span className="text-[10px] text-muted-foreground">
                                        Efetivo: {efetivo}%
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  <Input
                                    type="number"
                                    step="1"
                                    className="h-8 w-20 text-right tabular-nums"
                                    defaultValue={item.volume_minimo ?? ""}
                                    placeholder="—"
                                    onBlur={(e) => {
                                      const v = e.target.value.trim()
                                        ? parseFloat(e.target.value)
                                        : null;
                                      if (v !== item.volume_minimo) {
                                        updateItemMut.mutate({
                                          itemId: item.id,
                                          changes: { volume_minimo: v },
                                        });
                                      }
                                    }}
                                  />
                                </TableCell>
                                <TableCell>
                                  <MapeamentoStatusCell
                                    item={item}
                                    onUpdate={(changes) =>
                                      updateItemMut.mutate({
                                        itemId: item.id,
                                        changes,
                                      })
                                    }
                                  />
                                </TableCell>
                                <TableCell>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      if (confirm("Remover este item?")) {
                                        deleteItemMut.mutate(item.id);
                                      }
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                          {addingItem && (
                            <TableRow className="bg-accent/30">
                              <TableCell>
                                <Input
                                  className="h-8 font-mono text-sm"
                                  placeholder="DR.4403"
                                  value={novoCodFornecedor}
                                  onChange={(e) =>
                                    setNovoCodFornecedor(e.target.value)
                                  }
                                  autoFocus
                                />
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                (auto)
                              </TableCell>
                              <TableCell>
                                <Input
                                  type="number"
                                  step="0.1"
                                  className="h-8 w-20 text-right"
                                  placeholder="20"
                                  value={novoDesconto}
                                  onChange={(e) =>
                                    setNovoDesconto(e.target.value)
                                  }
                                />
                              </TableCell>
                              <TableCell></TableCell>
                              <TableCell>
                                <Input
                                  type="number"
                                  step="1"
                                  className="h-8 w-20 text-right"
                                  placeholder="—"
                                  value={novoVolume}
                                  onChange={(e) =>
                                    setNovoVolume(e.target.value)
                                  }
                                />
                              </TableCell>
                              <TableCell colSpan={2}>
                                <div className="flex gap-1 justify-end">
                                  <Button
                                    size="sm"
                                    onClick={handleAddItem}
                                    disabled={savingNovoItem}
                                  >
                                    {savingNovoItem && (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    )}
                                    Salvar
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setAddingItem(false);
                                      setNovoCodFornecedor("");
                                      setNovoDesconto("");
                                      setNovoVolume("");
                                    }}
                                    disabled={savingNovoItem}
                                  >
                                    Cancelar
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ========== TAB NEGOCIAÇÃO ========== */}
            {tipoOrigem === "negociacao_cliente" && (
              <TabsContent value="negociacao" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-base">
                      Histórico de negociação
                    </CardTitle>
                    <Button size="sm" onClick={() => setEventoOpen(true)}>
                      <Plus className="h-4 w-4" /> Registrar evento
                    </Button>
                  </CardHeader>
                  <CardContent>
                    {eventos.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">
                        Nenhum evento registrado ainda.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {eventos.map((ev) => {
                          const Icon = tipoEventoIcon(ev.tipo_evento);
                          return (
                            <div
                              key={ev.id}
                              className="flex gap-3 p-3 rounded-md border bg-card"
                            >
                              <div className="shrink-0 h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                                <Icon className="h-4 w-4 text-primary" />
                              </div>
                              <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <div className="font-medium text-sm">
                                    {TIPO_EVENTO_LABELS[ev.tipo_evento]}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatRelative(ev.data_evento)} ·{" "}
                                    {formatDateTimeBR(ev.data_evento)}
                                  </div>
                                </div>
                                {(ev.desconto_perc_proposto !== null ||
                                  ev.volume_minimo_proposto !== null) && (
                                  <div className="flex gap-2 flex-wrap">
                                    {ev.desconto_perc_proposto !== null && (
                                      <Badge variant="secondary">
                                        {ev.desconto_perc_proposto}% desconto
                                      </Badge>
                                    )}
                                    {ev.volume_minimo_proposto !== null && (
                                      <Badge variant="secondary">
                                        Vol. mín. {ev.volume_minimo_proposto}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                                {ev.conteudo && (
                                  <p className="text-sm whitespace-pre-wrap">
                                    {ev.conteudo}
                                  </p>
                                )}
                                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                                  <span>Por: {ev.registrado_por || "—"}</span>
                                  {ev.email_referencia && (
                                    <button
                                      className="hover:text-foreground transition-colors flex items-center gap-1"
                                      onClick={() => {
                                        navigator.clipboard.writeText(
                                          ev.email_referencia!,
                                        );
                                        toast.success("Copiado");
                                      }}
                                    >
                                      <Mail className="h-3 w-3" />
                                      {ev.email_referencia}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            )}
          </Tabs>
        </div>

        {/* ========== SIDEBAR DIREITA ========== */}
        <div>
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle className="text-base">Estado e ações</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-center">
                <Badge
                  variant="outline"
                  className={`${estadoBadgeClass(estado)} text-sm py-1.5 px-3`}
                >
                  {ESTADO_LABEL[estado] || estado}
                </Badge>
              </div>

              {!isNew && (
                <div className="text-center text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {itensAtivos}
                  </span>{" "}
                  {itensAtivos === 1 ? "item ativo" : "itens ativos"},{" "}
                  <span className="font-medium text-foreground">
                    {itensConfirmados}
                  </span>{" "}
                  confirmados
                </div>
              )}

              {!isNew && (
                <div className="space-y-2 pt-2 border-t">
                  {(estado === "rascunho" || estado === "negociando") && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Button
                              className="w-full"
                              disabled={
                                !podeAtivar ||
                                transicionarEstadoMut.isPending
                              }
                              onClick={() =>
                                transicionarEstadoMut.mutate("ativa")
                              }
                            >
                              <Check className="h-4 w-4" /> Ativar campanha
                            </Button>
                          </div>
                        </TooltipTrigger>
                        {!podeAtivar && (
                          <TooltipContent>
                            Confirme todos os itens antes de ativar
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  )}

                  {podeEncerrar && (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => transicionarEstadoMut.mutate("encerrada")}
                      disabled={transicionarEstadoMut.isPending}
                    >
                      Encerrar agora
                    </Button>
                  )}

                  {podeCancelar && (
                    <Button
                      className="w-full"
                      variant="destructive"
                      onClick={() => setCancelOpen(true)}
                      disabled={transicionarEstadoMut.isPending}
                    >
                      <X className="h-4 w-4" /> Cancelar campanha
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ========== DIALOG NOVO EVENTO ========== */}
      <Dialog open={eventoOpen} onOpenChange={setEventoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar evento de negociação</DialogTitle>
            <DialogDescription>
              Adicione um marco da negociação ao histórico da campanha.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Tipo de evento</Label>
              <Select
                value={novoEvento.tipo_evento}
                onValueChange={(v) =>
                  setNovoEvento({ ...novoEvento, tipo_evento: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TIPO_EVENTO_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Desconto proposto %</Label>
                <Input
                  type="number"
                  step="0.1"
                  value={novoEvento.desconto_perc_proposto}
                  onChange={(e) =>
                    setNovoEvento({
                      ...novoEvento,
                      desconto_perc_proposto: e.target.value,
                    })
                  }
                  placeholder="Ex: 25"
                />
              </div>
              <div>
                <Label>Volume mínimo</Label>
                <Input
                  type="number"
                  step="1"
                  value={novoEvento.volume_minimo_proposto}
                  onChange={(e) =>
                    setNovoEvento({
                      ...novoEvento,
                      volume_minimo_proposto: e.target.value,
                    })
                  }
                  placeholder="Opcional"
                />
              </div>
            </div>
            <div>
              <Label>Data do evento</Label>
              <Input
                type="datetime-local"
                value={novoEvento.data_evento}
                onChange={(e) =>
                  setNovoEvento({ ...novoEvento, data_evento: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Referência de email</Label>
              <Input
                value={novoEvento.email_referencia}
                onChange={(e) =>
                  setNovoEvento({
                    ...novoEvento,
                    email_referencia: e.target.value,
                  })
                }
                placeholder="Assunto ou link (opcional)"
              />
            </div>
            <div>
              <Label>Conteúdo</Label>
              <Textarea
                value={novoEvento.conteudo}
                onChange={(e) =>
                  setNovoEvento({ ...novoEvento, conteudo: e.target.value })
                }
                rows={4}
                placeholder="Descreva o evento, condições propostas, etc."
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Será registrado por: {userEmail}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEventoOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => addEventoMut.mutate()}
              disabled={addEventoMut.isPending}
            >
              {addEventoMut.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========== ALERT DIALOG CANCELAR ========== */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar campanha?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. A campanha será marcada como
              cancelada e não será mais aplicada nos pedidos de reposição.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => transicionarEstadoMut.mutate("cancelada")}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Sim, cancelar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
