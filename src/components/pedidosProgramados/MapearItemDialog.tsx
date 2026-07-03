import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useBuscaProdutoMapeamento, type ProdutoMapeado } from '@/hooks/usePedidosProgramados';

export function MapearItemDialog(props: {
  children: React.ReactNode;
  codigoItemCliente: string;
  descricaoCliente: string;
  codForn: string | null;
  onEscolher: (p: ProdutoMapeado) => void;
}) {
  const [open, setOpen] = useState(false);
  const [termo, setTermo] = useState('');
  const { data } = useBuscaProdutoMapeamento(open ? termo : '', open ? props.codForn : null);

  const Linha = ({ p, sugestao }: { p: ProdutoMapeado; sugestao?: boolean }) => (
    <button
      type="button"
      className="w-full text-left px-3 py-2 rounded-md hover:bg-accent/60 flex items-center gap-3"
      onClick={() => { props.onEscolher(p); setOpen(false); }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{p.descricao}</div>
        <div className="text-xs text-muted-foreground">{p.codigo} · {p.unidade ?? 'UN'}</div>
      </div>
      {sugestao && <Badge variant="outline" className="text-status-info shrink-0">COD.FORN bate</Badge>}
      <Badge variant="outline" className="shrink-0">{p.account === 'oben' ? 'Oben' : 'Colacor'}</Badge>
      {p.ativo === false && <Badge variant="outline" className="text-status-error shrink-0">inativo</Badge>}
    </button>
  );

  const sugestoes = data?.sugestoes ?? [];
  const busca = (data?.busca ?? []).filter((p) => !sugestoes.some((s) => s.id === p.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{props.children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Mapear item da Lider</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {props.codigoItemCliente} — {props.descricaoCliente}
            {props.codForn ? ` · COD.FORN ${props.codForn}` : ''}
          </p>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="Buscar por código ou descrição…"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
        />
        <div className="max-h-72 overflow-y-auto space-y-1">
          {sugestoes.map((p) => <Linha key={`s-${p.id}`} p={p} sugestao />)}
          {busca.map((p) => <Linha key={p.id} p={p} />)}
          {termo.length >= 2 && sugestoes.length === 0 && busca.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">Nada encontrado.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
