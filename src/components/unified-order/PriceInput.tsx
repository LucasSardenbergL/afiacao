import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { parseDecimalBR } from '@/lib/preco/parse-decimal-br';

interface PriceInputProps {
  value: number;
  onValueChange: (value: number) => void;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
  /** Confirma só ao sair do campo ou no Enter (e só se o texto mudou). Para valores que o
   *  dono pode RECUSAR (linha com cor, Fase 2B): a cada tecla, "130" passaria por "1" e
   *  "13", e uma recusa no fim deixaria o item preso no valor intermediário. */
  confirmarAoSair?: boolean;
  /** Texto exibido fora da edição (padrão: o número cru; 0 vira vazio). */
  formatar?: (value: number) => string;
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
  confirmarAoSair = false,
  formatar,
}: PriceInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const inicial = useRef<string>('');
  // Codex P2: redigitar o MESMO texto ("10,12" sobre o 10,12% exibido arredondado) é edição
  // explícita e confirma; só foco+saída sem digitar não regrava o valor exato.
  const editou = useRef(false);
  const display = draft ?? (formatar ? formatar(value) : value ? String(value) : '');

  const confirmar = () => {
    if (draft !== null && (editou.current || draft !== inicial.current)) {
      const parsed = parseDecimalBR(draft);
      if (parsed !== null) onValueChange(parsed);
    }
    setDraft(null);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      pattern="[0-9]*[.,]?[0-9]*"
      value={display}
      aria-invalid={invalid}
      aria-label={ariaLabel}
      onFocus={(e) => {
        inicial.current = display;
        editou.current = false;
        setDraft(display);
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        editou.current = true;
        if (confirmarAoSair) return;
        const parsed = parseDecimalBR(raw);
        if (parsed !== null) onValueChange(parsed);
      }}
      onKeyDown={(e) => {
        if (confirmarAoSair && e.key === 'Enter') e.currentTarget.blur();
      }}
      onBlur={() => (confirmarAoSair ? confirmar() : setDraft(null))}
      className={className}
    />
  );
}
