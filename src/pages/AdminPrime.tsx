// Prime Colacor — admin mínimo (staff): assinaturas, uso de benefício, planos.
// Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7 (PR-2).
// Princípio: app = extrato + gestão; a venda/entrega do benefício acontece na
// operação. Guards de honestidade vivem NO BANCO — esta tela traduz e opera.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PrimeAssinaturasTab } from '@/components/adminPrime/PrimeAssinaturasTab';
import { PrimePlanosTab } from '@/components/adminPrime/PrimePlanosTab';
import { PrimeUsoTab } from '@/components/adminPrime/PrimeUsoTab';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';

const AdminPrime = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const [{ tab }, setTab] = useUrlState({ tab: 'assinaturas' });

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  if (authLoading) return <PageSkeleton variant="list" />;
  if (!isStaff) return null;

  return (
    <div className="container mx-auto px-4 py-6 space-y-4">
      <header>
        <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
          <Crown className="w-6 h-6 text-muted-foreground" />
          Prime Colacor
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Assinaturas do programa, registro de uso de benefício e catálogo de planos. O
          extrato do cliente (PR-3) nasce do que for registrado aqui.
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab({ tab: v })}>
        <TabsList>
          <TabsTrigger value="assinaturas">Assinaturas</TabsTrigger>
          <TabsTrigger value="uso">Uso de benefício</TabsTrigger>
          <TabsTrigger value="planos">Planos</TabsTrigger>
        </TabsList>
        <TabsContent value="assinaturas" className="mt-4">
          <PrimeAssinaturasTab />
        </TabsContent>
        <TabsContent value="uso" className="mt-4">
          <PrimeUsoTab />
        </TabsContent>
        <TabsContent value="planos" className="mt-4">
          <PrimePlanosTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminPrime;
