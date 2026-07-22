/**
 * 4 KPIs de visita no dashboard Closer (substituem os placeholders "—").
 * Read-only. Cada tile EXIBE sua definição no subtítulo (não mascara a métrica):
 *  - Conversão · 30d = fechados ÷ visitas com resultado (+ "N sem resultado").
 *  - Ticket médio · 30d = receita ÷ fechados COM valor (+ "M sem valor").
 * Janela 30d (pulso); o Mapa de Conversão fica 90d (distribuição) — ambos rotulados.
 * Definições validadas com codex (ver spec).
 */
import { Card } from '@/components/ui/card';
import { CalendarClock, MapPin, TrendingUp, Receipt, type LucideIcon } from 'lucide-react';
import { useKpisVisita } from '@/hooks/useKpisVisita';
import { useVisitasAgendadas } from '@/hooks/useVisitasAgendadas';
import { diasDesde } from '@/lib/visitas/recencia';
import { hojeISO } from '@/lib/visitas/today';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';

function Tile({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: string }) {
  return (
    <Card className="p-3 text-center text-xs text-muted-foreground">
      <Icon className="w-5 h-5 mx-auto mb-1 opacity-40" />
      {label}
      <div className="text-base font-medium text-foreground mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground/70 mt-0.5 leading-tight">{sub}</div>}
    </Card>
  );
}

function rotuloProxima(dateISO: string | undefined, hoje: string): { value: string; sub: string } {
  if (!dateISO) return { value: '—', sub: 'nenhuma agendada' };
  const n = diasDesde(dateISO, hoje); // hoje − data: futuro negativo, atrasada positivo
  const dm = `${dateISO.slice(8, 10)}/${dateISO.slice(5, 7)}`;
  if (n === 0) return { value: 'Hoje', sub: 'agendada' };
  if (n === -1) return { value: 'Amanhã', sub: 'agendada' };
  if (n != null && n > 0) return { value: dm, sub: `atrasada ${n}d` };
  return { value: dm, sub: 'agendada' };
}

export function VisitasKpiTiles() {
  const { data: kpis, isLoading } = useKpisVisita(30);
  const { proximas } = useVisitasAgendadas();

  const carregando = isLoading || proximas.isLoading;
  const dash = carregando ? '…' : '—';
  const lista = proximas.data ?? [];
  const prox = rotuloProxima(lista[0]?.scheduled_date, hojeISO());

  const conversao = carregando || !kpis ? dash : formatarFracaoPct(kpis.taxaConversao);
  const conversaoSub = kpis && kpis.semResultado > 0
    ? `fechados ÷ c/ resultado · ${kpis.semResultado} sem resultado`
    : 'fechados ÷ c/ resultado';

  const ticket = carregando || !kpis || kpis.ticketMedio == null ? dash : formatBRL(kpis.ticketMedio);
  const ticketSub = kpis && kpis.fechadosComValor > 0
    ? `${kpis.fechadosComValor} c/ valor${kpis.fechadosSemValor > 0 ? ` · ${kpis.fechadosSemValor} sem valor` : ''}`
    : 'nenhum fechado c/ valor';

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Tile icon={CalendarClock} label="Visitas pendentes" value={carregando ? dash : String(lista.length)} sub="agendadas" />
      <Tile icon={MapPin} label="Próxima visita" value={carregando ? dash : prox.value} sub={carregando ? undefined : prox.sub} />
      <Tile icon={TrendingUp} label="Conversão · 30d" value={conversao} sub={conversaoSub} />
      <Tile icon={Receipt} label="Ticket médio · 30d" value={ticket} sub={ticketSub} />
    </div>
  );
}
