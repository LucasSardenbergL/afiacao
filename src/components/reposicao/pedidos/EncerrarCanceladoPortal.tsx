// 5.3 — botão auditado "Encerrar — cancelado no fornecedor" (decisão do founder: humano, não automático).
// Só master vê. A edge consulta o Omie e o banco revalida tudo; a tela só pede a justificativa e mostra o desfecho.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { PedidoSugerido } from './types';
import { corpoDoErroEdge, statusDoErroEdge } from './importar-portal';
import { interpretarRespostaEncerrar, podeOferecerEncerrar, type ResultadoEncerrar } from './encerrar-cancelado-portal';

const CHAVE_INVALIDAR = ['pedidos-ciclo'] as const;

export function EncerrarCanceladoPortal({ pedido }: { pedido: PedidoSugerido | null }) {
  // Escrita: identidade REAL (useAuth), nunca a da lente "Ver como".
  const { isMaster } = useAuth();
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [justificativa, setJustificativa] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoEncerrar | null>(null);

  if (!isMaster || !pedido || !podeOferecerEncerrar(pedido)) return null;
  const valida = justificativa.trim().length >= 10;

  const encerrar = async () => {
    setEnviando(true);
    setResultado(null);
    let r: ResultadoEncerrar;
    try {
      const { data, error } = await supabase.functions.invoke('sayerlack-encerrar-cancelado-portal', {
        body: { pedido_id: pedido.id, justificativa: justificativa.trim() },
      });
      r = error
        ? interpretarRespostaEncerrar(await corpoDoErroEdge(error), statusDoErroEdge(error))
        : interpretarRespostaEncerrar(data, 200);
    } catch {
      r = interpretarRespostaEncerrar(null, null);
    }
    setEnviando(false);
    setResultado(r);
    track('reposicao.encerrar_cancelado_portal', { pedido_id: pedido.id, desfecho: r.desfecho });
    // Qualquer desfecho que não seja recusa limpa pode ter mudado o pedido: recarrega a lista.
    if (r.desfecho !== 'recusado') void queryClient.invalidateQueries({ queryKey: [...CHAVE_INVALIDAR] });
    if (r.desfecho === 'encerrado') {
      toast.success('Pedido encerrado como cancelado no fornecedor');
      setAberto(false);
    }
  };

  return (
    <div className="rounded-md border border-status-error/40 p-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        A Sayerlack cancelou este pedido (protocolo {pedido.portal_protocolo}) e não há pedido de compra no Omie. Se o
        cancelamento foi confirmado com o fornecedor, encerre o pedido aqui — fica registrado quem encerrou e por quê.
      </p>
      <Button variant="outline" size="sm" onClick={() => { setResultado(null); setAberto(true); }}>
        Encerrar — cancelado no fornecedor
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { if (!enviando) setAberto(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Encerrar pedido #{pedido.id} — cancelado no fornecedor</DialogTitle>
            <DialogDescription>
              Antes de encerrar, o app confere no Omie que não existe pedido de compra deste pedido. O encerramento não
              cria nem altera nada no Omie nem no portal.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Com quem e quando o cancelamento foi confirmado (mín. 10 caracteres)"
            maxLength={1000}
            disabled={enviando}
          />
          {resultado && resultado.desfecho !== 'encerrado' && (
            <p className={resultado.desfecho === 'recusado' ? 'text-sm text-status-warning' : 'text-sm text-status-error'}>
              {resultado.mensagem}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(false)} disabled={enviando}>Voltar</Button>
            <Button variant="destructive" onClick={encerrar} disabled={!valida || enviando}>
              {enviando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Encerrar pedido
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
