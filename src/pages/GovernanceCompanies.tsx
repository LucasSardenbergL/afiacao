import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Building2, Save } from 'lucide-react';

interface CompanyProfile {
  id: string;
  account: string;
  legal_name: string;
  cnpj: string;
  phone: string | null;
  address: string | null;
}

const ACCOUNT_LABEL: Record<string, string> = {
  oben: 'OBEN',
  colacor: 'COLACOR',
  afiacao: 'COLACOR S.C (Afiação)',
};

export default function GovernanceCompanies() {
  const { user, loading: authLoading } = useAuth();
  const { role, loading: roleLoading } = useUserRole();
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const isAdmin = role === 'admin' || role === 'master';

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data, error } = await supabase
        .from('company_profiles')
        .select('id, account, legal_name, cnpj, phone, address')
        .order('account');
      if (error) {
        toast({ title: 'Erro ao carregar empresas', description: error.message, variant: 'destructive' });
      } else {
        setProfiles((data || []) as CompanyProfile[]);
      }
      setLoading(false);
    })();
  }, [user, toast]);

  const updateField = (id: string, field: keyof CompanyProfile, value: string) => {
    setProfiles(prev => prev.map(p => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const handleSave = async (profile: CompanyProfile) => {
    setSavingId(profile.id);
    const { error } = await supabase
      .from('company_profiles')
      .update({
        legal_name: profile.legal_name,
        cnpj: profile.cnpj,
        phone: profile.phone,
        address: profile.address,
      })
      .eq('id', profile.id);
    setSavingId(null);
    if (error) {
      toast({ title: 'Erro ao salvar', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Empresa atualizada' });
    }
  };

  if (authLoading || roleLoading || loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center text-muted-foreground">
        Acesso restrito a administradores.
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Building2 className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-semibold">Dados das Empresas</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Estes dados aparecem em todos os pedidos impressos. Alterações são aplicadas imediatamente.
      </p>

      {profiles.map(profile => (
        <Card key={profile.id}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{ACCOUNT_LABEL[profile.account] || profile.account}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Razão Social</Label>
                <Input
                  value={profile.legal_name}
                  onChange={e => updateField(profile.id, 'legal_name', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">CNPJ</Label>
                <Input
                  value={profile.cnpj}
                  onChange={e => updateField(profile.id, 'cnpj', e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Telefone</Label>
                <Input
                  value={profile.phone || ''}
                  onChange={e => updateField(profile.id, 'phone', e.target.value)}
                />
              </div>
              <div className="md:col-span-2">
                <Label className="text-xs">Endereço</Label>
                <Input
                  value={profile.address || ''}
                  onChange={e => updateField(profile.id, 'address', e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => handleSave(profile)} disabled={savingId === profile.id} className="gap-1.5">
                {savingId === profile.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Salvar
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
