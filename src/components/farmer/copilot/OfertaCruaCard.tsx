// Fallback de oferta para clientes sem plano pré-gerado (fora do top-25 noturno).
// Busca o melhor bundle pendente em farmer_bundle_recommendations escopado ao DONO da carteira do
// cliente (score.farmer_id), NÃO ao usuário logado: a tabela é multi por (customer,farmer) e, sob
// cobertura (#980), o bundle do cliente vive sob o dono — filtrar pelo viewer voltava vazio. A RLS
// fbrec_select_carteira deixa o cobridor ler o bundle do dono via carteira_visivel_para.
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface Props {
  customerId: string;
}

interface BundleProduct {
  name?: string;
  nome?: string;
}

interface BundleRow {
  bundle_products: unknown;
  m_bundle: number | null;
}

function parseProdutos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as BundleProduct[])
    .map((p) => (typeof p === 'object' && p !== null ? p.name || p.nome || '' : ''))
    .filter((s): s is string => Boolean(s));
}

export function OfertaCruaCard({ customerId }: Props) {
  // user.id NÃO entra no lookup (o bundle é escopado ao DONO via score) — entra só na queryKey como
  // discriminador de identidade: o QueryClient é global e não é limpo no sign-out, então sem isso o
  // cache de um usuário poderia ser servido a outro na mesma aba (vazamento de autorização).
  const { user } = useAuth();
  const { data: bundle } = useQuery<BundleRow | null>({
    queryKey: ['oferta-crua', customerId, user?.id],
    queryFn: async () => {
      // DONO da carteira do cliente (Opção A: 1 score/cliente, farmer_id = dono). maybeSingle p/
      // não lançar quando o cliente não tem score; sem dono → sem oferta (degradação honesta).
      const { data: score } = await supabase
        .from('farmer_client_scores')
        .select('farmer_id')
        .eq('customer_user_id', customerId)
        .maybeSingle();
      const ownerId = score?.farmer_id;
      if (!ownerId) return null;
      const { data } = await supabase
        .from('farmer_bundle_recommendations')
        .select('bundle_products, m_bundle')
        .eq('customer_user_id', customerId)
        .eq('farmer_id', ownerId)
        .eq('status', 'pendente')
        .order('lie_bundle', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ?? null;
    },
    staleTime: 60_000,
    enabled: Boolean(customerId),
  });

  const produtos = parseProdutos(bundle?.bundle_products);
  const margem = bundle?.m_bundle ?? null;

  if (!bundle || produtos.length === 0) return null;

  return (
    <Card className="border-dashed border-muted-foreground/30">
      <CardContent className="p-3 space-y-1">
        <p className="text-[11px] font-semibold leading-tight">
          💡 Ofereça: {produtos.join(' + ')}
        </p>
        {margem !== null && margem > 0 && (
          <Badge variant="outline" className="text-[7px]">
            +R$ {Math.round(margem)}/mês
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
