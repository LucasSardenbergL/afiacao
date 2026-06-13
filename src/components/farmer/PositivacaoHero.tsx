import { useEffect, useRef } from 'react';
import { Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { track } from '@/lib/analytics';
import { pctNovos } from '@/lib/positivacao/format';
import type { PositivacaoKpis } from '@/hooks/useMyPositivacao';

function KpiCard({ label, value, sub, info }: { label: string; value: string; sub?: string; info?: string }) {
  return (
    <Card className="p-4">
      <div className="text-2xs text-muted-foreground flex items-center gap-1">
        {label}
        {info && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="inline-flex" aria-label="Mais informação sobre este indicador">
                <Info className="w-3 h-3 text-muted-foreground/70" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-2xs">{info}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="kpi-value text-2xl">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

export function PositivacaoHero({ kpis, isHunter }: { kpis: PositivacaoKpis; isHunter: boolean }) {
  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    track('carteira.positivacao_vista', {
      pct: kpis.pctPositivacao,
      positivados: kpis.positivados,
      total_eligible: kpis.totalEligible,
      a_positivar: kpis.aPositivar.length,
      is_hunter: isHunter,
    });
  }, [kpis, isHunter]);

  const ticket = `R$ ${kpis.ticketMedio.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
  const receita = `R$ ${kpis.receitaMtd.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

  // ── HUNTER (aquisição) ──────────────────────────────────────────────────────
  // Placar ENXUTO e honesto: só o que é de aquisição. Os cards de retenção
  // (recência), penetração (a-positivar/cobertura) e ticket misturado VAZAM de
  // farmer → não entram aqui (decisão Codex). A fila de caça é a ação do dia
  // (CacaConteudo no HunterDashboard), não um KPI. Ver
  // docs/superpowers/specs/2026-06-13-kpis-hunter-meu-dia-design.md.
  if (isHunter) {
    const partNovos = `${pctNovos(kpis.novosPositivados, kpis.positivados)}%`;
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard
          label="Novos na carteira (MTD)"
          value={String(kpis.novosPositivados)}
          sub="1ª compra neste mês"
          info="Proxy de aquisição: clientes ATUALMENTE atribuídos a você cuja 1ª compra (de toda a história) caiu neste mês. Pode mudar se a carteira for reatribuída — ainda não é base de comissão."
        />
        <KpiCard label="Receita da carteira (MTD)" value={receita} sub="faturamento total da sua carteira no mês" />
        <KpiCard label="Participação de novos" value={partNovos} sub="dos seus compradores do mês" />
      </div>
    );
  }

  // ── FARMER (retenção · penetração · expansão) ────────────────────────────────
  return (
    <div className="space-y-3">
      {/* Hero (3 KPIs principais) */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard label="Positivação MTD" value={`${kpis.pctPositivacao}%`} sub={`${kpis.positivados}/${kpis.totalEligible} da carteira`} />
        <KpiCard label="Receita MTD" value={receita} sub="faturamento da carteira no mês" />
        <KpiCard label="Clientes a positivar" value={String(kpis.aPositivar.length)} sub="sem pedido no mês" />
      </div>
      {/* Linha secundária (KPIs de apoio) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Cobertura de contato" value={`${kpis.pctCobertura}%`} sub="contatados no mês" />
        <KpiCard label="Recuperados (win-back)" value={String(kpis.novosPositivados)} sub="voltaram a comprar no mês" />
        <KpiCard label="Recência crítica" value={String(kpis.recenciaCritica)} sub="risco alto / atrasados" />
        <KpiCard label="Ticket médio MTD" value={ticket} sub="receita ÷ compradores no mês" />
      </div>
    </div>
  );
}
