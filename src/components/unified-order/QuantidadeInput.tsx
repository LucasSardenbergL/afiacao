import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { confirmarQuantidade } from './quantidade';

interface QuantidadeInputProps {
  value: number;
  /** Chamado só ao confirmar (blur/Enter) e só com quantidade válida e diferente da atual. */
  onCommit: (quantidade: number) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * C7 (rodada 2): digitação num buffer local. O valor vai para o carrinho no blur ou Enter;
 * vazio/inválido volta ao anterior (nunca 0, nunca 1 inventado). Esc desfaz a edição.
 */
export function QuantidadeInput({ value, onCommit, className, 'aria-label': ariaLabel }: QuantidadeInputProps) {
  // null = não está editando → mostra o valor do carrinho (que pode mudar pelos botões ±).
  const [buffer, setBuffer] = useState<string | null>(null);
  // Esc marca o descarte ANTES do blur: o onBlur do mesmo evento ainda enxerga o buffer digitado.
  const descartarRef = useRef(false);
  // Só focar e sair NÃO commita: o valor do carrinho pode ter mudado por fora (replicação, ±) e
  // o buffer guardado no foco o desfaria (Codex P1).
  const editadoRef = useRef(false);

  // Confirma SÓ no blur (o Enter apenas tira o foco): dois caminhos de commit no mesmo evento
  // aplicariam o delta duas vezes, porque o `value` da closure ainda é o antigo.
  const confirmar = () => {
    const editado = editadoRef.current;
    editadoRef.current = false;
    if (descartarRef.current) { descartarRef.current = false; setBuffer(null); return; }
    if (buffer === null || !editado) { setBuffer(null); return; }
    const qtd = confirmarQuantidade(buffer, value);
    setBuffer(null);
    if (qtd !== value) onCommit(qtd);
  };

  return (
    <Input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      enterKeyHint="done"
      value={buffer ?? String(value)}
      aria-label={ariaLabel}
      onFocus={e => { editadoRef.current = false; setBuffer(String(value)); e.target.select(); }}
      // Texto CRU até o blur: filtrar dígitos aqui fazia "12,5" colado virar 125 (Codex P1).
      onChange={e => { editadoRef.current = true; setBuffer(e.target.value); }}
      onBlur={confirmar}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { descartarRef.current = true; e.currentTarget.blur(); }
      }}
      className={className}
    />
  );
}
