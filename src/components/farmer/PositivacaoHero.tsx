import { Card } from '@/components/ui/card';
import type { PositivacaoKpis } from '@/hooks/useMyPositivacao';

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

export function PositivacaoHero({ kpis, isHunter }: { kpis: PositivacaoKpis; isHunter: boolean }) {
  const ticket = `R$ ${kpis.ticketMedio.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
  return (
    <div className="space-y-3">
      {/* Hero (3 KPIs principais por papel) */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {isHunter ? (
          <>
            <KpiCard label="Novos clientes positivados" value={String(kpis.novosPositivados)} sub="1ª compra no mês" />
            <KpiCard label="Clientes a positivar" value={String(kpis.aPositivar.length)} sub="pool sem pedido no mês" />
            <KpiCard label="Recência crítica" value={String(kpis.recenciaCritica)} sub="risco alto / atrasados" />
          </>
        ) : (
          <>
            <KpiCard label="Positivação MTD" value={`${kpis.pctPositivacao}%`} sub={`${kpis.positivados}/${kpis.totalEligible} da carteira`} />
            <KpiCard label="Clientes a positivar" value={String(kpis.aPositivar.length)} sub="sem pedido no mês" />
            <KpiCard label="Cobertura de contato" value={`${kpis.pctCobertura}%`} sub="contatados no mês" />
          </>
        )}
      </div>
      {/* Linha secundária (KPIs de apoio) */}
      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Ticket médio MTD" value={ticket} sub="receita ÷ compradores no mês" />
        {isHunter ? (
          <KpiCard label="Cobertura de contato" value={`${kpis.pctCobertura}%`} sub="contatados no mês" />
        ) : (
          <KpiCard label="Recência crítica" value={String(kpis.recenciaCritica)} sub="risco alto / atrasados" />
        )}
      </div>
    </div>
  );
}
