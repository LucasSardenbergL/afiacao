// Barra de filtros do ranking completo (BLOCO 2).
// Extraída verbatim de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { CATEGORIAS, type Categoria } from "./types";

interface RankingToolbarProps {
  rankingCategoriaFiltro: Set<Categoria>;
  onToggleCategoria: (v: Categoria) => void;
  rankingComSugestao: "sim" | "nao" | "ambos";
  onComSugestaoChange: (v: "sim" | "nao" | "ambos") => void;
  rankingBusca: string;
  onBuscaChange: (v: string) => void;
}

export function RankingToolbar({
  rankingCategoriaFiltro,
  onToggleCategoria,
  rankingComSugestao,
  onComSugestaoChange,
  rankingBusca,
  onBuscaChange,
}: RankingToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Categoria ({rankingCategoriaFiltro.size})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Filtrar por categoria</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CATEGORIAS.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.value}
              checked={rankingCategoriaFiltro.has(c.value)}
              onCheckedChange={() => onToggleCategoria(c.value)}
              onSelect={(e) => e.preventDefault()}
            >
              {c.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select
        value={rankingComSugestao}
        onValueChange={(v) => onComSugestaoChange(v as "sim" | "nao" | "ambos")}
      >
        <SelectTrigger className="w-[180px] h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ambos">Com/sem sugestão</SelectItem>
          <SelectItem value="sim">Com sugestão ativa</SelectItem>
          <SelectItem value="nao">Sem sugestão ativa</SelectItem>
        </SelectContent>
      </Select>
      <div className="relative flex-1 min-w-[220px] max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por SKU ou descrição..."
          value={rankingBusca}
          onChange={(e) => onBuscaChange(e.target.value)}
          className="pl-8 h-9"
        />
      </div>
    </div>
  );
}
