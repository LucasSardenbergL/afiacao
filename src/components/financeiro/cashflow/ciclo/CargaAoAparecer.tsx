import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageSkeleton } from '@/components/ui/page-skeleton';

/** Só MONTA a seção (e portanto os hooks/RPCs dela) quando ela chega perto da tela; antes disso, skeleton — nunca
 *  vazio nem R$ 0. Sem IntersectionObserver (navegador antigo) monta direto. Uma vez montada, fica montada. */
export function CargaAoAparecer({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [apareceu, setApareceu] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (apareceu || !ref.current) return;
    const io = new IntersectionObserver((entradas) => {
      if (entradas.some((e) => e.isIntersecting)) { setApareceu(true); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [apareceu]);

  if (apareceu) return <>{children}</>;
  return (
    <div ref={ref} aria-busy="true" aria-label={`${rotulo} (carregando)`}>
      <PageSkeleton variant="list" />
    </div>
  );
}
