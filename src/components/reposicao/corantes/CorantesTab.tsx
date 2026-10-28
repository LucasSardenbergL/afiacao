import { useEffect, useRef } from 'react';
import { Droplets } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { useGiroCorantes } from './useGiroCorantes';
import { CorantesTable } from './CorantesTable';

/**
 * Aba "Corantes" do baixo giro (OBEN) — giro de corante Fase 1, ADVISORY: a aba não escreve e o
 * motor de compra não muda. A ação é manual, pelos controles que já existem.
 */
export function CorantesTab() {
  const { linhas, query } = useGiroCorantes();
  const estado = estadoDeLeitura(query);

  // Sensor de uso no LEDGER (o PostHog é bloqueado no Chrome do founder): uma vez por montagem e
  // só com a leitura PRONTA — aba que falhou não conta como uso. A RPC deduplica por titular/dia.
  const registrou = useRef(false);
  useEffect(() => {
    if (estado !== 'pronta' || registrou.current) return;
    registrou.current = true;
    void registrarNoLedger('reposicao.corantes_aberta', 'OBEN');
  }, [estado]);

  if (naoConsegui(estado)) return <AvisoLeituraFalhou oque="o giro dos corantes" estado={estado} />;
  if (estado !== 'pronta' || linhas === undefined) return <PageSkeleton variant="list" />;
  if (linhas.length === 0) {
    return (
      <EmptyState
        tone="operational"
        icon={Droplets}
        title="Sem dado de cobertura"
        description="O conector ainda não enviou as dosagens da máquina. A recomendação aparece quando houver cobertura."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <strong>OBEN</strong> · consumo medido nas dosagens da máquina tintométrica, por WP. <strong>Sugestão</strong>: o pedido automático
        não muda.
      </p>
      <CorantesTable linhas={linhas} />
      <p className="text-xs text-muted-foreground">
        Para agir: ajuste pelo &quot;Manter em estoque&quot; da aba Baixo giro ou pelo mínimo forçado do SKU. &quot;—&quot;
        é dado ausente, nunca zero.
      </p>
    </div>
  );
}
