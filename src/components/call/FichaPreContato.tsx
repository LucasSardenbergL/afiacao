import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { useHistoricoCompras } from '@/hooks/useHistoricoCompras';
import { MunicaoResumo } from './MunicaoResumo';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

interface Props {
  customerUserId: string;
  name: string;
  cidade: string;
  children: React.ReactNode; // trigger
}

export function FichaPreContato({ customerUserId, name, cidade, children }: Props) {
  const [open, setOpen] = useState(false);
  // Lazy: só busca quando o drawer abre.
  const alvo = open ? customerUserId : null;
  const { municao } = useMunicaoLigacao(alvo);
  const { historico, loading } = useHistoricoCompras(alvo);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="w-[90vw] sm:max-w-md overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="truncate">{name}</SheetTitle>
          <p className="text-xs text-muted-foreground">{cidade}</p>
        </SheetHeader>

        <div className="mt-3 rounded-md bg-muted/40 px-3 py-2">
          <MunicaoResumo municao={municao} />
        </div>

        {loading ? (
          <div className="mt-4 space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : historico && (historico.topProdutos.length > 0 || historico.ultimosPedidos.length > 0) ? (
          <>
            {historico.topProdutos.length > 0 && (
              <section className="mt-4">
                <h3 className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Compra com frequência</h3>
                <ul className="space-y-1">
                  {historico.topProdutos.map((p) => (
                    <li key={p.codigo} className="flex items-center justify-between gap-2 text-sm border-b last:border-0 py-1">
                      <span className="truncate">{p.nome}</span>
                      <span className="font-tabular text-xs text-muted-foreground shrink-0">
                        {p.vezes}× · {brl(p.ultimoPreco)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {historico.ultimosPedidos.length > 0 && (
              <section className="mt-4">
                <h3 className="text-2xs uppercase tracking-wide text-muted-foreground mb-1">Últimos pedidos</h3>
                <ul className="space-y-1">
                  {historico.ultimosPedidos.map((p, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-sm font-tabular py-0.5">
                      <span>{dataBr(p.data)}</span>
                      <span>{brl(p.valor)} <span className="text-muted-foreground">({p.nItens} itens)</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Sem compras registradas para este cliente.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
