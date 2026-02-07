import { Home, PlusCircle, ClipboardList, User, MessageCircle } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

const navItems = [
  { icon: Home, label: 'Início', path: '/' },
  { icon: ClipboardList, label: 'Pedidos', path: '/orders' },
  { icon: PlusCircle, label: 'Novo', path: '/new-order', isPrimary: true },
  { icon: MessageCircle, label: 'Suporte', path: '/support' },
  { icon: User, label: 'Perfil', path: '/profile' },
];

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-lg border-t border-border safe-bottom">
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto px-2">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;

          if (item.isPrimary) {
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className="flex flex-col items-center justify-center -mt-6 group"
              >
                <div className="w-14 h-14 rounded-full bg-gradient-primary shadow-glow flex items-center justify-center group-hover:scale-105 group-active:scale-95 transition-transform">
                  <Icon className="w-6 h-6 text-primary-foreground" />
                </div>
                <span className="text-[10px] font-semibold text-primary mt-1">
                  {item.label}
                </span>
              </button>
            );
          }

          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                'flex flex-col items-center justify-center py-2 px-3 rounded-xl transition-all min-w-[4rem] group',
                isActive 
                  ? 'text-primary' 
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <div className={cn(
                'p-1.5 rounded-lg transition-colors',
                isActive && 'bg-primary/10'
              )}>
                <Icon className={cn(
                  'w-5 h-5 transition-all',
                  isActive && 'stroke-[2.5]'
                )} />
              </div>
              <span className={cn(
                'text-[10px] mt-0.5 transition-all',
                isActive ? 'font-semibold' : 'font-medium'
              )}>
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
