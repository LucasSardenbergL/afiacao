import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { 
  Loader2, 
  AlertTriangle, 
  Clock, 
  Calendar, 
  Phone, 
  User, 
  Wrench,
  ChevronRight,
  TrendingUp
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface CustomerToolForecast {
  id: string;
  userId: string;
  customerName: string;
  customerPhone: string | null;
  customerDocument: string | null;
  toolId: string;
  toolName: string;
  categoryName: string;
  nextSharpeningDue: Date | null;
  lastSharpenedAt: Date | null;
  daysUntilDue: number;
  isOverdue: boolean;
  isDueSoon: boolean;
}

interface GroupedByCustomer {
  userId: string;
  customerName: string;
  customerPhone: string | null;
  customerDocument: string | null;
  tools: CustomerToolForecast[];
  urgencyLevel: 'overdue' | 'soon' | 'upcoming';
  mostUrgentDays: number;
}

const AdminDemandForecast = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  
  const [forecasts, setForecasts] = useState<CustomerToolForecast[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setSelectedTab] = useState('overdue');

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadForecasts();
    }
  }, [user, isStaff]);

  const loadForecasts = async () => {
    try {
      // Buscar todas as ferramentas de todos os usuários com próxima afiação
      const { data: toolsData, error: toolsError } = await supabase
        .from('user_tools')
        .select(`
          id,
          user_id,
          generated_name,
          custom_name,
          next_sharpening_due,
          last_sharpened_at,
          tool_categories (name)
        `)
        .not('next_sharpening_due', 'is', null)
        .order('next_sharpening_due', { ascending: true });

      if (toolsError) throw toolsError;

      if (!toolsData || toolsData.length === 0) {
        setForecasts([]);
        setLoading(false);
        return;
      }

      // Buscar perfis dos usuários
      const userIds = [...new Set(toolsData.map(t => t.user_id))];
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('user_id, name, phone, document, is_employee')
        .in('user_id', userIds);

      // Filtrar apenas clientes (não funcionários)
      const customerProfiles = profilesData?.filter(p => !p.is_employee) || [];
      const customerUserIds = new Set(customerProfiles.map(p => p.user_id));

      const now = new Date();
      const processedForecasts: CustomerToolForecast[] = toolsData
        .filter(tool => customerUserIds.has(tool.user_id))
        .map((tool: any) => {
          const profile = customerProfiles.find(p => p.user_id === tool.user_id);
          const nextDue = tool.next_sharpening_due ? new Date(tool.next_sharpening_due) : null;
          const daysUntilDue = nextDue 
            ? Math.ceil((nextDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            : 999;

          return {
            id: `${tool.user_id}-${tool.id}`,
            userId: tool.user_id,
            customerName: profile?.name || 'Cliente',
            customerPhone: profile?.phone || null,
            customerDocument: profile?.document || null,
            toolId: tool.id,
            toolName: tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta',
            categoryName: tool.tool_categories?.name || 'Ferramenta',
            nextSharpeningDue: nextDue,
            lastSharpenedAt: tool.last_sharpened_at ? new Date(tool.last_sharpened_at) : null,
            daysUntilDue,
            isOverdue: daysUntilDue < 0,
            isDueSoon: daysUntilDue >= 0 && daysUntilDue <= 7,
          };
        });

      setForecasts(processedForecasts);
    } catch (error) {
      console.error('Error loading forecasts:', error);
    } finally {
      setLoading(false);
    }
  };

  // Agrupar por cliente
  const groupByCustomer = (tools: CustomerToolForecast[]): GroupedByCustomer[] => {
    const grouped: Record<string, GroupedByCustomer> = {};

    tools.forEach(tool => {
      if (!grouped[tool.userId]) {
        grouped[tool.userId] = {
          userId: tool.userId,
          customerName: tool.customerName,
          customerPhone: tool.customerPhone,
          customerDocument: tool.customerDocument,
          tools: [],
          urgencyLevel: 'upcoming',
          mostUrgentDays: 999,
        };
      }
      grouped[tool.userId].tools.push(tool);

      // Atualizar nível de urgência
      if (tool.isOverdue) {
        grouped[tool.userId].urgencyLevel = 'overdue';
      } else if (tool.isDueSoon && grouped[tool.userId].urgencyLevel !== 'overdue') {
        grouped[tool.userId].urgencyLevel = 'soon';
      }

      // Atualizar dias mais urgentes
      if (tool.daysUntilDue < grouped[tool.userId].mostUrgentDays) {
        grouped[tool.userId].mostUrgentDays = tool.daysUntilDue;
      }
    });

    return Object.values(grouped).sort((a, b) => a.mostUrgentDays - b.mostUrgentDays);
  };

  const getFilteredCustomers = (tab: string): GroupedByCustomer[] => {
    let filtered: CustomerToolForecast[];
    
    switch (tab) {
      case 'overdue':
        filtered = forecasts.filter(f => f.isOverdue);
        break;
      case 'soon':
        filtered = forecasts.filter(f => f.isDueSoon);
        break;
      case 'upcoming':
        filtered = forecasts.filter(f => !f.isOverdue && !f.isDueSoon && f.daysUntilDue <= 30);
        break;
      default:
        filtered = forecasts;
    }

    return groupByCustomer(filtered);
  };

  const overdueCount = forecasts.filter(f => f.isOverdue).length;
  const dueSoonCount = forecasts.filter(f => f.isDueSoon).length;
  const upcomingCount = forecasts.filter(f => !f.isOverdue && !f.isDueSoon && f.daysUntilDue <= 30).length;

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Previsão de Demanda" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!isStaff) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Previsão de Demanda" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card className={cn(
            "text-center cursor-pointer transition-all",
            selectedTab === 'overdue' && "ring-2 ring-destructive"
          )} onClick={() => setSelectedTab('overdue')}>
            <CardContent className="pt-4 pb-3">
              <div className="w-8 h-8 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
              </div>
              <p className="text-2xl font-bold text-destructive">{overdueCount}</p>
              <p className="text-xs text-muted-foreground">Atrasados</p>
            </CardContent>
          </Card>
          
          <Card className={cn(
            "text-center cursor-pointer transition-all",
            selectedTab === 'soon' && "ring-2 ring-amber-500"
          )} onClick={() => setSelectedTab('soon')}>
            <CardContent className="pt-4 pb-3">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-2">
                <Clock className="w-4 h-4 text-amber-600" />
              </div>
              <p className="text-2xl font-bold text-amber-600">{dueSoonCount}</p>
              <p className="text-xs text-muted-foreground">Em 7 dias</p>
            </CardContent>
          </Card>
          
          <Card className={cn(
            "text-center cursor-pointer transition-all",
            selectedTab === 'upcoming' && "ring-2 ring-primary"
          )} onClick={() => setSelectedTab('upcoming')}>
            <CardContent className="pt-4 pb-3">
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-2">
                <Calendar className="w-4 h-4 text-primary" />
              </div>
              <p className="text-2xl font-bold text-primary">{upcomingCount}</p>
              <p className="text-xs text-muted-foreground">Em 30 dias</p>
            </CardContent>
          </Card>
        </div>

        {/* Info text */}
        <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground">
          <TrendingUp className="w-4 h-4" />
          <span>Clientes que devem ser contatados para afiação</span>
        </div>

        {/* Tabs */}
        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="overdue" className="text-xs">
              Atrasados ({overdueCount})
            </TabsTrigger>
            <TabsTrigger value="soon" className="text-xs">
              Em breve ({dueSoonCount})
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="text-xs">
              Próximos ({upcomingCount})
            </TabsTrigger>
          </TabsList>

          {['overdue', 'soon', 'upcoming'].map(tab => (
            <TabsContent key={tab} value={tab} className="space-y-3">
              {getFilteredCustomers(tab).map(customer => (
                <CustomerCard 
                  key={customer.userId} 
                  customer={customer}
                  onViewCustomer={() => navigate(`/admin/customers/${customer.userId}`)}
                />
              ))}
              {getFilteredCustomers(tab).length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  {tab === 'overdue' && 'Nenhuma ferramenta com afiação atrasada'}
                  {tab === 'soon' && 'Nenhuma ferramenta precisando de afiação em breve'}
                  {tab === 'upcoming' && 'Nenhuma ferramenta prevista para os próximos 30 dias'}
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </main>

      <BottomNav />
    </div>
  );
};

interface CustomerCardProps {
  customer: GroupedByCustomer;
  onViewCustomer: () => void;
}

const CustomerCard = ({ customer, onViewCustomer }: CustomerCardProps) => {
  const getUrgencyStyles = () => {
    switch (customer.urgencyLevel) {
      case 'overdue':
        return {
          border: 'border-destructive/30',
          bg: 'bg-destructive/5',
          badge: 'bg-destructive text-white',
          badgeText: 'Atrasado',
        };
      case 'soon':
        return {
          border: 'border-amber-300',
          bg: 'bg-amber-50',
          badge: 'bg-amber-500 text-white',
          badgeText: 'Em breve',
        };
      default:
        return {
          border: 'border-border',
          bg: 'bg-card',
          badge: 'bg-primary text-primary-foreground',
          badgeText: 'Próximo',
        };
    }
  };

  const styles = getUrgencyStyles();
  
  const getDaysText = () => {
    if (customer.mostUrgentDays < 0) {
      const days = Math.abs(customer.mostUrgentDays);
      return `${days} dia${days !== 1 ? 's' : ''} atrasado`;
    }
    if (customer.mostUrgentDays === 0) {
      return 'Vence hoje';
    }
    if (customer.mostUrgentDays === 1) {
      return 'Vence amanhã';
    }
    return `em ${customer.mostUrgentDays} dias`;
  };

  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (customer.customerPhone) {
      const phone = customer.customerPhone.replace(/\D/g, '');
      const message = encodeURIComponent(
        `Olá ${customer.customerName}! Notamos que suas ferramentas estão precisando de afiação. Gostaria de agendar o serviço?`
      );
      window.open(`https://wa.me/55${phone}?text=${message}`, '_blank');
    }
  };

  return (
    <Card 
      className={cn(
        "cursor-pointer hover:shadow-md transition-all",
        styles.border,
        styles.bg
      )}
      onClick={onViewCustomer}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <User className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-foreground">{customer.customerName}</p>
              {customer.customerDocument && (
                <p className="text-xs text-muted-foreground">
                  {customer.customerDocument}
                </p>
              )}
            </div>
          </div>
          <Badge className={styles.badge}>
            {styles.badgeText}
          </Badge>
        </div>

        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-2 text-sm">
            <Wrench className="w-4 h-4 text-muted-foreground" />
            <span className="text-muted-foreground">
              {customer.tools.length} ferramenta{customer.tools.length !== 1 ? 's' : ''} • {getDaysText()}
            </span>
          </div>
          
          <div className="flex flex-wrap gap-1">
            {customer.tools.slice(0, 3).map(tool => (
              <Badge key={tool.toolId} variant="outline" className="text-xs">
                {tool.categoryName}
              </Badge>
            ))}
            {customer.tools.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{customer.tools.length - 3} mais
              </Badge>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          {customer.customerPhone && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={handleWhatsApp}
            >
              <Phone className="w-4 h-4 mr-2" />
              WhatsApp
            </Button>
          )}
          <Button
            size="sm"
            variant="default"
            className="flex-1"
            onClick={onViewCustomer}
          >
            Ver Cliente
            <ChevronRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default AdminDemandForecast;
