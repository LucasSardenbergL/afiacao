import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { ColKey } from "@/types/reposicao";

const COL_DEFS: Array<{ key: ColKey; label: string }> = [
  { key: "fornecedor", label: "Fornecedor" },
  { key: "grupo", label: "Grupo" },
  { key: "skus", label: "SKUs" },
  { key: "valor", label: "Valor" },
  { key: "status", label: "Status" },
  { key: "qtdAprovada", label: "Qtd Aprovada" },
  { key: "preco", label: "Preço" },
  { key: "confianca", label: "Confiança" },
];

const DEFAULT_COLS: Record<ColKey, boolean> = {
  fornecedor: true,
  grupo: true,
  skus: true,
  valor: true,
  status: true,
  qtdAprovada: true,
  preco: false,
  confianca: false,
};

const COLS_STORAGE_KEY = "cockpit-colunas-v1";

export function useColumnConfig() {
  const [cols, setCols] = useState<Record<ColKey, boolean>>(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE_KEY);
      if (!raw) return DEFAULT_COLS;
      const parsed = JSON.parse(raw) as Partial<Record<ColKey, boolean>>;
      return { ...DEFAULT_COLS, ...parsed };
    } catch {
      return DEFAULT_COLS;
    }
  });
  const update = (key: ColKey, value: boolean) => {
    const next = { ...cols, [key]: value };
    setCols(next);
    try {
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  return { cols, update };
}

export function ColumnConfigPopover({
  cols,
  onChange,
}: {
  cols: Record<ColKey, boolean>;
  onChange: (k: ColKey, v: boolean) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" title="Configurar colunas">
          <SettingsIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="end">
        <div className="text-xs font-semibold mb-2 text-muted-foreground">Colunas visíveis</div>
        <div className="space-y-2">
          {COL_DEFS.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={cols[c.key]}
                onCheckedChange={(v) => onChange(c.key, !!v)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
