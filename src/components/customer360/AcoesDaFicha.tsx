// Onda 3 da tela Clientes — o que a vendedora FAZ a partir da 360: registrar o desfecho do contato,
// ver/criar a próxima ação e saber o crédito antes de oferecer. Cada bloco tem estado próprio: falha de
// uma leitura não esconde as outras, e nenhuma ausência vira zero.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ClipboardCheck, Landmark, Plus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BotoesContato } from '@/components/venda-cliente/BotoesContato';
import { CriarTarefaDialog } from '@/components/tarefas/CriarTarefaDialog';
import { useTarefasAbertasDoCliente } from '@/hooks/useTarefas';
import { useCreditoDoCliente } from '@/hooks/useAlertaCreditoCliente';
import { registrarUsoClientes } from '@/lib/nav/sensor-clientes';
import { resumoCredito, rotuloPrazoTarefa } from './acoes-da-ficha';

const estadoDe = (q: { data: unknown; isError: boolean }) =>
  q.data !== undefined ? 'ok' as const : q.isError ? 'falha' as const : 'carregando' as const;

/**
 * O cliente está na carteira ELEGÍVEL de quem está logado (o usuário REAL — escrita é sempre do
 * `useAuth`)? `venda_registrar_contato` só grava nesse caso (senão 42501), então os botões só aparecem aí.
 */
function useNaMinhaCarteira(customerId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['c360-na-minha-carteira', customerId, user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('carteira_assignments')
        .select('customer_user_id')
        .eq('customer_user_id', customerId)
        .eq('owner_user_id', user!.id)
        .eq('eligible', true)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  });
}

export function AcoesDaFicha({ customerId, customerName }: { customerId: string; customerName: string }) {
  const { user, isMaster, isGestorComercial } = useAuth();
  const { isImpersonating } = useImpersonation();
  const [criarTarefa, setCriarTarefa] = useState(false);

  const naCarteira = useNaMinhaCarteira(customerId);
  const tarefas = useTarefasAbertasDoCliente(customerId);
  const credito = useCreditoDoCliente(customerId, { lerAliases: isMaster || isGestorComercial });
  const resumo = resumoCredito(estadoDe(credito), credito.data);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="c360-acoes-da-ficha">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-muted-foreground" /> Desfecho do contato
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {naCarteira.data === true ? (
            <span onClickCapture={() => registrarUsoClientes({ acao: 'ficha_acao', ficha: '360', tipo: 'registrar_desfecho' })}>
              <BotoesContato compradorId={customerId} variante="grade" />
            </span>
          ) : naCarteira.data === false ? (
            <p className="text-xs text-muted-foreground">
              O desfecho é registrado por quem tem este cliente na carteira.
            </p>
          ) : naCarteira.isError ? (
            <p className="text-xs text-muted-foreground">Não consegui conferir a sua carteira agora.</p>
          ) : (
            <p className="text-xs text-muted-foreground">Conferindo a carteira…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center gap-2 space-y-0">
          <CalendarClock className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Próxima ação</CardTitle>
          {user && (
            <Button
              size="sm" variant="ghost" className="h-7 ml-auto text-xs gap-1"
              disabled={isImpersonating}
              onClick={() => {
                registrarUsoClientes({ acao: 'ficha_acao', ficha: '360', tipo: 'criar_tarefa' });
                setCriarTarefa(true);
              }}
            >
              <Plus className="w-3.5 h-3.5" /> Tarefa
            </Button>
          )}
        </CardHeader>
        <CardContent className="text-sm">
          {tarefas.data ? (
            tarefas.data.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="c360-sem-tarefa">
                Nenhuma tarefa aberta visível para você.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {tarefas.data.map((t) => (
                  <li key={t.id} className="flex items-start gap-2">
                    <span className="flex-1 min-w-0 truncate">{t.descricao}</span>
                    <Badge
                      variant="outline"
                      className={t.atrasada ? 'text-2xs text-status-error border-status-error/30' : 'text-2xs'}
                    >
                      {rotuloPrazoTarefa(t)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )
          ) : tarefas.isError ? (
            <p className="text-xs text-muted-foreground">Tarefas indisponíveis (a leitura falhou).</p>
          ) : (
            <p className="text-xs text-muted-foreground">Lendo as tarefas…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Landmark className="w-4 h-4 text-muted-foreground" /> Crédito
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <p
            data-testid="c360-credito"
            className={resumo.tom === 'alerta' ? 'font-medium text-status-error' : resumo.tom === 'ok' ? 'text-status-success' : 'text-muted-foreground'}
          >
            {resumo.titulo}
          </p>
          {resumo.notas.map((n) => (
            <p key={n} className="text-2xs text-muted-foreground">{n}</p>
          ))}
        </CardContent>
      </Card>

      {user && (
        <CriarTarefaDialog
          open={criarTarefa}
          onOpenChange={setCriarTarefa}
          cliente={{ customer_user_id: customerId, nome: customerName }}
          assignedTo={user.id}
          // Mesmo default explícito da tarefa por voz desta tela (Customer360.tsx §#9): não derivar a conta.
          empresa="oben"
        />
      )}
    </div>
  );
}
