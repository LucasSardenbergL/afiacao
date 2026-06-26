// Célula de status do mapeamento SKU fornecedor → SKU Omie, com busca/vínculo manual.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { eqInt, ilike, ilikeOr, isSearchablePostgrestTerm, orFilter } from "@/lib/postgrest";
import { toast } from "sonner";
import { Check, Sparkles, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EMPRESA, type ItemRow } from "./types";

export function MapeamentoStatusCell({
  item,
  onUpdate,
}: {
  item: ItemRow;
  onUpdate: (changes: Partial<ItemRow>) => void;
}) {
  const qc = useQueryClient();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    Array<{ omie_codigo_produto: number; descricao: string; codigo: string }>
  >([]);
  const [searching, setSearching] = useState(false);
  const [selectedSkus, setSelectedSkus] = useState<Record<number, { descricao: string; codigo: string }>>({});
  const [salvando, setSalvando] = useState(false);

  // Busca debounced
  useEffect(() => {
    if (!searchOpen || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      const term = searchQuery.trim();
      // só-wildcard (`**`) sanitiza pra vazio → o ilike do `.or()` viraria match-all (#1062);
      // busca pura: não-pesquisável = sem resultados (número sobrevive, segue pelo ramo isNumeric).
      if (!isSearchablePostgrestTerm(term)) { setSearchResults([]); setSearching(false); return; }
      // Busca por descrição OU código OU sku omie (numérico). account no banco é lowercase.
      const isNumeric = /^\d+$/.test(term);
      type OmieSearchRow = { omie_codigo_produto: number; descricao: string; codigo: string };
      let query = supabase
        .from("omie_products")
        .select("omie_codigo_produto, descricao, codigo")
        .eq("account", EMPRESA.toLowerCase())
        .eq("ativo", true);
      query = isNumeric
        ? query.or(orFilter(ilike("codigo", term), eqInt("omie_codigo_produto", term)))
        : query.or(ilikeOr(["descricao", "codigo"], term));
      const { data, error } = await query.limit(20);
      setSearching(false);
      if (!error) setSearchResults((data as unknown as OmieSearchRow[]) || []);
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
              className="bg-status-success/15 text-status-success border-status-success/30 cursor-default"
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
              className="bg-status-success/15 text-status-success border-status-success/30 cursor-default"
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
            className="bg-status-warning/15 text-status-warning border-status-warning/30 cursor-pointer"
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
              className="bg-status-info/15 text-status-info border-status-info/30 cursor-default"
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

  // ========== nao_encontrado (ou null) — busca manual com sugestão automática ==========
  // Pré-popula o campo com a descrição do fornecedor — 99% dos casos bate via ilike.
  const sugestaoTermo = (() => {
    const base = (item.descricao_produto_fornecedor || item.sku_codigo_fornecedor || "").trim();
    if (!base) return "";
    const palavras = base
      .replace(/[^\w\sÀ-ÿ.]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 3);
    return palavras.join(" ");
  })();

  return (
    <Popover
      open={searchOpen}
      onOpenChange={(open) => {
        setSearchOpen(open);
        if (open && !searchQuery) setSearchQuery(sugestaoTermo);
      }}
    >
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          className="bg-destructive/15 text-destructive border-destructive/30 cursor-pointer"
        >
          {q === "nao_encontrado" ? "Não encontrado" : "Pendente"}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-[420px]">
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Buscar produto Omie</Label>
            <p className="text-[11px] text-muted-foreground mb-1">
              Selecione <strong>uma ou mais embalagens</strong> — útil quando o código fornecedor
              (ex.: {item.sku_codigo_fornecedor}) cobre vários tamanhos (0,9L · 3,6L · 18L…).
            </p>
            <div className="relative mt-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por descrição, código ou SKU Omie…"
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
            {searchResults.map((p) => {
              const checked = !!selectedSkus[p.omie_codigo_produto];
              return (
                <label
                  key={p.omie_codigo_produto}
                  className="flex items-start gap-2 w-full text-left p-2 rounded hover:bg-accent transition-colors cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      setSelectedSkus((prev) => {
                        const next = { ...prev };
                        if (v) next[p.omie_codigo_produto] = { descricao: p.descricao, codigo: p.codigo };
                        else delete next[p.omie_codigo_produto];
                        return next;
                      });
                    }}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-muted-foreground">
                      {p.codigo} · {p.omie_codigo_produto}
                    </div>
                    <div className="text-sm">{p.descricao}</div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-xs text-muted-foreground">
              {Object.keys(selectedSkus).length} selecionado(s)
            </span>
            <Button
              size="sm"
              disabled={Object.keys(selectedSkus).length === 0 || salvando}
              onClick={async () => {
                const ids = Object.keys(selectedSkus).map(Number);
                if (ids.length === 0) return;
                setSalvando(true);
                try {
                  // Primeiro SKU → atualiza o item original (in-place)
                  const primeiroId = ids[0];
                  const primeiro = selectedSkus[primeiroId];
                  onUpdate({
                    sku_codigo_omie: primeiroId,
                    descricao_produto_fornecedor: primeiro.descricao,
                    mapeamento_qualidade: "manual_confirmado",
                    confirmado: true,
                  });

                  // Demais → inserir novos itens irmãos (mesmo desconto/volume).
                  // Para escapar do unique (campanha_id, sku_codigo_fornecedor, volume_minimo),
                  // sufixamos o código fornecedor com #omie<id>.
                  const extras = ids.slice(1);
                  if (extras.length > 0) {
                    const payload = extras.map((omieId) => ({
                      campanha_id: item.campanha_id,
                      sku_codigo_fornecedor: `${item.sku_codigo_fornecedor}#omie${omieId}`,
                      descricao_produto_fornecedor: selectedSkus[omieId].descricao,
                      sku_codigo_omie: omieId,
                      mapeamento_qualidade: "manual_confirmado",
                      desconto_perc: item.desconto_perc,
                      volume_minimo: item.volume_minimo,
                      confirmado: true,
                      ativo: true,
                      observacoes: `Expandido manualmente a partir de ${item.sku_codigo_fornecedor}`,
                    }));
                    const { error } = await supabase
                      .from("promocao_item")
                      .insert(payload as never);
                    if (error) throw error;
                    toast.success(`${ids.length} embalagens vinculadas`);
                  } else {
                    toast.success("Produto vinculado");
                  }
                  qc.invalidateQueries({ queryKey: ["promocao-itens", String(item.campanha_id)] });
                  setSelectedSkus({});
                  setSearchOpen(false);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Erro ao vincular");
                } finally {
                  setSalvando(false);
                }
              }}
            >
              {salvando && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Confirmar
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
