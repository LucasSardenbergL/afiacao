// Painel "Próximas visitas" — exibe visitas agendadas pendentes do vendedor com
// ações de 1 toque: Ir (Waze), Check-in e Cancelar. Resolve nomes e endereços
// internamente (não recebe props de dados externos).
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Calendar, MapPin, CheckCircle2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useVisitasAgendadas } from '@/hooks/useVisitasAgendadas';
import { deriveVisitaStatus } from '@/lib/visitas/visita-status';
import { navLink } from '@/lib/maps/nav-link';
import { hojeISO } from '@/lib/visitas/today';

export function ScheduledVisitsPanel() {
  const { proximas, cancelar, checkIn } = useVisitasAgendadas();

  const visits = proximas.data ?? [];
  const customerIds = [...new Set(visits.map((v) => v.customer_user_id))].sort();

  // Resolve nomes dos clientes
  const namesQuery = useQuery({
    queryKey: ['scheduled-visits-names', customerIds],
    enabled: customerIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, razao_social')
        .in('user_id', customerIds);
      if (error) throw new Error(error.message);
      const map: Record<string, string> = {};
      for (const p of data ?? []) {
        map[p.user_id] = p.razao_social || p.name;
      }
      return map;
    },
  });

  // Resolve endereços (best-effort para o botão "Ir")
  const addressesQuery = useQuery({
    queryKey: ['scheduled-visits-addresses', customerIds],
    enabled: customerIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('addresses')
        .select('user_id, street, number, city, state, is_default')
        .in('user_id', customerIds)
        .order('is_default', { ascending: false });
      if (error) throw new Error(error.message);

      const map: Record<string, string> = {};
      for (const addr of data ?? []) {
        // Mantém só o primeiro por user_id (ordenado por is_default desc → default vem primeiro)
        if (!map[addr.user_id]) {
          map[addr.user_id] = [addr.street, addr.number, addr.city, addr.state]
            .filter(Boolean)
            .join(', ');
        }
      }
      return map;
    },
  });

  // Enquanto carrega as visitas, não renderiza nada
  if (proximas.isLoading) return null;

  // Sem visitas pendentes: painel oculto
  if (visits.length === 0) return null;

  const nameMap = namesQuery.data ?? {};
  const addressMap = addressesQuery.data ?? {};
  const hoje = hojeISO();

  return (
    <Card>
      <CardHeader className="pb-2 pt-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Calendar className="w-4 h-4 text-primary" />
          Próximas visitas
          <Badge variant="secondary" className="ml-auto text-xs">
            {visits.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-2">
        {visits.map((visita) => {
          const statusDerivado = deriveVisitaStatus(visita.scheduled_date, visita.status, hoje);
          const isAtrasada = statusDerivado === 'atrasada';
          const nome = nameMap[visita.customer_user_id] ?? visita.customer_user_id;
          const endereco = addressMap[visita.customer_user_id] ?? null;
          const wazeHref = navLink(endereco);
          const isPending = checkIn.isPending && checkIn.variables?.customerUserId === visita.customer_user_id;

          return (
            <div
              key={visita.id}
              className="flex items-center gap-2 text-sm py-1 border-b last:border-b-0 border-border/50"
            >
              {/* Data */}
              <span className={`text-xs shrink-0 ${isAtrasada ? 'text-status-warning-bold font-semibold' : 'text-muted-foreground'}`}>
                {isAtrasada && 'Atrasada · '}
                {format(parseISO(visita.scheduled_date), "dd 'de' MMM", { locale: ptBR })}
              </span>

              {/* Nome */}
              <span className="flex-1 truncate font-medium text-foreground">
                {nome}
              </span>

              {/* Ações */}
              <div className="flex items-center gap-1 shrink-0">
                {/* Botão Ir (Waze) */}
                {wazeHref && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    asChild
                  >
                    <a href={wazeHref} target="_blank" rel="noreferrer" aria-label="Navegar no Waze">
                      <MapPin className="w-3.5 h-3.5" />
                    </a>
                  </Button>
                )}

                {/* Check-in */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-status-success-bold hover:text-status-success-bold"
                  disabled={isPending}
                  onClick={() => checkIn.mutate({ customerUserId: visita.customer_user_id })}
                  aria-label="Fazer check-in"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                </Button>

                {/* Cancelar */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  disabled={cancelar.isPending}
                  onClick={() => cancelar.mutate(visita.id)}
                  aria-label="Cancelar visita"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
