import { User, MapPin, Phone, Mail, ChevronRight, LogOut, Settings, HelpCircle, FileText, Star } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { mockUser, mockAddresses, mockOrders } from '@/data/mockData';

const Profile = () => {
  const completedOrders = mockOrders.filter(o => o.status === 'entregue').length;

  const menuItems = [
    { icon: MapPin, label: 'Meus Endereços', count: mockAddresses.length },
    { icon: FileText, label: 'Dados Fiscais' },
    { icon: Star, label: 'Avaliações', count: 3 },
    { icon: Settings, label: 'Configurações' },
    { icon: HelpCircle, label: 'Ajuda e FAQ' },
  ];

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meu Perfil" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Profile card */}
        <div className="bg-card rounded-xl p-6 shadow-soft border border-border mb-6">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-16 h-16 rounded-full bg-gradient-primary flex items-center justify-center">
              <span className="text-2xl font-bold text-primary-foreground">
                {mockUser.name.charAt(0)}
              </span>
            </div>
            <div className="flex-1">
              <h2 className="font-display font-bold text-lg">{mockUser.name}</h2>
              <p className="text-sm text-muted-foreground">Cliente desde Jan/2024</p>
            </div>
            <Button variant="outline" size="sm">
              Editar
            </Button>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Phone className="w-4 h-4" />
              <span>{mockUser.phone}</span>
            </div>
            {mockUser.email && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Mail className="w-4 h-4" />
                <span>{mockUser.email}</span>
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="flex gap-4 mt-4 pt-4 border-t border-border">
            <div className="flex-1 text-center">
              <p className="text-2xl font-bold text-primary">{completedOrders}</p>
              <p className="text-xs text-muted-foreground">Pedidos</p>
            </div>
            <div className="flex-1 text-center border-l border-border">
              <p className="text-2xl font-bold text-foreground">4.8</p>
              <p className="text-xs text-muted-foreground">Avaliação</p>
            </div>
            <div className="flex-1 text-center border-l border-border">
              <p className="text-2xl font-bold text-foreground">{mockAddresses.length}</p>
              <p className="text-xs text-muted-foreground">Endereços</p>
            </div>
          </div>
        </div>

        {/* Menu items */}
        <div className="bg-card rounded-xl shadow-soft border border-border overflow-hidden mb-6">
          {menuItems.map((item, index) => (
            <button
              key={item.label}
              className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
            >
              <item.icon className="w-5 h-5 text-muted-foreground" />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.count !== undefined && (
                <span className="text-sm text-muted-foreground">{item.count}</span>
              )}
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>
          ))}
        </div>

        {/* Logout */}
        <Button variant="outline" className="w-full text-destructive hover:text-destructive hover:bg-destructive/10">
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
