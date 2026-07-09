// Chips de UF do seletor de cidades (Visitas em campo). Deriva as UFs da lista de
// cidades já cacheada (sem ida ao banco). "Todos" + uma por UF; selecionar filtra
// o CityMultiSelector. Touch-friendly (botões), rolável no mobile.
import { Button } from '@/components/ui/button';
import { ufsDe } from '@/lib/route/city-filter';
import type { CityOption } from './types';

export function UfSelector({
  cidades,
  value,
  onChange,
}: {
  cidades: CityOption[];
  value: string | null;
  onChange: (uf: string | null) => void;
}) {
  const ufs = ufsDe(cidades);
  if (ufs.length <= 1) return null; // 1 só UF não precisa de seletor

  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <span className="text-xs font-medium text-muted-foreground shrink-0 pr-1">Estado:</span>
      <Button
        size="sm"
        variant={value === null ? 'default' : 'outline'}
        className="h-7 text-xs shrink-0"
        onClick={() => onChange(null)}
      >
        Todos
      </Button>
      {ufs.map((uf) => (
        <Button
          key={uf}
          size="sm"
          variant={value === uf ? 'default' : 'outline'}
          className="h-7 text-xs shrink-0 tabular-nums"
          onClick={() => onChange(uf)}
        >
          {uf}
        </Button>
      ))}
    </div>
  );
}
