// Venda R2 · Entrega 1 — destino do link do resumo diário por e-mail: /meu-dia/abrir/:token.
// Grava o CLIQUE no servidor (`venda_resumo_abrir`: só conta se quem abre é o destinatário daquele e-mail; na farmer,
// marca `mostrada_em` dos itens que o e-mail mostrou) e segue para a ficha do comprador no Meu Dia. Na lente
// "Ver como" não grava (inspeção não conta). Link malformado, token desconhecido, erro ou demora > 8 s → Meu Dia.
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { supabase } from '@/integrations/supabase/client';
import { lerAbertura, lerTokenDoLink, linkFichaMeuDia } from '@/lib/venda-cliente/resumo-link';

const ESPERA_MAX_MS = 8000;

export default function VendaResumoAbrir() {
  const { token } = useParams<{ token: string }>();
  const { isImpersonating } = useImpersonation();
  const t = lerTokenDoLink(token);
  const [destino, setDestino] = useState<string | null>(!t || isImpersonating ? '/meu-dia' : null);

  useEffect(() => {
    if (!t || isImpersonating) return;
    let vivo = true;
    const teto = setTimeout(() => {
      if (vivo) setDestino((d) => d ?? '/meu-dia');
    }, ESPERA_MAX_MS);
    void supabase.rpc('venda_resumo_abrir', { p_token: t }).then(({ data, error }) => {
      clearTimeout(teto);
      if (!vivo) return;
      const ab = error ? null : lerAbertura(data);
      if (error) console.error('[resumo-email] falha ao registrar o clique:', error.message);
      setDestino((d) => d ?? (ab ? linkFichaMeuDia(ab.comprador_id) : '/meu-dia'));
    });
    return () => {
      vivo = false;
      clearTimeout(teto);
    };
    // Uma vez por montagem: o redirect desmonta a página logo em seguida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!destino) return <PageSkeleton variant="detail" />;
  return <Navigate to={destino} replace />;
}
