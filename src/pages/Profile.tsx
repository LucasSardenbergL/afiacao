import { useState, useEffect } from 'react';
import { User, MapPin, Phone, Mail, ChevronRight, LogOut, Settings, HelpCircle, FileText, Star, Loader2, Wrench } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { SharpeningSuggestions } from '@/components/SharpeningSuggestions';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface ProfileData {
  name: string;
  email: string | null;
  phone: string | null;
  customer_type: string | null;
}

const Profile = () => {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [addressCount, setAddressCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  const [toolCount, setToolCount] = useState(0);

  useEffect(() => {
    if (user) {
      loadProfileData();
    }
  }, [user]);

  const loadProfileData = async () => {
    if (!user) return;
    
    try {
      // Load profile
      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, email, phone, customer_type')
        .eq('user_id', user.id)
        .maybeSingle();

      if (profileData) {
        setProfile(profileData);
      } else {
        // Use auth email if no profile
        setProfile({
          name: user.email?.split('@')[0] || 'Usuário',
          email: user.email || null,
          phone: null,
          customer_type: null,
        });
      }

      // Load address count
      const { count: addrCount } = await supabase
        .from('addresses')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      
      setAddressCount(addrCount || 0);

      // Load completed order count
      const { count: ordCount } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'entregue');
      
      setOrderCount(ordCount || 0);

      // Load tool count
      const { count: tlCount } = await supabase
        .from('user_tools')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      
      setToolCount(tlCount || 0);
    } catch (error) {
      console.error('Error loading profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      toast({
        title: 'Até logo!',
        description: 'Você saiu da sua conta',
      });
    } catch (error) {
      toast({
        title: 'Erro ao sair',
        description: 'Tente novamente',
        variant: 'destructive',
      });
    }
  };

  const menuItems = [
    { icon: Wrench, label: 'Minhas Ferramentas', count: toolCount },
    { icon: MapPin, label: 'Meus Endereços', count: addressCount },
    { icon: FileText, label: 'Dados Fiscais' },
    { icon: Star, label: 'Avaliações' },
    { icon: Settings, label: 'Configurações' },
    { icon: HelpCircle, label: 'Ajuda e FAQ' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Meu Perfil" showBack showNotifications />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meu Perfil" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Profile card */}
        <div className="bg-card rounded-xl p-6 shadow-soft border border-border mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-full bg-gradient-primary flex items-center justify-center">
              <span className="text-2xl font-bold text-primary-foreground">
                {profile?.name?.charAt(0).toUpperCase() || 'U'}
              </span>
            </div>
            <div className="flex-1">
              <h2 className="font-display font-bold text-lg">{profile?.name || 'Usuário'}</h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  Cliente desde {new Date(user?.created_at || Date.now()).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                </p>
                {profile?.customer_type && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    profile.customer_type === 'industrial' 
                      ? 'bg-amber-100 text-amber-800' 
                      : 'bg-blue-100 text-blue-800'
                  }`}>
                    {profile.customer_type === 'industrial' ? 'Industrial' : 'Doméstico'}
                  </span>
                )}
              </div>
            </div>
            <Button variant="outline" size="sm">
              Editar
            </Button>
          </div>

          <div className="space-y-2 text-sm">
            {profile?.phone && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="w-4 h-4" />
                <span>{profile.phone}</span>
              </div>
            )}
            {profile?.email && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="w-4 h-4" />
                <span>{profile.email}</span>
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="flex gap-4 mt-4 pt-4 border-t border-border">
            <div className="flex-1 text-center">
              <p className="text-2xl font-bold text-primary">{orderCount}</p>
              <p className="text-xs text-muted-foreground">Pedidos</p>
            </div>
            <div className="flex-1 text-center border-l border-border">
              <p className="text-2xl font-bold text-foreground">{toolCount}</p>
              <p className="text-xs text-muted-foreground">Ferramentas</p>
            </div>
            <div className="flex-1 text-center border-l border-border">
              <p className="text-2xl font-bold text-foreground">{addressCount}</p>
              <p className="text-xs text-muted-foreground">Endereços</p>
            </div>
          </div>
        </div>

        {/* Sharpening Suggestions */}
        <div className="mb-6">
          <h3 className="font-display font-bold text-lg mb-3">Agenda de Afiação</h3>
          <SharpeningSuggestions />
        </div>

        {/* Menu items */}
        <div className="bg-card rounded-xl shadow-soft border border-border overflow-hidden mb-6">
          {menuItems.map((item) => (
            <button
              key={item.label}
              className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
            >
              <item.icon className="w-5 h-5 text-muted-foreground" />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="text-sm text-muted-foreground">{item.count}</span>
              )}
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>
          ))}
        </div>

        {/* Logout */}
        <Button 
          variant="outline" 
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sair da conta
        </Button>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Versão 1.0.0
        </p>
      </main>

      <BottomNav />
    </div>
  );
};

export default Profile;
