import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { CalendarClock, CalendarDays, ChevronLeft, FileUp, List, Loader2, Settings2 } from 'lucide-react';
import { usePedidosProgramadosLista, usePedidosProgramadosMutations } from '@/hooks/usePedidosProgramados';
import { PedidosProgramadosConfigDialog } from '@/components/pedidosProgramados/ConfigDialog';
import { CalendarioFaturamento } from '@/components/pedidosProgramados/CalendarioFaturamento';
import { dataLocalISO } from '@/lib/pedidosProgramados/calendario';
import { useUrlState } from '@/hooks/useUrlState';
import { track } from '@/lib/analytics';

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  extraindo: { label: 'Extraindo…', cls: 'text-status-info' },
  erro_extracao: { label: 'Erro na extração', cls: 'text-status-error' },
  ativo: { label: 'Ativo', cls: 'text-status-success' },
  concluido: { label: 'Concluído', cls: 'text-muted-foreground' },
  cancelado: { label: 'Cancelado', cls: 'text-muted-foreground' },
};

const fmtData = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '—');

const PedidosProgramados = () => {
  const navigate = useNavigate();
  const { data: pedidos, isPending } = usePedidosProgramadosLista();
  const { uploadPdf } = usePedidosProgramadosMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [urlState, setUrlState] = useUrlState({ view: 'lista', mes: '' });
  const view = urlState.view === 'calendario' ? 'calendario' : 'lista';
  const mesResolvido = urlState.mes || dataLocalISO(new Date()).slice(0, 7);

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/sales')}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Voltar"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Pedidos programados</h1>
          <p className="text-xs text-muted-foreground">PDF da Lider → envios agendados ao Omie</p>
        </div>
        <div className="flex items-center border rounded-md p-0.5 gap-0.5" role="group" aria-label="Modo de visualização">
          <Button
            variant={view === 'lista' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setUrlState({ view: 'lista' })}
            aria-pressed={view === 'lista'}
          >
            <List className="w-4 h-4 mr-1" />Lista
          </Button>
          <Button
            variant={view === 'calendario' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => { setUrlState({ view: 'calendario' }); track('pedidos_programados.ver_calendario'); }}
            aria-pressed={view === 'calendario'}
          >
            <CalendarDays className="w-4 h-4 mr-1" />Calendário
          </Button>
        </div>
        <PedidosProgramadosConfigDialog>
          <Button variant="outline" size="sm"><Settings2 className="w-4 h-4 mr-1" />Config</Button>
        </PedidosProgramadosConfigDialog>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadPdf.mutate(f, { onSuccess: ({ headerId }) => navigate(`/sales/programados/${headerId}`) });
            e.target.value = '';
          }}
        />
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploadPdf.isPending}>
          {uploadPdf.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FileUp className="w-4 h-4 mr-1" />}
          Subir PDF
        </Button>
      </div>

      {view === 'calendario' ? (
        <CalendarioFaturamento
          mes={mesResolvido}
          onMudarMes={(mes) => setUrlState({ mes })}
        />
      ) : isPending ? (
        <div className="flex items-center justify-center pt-24">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : !pedidos || pedidos.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Nenhum pedido programado"
          description="Suba o PDF do pedido de compra da Lider pra começar."
          actionLabel="Subir PDF"
          onAction={() => fileRef.current?.click()}
        />
      ) : (
        <div className="space-y-2">
          {pedidos.map((p) => {
            const st = STATUS_LABEL[p.status] ?? STATUS_LABEL.ativo;
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => navigate(`/sales/programados/${p.id}`)}
                className="w-full text-left border rounded-md px-4 py-3 hover:bg-accent/50 transition-colors flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    PC {p.numero_pedido_compra ?? '—'}{p.versao ? ` · v${p.versao}` : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Emissão {fmtData(p.data_emissao_cliente)} · upload {new Date(p.created_at).toLocaleDateString('pt-BR')}
                  </div>
                  {p.erro_motivo && <div className="text-xs text-status-error mt-1 truncate">{p.erro_motivo}</div>}
                </div>
                <Badge variant="outline" className={st.cls}>{st.label}</Badge>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PedidosProgramados;
