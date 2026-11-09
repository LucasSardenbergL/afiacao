import { Copy, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useIsTouchDevice } from '@/hooks/useIsTouchDevice';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { normalizeBrPhone } from '@/lib/phone';
import { track } from '@/lib/analytics';
import { registrarIntencaoContato } from '@/queries/useRadarRegistroEmpurrado';
import { cn } from '@/lib/utils';

/**
 * A ação do telefone no Radar (pacote A7). No desktop o "Ligar" abria o softphone WebRTC, e a telefonia está
 * congelada até 10/01/2027: era um beco sem saída. Aqui o desktop COPIA o número (o vendedor liga do aparelho
 * dele) e o celular mantém o `tel:` (discador do aparelho, pela operadora). Não toca o módulo de telefonia.
 *
 * Sob a lente "Ver como" o `tel:` fica bloqueado (furaria o write-guard); copiar é leitura e continua.
 *
 * Com `cnpj` (a ficha do lead), ligar e copiar gravam a INTENÇÃO de contato no ledger do Radar (pacote M): o
 * track() do PostHog é cego no navegador do founder. A gravação nunca segura nem desfaz o clique.
 */
export function RadarTelefoneAcao({
  telefone,
  variant = 'icon',
  className,
  discreto = false,
  cnpj,
}: {
  telefone: string | null | undefined;
  /** 'icon' = ícone compacto (linha, telefone da ficha); 'full' = botão com texto (modo discagem). */
  variant?: 'icon' | 'full';
  className?: string;
  /** O número parece ser da contabilidade (migration 20261109140000): a ação continua, mas sem destaque. */
  discreto?: boolean;
  /** O lead do telefone: com ele, o toque vira intenção de contato no ledger (radar_eventos). */
  cnpj?: string;
}) {
  const isTouch = useIsTouchDevice();
  const digitos = normalizeBrPhone(telefone);
  if (!telefone || digitos.length < 10) return null; // sem DDD+número: não fabrica ação quebrada
  const icone = variant === 'icon';
  const tomCheio = discreto ? 'outline' : 'default';
  const classeDiscreta = discreto ? 'text-muted-foreground' : undefined;

  if (isTouch) {
    const conteudo = (
      <>
        <Smartphone className={icone ? 'w-4 h-4' : 'w-4 h-4 mr-1'} />
        {!icone && 'Ligar'}
      </>
    );
    // Mesmo sinal do write-guard (não o contexto): a linha também renderiza fora do provider da lente.
    if (isLensActive()) {
      return (
        <Button size={icone ? 'icon' : 'sm'} variant="ghost" disabled className={cn(icone && 'h-8 w-8', className)}
          title="Ligação indisponível em modo Ver como" aria-label="Ligar">
          {conteudo}
        </Button>
      );
    }
    return (
      <Button asChild size={icone ? 'icon' : 'sm'} variant={icone ? 'ghost' : tomCheio} className={cn(icone && 'h-8 w-8', classeDiscreta, className)}>
        <a href={`tel:${digitos}`} aria-label="Ligar pelo celular" title="Abre o discador do seu celular"
          onClick={() => {
            track('radar.telefone_acao', { acao: 'ligar_celular' });
            if (cnpj) void registrarIntencaoContato(cnpj, 'ligar');
          }}>
          {conteudo}
        </a>
      </Button>
    );
  }

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(telefone);
      track('radar.telefone_acao', { acao: 'copiar' });
      if (cnpj) void registrarIntencaoContato(cnpj, 'copiar');
      toast.success('Telefone copiado', { description: telefone });
    } catch {
      // Sem permissão de área de transferência: o número continua visível para digitar.
      toast.error('Não consegui copiar', { description: `Disque ${telefone} pelo seu aparelho.` });
    }
  };
  return (
    <Button size={icone ? 'icon' : 'sm'} variant={icone ? 'ghost' : tomCheio} onClick={() => void copiar()}
      className={cn(icone && 'h-8 w-8', classeDiscreta, className)} aria-label={`Copiar telefone ${telefone}`}
      title="Copiar o telefone (ligue pelo seu aparelho)">
      <Copy className={icone ? 'w-4 h-4' : 'w-4 h-4 mr-1'} />
      {!icone && 'Copiar telefone'}
    </Button>
  );
}
