import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { Dialer } from './Dialer';

interface CallButtonProps {
  phone: string;
  customerName: string;
  /** 'full' = botão "Ligar {telefone}"; 'icon' = ícone compacto. */
  variant?: 'full' | 'icon';
  className?: string;
}

/**
 * Botão de ligar que escolhe o backend certo por dispositivo:
 * - DESKTOP: dialer in-app <Dialer> (Nvoip click-to-call ou WebRTC, conforme a
 *   feature flag useWebRTCCall). Inicia a chamada DENTRO do app.
 * - MOBILE/TOUCH: link tel: nativo (o celular disca pela operadora) — o vendedor
 *   externo no celular continua usando o discador do aparelho.
 *
 * Substitui os <a href="tel:..."> espalhados nas páginas de cliente, que no
 * desktop entregavam a chamada pro SO (macOS abria o app Telefone / erro WPC)
 * em vez de usar a telefonia in-app. Ver DEBUG report 2026-05-20.
 */
export function CallButton({ phone, customerName, variant = 'full', className }: CallButtonProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    if (variant === 'icon') {
      return (
        <Button asChild variant="ghost" size="icon" className={cn('h-8 w-8 text-status-success', className)}>
          <a href={`tel:${phone}`} title={`Ligar para ${phone}`}>
            <Phone className="w-4 h-4" />
          </a>
        </Button>
      );
    }
    return (
      <Button asChild variant="outline" size="sm" className={className}>
        <a href={`tel:${phone}`}>
          <Phone className="w-3.5 h-3.5 mr-1.5" />
          Ligar
        </a>
      </Button>
    );
  }

  // Desktop: dialer in-app. Quando idle renderiza "Ligar {telefone}" (ou ícone se
  // compact); quando a chamada inicia, vira card de status (inline).
  return <Dialer phoneNumber={phone} customerName={customerName} compact={variant === 'icon'} />;
}
