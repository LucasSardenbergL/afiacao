import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ChevronLeft, Send, Trash2, XCircle } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { toast } from 'sonner';
import {
  usePedidoProgramadoDetalhe,
  usePedidosProgramadosMutations,
  type PedidoProgramadoItem,
} from '@/hooks/usePedidosProgramados';
import { MapearItemDialog } from '@/components/pedidosProgramados/MapearItemDialog';

const fmtData = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '—');
const fmtMoeda = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const ENVIO_STATUS_CLS: Record<string, string> = {
  agendado: 'text-status-info',
  // claim do edge em voo: sem botões de ação (a condição de render já cobre — só
  // agendado/erro têm "Enviar agora"/"Cancelar")
  processando: 'text-status-warning',
  enviado: 'text-status-success',
  erro: 'text-status-error',
  cancelado: 'text-muted-foreground',
};

const PedidoProgramadoDetalhe = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isPending } = usePedidoProgramadoDetalhe(id);
  const { atualizarItem, mapearItem, criarEnvio, cancelarEnvio, cancelarPedido, enviarAgora } = usePedidosProgramadosMutations(id);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [dataEnvio, setDataEnvio] = useState('');

  const pendentes = useMemo(() => (data?.itens ?? []).filter((i) => !i.envio_id), [data?.itens]);
  const itensSelecionados = pendentes.filter((i) => selecionados.has(i.id));
  const selecaoResolvida =
    itensSelecionados.length > 0 &&
    itensSelecionados.every(
      (i) => i.mapa?.omie_products && typeof i.preco_final === 'number' && i.preco_final > 0,
    );

  if (isPending || !data) {
    return (
      <PageSkeleton variant="detail" />
    );
  }
  const { pedido, itens, envios } = data;

  const alternarSelecao = (itemId: string) => (checked: boolean | string) => {
    setSelecionados((prev) => {
      const s = new Set(prev);
      if (checked) s.add(itemId); else s.delete(itemId);
      return s;
    });
  };

  const agendar = () => {
    if (!dataEnvio) { toast.error('Escolha a data de envio.'); return; }
    criarEnvio.mutate(
      { itens: itensSelecionados, dataEnvio },
      { onSuccess: () => { setSelecionados(new Set()); setDataEnvio(''); } },
    );
  };

  const LinhaItem = ({ it }: { it: PedidoProgramadoItem }) => {
    const prod = it.mapa?.omie_products ?? null;
    return (
      <div className="grid grid-cols-[auto_90px_1fr_1fr_90px_120px] gap-3 items-center border rounded-md px-3 py-2">
        <Checkbox
          checked={selecionados.has(it.id)}
          onCheckedChange={alternarSelecao(it.id)}
          aria-label={`Selecionar ${it.codigo_item_cliente}`}
        />
        <div className="text-xs">
          <div className="text-muted-foreground">entrega</div>
          <div>{fmtData(it.data_entrega_cliente)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-sm truncate">{it.descricao_cliente}</div>
          <div className="text-xs text-muted-foreground truncate">
            {it.codigo_item_cliente}
            {it.num_ordem_cliente ? ` · ord ${it.num_ordem_cliente}` : ''}
            {it.cod_forn ? ` · COD.FORN ${it.cod_forn}` : ''}
          </div>
        </div>
        <div className="min-w-0">
          {prod ? (
            <>
              <div className="text-sm truncate">{prod.descricao}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                {prod.codigo}
                <Badge variant="outline" className="text-[10px] py-0">
                  {prod.account === 'oben' ? 'Oben' : 'Colacor'}
                </Badge>
                {prod.ativo === false && (
                  <Badge variant="outline" className="text-[10px] py-0 text-status-error">inativo</Badge>
                )}
              </div>
            </>
          ) : (
            <MapearItemDialog
              codigoItemCliente={it.codigo_item_cliente}
              descricaoCliente={it.descricao_cliente}
              codForn={it.cod_forn}
              onEscolher={(p) =>
                mapearItem.mutate({
                  clienteRef: pedido.cliente_ref,
                  codigoItemCliente: it.codigo_item_cliente,
                  omieProductId: p.id,
                })
              }
            >
              <Button variant="outline" size="sm" className="text-status-warning">Mapear</Button>
            </MapearItemDialog>
          )}
        </div>
        <Input
          type="number"
          step="0.001"
          min="0"
          className="h-8 text-sm"
          defaultValue={it.quantidade}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0 && v !== it.quantidade) {
              atualizarItem.mutate({ id: it.id, quantidade: v });
            }
          }}
          aria-label="Quantidade"
        />
        <div>
          <Input
            type="number"
            step="0.01"
            min="0"
            className="h-8 text-sm"
            placeholder="preço"
            defaultValue={it.preco_final ?? ''}
            onBlur={(e) => {
              const raw = e.target.value;
              const v = raw === '' ? null : Number(raw);
              if ((v === null || (Number.isFinite(v) && v > 0)) && v !== it.preco_final) {
                atualizarItem.mutate({ id: it.id, preco_final: v });
              }
            }}
            aria-label="Preço final"
          />
          {/* Referência sempre visível (o preço do PDF "sempre vem errado" — spec) */}
          <div className="text-[10px] text-muted-foreground mt-0.5 text-right">
            PDF: {fmtMoeda(it.preco_pdf)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-24">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/sales/programados')}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Voltar"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">
            PC {pedido.numero_pedido_compra ?? '—'}{pedido.versao ? ` · v${pedido.versao}` : ''}
          </h1>
          <p className="text-xs text-muted-foreground">
            Emissão {fmtData(pedido.data_emissao_cliente)} · {itens.length} itens · {pendentes.length} pendentes
          </p>
        </div>
        <Badge variant="outline">{pedido.status}</Badge>
        {(pedido.status === 'ativo' || pedido.status === 'erro_extracao') && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-status-error">
                <Trash2 className="w-3.5 h-3.5 mr-1" />Cancelar pedido
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancelar este pedido programado?</AlertDialogTitle>
                <AlertDialogDescription>
                  Uso típico: chegou uma REVISÃO do PC (VERSAO nova) e este ficou obsoleto.
                  Envios apenas agendados serão cancelados junto; envio já enviado ou com erro
                  bloqueia o cancelamento (resolva-o antes).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Voltar</AlertDialogCancel>
                <AlertDialogAction onClick={() => cancelarPedido.mutate()}>
                  Cancelar pedido
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Pool de itens pendentes (cada um com a data de entrega do cliente) */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Itens pendentes</h2>
        {pendentes.length === 0
          ? <p className="text-xs text-muted-foreground">Todos os itens já estão em envios.</p>
          : pendentes.map((it) => <LinhaItem key={it.id} it={it} />)}
      </section>

      {/* Envios */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Envios</h2>
        {envios.length === 0 && <p className="text-xs text-muted-foreground">Nenhum envio criado ainda.</p>}
        {envios.map((e) => {
          const itensDoEnvio = itens.filter((i) => i.envio_id === e.id);
          return (
            <div key={e.id} className="border rounded-md px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 text-sm">
                  Envio em <strong>{fmtData(e.data_envio)}</strong> · {itensDoEnvio.length} itens
                </div>
                <Badge variant="outline" className={ENVIO_STATUS_CLS[e.status]}>{e.status}</Badge>
                {(e.status === 'agendado' || e.status === 'erro') && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => enviarAgora.mutate(e.id)}
                      disabled={enviarAgora.isPending}
                    >
                      <Send className="w-3.5 h-3.5 mr-1" />Enviar agora
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => cancelarEnvio.mutate(e.id)}>
                      <XCircle className="w-3.5 h-3.5 mr-1" />Cancelar
                    </Button>
                  </>
                )}
              </div>
              {e.erro_motivo && <p className="text-xs text-status-error">{e.erro_motivo}</p>}
              <div className="text-xs text-muted-foreground truncate">
                {itensDoEnvio.map((i) => i.mapa?.omie_products?.descricao ?? i.descricao_cliente).join(' · ')}
              </div>
            </div>
          );
        })}
      </section>

      {/* Barra de agendamento */}
      {itensSelecionados.length > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-background border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 z-40">
          <span className="text-sm">{itensSelecionados.length} selecionado(s)</span>
          <Input
            type="date"
            className="h-9 w-40"
            value={dataEnvio}
            onChange={(e) => setDataEnvio(e.target.value)}
            aria-label="Data de envio ao Omie"
          />
          <Button size="sm" onClick={agendar} disabled={!selecaoResolvida || !dataEnvio || criarEnvio.isPending}>
            Criar envio
          </Button>
          {!selecaoResolvida && <span className="text-xs text-status-warning">há item sem mapeamento/preço</span>}
        </div>
      )}
    </div>
  );
};

export default PedidoProgramadoDetalhe;
