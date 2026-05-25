// Filtros dos aumentos (fornecedor + estado + busca).
// Extraído verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALL, ESTADOS } from "./config";

interface AumentosFiltrosProps {
  filtroFornecedor: string;
  onFiltroFornecedorChange: (v: string) => void;
  filtroEstado: string;
  onFiltroEstadoChange: (v: string) => void;
  busca: string;
  onBuscaChange: (v: string) => void;
  fornecedores: string[];
}

export function AumentosFiltros({
  filtroFornecedor,
  onFiltroFornecedorChange,
  filtroEstado,
  onFiltroEstadoChange,
  busca,
  onBuscaChange,
  fornecedores,
}: AumentosFiltrosProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      <Select value={filtroFornecedor} onValueChange={onFiltroFornecedorChange}>
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
      <Select value={filtroEstado} onValueChange={onFiltroEstadoChange}>
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
          onChange={(e) => onBuscaChange(e.target.value)}
        />
      </div>
    </div>
  );
}
