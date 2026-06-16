// Hero/header do CustomerDashboard (saudação, badge de tipo, stats row).
// Extraído verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { User, TrendingUp, Package, Wrench, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { stagger, fadeUp } from './config';

interface DashboardHeroProps {
  getGreeting: () => string;
  displayName: string;
  customerType: string | null | undefined;
  pendingOrdersCount: number;
  userToolsCount: number;
  gamScoreTotal: number;
  navigate: ReturnType<typeof useNavigate>;
}

export function DashboardHero({
  getGreeting,
  displayName,
  customerType,
  pendingOrdersCount,
  userToolsCount,
  gamScoreTotal,
  navigate,
}: DashboardHeroProps) {
  return (
    <header className="bg-gradient-dark text-secondary-foreground px-4 pt-12 pb-10 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-72 h-72 bg-primary/8 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/5 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2" />
      <motion.div
        className="max-w-lg mx-auto relative z-10"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex items-start justify-between mb-6">
          <div className="space-y-1">
            <p className="text-sm text-secondary-foreground/60 font-medium">{getGreeting()},</p>
            <h1 className="text-2xl font-display font-bold tracking-tight">{displayName}</h1>
            {customerType && (
              <span className={cn(
                'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-wider',
                customerType === 'industrial'
                  ? 'bg-status-warning/20 text-status-warning-bg'
                  : 'bg-status-info/20 text-status-info-bg'
              )}>
                {customerType === 'industrial' ? (
                  <><TrendingUp className="w-3 h-3" /> Industrial</>
                ) : 'Doméstico'}
              </span>
            )}
          </div>
          <motion.button
            onClick={() => navigate('/profile')}
            className="w-12 h-12 rounded-2xl bg-secondary-foreground/10 hover:bg-secondary-foreground/20 flex items-center justify-center transition-colors border border-secondary-foreground/10"
            whileTap={{ scale: 0.92 }}
          >
            <User className="w-5 h-5 text-secondary-foreground/80" />
          </motion.button>
        </div>

        {/* Stats Row */}
        <motion.div className="grid grid-cols-3 gap-2" variants={stagger} initial="hidden" animate="show">
          {[
            { icon: Package, value: pendingOrdersCount, label: 'Pedidos', path: '/orders' },
            { icon: Wrench, value: userToolsCount, label: 'Ferramentas', path: '/tools' },
            { icon: Trophy, value: gamScoreTotal, label: 'Score', path: '/gamification' },
          ].map(stat => (
            <motion.button
              key={stat.label}
              variants={fadeUp}
              onClick={() => navigate(stat.path)}
              className="bg-secondary-foreground/8 hover:bg-secondary-foreground/14 rounded-2xl p-3 backdrop-blur-sm border border-secondary-foreground/5 transition-colors text-left group"
              whileTap={{ scale: 0.96 }}
            >
              <stat.icon className="w-4 h-4 text-secondary-foreground/50 mb-1" />
              <p className="text-2xl font-bold tracking-tight">{stat.value}</p>
              <p className="text-[10px] text-secondary-foreground/50 font-medium">{stat.label}</p>
            </motion.button>
          ))}
        </motion.div>
      </motion.div>
    </header>
  );
}
