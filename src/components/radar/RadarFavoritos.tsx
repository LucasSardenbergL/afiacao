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

/** Os filtros da URL (`useUrlState`), sem a vista: o que um favorito guarda e reaplica. */
export type FiltrosSalvos = Record<string, string | boolean>;
export interface FavoritoRadar { nome: string; filtros: FiltrosSalvos }

export const MAX_FAVORITOS = 20;
export const chaveFavoritos = (userId: string) => `radar.favoritos.v1:${userId}`;

/** Só as chaves que a tela conhece, com o MESMO tipo do default; o resto volta ao default. Um favorito
 *  salvo numa versão antiga da tela (chave que sumiu, tipo que mudou) aplica o que ainda faz sentido. */
export function sanitizarFiltros(bruto: unknown, padrao: FiltrosSalvos): FiltrosSalvos {
  const out: FiltrosSalvos = { ...padrao };
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return out;
  const r = bruto as Record<string, unknown>;
  for (const k of Object.keys(padrao)) {
    const v = r[k];
    if (typeof v === typeof padrao[k]) out[k] = v as string | boolean;
  }
  return out;
}

/** Lê os favoritos do usuário. Storage bloqueado, JSON quebrado ou forma estranha = lista vazia
 *  (preferência local; perder é chato, não é dano). */
export function lerFavoritos(storage: Pick<Storage, 'getItem'> | null, userId: string, padrao: FiltrosSalvos): FavoritoRadar[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(chaveFavoritos(userId));
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((f): f is { nome: string; filtros: unknown } =>
        typeof f === 'object' && f !== null && typeof (f as { nome?: unknown }).nome === 'string' && (f as { nome: string }).nome.trim() !== '')
      .slice(0, MAX_FAVORITOS)
      .map((f) => ({ nome: f.nome.trim(), filtros: sanitizarFiltros(f.filtros, padrao) }));
  } catch {
    return [];
  }
}

/** Grava; devolve false se o storage recusou (cheio, bloqueado) — a tela avisa. */
export function gravarFavoritos(storage: Pick<Storage, 'setItem'> | null, userId: string, lista: FavoritoRadar[]): boolean {
  if (!storage) return false;
  try {
    storage.setItem(chaveFavoritos(userId), JSON.stringify(lista));
    return true;
  } catch {
    return false;
  }
}

/** Acrescenta (ou substitui o de mesmo nome, sem caixa) no topo; corta no teto. */
export function comFavorito(lista: FavoritoRadar[], nome: string, filtros: FiltrosSalvos): FavoritoRadar[] {
  const n = nome.trim();
  const resto = lista.filter((f) => f.nome.toLowerCase() !== n.toLowerCase());
  return [{ nome: n, filtros }, ...resto].slice(0, MAX_FAVORITOS);
}

export function mesmosFiltros(a: FiltrosSalvos, b: FiltrosSalvos): boolean {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if (a[k] !== b[k]) return false;
  return true;
}

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
