import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Trash2, Search as SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Item } from "./types";
import { SkuPickerDialog } from "./SkuPickerDialog";

type FamiliaSelecionada = {
  familia: string;
  apenasEspecificos: boolean;
  skusEspecificos: number[];
};

export function MapeamentoDialog({
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
      ((data || []) as Array<{ familia: string | null }>).forEach((r) => r.familia && set.add(r.familia));
      return Array.from(set).sort();
    },
  });

  // Mapeamentos existentes para este item
  const { data: existentes = [] } = useQuery({
    queryKey: ["mapeamentos-item", item.id, open],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("categoria_aumento_familia_mapeamento")
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
        .from("categoria_aumento_familia_mapeamento")
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
          .from("categoria_aumento_familia_mapeamento")
          .insert(inserts);
        if (insErr) throw insErr;
      }
      toast.success("Mapeamento salvo");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar mapeamento");
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
