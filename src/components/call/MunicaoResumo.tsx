import type { Municao } from '@/lib/call/municao';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resumo da munição (última compra + ticket médio). Conteúdo puro — o container aplica padding. */
export function MunicaoResumo({ municao }: { municao: Municao | null }) {
  if (!municao) return null;
  return (
    <div className="text-xs text-muted-foreground space-y-0.5">
      {municao.ultimaCompra ? (
        <div>
          Última compra:{' '}
          <span className="text-foreground font-medium">{brl(municao.ultimaCompra.valor)}</span>
          {municao.diasDesdeUltima != null && <> · há {municao.diasDesdeUltima}d</>}
        </div>
      ) : (
        <div>Sem compras anteriores registradas.</div>
      )}
      {municao.ticketMedio != null && <div>Ticket médio: {brl(municao.ticketMedio)}</div>}
    </div>
  );
}
