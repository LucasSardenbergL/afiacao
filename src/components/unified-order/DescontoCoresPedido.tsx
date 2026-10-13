import { useState } from 'react';
import { toast } from 'sonner';
import { Percent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseDecimalBR } from '@/lib/preco/parse-decimal-br';
import { track } from '@/lib/analytics';

interface DescontoCoresPedidoProps {
  nCores: number;
  /** Aplica o % em TODAS as linhas com cor (tudo-ou-nada); `null` = recusado (o dono avisa). */
  onAplicar: (descontoPct: number) => { aplicadas: number } | null;
}

/**
 * Desconto do PEDIDO para as cores (Fase 2B): um % aplicado de uma vez às linhas com cor
 * que já estão no carrinho, em vez de redigitar cor por cor. Ação explícita, não estado:
 * cor adicionada depois entra sem desconto (o 1 toque nunca herda desconto) e o botão
 * aplica de novo. Só cores: o preço dos outros produtos é negociado item a item.
 */
export function DescontoCoresPedido({ nCores, onAplicar }: DescontoCoresPedidoProps) {
  const [texto, setTexto] = useState('');
  const pct = parseDecimalBR(texto);
  const valido = pct !== null && pct >= 0 && pct < 100;

  const aplicar = () => {
    if (!valido || pct === null) return;
    const r = onAplicar(pct);
    if (!r) return;
    track('tint.desconto_pedido_aplicado', { cores: r.aplicadas, desconto_pct: pct });
    toast.success(`Desconto de ${texto.trim()}% aplicado em ${r.aplicadas} cor${r.aplicadas === 1 ? '' : 'es'}`);
    setTexto('');
  };

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5" data-testid="desconto-cores-pedido">
      <Percent className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="text-[11px] text-muted-foreground flex-1">Desconto nas {nCores} cores</span>
      <Input
        type="text"
        inputMode="decimal"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') aplicar();
        }}
        placeholder="%"
        aria-label="Desconto do pedido para as cores (%)"
        className="h-6 w-14 text-xs text-right"
      />
      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={!valido} onClick={aplicar}>
        Aplicar
      </Button>
    </div>
  );
}
