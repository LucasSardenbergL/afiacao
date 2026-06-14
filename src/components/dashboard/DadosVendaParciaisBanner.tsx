import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';

/**
 * Aviso de dados de venda parciais.
 *
 * Os números de venda/positivação destes dashboards vêm de `sales_orders`/`order_items`,
 * que hoje cobrem só uma fração do faturamento real (o `sync_pedidos` roda em janela
 * rolante curta, sem backfill histórico — gap mapeado no CLAUDE.md / sessão push-vendedora
 * e confirmado pelo spec de OTE). Logo, receita, positivação, novos clientes e ticket
 * aparecem SUBESTIMADOS até o backfill concluir.
 *
 * Honestidade > precisão falsa: o banner avisa que é visão operacional, NÃO base de
 * comissão (a remuneração é definida pelo spec vigente de OTE, sobre dado reconciliado).
 * NÃO fixa o "%" de cobertura (envelhece) — é qualitativo e reversível: quando o backfill
 * rodar e houver uma métrica de cobertura, remover/condicionar este componente.
 */
export function DadosVendaParciaisBanner() {
  return (
    <Card className="p-3 border-status-warning/40 bg-status-warning-bg/40">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
        <div className="text-2xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-status-warning">Dados de venda parciais.</span>{' '}
          Os números de venda e positivação consideram apenas pedidos já sincronizados no app,
          que ainda não cobrem todo o faturamento (backfill pendente) — então aparecem
          subestimados. Use como visão operacional, <span className="font-medium">não como base de comissão</span>.
        </div>
      </div>
    </Card>
  );
}
