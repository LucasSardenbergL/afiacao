import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  variant?: 'default' | 'subtle';
}

export function EmptyState({ icon: Icon, title, description, actionLabel, onAction, className, variant = 'default' }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6',
        variant === 'default' && 'bg-card rounded-2xl border border-border shadow-soft',
        className
      )}
    >
      <motion.div
        className="w-20 h-20 rounded-3xl bg-muted flex items-center justify-center mb-5 relative"
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      >
        <Icon className="w-9 h-9 text-muted-foreground" />
        {/* Decorative dots */}
        <div className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-primary/20" />
        <div className="absolute -bottom-2 -left-1 w-2 h-2 rounded-full bg-primary/10" />
      </motion.div>

      <h3 className="font-display font-bold text-lg text-foreground mb-1.5">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-[260px] leading-relaxed mb-6">
        {description}
      </p>

      {actionLabel && onAction && (
        <motion.div whileTap={{ scale: 0.97 }}>
          <Button size="lg" onClick={onAction} className="shadow-glow rounded-xl font-semibold">
            {actionLabel}
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
