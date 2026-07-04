import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { parseDecimalBR } from '@/lib/preco/parse-decimal-br';

interface PriceInputProps {
  value: number;
  onValueChange: (value: number) => void;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * Input de preço que aceita vírgula decimal (teclado pt-BR). Mantém o texto digitado
 * num buffer local enquanto o campo está em uso — sem isso, o `value` numérico controlado
 * re-renderiza a cada tecla e DESCARTA a vírgula, transformando "12,5" em 125 (preço 10×).
 * Só propaga quando o texto parseia para um número (nunca fabrica zero — money-path).
 */
export function PriceInput({
  value,
  onValueChange,
  invalid,
  className,
  'aria-label': ariaLabel,
}: PriceInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value ? String(value) : '');

  return (
    <Input
      type="text"
      inputMode="decimal"
      pattern="[0-9]*[.,]?[0-9]*"
      value={display}
      aria-invalid={invalid}
      aria-label={ariaLabel}
      onFocus={(e) => {
        setDraft(display);
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const parsed = parseDecimalBR(raw);
        if (parsed !== null) onValueChange(parsed);
      }}
      onBlur={() => setDraft(null)}
      className={className}
    />
  );
}
