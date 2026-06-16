// Linha de filtros da tabela de SLA por SKU (fornecedor/tendência/grupo/busca).
// Extraída verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";

interface SlaFiltrosProps {
  filtroFornecedor: string;
  onFiltroFornecedorChange: (v: string) => void;
  filtroTendencia: string;
  onFiltroTendenciaChange: (v: string) => void;
  filtroGrupo: string;
  onFiltroGrupoChange: (v: string) => void;
  busca: string;
  onBuscaChange: (v: string) => void;
  fornecedoresOptions: string[];
  grupos: string[];
}

export function SlaFiltros({
  filtroFornecedor,
  onFiltroFornecedorChange,
  filtroTendencia,
  onFiltroTendenciaChange,
  filtroGrupo,
  onFiltroGrupoChange,
  busca,
  onBuscaChange,
  fornecedoresOptions,
  grupos,
}: SlaFiltrosProps) {
  return (
    <div className="flex flex-wrap gap-3 items-end">
      <div className="w-[220px]">
        <Label className="text-xs">Fornecedor</Label>
        <Select value={filtroFornecedor} onValueChange={onFiltroFornecedorChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos</SelectItem>
            {fornecedoresOptions.map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-[150px]">
        <Label className="text-xs">Tendência</Label>
        <Select value={filtroTendencia} onValueChange={onFiltroTendenciaChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todas</SelectItem>
            <SelectItem value="melhorando">Melhorando</SelectItem>
            <SelectItem value="estavel">Estável</SelectItem>
            <SelectItem value="piorando">Piorando</SelectItem>
            <SelectItem value="sem_dados">Sem dados</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="w-[180px]">
        <Label className="text-xs">Grupo de produção</Label>
        <Select value={filtroGrupo} onValueChange={onFiltroGrupoChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos</SelectItem>
            {grupos.map((g) => (
              <SelectItem key={g} value={g}>{g}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 min-w-[200px]">
        <Label className="text-xs">Buscar SKU</Label>
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-7"
            placeholder="Código ou descrição"
            value={busca}
            onChange={(e) => onBuscaChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
