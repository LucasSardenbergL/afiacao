import { useState } from 'react';
import { Bell, Share, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { usePushSubscription } from '@/hooks/usePushSubscription';

const DISMISS_KEY = 'push-card-dismissed-v1';

/**
 * Card de opt-in do Web Push no Meu Dia da vendedora. Some quando: já ativo,
 * sem suporte, permissão negada, ou dispensado (localStorage). No iOS fora de
 * PWA instalado, vira instrução de instalação (16.4+ exige tela de início).
 */
export function AtivarNotificacoesCard() {
  const { status, ativar } = usePushSubscription();
  const [dispensado, setDispensado] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1',
  );
  const [ativando, setAtivando] = useState(false);

  if (dispensado) return null;
  if (status !== 'pronto' && status !== 'ios_precisa_instalar') return null;

  const dispensar = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDispensado(true);
    track('push.card_dismissed');
  };

  const onAtivar = async () => {
    setAtivando(true);
    const ok = await ativar();
    setAtivando(false);
    if (ok) {
      toast.success('Notificações ativadas', {
        description: 'Você será avisada quando um cliente responder ou chegar tarefa nova.',
      });
    } else {
      toast.error('Não foi possível ativar', {
        description: 'Verifique a permissão de notificações do navegador.',
      });
    }
  };

  return (
    <Card className="border-dashed p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-muted p-1.5">
          {status === 'ios_precisa_instalar' ? (
            <Share className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Bell className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {status === 'ios_precisa_instalar' ? (
            <>
              <p className="text-sm font-medium">Receba avisos no celular</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                No iPhone, primeiro instale o app: toque em <Share className="inline h-3 w-3" />{' '}
                Compartilhar → "Adicionar à Tela de Início". Depois ative as notificações por aqui.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">Ative as notificações</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Cliente respondeu no WhatsApp, tarefa nova ou SLA estourando — avisamos mesmo com o
                app fechado.
              </p>
              <Button size="sm" className="mt-2" onClick={onAtivar} disabled={ativando}>
                {ativando ? 'Ativando…' : 'Ativar notificações'}
              </Button>
            </>
          )}
        </div>
        <button
          onClick={dispensar}
          aria-label="Dispensar"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </Card>
  );
}
