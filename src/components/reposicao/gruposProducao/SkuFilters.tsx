// Filtros (fornecedor/grupo/busca) + barra de ação em lote da associação SKU→Grupo.
// Extraído de src/pages/AdminReposicaoGruposProducao.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Loader2 } from "lucide-react";
import { ALL, SEM_GRUPO, type Grupo } from "./types";

export function SkuFilters({
  filtroFornecedor, setFiltroFornecedor, filtroGrupo, setFiltroGrupo, busca, setBusca, setPage,
  fornecedoresDisponiveis, grupos, selecionadosCount, bulkGrupo, setBulkGrupo,
  onAplicarLote, onLimparSelecao, moverLotePending,
}: {
  filtroFornecedor: string;
  setFiltroFornecedor: (v: string) => void;
  filtroGrupo: string;
  setFiltroGrupo: (v: string) => void;
  busca: string;
  setBusca: (v: string) => void;
  setPage: (p: number) => void;
  fornecedoresDisponiveis: string[];
  grupos: Grupo[];
  selecionadosCount: number;
  bulkGrupo: string;
  setBulkGrupo: (v: string) => void;
  onAplicarLote: () => void;
  onLimparSelecao: () => void;
  moverLotePending: boolean;
}) {
  return (
    <>
      {/* Filtros */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Select value={filtroFornecedor} onValueChange={(v) => { setFiltroFornecedor(v); setPage(0); }}>
          <SelectTrigger>
            <SelectValue placeholder="Fornecedor" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os fornecedores</SelectItem>
            {fornecedoresDisponiveis.map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filtroGrupo} onValueChange={(v) => { setFiltroGrupo(v); setPage(0); }}>
          <SelectTrigger>
            <SelectValue placeholder="Grupo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Todos os grupos</SelectItem>
            <SelectItem value={SEM_GRUPO}>Sem grupo</SelectItem>
            {grupos.map((g) => (
              <SelectItem key={g.id} value={g.grupo_codigo}>
                {g.grupo_codigo} ({g.fornecedor_nome})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="md:col-span-2 relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por SKU ou descrição…"
            className="pl-9"
            value={busca}
            onChange={(e) => { setBusca(e.target.value); setPage(0); }}
          />
        </div>
      </div>

      {/* Ação em lote */}
      {selecionadosCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border bg-muted/40 p-3">
          <span className="text-sm font-medium">{selecionadosCount} selecionado(s)</span>
          <Select value={bulkGrupo} onValueChange={setBulkGrupo}>
            <SelectTrigger className="max-w-xs">
              <SelectValue placeholder="Mover para grupo…" />
            </SelectTrigger>
            <SelectContent>
              {grupos.map((g) => (
                <SelectItem key={g.id} value={g.grupo_codigo}>
                  {g.grupo_codigo} — {g.fornecedor_nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={onAplicarLote}
            disabled={!bulkGrupo || moverLotePending}
          >
            {moverLotePending && <Loader2 className="h-4 w-4 animate-spin" />}
            Aplicar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onLimparSelecao}
          >
            Cancelar
          </Button>
        </div>
      )}
    </>
  );
}
