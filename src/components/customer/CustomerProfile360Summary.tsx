import { useCustomerCalls } from '@/hooks/useCustomerCalls';
import { aggregateCustomerProfile } from '@/lib/call-session/aggregate-customer-profile';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Phone, TrendingUp, Wallet, Clock, AlertTriangle, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

/**
 * Resumo 360 do cliente a partir das chamadas gravadas (`farmer_calls` com transcript).
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md), pela porta do
 * IRMÃO: `const { data } = useCustomerCalls(...)` sem ler `error`, `data ?? []` degradando
 * a ausência para vazio e `totalCalls === 0` apagando o bloco. Numa ficha de cliente isso
 * é caro por afirmação: quem abre o 360 e não vê o resumo conclui que NUNCA se falou com
 * aquele cliente — e decide a abordagem por aí. `farmer_calls` tem 0 linhas hoje (psql-ro,
 * 2026-08-23); o gatilho é a primeira chamada com transcript.
 */
export function CustomerProfile360Summary({ customerId }: { customerId: string }) {
  const q = useCustomerCalls(customerId);
  const { data } = q;
  const estado = estadoDeLeitura(q);

  // Sem NADA em mãos: avisa em vez de afirmar "nunca falamos com este cliente".
  if (naoConsegui(estado) && !data) {
    return (
      <Card className="p-3">
        <AvisoLeituraFalhou oque="o histórico de chamadas deste cliente" estado={estado} className="mb-0" />
      </Card>
    );
  }
  const velho = desatualizado(q, Boolean(data));

  // Ausência VERIFICADA: os estados sem leitura saíram acima.
  const profile = aggregateCustomerProfile(data ?? []);
  if (profile.totalCalls === 0) return null;

  return (
    <Card className="p-3 space-y-3">
      {velho && <AvisoLeituraFalhou oque="a leitura mais recente" estado={velho} className="mb-0" />}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI icon={Phone} label="Chamadas" value={profile.totalCalls.toString()} sub={profile.lastCallAt ? `Última ${formatDistanceToNow(new Date(profile.lastCallAt), { locale: ptBR, addSuffix: true })}` : ''} />
        <KPI icon={Clock} label="Duração total" value={`${Math.floor(profile.totalDurationSeconds / 60)}min`} />
        <KPI icon={Wallet} label="Receita acumulada" value={`R$ ${profile.totalRevenue.toLocaleString('pt-BR')}`} sub={profile.totalMargin > 0 ? `Margem R$ ${profile.totalMargin.toLocaleString('pt-BR')}` : ''} />
        <KPI icon={TrendingUp} label="Ticket médio" value={profile.avgTicket > 0 ? `R$ ${Math.round(profile.avgTicket).toLocaleString('pt-BR')}` : '—'} />
      </div>

      {profile.competitorsMentioned.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Building2 className="w-3 h-3"/>Concorrentes citados pelo cliente
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.competitorsMentioned.map(c => (
              <Badge key={c.value} variant="outline" className="text-2xs">
                {c.value} <span className="ml-1 opacity-60">×{c.totalOccurrences}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {profile.topObjections.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3"/>Objeções recorrentes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.topObjections.map(o => (
              <Badge key={o.type} variant="outline" className="text-2xs" title={o.exampleNote}>
                {o.type.replace(/_/g, ' ')} <span className="ml-1 opacity-60">×{o.count}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function KPI({ icon: Icon, label, value, sub }: { icon: typeof Phone; label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="text-base font-medium tabular-nums">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
