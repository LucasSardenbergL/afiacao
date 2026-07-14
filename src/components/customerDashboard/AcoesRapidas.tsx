// Seção "Ações Rápidas" do CustomerDashboard.
// Extraída verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { QUICK_ACTIONS } from './config';

interface AcoesRapidasProps {
  navigate: ReturnType<typeof useNavigate>;
}

export function AcoesRapidas({ navigate }: AcoesRapidasProps) {
  return (
    <>
      <h2 className="font-display font-bold text-lg text-foreground mb-3">Ações Rápidas</h2>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
        {QUICK_ACTIONS.map((item) => (
          <motion.button
            key={item.path}
            onClick={() => navigate(item.path)}
            className="bg-card rounded-2xl p-3 shadow-soft border border-border/80 hover:shadow-medium hover:border-primary/20 transition-all flex flex-col items-center gap-2 group"
            whileTap={{ scale: 0.95 }}
            whileHover={{ y: -2 }}
          >
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <item.icon className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <span className="text-[11px] font-semibold text-foreground text-center leading-tight">{item.label}</span>
          </motion.button>
        ))}
      </div>
    </>
  );
}
