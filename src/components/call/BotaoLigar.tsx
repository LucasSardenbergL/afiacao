import { Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useIsTouchDevice } from '@/hooks/useIsTouchDevice';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { normalizeBrPhone } from '@/lib/phone';
import { Dialer } from './Dialer';

interface BotaoLigarProps {
  telefone: string | null | undefined;
  nomeCliente: string;
  /** 'full' = botão "Ligar"; 'icon' = ícone compacto. Default 'full'. */
  variant?: 'full' | 'icon';
  /** Analytics do call-site. Disparado quando a ligação é INICIADA pelo discador do
   *  aparelho (caminho mobile). No desktop a chamada é registrada pela própria
   *  telefonia WebRTC, então o call-site não precisa rastrear o clique. */
  onLigar?: () => void;
  className?: string;
}

/**
 * Botão "Ligar" híbrido por plataforma — fonte ÚNICA da ação "ligar" nas telas de
 * campo/lista (route-planner, fila, caça, radar). A intenção é deixar CLARO e
 * CONSISTENTE, em todo o app, o que acontece ao ligar em cada dispositivo:
 *
 * - DESKTOP (não-touch): softphone WebRTC in-app (reusa <Dialer>) — grava + copiloto,
 *   igual ao resto do app de vendas. Resolve "no notebook o botão não puxa o WebRTC".
 * - CELULAR/TABLET (touch, via useIsTouchDevice): discador do APARELHO (tel:) — liga
 *   pela operadora, SEM gravação. Sinaliza com o ícone Smartphone (≠ do softphone) e
 *   avisa no toque (toast). Bloqueia na lente "Ver como" (o tel: furaria o write-guard).
 *
 * Não estende o CallButton de propósito: ele é "WebRTC sempre" (a tela de Telefonia
 * depende disso). Este é o modo híbrido, separado — um propósito por componente.
 */
export function BotaoLigar({ telefone, nomeCliente, variant = 'full', onLigar, className }: BotaoLigarProps) {
  const isTouch = useIsTouchDevice();

  const digitos = normalizeBrPhone(telefone);
  if (digitos.length < 10) return null; // sem DDD+número válido: esconde (não fabrica link quebrado)

  // DESKTOP → softphone in-app. O <Dialer> já trata o gate da lente internamente.
  if (!isTouch) {
    return <Dialer phoneNumber={telefone as string} customerName={nomeCliente} compact={variant === 'icon'} />;
  }

  const isIcon = variant === 'icon';
  const classes = cn(isIcon ? 'h-8 w-8' : 'h-8 text-xs gap-1.5', className);
  const conteudo = (
    <>
      <Smartphone className={isIcon ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
      {!isIcon && 'Ligar'}
    </>
  );

  // CELULAR sob a lente "Ver como": o tel: navega direto e furaria o write-guard → bloqueia.
  if (isLensActive()) {
    return (
      <Button
        size={isIcon ? 'icon' : 'sm'}
        variant="ghost"
        disabled
        className={classes}
        title="Ligação indisponível em modo Ver como"
        aria-label="Ligar"
      >
        {conteudo}
      </Button>
    );
  }

  return (
    <Button asChild size={isIcon ? 'icon' : 'sm'} variant="ghost" className={classes}>
      <a
        href={`tel:${digitos}`}
        aria-label="Ligar pelo celular"
        title="Abre o discador do seu celular — ligação pelo aparelho, sem gravação"
        onClick={() => {
          onLigar?.();
          toast.info('Ligando pelo seu celular — chamada pelo aparelho, sem gravação.');
        }}
      >
        {conteudo}
      </a>
    </Button>
  );
}
