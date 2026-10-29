import { useState } from 'react';
import { Check, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import {
  comFavorito, gravarFavoritos, lerFavoritos, mesmosFiltros, MAX_FAVORITOS, type FavoritoRadar, type FiltrosSalvos,
} from '@/lib/radar/favoritos';

function obterStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * Favoritos de filtro NOMEADOS ("Moveleiro em Nova Serrana", "Marmorarias SP") por usuário, no
 * localStorage, sobre os filtros que já vivem na URL. Aplicar = trocar os filtros da URL de uma vez.
 * Identidade = `useAuth()` real (preferência de quem está no teclado, não da lente "Ver como").
 */
export function RadarFavoritos({
  atuais,
  padrao,
  onAplicar,
}: {
  atuais: FiltrosSalvos;
  padrao: FiltrosSalvos;
  onAplicar: (f: FiltrosSalvos) => void;
}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [lista, setLista] = useState<FavoritoRadar[]>(() => (userId ? lerFavoritos(obterStorage(), userId, padrao) : []));
  const [donoLido, setDonoLido] = useState(userId);
  const [salvando, setSalvando] = useState(false);
  const [nome, setNome] = useState('');

  // Troca de usuário na mesma montagem (logout/login): relê a lista do novo dono.
  if (donoLido !== userId) {
    setDonoLido(userId);
    setLista(userId ? lerFavoritos(obterStorage(), userId, padrao) : []);
  }

  const persistir = (nova: FavoritoRadar[]) => {
    if (!userId) return false;
    if (!gravarFavoritos(obterStorage(), userId, nova)) {
      toast.error('Não consegui salvar os favoritos neste navegador (armazenamento bloqueado ou cheio).');
      return false;
    }
    setLista(nova);
    return true;
  };

  const salvar = () => {
    const n = nome.trim();
    if (!n) return;
    const substituiu = lista.some((f) => f.nome.toLowerCase() === n.toLowerCase());
    if (persistir(comFavorito(lista, n, atuais))) {
      track('radar.favorito_salvo', { total: Math.min(lista.length + (substituiu ? 0 : 1), MAX_FAVORITOS), substituiu });
      toast.success(`Favorito "${n}" salvo`);
      setSalvando(false);
      setNome('');
    }
  };

  const aplicar = (f: FavoritoRadar) => {
    track('radar.favorito_aplicado', { total: lista.length });
    onAplicar(f.filtros);
  };

  const remover = (f: FavoritoRadar) => {
    if (persistir(lista.filter((x) => x.nome !== f.nome))) track('radar.favorito_removido', { total: lista.length - 1 });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={!userId} data-testid="radar-favoritos">
            <Star className="w-4 h-4 mr-1" />
            Favoritos{lista.length > 0 ? ` (${lista.length})` : ''}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
            {lista.length === 0 ? 'Nenhum favorito ainda' : 'Aplicar filtros salvos'}
          </DropdownMenuLabel>
          {lista.map((f) => (
            <DropdownMenuItem key={f.nome} onSelect={() => aplicar(f)} className="gap-2">
              <Check className={mesmosFiltros(f.filtros, atuais) ? 'w-4 h-4' : 'w-4 h-4 invisible'} />
              <span className="flex-1 truncate">{f.nome}</span>
              <button
                type="button"
                aria-label={`Remover favorito ${f.nome}`}
                className="text-muted-foreground hover:text-status-error"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); remover(f); }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { setNome(''); setSalvando(true); }}>Salvar filtros atuais…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={salvando} onOpenChange={setSalvando}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Salvar filtros como favorito</DialogTitle>
            <DialogDescription>Fica neste navegador, só para você. Mesmo nome substitui.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); salvar(); }}>
            <Input autoFocus value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Moveleiro em Nova Serrana" />
            <DialogFooter className="mt-3">
              <Button type="submit" size="sm" disabled={!nome.trim()}>Salvar</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
