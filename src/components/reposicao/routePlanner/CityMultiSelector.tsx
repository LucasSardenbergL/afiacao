// Seletor MULTI-cidade do contexto "Visitas em campo". Reusa a RPC
// radar_contagem_por_municipio (até 500 cidades, com nº de prospects por cidade).
// Selecionar NÃO fecha o popover (multi); cidades viram chips removíveis.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { CityOption } from './types';

interface RawCidadeRow {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

async function fetchCidades(): Promise<CityOption[]> {
  const { data, error } = await supabase.rpc(
    'radar_contagem_por_municipio',
    { p_limit: 500 } as never,
  );
  if (error) throw error;
  const rows = (data ?? []) as RawCidadeRow[];
  return rows.map((r) => ({
    codigo: r.municipio_codigo,
    nome: r.municipio_nome,
    uf: r.uf,
    total: r.total,
    comTelefone: r.com_telefone,
    aContatar: r.a_contatar,
  }));
}

interface CityMultiSelectorProps {
  value: CityOption[];
  onToggle: (city: CityOption) => void;
  onRemove: (codigo: string) => void;
}

export function CityMultiSelector({ value, onToggle, onRemove }: CityMultiSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectedCodes = new Set(value.map((c) => c.codigo));

  const { data: cidades = [], isLoading } = useQuery({
    queryKey: ['radar-cidades-rota'],
    queryFn: fetchCidades,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-muted-foreground shrink-0">Cidades:</span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="min-w-[240px] justify-between font-normal"
              disabled={isLoading}
            >
              <span className="truncate">
                {isLoading
                  ? 'Carregando…'
                  : value.length === 0
                    ? 'Selecione as cidades…'
                    : `${value.length} cidade(s) selecionada(s)`}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[340px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Buscar cidade…" />
              <CommandList>
                <CommandEmpty>Nenhuma cidade encontrada.</CommandEmpty>
                <CommandGroup>
                  {cidades.map((cidade) => {
                    const selected = selectedCodes.has(cidade.codigo);
                    return (
                      <CommandItem
                        key={cidade.codigo}
                        value={`${cidade.nome} ${cidade.uf}`}
                        onSelect={() => onToggle(cidade)}
                      >
                        <Check className={cn('mr-2 h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                        <span className="flex-1">
                          {cidade.nome} ({cidade.uf})
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                          {cidade.total} prospects
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((c) => (
            <Badge key={c.codigo} variant="secondary" className="gap-1 pr-1">
              {c.nome} ({c.uf})
              <button
                type="button"
                onClick={() => onRemove(c.codigo)}
                className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                aria-label={`Remover ${c.nome}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
