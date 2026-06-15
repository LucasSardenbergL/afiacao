import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Nudge condicional no Meu Dia: ligações registradas (com transcript salvo) mas
 * SEM cliente vinculado. Aparece só quando há o que vincular e SOME quando vazio
 * (mesmo padrão do SlaCardMeuDia) — assim não polui a home.
 *
 * Antes isto era um item permanente na seção Vendas do menu ("Chamadas
 * pendentes") que confundia a vendedora (ela não sabia o que era nem quando
 * usar). Decisão Lucas (2026-06-11): sai do menu, vira nudge que só chama
 * atenção quando há trabalho real.
 *
 * Suprimido na lente "Ver como" — a query usa o user REAL (igual à página de
 * destino /farmer/calls/pending-link, que não é lente-aware), então o contador
 * seria do master; mostrá-lo na lente do alvo enganaria (segue o padrão dos
 * badges do menu, também suprimidos na lente).
 */
export function ChamadasPendentesNudge() {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const { data: count } = useQuery({
    queryKey: ['chamadas-pendentes-count', user?.id],
    enabled: !!user && !isImpersonating,
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      // Espelha a query da página /farmer/calls/pending-link (mesma definição de
      // "pendente": transcript salvo + sem customer_user_id). head:true = só conta.
      const { count, error } = await supabase
        .from('farmer_calls')
        .select('id', { count: 'exact', head: true })
        .eq('farmer_id', user!.id)
        .is('customer_user_id', null)
        .not('transcript', 'is', null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  if (isImpersonating || !count || count === 0) return null;

  return (
    <Card className="p-4 border-status-warning/40">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-status-warning" />
            <h2 className="text-sm font-semibold">
              {count === 1 ? '1 ligação sem cliente vinculado' : `${count} ligações sem cliente vinculado`}
            </h2>
          </div>
          <p className="text-2xs text-muted-foreground mt-1">
            Vincule a um cliente pra a ligação entrar no histórico dele.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/farmer/calls/pending-link">Vincular</Link>
        </Button>
      </div>
    </Card>
  );
}
