import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Cenario } from '@/hooks/useCashflowProjection';

type Props = {
  value: Cenario;
  onChange: (next: Cenario) => void;
};

export function CenarioToggle({ value, onChange }: Props) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => (v === 'realista' || v === 'otimista' || v === 'pessimista') && onChange(v)}
      className="h-8"
      size="sm"
      aria-label="Cenário"
    >
      <ToggleGroupItem value="pessimista" aria-label="Pessimista">Pessimista</ToggleGroupItem>
      <ToggleGroupItem value="realista" aria-label="Realista">Realista</ToggleGroupItem>
      <ToggleGroupItem value="otimista" aria-label="Otimista">Otimista</ToggleGroupItem>
    </ToggleGroup>
  );
}
