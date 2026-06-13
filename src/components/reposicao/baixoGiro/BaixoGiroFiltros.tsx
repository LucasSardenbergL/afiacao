import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FiltrosBaixoGiro } from "./types";

interface BaixoGiroFiltrosProps {
  filtros: FiltrosBaixoGiro;
  onChange: (f: FiltrosBaixoGiro) => void;
}

export function BaixoGiroFiltros({ filtros, onChange }: BaixoGiroFiltrosProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="w-full sm:w-48">
        <Select
          value={filtros.situacao}
          onValueChange={(v: FiltrosBaixoGiro["situacao"]) =>
            onChange({ ...filtros, situacao: v })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Situação" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todas</SelectItem>
            <SelectItem value="sem_preco">Sem preço</SelectItem>
            <SelectItem value="sem_fornecedor">Sem fornecedor</SelectItem>
            <SelectItem value="sem_grupo">Aguardando grupo</SelectItem>
            <SelectItem value="sem_leadtime">Sem lead time</SelectItem>
            <SelectItem value="aguardando_2a_ordem">Aguardando 2ª compra</SelectItem>
            <SelectItem value="sem_parametro">Sem parâmetro</SelectItem>
            <SelectItem value="ok">Em dia</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="w-full sm:w-48">
        <Select
          value={filtros.estoque}
          onValueChange={(v: FiltrosBaixoGiro["estoque"]) =>
            onChange({ ...filtros, estoque: v })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder="Estoque" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="com_estoque">Com estoque parado</SelectItem>
            <SelectItem value="sem_estoque">Sem estoque</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1">
        <Input
          placeholder="Código ou descrição"
          value={filtros.busca}
          onChange={(e) => onChange({ ...filtros, busca: e.target.value })}
        />
      </div>
    </div>
  );
}
