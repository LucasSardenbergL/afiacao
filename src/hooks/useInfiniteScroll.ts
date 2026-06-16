import { useCallback, useRef } from 'react';

/**
 * IntersectionObserver-based infinite scroll trigger.
 *
 * Use:
 *   const sentinelRef = useInfiniteScroll(
 *     () => query.fetchNextPage(),
 *     !!query.hasNextPage && !query.isFetchingNextPage,
 *   );
 *   ...
 *   <div ref={sentinelRef} />   // sentinela invisível no fim da lista
 *
 * Retorna uma **callback ref**: o React a chama com o nó quando o sentinel
 * monta/desmonta. Assim o observer sempre fica vinculado ao nó ATUAL — quando
 * o sentinel é re-montado (ele alterna conteúdo entre spinner e "Carregar mais"
 * conforme pagina), o gatilho não "solta" do alvo e o auto-load não trava.
 *
 * - `onLoadMore` vive numa ref → trocar o callback NÃO recria o observer.
 * - o observer só é (re)criado quando `enabled` muda ou o nó troca.
 * - `rootMargin: '200px'` antecipa o load 200px antes do sentinel aparecer.
 */
export function useInfiniteScroll(
  onLoadMore: () => void,
  enabled: boolean,
): (node: HTMLDivElement | null) => void {
  const cbRef = useRef(onLoadMore);
  cbRef.current = onLoadMore;

  const observerRef = useRef<IntersectionObserver | null>(null);

  return useCallback(
    (node: HTMLDivElement | null) => {
      // Desliga o observer anterior (nó desmontado, enabled mudou, ou re-mount).
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (!node || !enabled) return;
      if (typeof IntersectionObserver === 'undefined') return; // SSR / ambiente sem IO

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) cbRef.current();
        },
        { root: null, rootMargin: '200px', threshold: 0 },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [enabled],
  );
}
