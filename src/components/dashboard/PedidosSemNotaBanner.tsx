import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { formatBRL } from '@/components/customer360/format';
import { usePedidosSemNota } from '@/hooks/dashboard/usePedidosSemNota';

/**
 * Aviso MEDIDO dos pedidos de venda que seguem sem nota no Omie há mais de 30 dias (último ano).
 *
 * Substituiu o "Dados de venda parciais" (2026-10-12), que afirmava cobertura parcial e números
 * SUBESTIMADOS — a medição contra o DRE mostrou o contrário: os pedidos cobrem a receita, e ~27% da
 * venda do último ano, nas duas empresas, é pedido aberto no Omie que nunca virou nota. Eles contam
 * como venda (positivação, ranking, crescimento). Decisão do founder: mostrar, não mudar a régua.
 * Diário: docs/historico/status-pedidos-colacor-congelado.md.
 *
 * Estados: carregando → nada; erro → diz que não mediu (nunca some calado); zero medido → nada.
 */
export function PedidosSemNotaBanner() {
  const { data, isLoading, isError } = usePedidosSemNota();

  if (isLoading) return null;
  if (isError || !data) {
    return (
      <Card className="p-3 border-status-warning/40 bg-status-warning-bg/40">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
          <div className="text-2xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-status-warning">Não consegui medir os pedidos sem nota no Omie.</span>{' '}
            Os números abaixo incluem pedidos ainda não faturados. Use como visão operacional,{' '}
            <span className="font-medium">não como base de comissão</span>.
          </div>
        </div>
      </Card>
    );
  }
  if (data.pedidos === 0) return null;

  const nome = (a: string) => COMPANIES[a as Company]?.shortName ?? a;
  return (
    <Card className="p-3 border-status-warning/40 bg-status-warning-bg/40">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
        <div className="text-2xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-status-warning">
            {formatBRL(data.receita)} em {data.pedidos} pedidos sem nota no Omie há mais de 30 dias.
          </span>{' '}
          São pedidos de venda do último ano que não foram faturados nem cancelados — e contam como venda
          nos números do app (positivação, ranking, crescimento).
          {data.porEmpresa.length > 1 && (
            <> {data.porEmpresa.map((e) => `${nome(e.account)}: ${formatBRL(e.receita)} (${e.pedidos})`).join(' · ')}.</>
          )}{' '}
          Use como visão operacional, <span className="font-medium">não como base de comissão</span>.
        </div>
      </div>
    </Card>
  );
}
