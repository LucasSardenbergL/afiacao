// Combobox de forma de pagamento (parcela Omie).
// Extraído verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronsUpDown, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

/**
 * O que o botão mostra para a condição salva (revisão /sales #29). Antes, código fora da lista virava
 * string vazia: o pedido parecia sem condição. Agora o código original aparece, e diz POR QUE não está
 * na lista — a lista completa não o tem (parcela inativada no Omie) ou a lista não carregou inteira.
 */
export function rotuloDaCondicao(
  formas: Array<{ codigo: string; descricao: string }>,
  selected: string,
  listaCompleta: boolean,
): string {
  if (!selected) return 'Selecionar parcela';
  const achada = formas.find(f => f.codigo === selected);
  if (achada) return achada.descricao;
  return listaCompleta
    ? `${selected} (indisponível para nova escolha)`
    : `${selected} (lista de condições indisponível)`;
}

export function PaymentComboboxEdit({
  formas,
  selected,
  onSelect,
  disabled,
  listaCompleta,
}: {
  formas: Array<{ codigo: string; descricao: string }>;
  selected: string;
  onSelect: (v: string) => void;
  disabled?: boolean;
  /** A listagem de condições carregou sem erro nem degradação: código ausente dela é inativo de fato. */
  listaCompleta: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between text-sm h-9 font-normal"
        >
          <span className="truncate">{rotuloDaCondicao(formas, selected, listaCompleta)}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar... ex: 30, 60, vista" className="h-8 text-sm" />
          <CommandList>
            <CommandEmpty className="py-2 text-center text-xs text-muted-foreground">Nenhuma condição encontrada.</CommandEmpty>
            <CommandGroup>
              {formas.map(f => (
                <CommandItem
                  key={f.codigo}
                  value={f.descricao}
                  onSelect={() => { onSelect(f.codigo); setOpen(false); }}
                  className="text-sm"
                >
                  <Check className={cn('mr-2 h-3.5 w-3.5', selected === f.codigo ? 'opacity-100' : 'opacity-0')} />
                  {f.descricao}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
