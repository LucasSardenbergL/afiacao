// Barra de filtros + ações do painel "Ciclo de hoje".
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { ListChecks, Search, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ColKey } from "@/types/reposicao";
import { ColumnConfigPopover } from "../ColumnConfig";
import { ALL, type CicloFilters } from "./types";

interface FiltersToolbarProps {
  filters: CicloFilters;
  setFilters: (f: CicloFilters) => void;
  fornecedores: string[];
  statuses: string[];
  eligibleAutoCount: number;
  busy: boolean;
  onOpenAuto: () => void;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  cols: Record<ColKey, boolean>;
  onColChange: (k: ColKey, v: boolean) => void;
  onClearFilters: () => void;
}

export function FiltersToolbar({
  filters,
  setFilters,
  fornecedores,
  statuses,
  eligibleAutoCount,
  busy,
  onOpenAuto,
  reviewMode,
  setReviewMode,
  cols,
  onColChange,
  onClearFilters,
}: FiltersToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 bg-card">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          placeholder="Buscar SKU, descrição ou fornecedor..."
          className="pl-8 h-9"
        />
      </div>
      <Select
        value={filters.fornecedor}
        onValueChange={(v) => setFilters({ ...filters, fornecedor: v })}
      >
        <SelectTrigger className="w-[180px] h-9">
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
      <Select value={filters.status} onValueChange={(v) => setFilters({ ...filters, status: v })}>
        <SelectTrigger className="w-[180px] h-9">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os status</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" onClick={onClearFilters}>
        Limpar filtros
      </Button>
      <Button
        size="sm"
        onClick={onOpenAuto}
        disabled={eligibleAutoCount === 0 || busy}
        title={
          eligibleAutoCount === 0
            ? "Nenhum item elegível para aprovação automática"
            : "Aprovar automaticamente apenas os itens classificados como Auto"
        }
      >
        <Zap className="h-4 w-4 mr-1.5" />
        Aprovar elegíveis ({eligibleAutoCount})
      </Button>
      <Button
        size="sm"
        variant={reviewMode ? "default" : "outline"}
        onClick={() => setReviewMode(!reviewMode)}
      >
        <ListChecks className="h-4 w-4 mr-1.5" />
        Modo revisão
      </Button>
      <ColumnConfigPopover cols={cols} onChange={onColChange} />
    </div>
  );
}
