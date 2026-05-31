import { useMemo, useState } from 'react';
import { MessageSquareText, ChevronDown, ChevronUp } from 'lucide-react';
import { useRouteContactList } from '@/queries/useRouteContactList';
import type { RouteContactItem } from '@/queries/useRouteContactList';
import { usePropostaPreview } from '@/queries/usePropostaPreview';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }

function PropostaRow({ cliente }: { cliente: RouteContactItem }) {
  const [aberto, setAberto] = useState(false);
  const { data, isLoading } = usePropostaPreview(cliente.customerUserId, { enabled: aberto });

  return (
    <Card className="p-3">
      <button type="button" onClick={() => setAberto(a => !a)} className="flex items-center gap-2 w-full text-left">
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{cliente.name}</div>
          <div className="text-xs text-muted-foreground font-tabular">{cliente.cityKey.city}</div>
        </div>
        <span className="kpi-value text-sm w-24 text-right">R$ {Math.round(cliente.valorDaLigacao)}</span>
        {aberto ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {aberto && (
        <div className="mt-3 border-t pt-3">
          {isLoading && <div className="text-xs text-muted-foreground">Gerando proposta…</div>}
          {!isLoading && data && (
            data.proposta.vazia ? (
              <div className="text-xs text-muted-foreground">
                {data.semHistorico ? 'Sem histórico de pedidos recentes.' : 'Sem cesta de recompra confiável (histórico fino ou só SKUs inativos).'}
              </div>
            ) : (
              <>
                <pre className="whitespace-pre-wrap text-sm bg-muted/40 rounded-md p-3 font-sans">{data.proposta.texto}</pre>
                <div className="flex flex-wrap gap-2 mt-2 text-[11px] text-muted-foreground">
                  <Badge variant="secondary">{data.proposta.itensPrincipais} itens principais</Badge>
                  {data.removidosInativos > 0 && <Badge variant="outline">{data.removidosInativos} SKU inativo oculto</Badge>}
                  <span>conta: {data.account}</span>
                  <span>· {data.totalPedidos} pedidos</span>
                </div>
                {data.statusesVistos.length > 0 && (
                  <div className="text-[11px] text-muted-foreground mt-1">status no histórico: {data.statusesVistos.join(', ')}</div>
                )}
              </>
            )
          )}
        </div>
      )}
    </Card>
  );
}

export default function RotaPropostas() {
  const workday = useMemo(() => todayIso(), []);
  const { data, isLoading } = useRouteContactList(workday);

  if (isLoading) return <PageSkeleton variant="list" />;

  const fila = data?.whatsappQueue ?? [];
  const cidadesLabel = data?.cidades?.length ? data.cidades.join(', ') : null;

  return (
    <div className="p-4 space-y-4">
      <header>
        <h1 className="font-display text-2xl">Preview das propostas (WhatsApp)</h1>
        <p className="text-sm text-muted-foreground">
          {data?.dailyOnly ? 'Motor diário (Divinópolis + Carmo do Cajuru)' : cidadesLabel ? `Rota de amanhã — ${cidadesLabel}` : 'Sem rota para amanhã'}
          {' · '}o que a IA proporia (gerado do histórico — phone-free; envio só no PR2b-send)
        </p>
      </header>

      {fila.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          tone="operational"
          title="Nenhum cliente na fila de WhatsApp"
          description="A fila de proposta (accept-a-proposal) vem dos clientes com recompra previsível nas cidades de amanhã."
        />
      ) : (
        <div className="space-y-2">
          {fila.map(c => <PropostaRow key={c.customerUserId} cliente={c} />)}
        </div>
      )}
    </div>
  );
}
