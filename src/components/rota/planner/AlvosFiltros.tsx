// Controles de filtro do universo de alvos (contexto campo): tipo, busca, "só com
// telefone", status (multi) e bairro. Estado vive no hook (FiltrosAlvo); aqui só
// dispara patches via onChange. Os status são os 3 do Radar (a_contatar /
// contatado_sem_resposta / em_conversa).
import { Search, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { labelProspeccaoStatus } from '@/lib/route/prospect-stop';
import type { FiltrosAlvo } from '@/lib/route/field-targets';
import type { TargetFilter } from './types';

const STATUS_OPCOES = ['a_contatar', 'contatado_sem_resposta', 'em_conversa'] as const;
const TIPO_OPCOES: { key: TargetFilter; label: string }[] = [
  { key: 'todos', label: 'Todos' },
  { key: 'clientes', label: 'Clientes' },
  { key: 'prospects', label: 'Prospects' },
];

const TODOS_BAIRROS = '__todos__';

export function AlvosFiltros({
  filtros,
  onChange,
  bairros,
}: {
  filtros: FiltrosAlvo;
  onChange: (patch: Partial<FiltrosAlvo>) => void;
  bairros: string[];
}) {
  const toggleStatus = (st: string) => {
    const has = filtros.status.includes(st);
    onChange({ status: has ? filtros.status.filter((s) => s !== st) : [...filtros.status, st] });
  };

  return (
    <div className="space-y-2">
      {/* tipo */}
      <div className="flex gap-1">
        {TIPO_OPCOES.map((o) => (
          <Button
            key={o.key}
            size="sm"
            variant={filtros.tipo === o.key ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => onChange({ tipo: o.key })}
          >
            {o.label}
          </Button>
        ))}
      </div>

      {/* busca + telefone */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={filtros.busca}
            onChange={(e) => onChange({ busca: e.target.value })}
            placeholder="Buscar por nome…"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button
          size="sm"
          variant={filtros.comTelefone ? 'default' : 'outline'}
          className="h-8 text-xs gap-1 shrink-0"
          onClick={() => onChange({ comTelefone: !filtros.comTelefone })}
          aria-pressed={filtros.comTelefone}
        >
          <Phone className="w-3.5 h-3.5" /> Com telefone
        </Button>
      </div>

      {/* status (multi) + bairro */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_OPCOES.map((st) => (
            <Button
              key={st}
              size="sm"
              variant={filtros.status.includes(st) ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => toggleStatus(st)}
              aria-pressed={filtros.status.includes(st)}
            >
              {labelProspeccaoStatus(st)}
            </Button>
          ))}
        </div>
        {bairros.length > 0 && (
          <Select
            value={filtros.bairro ?? TODOS_BAIRROS}
            onValueChange={(v) => onChange({ bairro: v === TODOS_BAIRROS ? null : v })}
          >
            <SelectTrigger className="h-7 w-[160px] text-xs">
              <SelectValue placeholder="Bairro" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS_BAIRROS}>Todos os bairros</SelectItem>
              {bairros.map((b) => (
                <SelectItem key={b} value={b}>{b}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
