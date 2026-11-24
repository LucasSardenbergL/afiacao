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

/**
 * Lista virtualizada (onda E): só as linhas perto da tela existem no DOM, então o índice vem do
 * `data-indice` do link e o total da lista INTEIRA. Alvo fora do DOM → `irPara` rola até ele e o foco
 * entra quando a linha monta (até ~10 quadros).
 */
export interface NavegacaoVirtual {
  total: number;
  irPara: (indice: number) => void;
}

const QUADROS_PARA_FOCAR = 10;

function focarQuandoMontar(lista: HTMLElement, indice: number, quadros = QUADROS_PARA_FOCAR): void {
  const el = lista.querySelector<HTMLElement>(`${SELETOR_LINK_CLIENTE}[data-indice="${indice}"]`);
  if (el) { el.focus(); el.scrollIntoView?.({ block: 'nearest' }); return; }
  if (quadros > 0) requestAnimationFrame(() => focarQuandoMontar(lista, indice, quadros - 1));
}

export function useTecladoClientes(listaRef: RefObject<HTMLElement>, navegacao?: NavegacaoVirtual): void {
  const total = navegacao?.total;
  const irPara = navegacao?.irPara;
  const atalhos = useMemo<Shortcut[]>(() => {
    const mover = (passo: 1 | -1) => {
      const lista = listaRef.current;
      if (!lista) return;
      const links = Array.from(lista.querySelectorAll<HTMLElement>(SELETOR_LINK_CLIENTE));
      const focado = links.find((l) => l === document.activeElement || l.contains(document.activeElement));
      if (total != null && irPara) {
        const atual = focado ? Number(focado.dataset.indice ?? -1) : -1;
        const alvo = proximoIndice(atual, total, passo);
        if (alvo == null) return;
        if (!lista.querySelector(`${SELETOR_LINK_CLIENTE}[data-indice="${alvo}"]`)) irPara(alvo);
        focarQuandoMontar(lista, alvo);
        return;
      }
      const alvo = proximoIndice(focado ? links.indexOf(focado) : -1, links.length, passo);
      if (alvo == null) return;
      links[alvo].focus();
      links[alvo].scrollIntoView?.({ block: 'nearest' });
    };
    const vale = () => focoLivreOuNaLista(listaRef.current);
    return [
      { keys: 'j', label: 'Próximo cliente (Enter abre a 360)', group: 'Clientes', handler: () => mover(1), enabled: vale },
      { keys: 'k', label: 'Cliente anterior', group: 'Clientes', handler: () => mover(-1), enabled: vale },
    ];
  }, [listaRef, total, irPara]);
  useRegisterShortcuts(atalhos);
}
