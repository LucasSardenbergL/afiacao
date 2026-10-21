import type { Municao } from '@/lib/venda-cliente/municao';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Resumo da munição (última compra + ticket médio). Conteúdo puro — o container aplica padding.
 * `erro` = leitura falhou: diz isso, em vez de sumir calado ou afirmar "sem compras".
 */
export function MunicaoResumo({ municao, erro = false }: { municao: Municao | null; erro?: boolean }) {
  if (erro) return <div className="text-xs text-status-warning">Não consegui ler as compras deste cliente agora.</div>;
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
