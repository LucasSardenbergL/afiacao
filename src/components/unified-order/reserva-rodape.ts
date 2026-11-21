import { useEffect, type RefObject } from 'react';

/**
 * Painel × barra de envio (P2 do Codex no #4086): o HUD da ligação é `fixed` no rodapé e, num
 * celular de 360px, cobria o total e o Enviar do Novo Pedido. Os dois ficam visíveis: a barra
 * publica a própria altura (já com a área segura) em `--rodape-fixo` no <html>, e os painéis
 * flutuantes do rodapé sobem por ela (`bottom: calc(Xrem + var(--rodape-fixo, …))`).
 * Sem barra montada a variável some e os painéis voltam ao lugar.
 */
export const VAR_RODAPE_FIXO = '--rodape-fixo';

export function publicarRodape(raiz: HTMLElement, alturaPx: number | null): void {
  if (alturaPx === null || !(alturaPx > 0)) raiz.style.removeProperty(VAR_RODAPE_FIXO);
  else raiz.style.setProperty(VAR_RODAPE_FIXO, `${Math.ceil(alturaPx)}px`);
}

export function useReservaRodape(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raiz = document.documentElement;
    const medir = () => publicarRodape(raiz, el.getBoundingClientRect().height);
    medir();
    const obs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(medir);
    obs?.observe(el);
    return () => { obs?.disconnect(); publicarRodape(raiz, null); };
  }, [ref]);
}
