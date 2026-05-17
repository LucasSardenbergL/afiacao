import { useEffect, useRef } from 'react';

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
 * O `rootMargin: '200px'` antecipa o load — o trigger dispara 200px ANTES da
 * sentinela entrar no viewport, fica fluido sem "barrar" o scroll.
 */
export function useInfiniteScroll(
  onLoadMore: () => void,
  enabled: boolean,
): React.RefObject<HTMLDivElement> {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!enabled || !el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, onLoadMore]);

  return sentinelRef;
}
