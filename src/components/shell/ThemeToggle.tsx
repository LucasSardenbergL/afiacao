import { useEffect, useState } from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Toggle de tema (light / dark / system) — montado no AppShell topbar.
 * Usa next-themes (já instalado). Persistência via localStorage automática.
 *
 * Morph animado: ícones Sun e Moon vivem sobrepostos; o ativo aparece com
 * scale+rotate, o outro recolhe. Sem swap brusco. (Vercel-ish pattern.)
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Alternar tema"
        >
          <Sun
            className={cn(
              'absolute w-4 h-4 transition-all duration-300',
              isDark ? 'opacity-0 scale-50 -rotate-90' : 'opacity-100 scale-100 rotate-0',
            )}
          />
          <Moon
            className={cn(
              'absolute w-4 h-4 transition-all duration-300',
              isDark ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 rotate-90',
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="w-4 h-4 mr-2" />
          Light
          {theme === 'light' && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="w-4 h-4 mr-2" />
          Dark
          {theme === 'dark' && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Monitor className="w-4 h-4 mr-2" />
          Sistema
          {theme === 'system' && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
