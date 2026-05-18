import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export function RegimeToggle() {
  const { regime, setRegime } = useFinanceiroRegime();
  return (
    <ToggleGroup
      type="single"
      value={regime}
      onValueChange={(v) => v === 'caixa' || v === 'competencia' ? setRegime(v) : null}
      className="h-8"
      size="sm"
      aria-label="Regime DRE"
    >
      <ToggleGroupItem value="caixa" aria-label="Caixa">Caixa</ToggleGroupItem>
      <ToggleGroupItem value="competencia" aria-label="Competência">Competência</ToggleGroupItem>
    </ToggleGroup>
  );
}
