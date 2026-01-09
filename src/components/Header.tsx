import { ArrowLeft, Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface HeaderProps {
  title?: string;
  showBack?: boolean;
  showNotifications?: boolean;
  transparent?: boolean;
  className?: string;
  rightElement?: React.ReactNode;
}

export function Header({
  title,
  showBack = false,
  showNotifications = false,
  transparent = false,
  className,
  rightElement,
}: HeaderProps) {
  const navigate = useNavigate();

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-40 safe-top',
        transparent ? 'bg-transparent' : 'bg-background/80 backdrop-blur-lg border-b border-border',
        className
      )}
    >
      <div className="flex items-center justify-between h-14 px-4 max-w-lg mx-auto">
        <div className="w-10">
          {showBack && (
            <button
              onClick={() => navigate(-1)}
              className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-muted transition-smooth"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
        </div>

        {title && (
          <h1 className="font-display font-bold text-lg text-foreground">
            {title}
          </h1>
        )}

        <div className="w-10 flex justify-end">
          {showNotifications && (
            <button className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-muted transition-smooth relative">
              <Bell className="w-5 h-5" />
              <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full" />
            </button>
          )}
          {rightElement}
        </div>
      </div>
    </header>
  );
}
