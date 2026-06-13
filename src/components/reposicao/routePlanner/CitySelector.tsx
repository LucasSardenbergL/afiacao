// Seletor de cidade para o modo Prospecção do Roteirizador.
// Usa a RPC radar_contagem_por_municipio e exibe quantidade de prospects por cidade.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

interface CitySelectorProps {
  value: CityOption | null;
  onChange: (city: CityOption | null) => void;
}

export function CitySelector({ value, onChange }: CitySelectorProps) {
  const [open, setOpen] = useState(false);

  const { data: cidades = [], isLoading } = useQuery({
    queryKey: ['radar-cidades-rota'],
    queryFn: fetchCidades,
    staleTime: 5 * 60 * 1000,
  });

  const label = value
    ? `${value.nome} (${value.uf}) — ${value.aContatar} prospects`
    : 'Selecione uma cidade…';

  return (
    <div className="flex items-center gap-2">
      <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
      <span className="text-sm font-medium text-muted-foreground shrink-0">Cidade:</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="min-w-[240px] justify-between font-normal"
            disabled={isLoading}
          >
            <span className="truncate">{isLoading ? 'Carregando…' : label}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar cidade…" />
            <CommandList>
              <CommandEmpty>Nenhuma cidade encontrada.</CommandEmpty>
              <CommandGroup>
                {cidades.map((cidade) => (
                  <CommandItem
                    key={cidade.codigo}
                    value={`${cidade.nome} ${cidade.uf}`}
                    onSelect={() => {
                      onChange(value?.codigo === cidade.codigo ? null : cidade);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        value?.codigo === cidade.codigo ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="flex-1">
                      {cidade.nome} ({cidade.uf})
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {cidade.aContatar}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
