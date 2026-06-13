import { Card } from '@/components/ui/card';
import { Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useKpisVisitaMtd } from '@/hooks/useKpisVisitaMtd';
import { formatBRL } from '@/components/customer360/format';

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

/**
 * Placar do mês do CLOSER (output, MTD) — o norte do dashboard de visitas.
 *
 * ⚠️ "Valor informado" = `revenue_generated` que o vendedor digita ao registrar a
 * visita; NÃO é conciliado com o ERP → não é receita reconhecida nem base de comissão
 * (decisão Codex; ver docs/superpowers/specs/2026-06-13-kpis-closer-meu-dia-design.md).
 * A qualidade do dado é exposta (fechamentos sem valor, visitas sem resultado) pra não
 * mascarar subnotificação. Self-hide quando não há visita no mês.
 */
export function ClosersMtdHero() {
  const { data: k, isLoading } = useKpisVisitaMtd();
  if (isLoading || !k || k.totalVisitas === 0) return null; // self-hide

  const qualidade: string[] = [];
  if (k.fechadosSemValor > 0) qualidade.push(`${k.fechadosSemValor} fechamento${k.fechadosSemValor > 1 ? 's' : ''} sem valor`);
  if (k.semResultado > 0) qualidade.push(`${k.semResultado} visita${k.semResultado > 1 ? 's' : ''} sem resultado`);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard
          label="Valor informado (mês)"
          value={formatBRL(k.receitaTotal)}
          sub="pedidos fechados em visita"
          info="Valor INFORMADO pelo vendedor ao registrar a visita — não conciliado com o ERP. Não é receita reconhecida nem base de comissão."
        />
        <KpiCard label="Fechamentos (mês)" value={String(k.fechados)} sub="visitas que viraram pedido" />
        <KpiCard label="Visitas registradas (mês)" value={String(k.totalVisitas)} sub="atividade do mês" />
      </div>
      {qualidade.length > 0 && (
        <p className="text-2xs text-muted-foreground">Qualidade do dado: {qualidade.join(' · ')}.</p>
      )}
    </div>
  );
}
