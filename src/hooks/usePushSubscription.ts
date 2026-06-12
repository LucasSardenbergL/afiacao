import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { logger } from '@/lib/logger';
import { track } from '@/lib/analytics';
import { VAPID_PUBLIC_KEY, vapidKeyToUint8Array } from '@/lib/push/vapid';
import { suportaPush } from '@/lib/push/device';

/**
 * Estado da assinatura de Web Push deste device:
 * - carregando: ainda detectando suporte/assinatura existente
 * - unsupported: navegador sem Push API (ou SW indisponível)
 * - ios_precisa_instalar: iOS Safari fora de PWA instalado (16.4+ exige
 *   "Adicionar à Tela de Início" antes do push funcionar)
 * - negado: permissão de notificação bloqueada (só reverte nas configs do browser)
 * - pronto: suportado e sem assinatura — pode ativar
 * - ativo: assinado neste device
 */
export type PushStatus =
  | 'carregando'
  | 'unsupported'
  | 'ios_precisa_instalar'
  | 'negado'
  | 'pronto'
  | 'ativo';

function detectarIosForaDoPwa(): boolean {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  if (!isIos) return false;
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

/**
 * Grava/repara a assinatura via RPC SECURITY DEFINER: o endpoint é REATRIBUÍDO
 * pra quem está logado agora — em device compartilhado, o upsert own-only de RLS
 * deixaria a linha presa na vendedora anterior e o push DELA continuaria chegando
 * neste device (P1 da revisão adversarial).
 */
async function salvarAssinatura(sub: PushSubscription): Promise<boolean> {
  const { error } = await supabase.rpc('upsert_push_subscription', {
    p_endpoint: sub.endpoint,
    p_subscription: sub.toJSON() as unknown as import('@/integrations/supabase/types').Json,
    p_user_agent: navigator.userAgent.slice(0, 256),
  });
  if (error) {
    logger.warn('Falha ao salvar push subscription', { stage: 'push_save', error: error.message });
    return false;
  }
  return true;
}

export function usePushSubscription(): {
  status: PushStatus;
  ativar: () => Promise<boolean>;
} {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus>('carregando');

  // Detecção inicial: suporte → permissão → assinatura existente neste device.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      if (!suportaPush()) {
        setStatus(detectarIosForaDoPwa() ? 'ios_precisa_instalar' : 'unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        setStatus('negado');
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (cancelado) return;
        if (sub && user) {
          // Repara a linha no banco se sumiu (reinstalação, limpeza, etc).
          void salvarAssinatura(sub);
          setStatus('ativo');
        } else {
          setStatus('pronto');
        }
      } catch (error) {
        if (!cancelado) {
          logger.warn('Falha ao checar push subscription', { stage: 'push_check', error });
          setStatus('unsupported');
        }
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [user]);

  const ativar = useCallback(async (): Promise<boolean> => {
    if (!user || !suportaPush()) return false;
    try {
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') {
        setStatus(permissao === 'denied' ? 'negado' : 'pronto');
        track('push.permissao_recusada');
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Uint8Array satisfaz BufferSource; cast explícito pro lib.dom aceitar.
          applicationServerKey: vapidKeyToUint8Array(VAPID_PUBLIC_KEY) as unknown as ArrayBuffer,
        }));
      const ok = await salvarAssinatura(sub);
      if (ok) {
        setStatus('ativo');
        track('push.ativado');
      }
      return ok;
    } catch (error) {
      logger.warn('Falha ao ativar push', { stage: 'push_subscribe', error });
      return false;
    }
  }, [user]);

  return { status, ativar };
}
