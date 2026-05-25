// Filtros do HistoricoTab (ano + status do trimestre).
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split).
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface HistoricoFiltrosProps {
  filtroAno: string;
  onFiltroAnoChange: (v: string) => void;
  filtroStatus: string;
  onFiltroStatusChange: (v: string) => void;
  anosDisponiveis: number[];
}

export function HistoricoFiltros({
  filtroAno,
  onFiltroAnoChange,
  filtroStatus,
  onFiltroStatusChange,
  anosDisponiveis,
}: HistoricoFiltrosProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Ano:</span>
        <Select value={filtroAno} onValueChange={onFiltroAnoChange}>
          <SelectTrigger className="w-[120px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__todos__">Todos</SelectItem>
            {anosDisponiveis.map((a) => (
              <SelectItem key={a} value={String(a)}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ToggleGroup
        type="single"
        value={filtroStatus}
        onValueChange={(v) => v && onFiltroStatusChange(v)}
        size="sm"
      >
        <ToggleGroupItem value="todos" className="text-xs h-8">Todos</ToggleGroupItem>
        <ToggleGroupItem value="andamento" className="text-xs h-8">Em andamento</ToggleGroupItem>
        <ToggleGroupItem value="encerrados" className="text-xs h-8">Encerrados</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
