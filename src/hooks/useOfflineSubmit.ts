import { useState, useCallback } from 'react';
import { toast } from 'sonner';

export interface UseOfflineSubmitOptions {
  /** Envio online real (ex: h.submitOrder). */
  submit: () => void | Promise<void>;
  /** Estado de rede (de useNetworkStatus). */
  online: boolean;
  /** Há conteúdo a enviar (cart > 0)? Gate o CTA de reconexão. */
  hasContent: boolean;
}

export interface UseOfflineSubmitReturn {
  /** Handler do botão de envio: offline → marca pendente + toast; online → submit(). */
  onSubmit: () => void;
  /** True quando offline (pra UI do botão). */
  offline: boolean;
  /** Mostra o banner de reconexão (online + intent offline pendente + tem conteúdo). */
  showReconnectCta: boolean;
  /** Handler do CTA "Enviar agora": limpa pendente + submit(). */
  onReconnectSubmit: () => void;
}

/**
 * Gate offline-first para o envio de pedido. Não enfileira (submitOrder cria PV cobrado
 * no Omie, não-idempotente). Offline: salva intent pendente + avisa (o rascunho já é
 * auto-salvo pelo useOrderDraft). Online de novo: expõe CTA pra enviar de verdade.
 */
export function useOfflineSubmit({ submit, online, hasContent }: UseOfflineSubmitOptions): UseOfflineSubmitReturn {
  const [pending, setPending] = useState(false);

  const onSubmit = useCallback(() => {
    if (!online) {
      setPending(true);
      toast.info('Sem conexão — salvo como rascunho. Enviaremos quando reconectar.');
      return;
    }
    setPending(false);
    void submit();
  }, [online, submit]);

  const onReconnectSubmit = useCallback(() => {
    setPending(false);
    void submit();
  }, [submit]);

  return {
    onSubmit,
    offline: !online,
    showReconnectCta: online && pending && hasContent,
    onReconnectSubmit,
  };
}
