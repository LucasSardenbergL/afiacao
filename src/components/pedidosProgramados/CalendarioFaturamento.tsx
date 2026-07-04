import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import { usePedidosProgramadosCalendario } from '@/hooks/usePedidosProgramados';
import {
  agruparEnviosPorDia,
  dataLocalISO,
  gerarDiasDaGrade,
  type DiaAgregado,
  type StatusEnvio,
} from '@/lib/pedidosProgramados/calendario';

const DOT_CLS: Record<Exclude<StatusEnvio, 'cancelado'>, string> = {
  agendado: 'bg-status-info',
  enviado: 'bg-status-success',
  erro: 'bg-status-error',
};

const BADGE_CLS: Record<StatusEnvio, string> = {
  agendado: 'text-status-info',
  enviado: 'text-status-success',
  erro: 'text-status-error',
  cancelado: 'text-muted-foreground',
};

// Exibição de DATE: sempre via T12:00:00 (padrão do repo — evita shift de fuso)
const d12 = (data: string) => new Date(`${data}T12:00:00`);
const fmtMoeda = (v: number | null, opts?: Intl.NumberFormatOptions) =>
  v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', ...opts });
// Célula compacta: sem centavos. Painel: valor completo.
const fmtMoedaDia = (v: number | null) =>
  fmtMoeda(v, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const NOME_EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor' };

interface Props {
  mes: string; // 'YYYY-MM' já resolvido pela página
  onMudarMes: (mes: string) => void; // '' = voltar ao mês atual
}

export const CalendarioFaturamento = ({ mes, onMudarMes }: Props) => {
  const { data, isPending } = usePedidosProgramadosCalendario(mes);
  const [diaAberto, setDiaAberto] = useState<string | null>(null);

  const porDia = useMemo(() => agruparEnviosPorDia(data?.envios ?? []), [data?.envios]);
  const grade = useMemo(() => gerarDiasDaGrade(mes), [mes]);
  const hoje = dataLocalISO(new Date());

  const [ano, m] = mes.split('-').map(Number);
  const navegar = (delta: number) => {
    setDiaAberto(null); // Sheet de um mês não sobrevive à navegação para outro
    const alvo = new Date(ano, m - 1 + delta, 1);
    onMudarMes(dataLocalISO(alvo).slice(0, 7));
  };
  const tituloMes = format(new Date(ano, m - 1, 1), 'MMMM yyyy', { locale: ptBR });

  const diaSel: DiaAgregado | undefined = diaAberto ? porDia.get(diaAberto) : undefined;
  const mesVazio = !isPending && porDia.size === 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navegar(-1)} aria-label="Mês anterior">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium min-w-32 text-center capitalize">{tituloMes}</span>
        <Button variant="ghost" size="sm" onClick={() => navegar(1)} aria-label="Mês seguinte">
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onMudarMes('')}>Hoje</Button>
        <div className="ml-auto flex items-center gap-3">
          {(['agendado', 'enviado', 'erro'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('w-1.5 h-1.5 rounded-full', DOT_CLS[s])} />{s}
            </span>
          ))}
        </div>
      </div>

      {data?.truncado && (
        <p className="text-xs text-status-warning">
          Mês truncado em 1.000 envios pela capa do PostgREST — os totais abaixo podem estar incompletos.
        </p>
      )}

      <div className={cn('grid grid-cols-7 gap-1.5', isPending && porDia.size === 0 && 'opacity-60 animate-pulse')}>
        {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d) => (
          <div key={d} className="text-[11px] text-muted-foreground px-1.5 pb-0.5">{d}</div>
        ))}
        {grade.map((dia) => {
          const info = porDia.get(dia.data);
          const clicavel = !dia.foraDoMes && !!info && info.ativos > 0;
          const ehHoje = dia.data === hoje;
          return (
            <button
              key={dia.data}
              type="button"
              disabled={!clicavel}
              onClick={() => {
                setDiaAberto(dia.data);
                track('pedidos_programados.calendario_dia', { data: dia.data });
              }}
              aria-label={
                clicavel
                  ? `${format(d12(dia.data), "EEEE, d 'de' MMMM", { locale: ptBR })} — ${info!.ativos} envio(s), ${fmtMoedaDia(info!.totalValor)}${info!.temErro ? ', com erro' : ''}`
                  : format(d12(dia.data), "d 'de' MMMM", { locale: ptBR })
              }
              className={cn(
                'min-h-[76px] rounded-md border p-1.5 text-left flex flex-col gap-0.5 transition-colors',
                dia.foraDoMes && 'border-transparent',
                clicavel && 'hover:bg-accent/50 cursor-pointer',
                clicavel && info!.temErro && 'border-status-error/50 bg-status-error-bg',
              )}
            >
              <span className="flex items-center justify-between text-xs">
                <span
                  className={cn(
                    dia.foraDoMes ? 'text-muted-foreground/50' : 'text-muted-foreground',
                    ehHoje && 'bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 font-medium',
                  )}
                >
                  {dia.diaDoMes}
                </span>
                {clicavel && info!.temErro && (
                  <AlertTriangle className="w-3.5 h-3.5 text-status-error" aria-hidden="true" />
                )}
              </span>
              {clicavel && (
                <>
                  <span className="text-xs font-medium">
                    {info!.ativos} {info!.ativos === 1 ? 'envio' : 'envios'}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtMoedaDia(info!.totalValor)}
                  </span>
                  <span className="mt-auto flex gap-1">
                    {info!.statusPresentes.map((s) => (
                      <span
                        key={s}
                        className={cn('w-1.5 h-1.5 rounded-full', DOT_CLS[s as keyof typeof DOT_CLS])}
                      />
                    ))}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {mesVazio && (
        <p className="text-xs text-muted-foreground">Nenhum envio em {tituloMes}.</p>
      )}

      <Sheet open={!!diaAberto} onOpenChange={(open) => { if (!open) setDiaAberto(null); }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          {diaAberto && (
            <>
              <SheetHeader>
                <SheetTitle className="capitalize">
                  {format(d12(diaAberto), "EEEE, d 'de' MMMM", { locale: ptBR })}
                </SheetTitle>
                <SheetDescription>
                  {diaSel
                    ? `${diaSel.ativos} envio(s) · ${fmtMoeda(diaSel.totalValor)}`
                    : 'Sem envios neste dia.'}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3">
                {(diaSel?.envios ?? [])
                  .slice()
                  .sort((a, b) => (a.status === 'cancelado' ? 1 : 0) - (b.status === 'cancelado' ? 1 : 0))
                  .map((e) => (
                    <div key={e.id} className="border rounded-md px-3 py-2.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">PC {e.numero_pedido_compra ?? '—'}</span>
                        <Badge variant="outline" className={BADGE_CLS[e.status]}>{e.status}</Badge>
                        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
                          {e.semItens ? 'sem itens' : fmtMoeda(e.valor)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {e.itens.length} {e.itens.length === 1 ? 'item' : 'itens'}
                        {e.empresas.length > 0 &&
                          ` · vira ${e.empresas.length} pedido${e.empresas.length > 1 ? 's' : ''}: ${e.empresas.map((a) => NOME_EMPRESA[a]).join(', ')}`}
                        {!e.semItens && e.valor === null && ' · valor incompleto (item sem preço)'}
                      </div>
                      {e.erro_motivo && <p className="text-xs text-status-error">{e.erro_motivo}</p>}
                      <Link
                        to={`/sales/programados/${e.pedido_programado_id}`}
                        className="text-xs text-primary hover:underline inline-block"
                      >
                        Abrir pedido →
                      </Link>
                    </div>
                  ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};
