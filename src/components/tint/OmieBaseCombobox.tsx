// Seletor de produto Omie pra uma base tintométrica: busca digitável +
// ranqueamento por relevância à base (sugeridos no topo). Substitui o <Select>
// alfabético-cego de TintMapping. Busca acento-insensitive controlada por nós
// (shouldFilter={false}) pra preservar a ordem "sugeridos pra esta base".
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronsUpDown, Check, Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { ranquearProdutos, type LinhaSku, type ProdutoOmieMatch } from '@/lib/tint/omie-match';
import { normalizarBusca } from '@/lib/tint/cores-do-cliente';

export interface ProdutoOmieOption extends ProdutoOmieMatch {
  valor_unitario: number;
  estoque: number | null;
}

type Ranqueado = ProdutoOmieOption & { codigoBateu: boolean; embalagemBateu: boolean; score: number };

interface OmieBaseComboboxProps {
  produtos: ProdutoOmieOption[];
  linha: LinhaSku;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

export function OmieBaseCombobox({ produtos, linha, value, onChange, disabled }: OmieBaseComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selecionado = produtos.find((p) => p.id === value) ?? null;

  const { sugeridos, outros } = useMemo(() => {
    const q = normalizarBusca(query);
    const ranqueados = ranquearProdutos(linha, produtos).filter((p) =>
      q === '' ? true : normalizarBusca(`${p.codigo} ${p.descricao}`).includes(q),
    );
    return {
      sugeridos: ranqueados.filter((p) => p.codigoBateu),
      outros: ranqueados.filter((p) => !p.codigoBateu),
    };
  }, [produtos, linha, query]);

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between text-sm h-8 font-normal"
        >
          <span className="truncate">
            {selecionado ? `${selecionado.codigo} — ${selecionado.descricao}` : 'Selecionar…'}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[440px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Buscar por código ou descrição…"
            value={query}
            onValueChange={setQuery}
            className="h-9 text-sm"
          />
          <CommandList>
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
              Nenhum produto encontrado.
            </CommandEmpty>
            {value && (
              <CommandItem
                value="__limpar__"
                onSelect={() => pick(null)}
                className="text-xs text-muted-foreground"
              >
                Limpar seleção
              </CommandItem>
            )}
            {sugeridos.length > 0 && (
              <CommandGroup heading="Sugeridos pra esta base">
                {sugeridos.map((p) => (
                  <ProdutoItem key={p.id} p={p} selecionado={value === p.id} onPick={pick} />
                ))}
              </CommandGroup>
            )}
            {outros.length > 0 && (
              <CommandGroup heading="Outros produtos">
                {outros.map((p) => (
                  <ProdutoItem key={p.id} p={p} selecionado={value === p.id} onPick={pick} />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ProdutoItem({
  p,
  selecionado,
  onPick,
}: {
  p: Ranqueado;
  selecionado: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <CommandItem value={p.id} onSelect={() => onPick(p.id)} className="text-sm">
      <Check className={cn('mr-2 h-3.5 w-3.5 shrink-0', selecionado ? 'opacity-100' : 'opacity-0')} />
      <span className="flex-1 truncate">
        <span className="font-mono text-xs text-muted-foreground">{p.codigo}</span> {p.descricao}
      </span>
      {p.codigoBateu && p.embalagemBateu && (
        <Sparkles className="ml-1 h-3 w-3 shrink-0 text-status-success" aria-label="casa código + embalagem" />
      )}
      <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
        R$ {p.valor_unitario.toFixed(2)}
      </span>
    </CommandItem>
  );
}
