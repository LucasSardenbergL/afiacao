// Fallback de oferta para clientes sem plano pré-gerado (fora do top-25 noturno).
// Busca o melhor bundle pendente diretamente de farmer_bundle_recommendations.
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';

interface Props {
  customerId: string;
  farmerId: string;
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

export function OfertaCruaCard({ customerId, farmerId }: Props) {
  const { data: bundle } = useQuery<BundleRow | null>({
    queryKey: ['oferta-crua', customerId, farmerId],
    queryFn: async () => {
      const { data } = await supabase
        .from('farmer_bundle_recommendations')
        .select('bundle_products, m_bundle')
        .eq('customer_user_id', customerId)
        .eq('farmer_id', farmerId)
        .eq('status', 'pendente')
        .order('lie_bundle', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ?? null;
    },
    staleTime: 60_000,
    enabled: Boolean(customerId) && Boolean(farmerId),
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
