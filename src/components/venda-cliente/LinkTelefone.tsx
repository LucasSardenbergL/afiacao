import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { hrefTelefone } from '@/lib/venda-cliente/telefone';

interface Props {
  telefone: string | null;
  compradorId: string;
  origem: 'lista' | 'ficha';
  variante?: 'botao' | 'destaque';
  className?: string;
}

/**
 * Ligar pelo telefone DELA (`tel:` abre o discador). M-41: a telefonia do app está
 * congelada — nunca `BotaoLigar`/`CallButton`/WebRTC aqui.
 * Sensor `venda.tel_clicado` no ledger (o clique é o único rastro: a ligação sai do app).
 */
export function LinkTelefone({ telefone, compradorId, origem, variante = 'botao', className }: Props) {
  const href = hrefTelefone(telefone);
  if (!href) {
    return variante === 'destaque'
      ? <p className={cn('text-sm text-muted-foreground', className)}>Sem telefone no cadastro</p>
      : null;
  }
  const onClick = () => {
    void registrarNoLedger('venda.tel_clicado', compradorId, { origem });
  };
  if (variante === 'destaque') {
    return (
      <a
        href={href}
        onClick={onClick}
        className={cn(
          'group inline-flex items-center gap-2 font-display text-2xl tabular-nums tracking-tight text-foreground hover:text-primary transition-colors',
          className,
        )}
      >
        <Phone className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
        {telefone}
      </a>
    );
  }
  return (
    <Button asChild size="sm" variant="outline" className={cn('gap-1.5', className)}>
      <a href={href} onClick={onClick} aria-label={`Ligar para ${telefone}`}>
        <Phone className="w-3.5 h-3.5" /> Ligar
      </a>
    </Button>
  );
}
