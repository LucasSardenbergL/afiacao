import { Dialer } from './Dialer';

interface CallButtonProps {
  phone: string;
  customerName: string;
  /** Id do cliente da ficha/linha — vira candidato a dono da ligação (validado antes de gravar). */
  customerId?: string | null;
  /** 'full' = botão "Ligar {telefone}"; 'icon' = ícone compacto. */
  variant?: 'full' | 'icon';
  /** Mantido por compatibilidade de API; o dialer in-app renderiza o próprio botão. */
  className?: string;
}

/**
 * Botão de ligar — usa SEMPRE o dialer in-app (WebRTC) em qualquer dispositivo,
 * iniciando a chamada DENTRO do app (grava + copiloto/transcrição ao vivo).
 *
 * Antes, em dispositivo touch (celular/tablet), caía pro discador nativo via
 * `<a href="tel:">` — o que abria o app Telefone do SO e perdia gravação + copiloto.
 * Isso foi descontinuado: a ligação de venda agora roda sempre in-app via WebRTC.
 */
export function CallButton({ phone, customerName, customerId, variant = 'full' }: CallButtonProps) {
  return <Dialer phoneNumber={phone} customerName={customerName} customerId={customerId} compact={variant === 'icon'} />;
}
