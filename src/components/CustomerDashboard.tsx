// Dashboard do cliente (afiação) — hero, ação prioritária, gamificação, pedidos,
// ferramentas, ações rápidas. Composição com useCustomerDashboard + seções.
// God-component split de src/components/CustomerDashboard.tsx (comportamento 1:1).
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { PlusCircle, TrendingUp, Sparkles } from 'lucide-react';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { useCustomerDashboard } from '@/components/customerDashboard/useCustomerDashboard';
import { stagger, fadeUp } from '@/components/customerDashboard/config';
import { DashboardHero } from '@/components/customerDashboard/DashboardHero';
import { PriorityCard } from '@/components/customerDashboard/PriorityCard';
import { GamificationMini } from '@/components/customerDashboard/GamificationMini';
import { PedidosAndamento } from '@/components/customerDashboard/PedidosAndamento';
import { FerramentasAtencao } from '@/components/customerDashboard/FerramentasAtencao';
import { AcoesRapidas } from '@/components/customerDashboard/AcoesRapidas';
import type { Profile, Order, UserTool } from '@/components/customerDashboard/types';

interface CustomerDashboardProps {
  profile: Profile | null;
  pendingOrders: Order[];
  userTools: UserTool[];
  getGreeting: () => string;
}

export function CustomerDashboard({ profile, pendingOrders, userTools, getGreeting }: CustomerDashboardProps) {
  const navigate = useNavigate();
  const {
    gamScore,
    displayName,
    urgentTools,
    levelInfo,
    priority,
    ordersNeedingAction,
    otherActiveOrders,
  } = useCustomerDashboard(profile, pendingOrders, userTools);

  return (
    <div className="space-y-6">
      {/* ─── Hero Header ─── */}
      <DashboardHero
        getGreeting={getGreeting}
        displayName={displayName}
        customerType={profile?.customer_type}
        pendingOrdersCount={pendingOrders.length}
        userToolsCount={userTools.length}
        gamScoreTotal={gamScore?.total_score || 0}
        navigate={navigate}
      />

      <motion.main
        className="px-4 -mt-5 max-w-lg mx-auto relative z-20 space-y-5"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        {/* Onboarding */}
        <OnboardingWizard hasTools={userTools.length > 0} hasOrders={pendingOrders.length > 0} />

        {/* ─── SEÇÃO 1: Ação Recomendada ─── */}
        <motion.div variants={fadeUp}>
          <PriorityCard priority={priority} navigate={navigate} />
        </motion.div>

        {/* Gamification Mini */}
        {gamScore && levelInfo && (
          <motion.div variants={fadeUp}>
            <GamificationMini gamScore={gamScore} levelInfo={levelInfo} navigate={navigate} />
          </motion.div>
        )}

        {/* ─── SEÇÃO 2: Pedidos em Andamento ─── */}
        {pendingOrders.length > 0 && (
          <motion.section variants={fadeUp}>
            <PedidosAndamento
              ordersNeedingAction={ordersNeedingAction}
              otherActiveOrders={otherActiveOrders}
              navigate={navigate}
            />
          </motion.section>
        )}

        {/* ─── SEÇÃO 3: Ferramentas que Exigem Atenção ─── */}
        {urgentTools.length > 0 && (
          <motion.section variants={fadeUp}>
            <FerramentasAtencao urgentTools={urgentTools} navigate={navigate} />
          </motion.section>
        )}

        {/* ─── SEÇÃO 4: Ações Rápidas ─── */}
        <motion.section variants={fadeUp}>
          <AcoesRapidas navigate={navigate} />
        </motion.section>

        {/* Empty state for brand-new users */}
        {pendingOrders.length === 0 && userTools.length === 0 && priority.type !== 'no_tools' && (
          <motion.div variants={fadeUp}>
            <Card className="text-center py-8">
              <CardContent className="space-y-3">
                <Sparkles className="w-10 h-10 text-primary mx-auto" />
                <h3 className="font-semibold text-foreground">Bem-vindo à Colacor!</h3>
                <p className="text-sm text-muted-foreground">Faça seu primeiro pedido de afiação e mantenha suas ferramentas sempre afiadas.</p>
                <Button onClick={() => navigate('/new-order')} className="rounded-xl">
                  <PlusCircle className="w-4 h-4 mr-1.5" /> Criar Primeiro Pedido
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Industrial benefit */}
        {profile?.customer_type === 'industrial' && (
          <motion.section variants={fadeUp}>
            <Card className="bg-gradient-primary text-primary-foreground border-0 overflow-hidden">
              <CardContent className="p-5 relative">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2" />
                <div className="relative z-10">
                  <div className="flex items-center gap-2 mb-2">
                    <TrendingUp className="w-5 h-5" />
                    <span className="font-semibold">Cliente Industrial</span>
                  </div>
                  <p className="text-sm text-primary-foreground/80">Você tem frete gratuito em todos os seus pedidos!</p>
                </div>
              </CardContent>
            </Card>
          </motion.section>
        )}
      </motion.main>
    </div>
  );
}
