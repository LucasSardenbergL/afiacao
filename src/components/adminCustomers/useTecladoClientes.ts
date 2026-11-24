// Teclado da lista de Clientes (onda C, item 7): J/K movem o foco entre os NOMES (links reais) e o Enter
// é o do próprio link — abre a 360 com a origem, como o clique. Pelo registro do app (o diálogo `?` os
// descobre); nada de listener `keydown` solto.
//
// WCAG 2.1.4 (atalho de uma letra): a tecla só é da lista quando o foco está NELA ou em lugar nenhum.
// Com o foco em outro controle (busca, menu, diálogo), a letra é desse controle e o evento segue intacto.
import { useMemo, type RefObject } from 'react';
import { useRegisterShortcuts, type Shortcut } from '@/components/shell/ShortcutsRegistry';

const SELETOR_LINK_CLIENTE = '[data-link-cliente]';

function focoLivreOuNaLista(lista: HTMLElement | null): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  return !!lista?.contains(el);
}

/**
 * Próximo índice a focar. `atual` = índice do link focado (-1 = nenhum): J sem foco vai ao 1º, K sem foco
 * ao último; nas pontas, para (não dá a volta — a vendedora perderia o lugar numa lista longa).
 */
function proximoIndice(atual: number, total: number, passo: 1 | -1): number | null {
  if (total <= 0) return null;
  if (atual < 0) return passo === 1 ? 0 : total - 1;
  const alvo = atual + passo;
  return alvo < 0 || alvo >= total ? atual : alvo;
}

export function useTecladoClientes(listaRef: RefObject<HTMLElement>): void {
  const atalhos = useMemo<Shortcut[]>(() => {
    const mover = (passo: 1 | -1) => {
      const lista = listaRef.current;
      if (!lista) return;
      const links = Array.from(lista.querySelectorAll<HTMLElement>(SELETOR_LINK_CLIENTE));
      const atual = links.findIndex((l) => l === document.activeElement || l.contains(document.activeElement));
      const alvo = proximoIndice(atual, links.length, passo);
      if (alvo == null) return;
      links[alvo].focus();
      links[alvo].scrollIntoView?.({ block: 'nearest' });
    };
    const vale = () => focoLivreOuNaLista(listaRef.current);
    return [
      { keys: 'j', label: 'Próximo cliente (Enter abre a 360)', group: 'Clientes', handler: () => mover(1), enabled: vale },
      { keys: 'k', label: 'Cliente anterior', group: 'Clientes', handler: () => mover(-1), enabled: vale },
    ];
  }, [listaRef]);
  useRegisterShortcuts(atalhos);
}
