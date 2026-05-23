// Barra de filtros das sugestões ativas (BLOCO 1).
// Extraída verbatim de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  STATUS_LIST,
  ORDENACOES,
  type StatusSugestao,
  type Categoria,
  type OrdenacaoKey,
} from "./types";
import { categoriaLabel } from "./helpers";

interface SugestoesToolbarProps {
  statusFiltro: Set<StatusSugestao>;
  onToggleStatus: (v: StatusSugestao) => void;
  categoriaFiltro: Set<Categoria>;
  onToggleCategoria: (v: Categoria) => void;
  ordenacao: OrdenacaoKey;
  onOrdenacaoChange: (v: OrdenacaoKey) => void;
}

export function SugestoesToolbar({
  statusFiltro,
  onToggleStatus,
  categoriaFiltro,
  onToggleCategoria,
  ordenacao,
  onOrdenacaoChange,
}: SugestoesToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Status ({statusFiltro.size})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Filtrar por status</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {STATUS_LIST.map((st) => (
            <DropdownMenuCheckboxItem
              key={st.value}
              checked={statusFiltro.has(st.value)}
              onCheckedChange={() => onToggleStatus(st.value)}
              onSelect={(e) => e.preventDefault()}
            >
              {st.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Categoria ({categoriaFiltro.size})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Filtrar por categoria</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(["prioritario", "forte", "moderado"] as Categoria[]).map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={categoriaFiltro.has(c)}
              onCheckedChange={() => onToggleCategoria(c)}
              onSelect={(e) => e.preventDefault()}
            >
              {categoriaLabel(c)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select value={ordenacao} onValueChange={(v) => onOrdenacaoChange(v as OrdenacaoKey)}>
        <SelectTrigger className="w-[200px] h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ORDENACOES.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
