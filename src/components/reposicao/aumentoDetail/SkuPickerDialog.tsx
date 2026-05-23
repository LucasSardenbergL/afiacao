import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, Search as SearchIcon } from "lucide-react";

export function SkuPickerDialog({
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
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {filtrados.length} SKU{filtrados.length === 1 ? "" : "s"}
            {busca.trim() ? " filtrado" : " na família"}
            {filtrados.length !== 1 && busca.trim() ? "s" : ""}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = new Set(selected);
                filtrados.forEach((s) => next.add(s.omie_codigo_produto));
                setSelected(next);
              }}
              disabled={isLoading || filtrados.length === 0}
            >
              Selecionar todos
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = new Set(selected);
                filtrados.forEach((s) => next.delete(s.omie_codigo_produto));
                setSelected(next);
              }}
              disabled={isLoading || filtrados.length === 0}
            >
              Desmarcar todos
            </Button>
          </div>
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
