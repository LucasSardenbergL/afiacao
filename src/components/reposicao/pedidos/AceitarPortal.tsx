// 5.2 fatia 2 — botão auditado "Aceitar o portal" (decisão do founder: opção (a), humano, com justificativa).
// Mostra as diferenças da divergência aberta (as que o humano aceita), chama a RPC (o banco revalida tudo e grava a
// trilha com o antes e o depois) e, aceito, re-dispara pelo caminho de sempre: a importadora relê o portal e dispara.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { ResultadoTela } from './importar-portal';
import type { PedidoSugerido } from './types';
import {
  descreverDiferenca, interpretarRespostaAceitar, lerDiferencas, podeOferecerAceitar, redispararPeloPortal,
  type ResultadoAceitar,
} from './aceitar-portal';

const CHAVE_INVALIDAR = ['pedidos-ciclo'] as const;

export function AceitarPortal({ pedido }: { pedido: PedidoSugerido | null }) {
  // Escrita: identidade REAL (useAuth), nunca a da lente "Ver como".
  const { isStaff } = useAuth();
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [justificativa, setJustificativa] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoAceitar | null>(null);
  const [redisparo, setRedisparo] = useState<ResultadoTela | null>(null);
  const divergenciaId = pedido?.portal_divergencia_aberta_id ?? null;
  const oferecer = isStaff && podeOferecerAceitar(pedido);

  const divergencia = useQuery({
    queryKey: ['sayerlack-divergencia', divergenciaId],
    enabled: oferecer && typeof divergenciaId === 'number',
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sayerlack_portal_divergencia')
        .select('id, diferencas, lido_de, resolvida_em')
        .eq('id', divergenciaId as number)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (!oferecer || !pedido || typeof divergenciaId !== 'number') return null;
  const diferencas = divergencia.data ? lerDiferencas(divergencia.data.diferencas) : null;
  const valida = justificativa.trim().length >= 10;
  const protocolo = (pedido.portal_protocolo ?? '').trim();

  const aceitar = async () => {
    setEnviando(true);
    setResultado(null);
    setRedisparo(null);
    let r: ResultadoAceitar;
    try {
      const { data, error } = await supabase.rpc('sayerlack_aceitar_portal', {
        p_pedido_id: pedido.id, p_divergencia_id: divergenciaId, p_justificativa: justificativa.trim(),
      });
      r = interpretarRespostaAceitar(data, error);
    } catch {
      r = interpretarRespostaAceitar(null, null);
    }
    setResultado(r);
    track('reposicao.aceitar_portal', { pedido_id: pedido.id, desfecho: r.desfecho });
    if (r.desfecho !== 'recusado') void queryClient.invalidateQueries({ queryKey: [...CHAVE_INVALIDAR] });
    if (r.desfecho === 'aceito') {
      toast.success('Pedido atualizado com o portal — re-disparando');
      const d = await redispararPeloPortal(protocolo);
      setRedisparo(d);
      track('reposicao.aceitar_portal_redisparo', { pedido_id: pedido.id, tom: d.tom });
      void queryClient.invalidateQueries({ queryKey: [...CHAVE_INVALIDAR] });
    }
    setEnviando(false);
  };

  return (
    <div className="rounded-md border border-status-warning/40 p-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        O pedido mudou no portal Sayerlack (protocolo {protocolo}) e o disparo está bloqueado. Se a mudança foi
        combinada com o fornecedor, aceite o portal: o pedido do app passa a ser o que o portal mostra e é re-disparado.
      </p>
      <Button variant="outline" size="sm" onClick={() => { setResultado(null); setRedisparo(null); setAberto(true); }}>
        Aceitar o portal
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { if (!enviando) setAberto(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aceitar o portal — pedido #{pedido.id}</DialogTitle>
            <DialogDescription>
              Itens, quantidades, valores e condição de pagamento do app são trocados pelos do portal, com o custo
              recalculado pela mesma prova da importação. Fica registrado quem aceitou, por quê, e o antes e o depois.
            </DialogDescription>
          </DialogHeader>
          {divergencia.isLoading && <p className="text-sm text-muted-foreground">Carregando as diferenças…</p>}
          {!divergencia.isLoading && diferencas === null && (
            <p className="text-sm text-status-error">Não consegui ler as diferenças desta divergência — não aceite às cegas.</p>
          )}
          {diferencas && (
            <ul className="text-sm list-disc pl-5 space-y-0.5">
              {diferencas.map((d, i) => <li key={i}>{descreverDiferenca(d)}</li>)}
            </ul>
          )}
          <Textarea
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Com quem e quando a mudança foi combinada (mín. 10 caracteres)"
            maxLength={1000}
            disabled={enviando || resultado?.desfecho === 'aceito'}
          />
          {resultado && resultado.desfecho !== 'aceito' && (
            <p className={resultado.desfecho === 'recusado' ? 'text-sm text-status-warning' : 'text-sm text-status-error'}>
              {resultado.mensagem}
            </p>
          )}
          {resultado?.desfecho === 'aceito' && (
            <div className="text-sm space-y-1">
              <p className="text-status-success">{resultado.mensagem}</p>
              {enviando && !redisparo && <p className="text-muted-foreground">Relendo o portal e disparando o pedido de compra…</p>}
              {redisparo && (
                <p className={redisparo.tom === 'sucesso' ? 'text-status-success' : redisparo.tom === 'aviso' ? 'text-status-warning' : 'text-status-error'}>
                  {redisparo.titulo}: {redisparo.mensagem}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(false)} disabled={enviando}>
              {resultado?.desfecho === 'aceito' ? 'Fechar' : 'Voltar'}
            </Button>
            {resultado?.desfecho !== 'aceito' && (
              <Button onClick={aceitar} disabled={!valida || enviando || diferencas === null}>
                {enviando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Aceitar e re-disparar
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
