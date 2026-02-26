import React from 'react';
import { Home, PlusCircle, ClipboardList, User, MessageCircle, ShoppingCart } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useUnreadMessages } from '@/hooks/useUnreadMessages';
import { useInsideAppShell } from '@/contexts/AppShellContext';

const customerNavItems = [
  { icon: Home, label: 'Início', path: '/' },
  { icon: ClipboardList, label: 'Pedidos', path: '/orders' },
  { icon: PlusCircle, label: 'Novo', path: '/new-order', isPrimary: true },
  { icon: MessageCircle, label: 'Suporte', path: '/support' },
  { icon: User, label: 'Perfil', path: '/profile' },
];

const staffNavItems = [
  { icon: Home, label: 'Início', path: '/' },
  { icon: ClipboardList, label: 'OS', path: '/orders' },
  { icon: PlusCircle, label: 'Novo', path: '/new-order', isPrimary: true },
  { icon: ShoppingCart, label: 'Vendas', path: '/sales' },
  { icon: User, label: 'Perfil', path: '/profile' },
];

export const BottomNav = React.forwardRef<HTMLElement, object>(function BottomNav(_props, ref) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isStaff } = useAuth();
  const { unreadCount } = useUnreadMessages();
  const insideShell = useInsideAppShell();

  if (insideShell) return null;

  const navItems = isStaff ? staffNavItems : customerNavItems;

  return (
    <nav ref={ref} className="fixed bottom-0 left-0 right-0 z-50 safe-bottom">
      <div className="bg-card/90 backdrop-blur-xl border-t border-border/50 shadow-[0_-4px_20px_-4px_hsl(0_0%_0%/0.08)]">
        <div className="flex items-center justify-around h-[4.25rem] max-w-lg mx-auto px-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            const showBadge = item.path === '/orders' && unreadCount > 0;

            if (item.isPrimary) {
              return (
                <motion.button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className="flex flex-col items-center justify-center -mt-7 group"
                  whileTap={{ scale: 0.9 }}
                >
                  <motion.div 
                    className="w-14 h-14 rounded-full bg-gradient-primary shadow-glow flex items-center justify-center"
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.92 }}
                    transition={{ type: "spring", stiffness: 400, damping: 17 }}
                  >
                    <Icon className="w-6 h-6 text-primary-foreground" />
                  </motion.div>
                  <span className="text-[10px] font-bold text-primary mt-1 tracking-wide">
                    {item.label}
                  </span>
                </motion.button>
              );
            }

            return (
              <motion.button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={cn(
                  'flex flex-col items-center justify-center py-1.5 px-3 rounded-xl transition-colors min-w-[3.5rem] group relative',
                  isActive 
                    ? 'text-primary' 
                    : 'text-muted-foreground hover:text-foreground'
                )}
                whileTap={{ scale: 0.92 }}
              >
                <div className={cn(
                  'p-1.5 rounded-xl transition-all relative',
                  isActive && 'bg-primary/10'
                )}>
                  <motion.div
                    animate={isActive ? { scale: [1, 1.15, 1] } : {}}
                    transition={{ duration: 0.3 }}
                  >
                    <Icon className={cn(
                      'w-5 h-5 transition-all',
                      isActive && 'stroke-[2.5]'
                    )} />
                  </motion.div>
                  {showBadge && (
                    <motion.span 
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 500 }}
                    >
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </motion.span>
                  )}
                </div>
                <span className={cn(
                  'text-[10px] mt-0.5 transition-all',
                  isActive ? 'font-bold' : 'font-medium'
                )}>
                  {item.label}
                </span>
                {/* Active dot indicator */}
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute -bottom-0.5 w-1 h-1 rounded-full bg-primary"
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  />
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </nav>
  );
});
