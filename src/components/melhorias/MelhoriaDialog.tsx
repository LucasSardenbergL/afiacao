// src/components/melhorias/MelhoriaDialog.tsx
// Dialog global (topbar) de criação de melhoria. Captura rota/empresa sozinho;
// mostra a resposta da IA inline. Falha da IA = degradação honesta (item segue na fila).
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { useCriarMelhoria, useMelhoriaThread } from '@/hooks/useMelhorias';
import { MelhoriaThread } from './MelhoriaThread';

export function MelhoriaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { user } = useAuth();
  const { activeCompany } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const [texto, setTexto] = useState('');
  const [itemCriadoId, setItemCriadoId] = useState<string | null>(null);
  const criar = useCriarMelhoria();
  const { data: thread } = useMelhoriaThread(itemCriadoId);

  const fechar = (o: boolean) => {
    if (!o) {
      setTexto('');
      setItemCriadoId(null);
      criar.reset();
    }
    onOpenChange(o);
  };

  const enviar = async () => {
    if (!user?.id || texto.trim().length < 5) return;
    try {
      const r = await criar.mutateAsync({
        conteudo: texto,
        empresa: activeCompany,
        rotaOrigem: location.pathname,
        autorUserId: user.id,
      });
      setItemCriadoId(r.item.id);
      if (!r.triagemOk) {
        toast.info(
          'Recebido! A avaliação automática falhou, mas sua mensagem está na fila do Lucas.',
        );
      }
    } catch {
      toast.error('Não consegui enviar — tente de novo.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sugerir melhoria · reportar problema</DialogTitle>
          <DialogDescription>
            Escreva livre: o que travou, o que poderia ser melhor, ou uma pergunta. A IA avalia na
            hora e o Lucas vê tudo.
          </DialogDescription>
        </DialogHeader>

        {!itemCriadoId ? (
          <div className="space-y-3">
            <Textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Ex.: o picking trava quando bipo duas vezes seguidas…"
              rows={4}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => fechar(false)}>
                Cancelar
              </Button>
              <Button
                onClick={enviar}
                disabled={criar.isPending || texto.trim().length < 5}
              >
                {criar.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    A IA está avaliando…
                  </>
                ) : (
                  'Enviar'
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <MelhoriaThread mensagens={thread ?? []} />
            <div className="flex justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  fechar(false);
                  navigate('/melhorias');
                }}
              >
                Ver meus envios
              </Button>
              <Button size="sm" onClick={() => fechar(false)}>
                Fechar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
