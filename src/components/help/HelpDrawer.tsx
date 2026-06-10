import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { HelpCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { getHelpMappingForRoute } from '@/lib/help-utils';

// O corpo (react-markdown + manuais .md em string) é pesado e raramente
// usado — carrega num chunk próprio só no primeiro open (ver HelpDrawerContent).
const HelpDrawerContent = lazy(() => import('./HelpDrawerContent'));

interface HelpDrawerProps {
  /** Override the route-based anchor */
  anchor?: string;
  /** Override the route-based module */
  module?: string;
  /** Custom trigger; defaults to a "?" icon button */
  trigger?: React.ReactNode;
}

const ContentSkeleton = () => (
  <>
    {/* espelha a barra "Ver documentação completa" — sem ela o conteúdo
        empurraria pra baixo quando o chunk carrega (layout shift) */}
    <div className="px-6 py-3 border-b border-border bg-muted/30">
      <Skeleton className="h-4 w-44" />
    </div>
    <div className="px-6 py-6 space-y-3">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  </>
);

/**
 * Side drawer that shows the contextual help section for the current route.
 */
export function HelpDrawer({ anchor, module, trigger }: HelpDrawerProps) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // Latch: monta o conteúdo no 1º open e MANTÉM montado — desmontar em
  // open=false faria o corpo sumir na hora enquanto o Sheet ainda anima o
  // slide-out (~300ms de drawer vazio). O chunk lazy continua carregando só
  // no primeiro uso.
  const [hasOpened, setHasOpened] = useState(false);
  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) setHasOpened(true);
  };

  const routeMapping = getHelpMappingForRoute(location.pathname);
  const resolvedModuleSlug = module ?? routeMapping.module;
  const resolvedAnchor = anchor ?? routeMapping.anchor;

  // ESC closes (Sheet handles it natively, kept here for completeness)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
            aria-label="Ajuda contextual"
          >
            <HelpCircle className="h-5 w-5" />
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md md:max-w-lg p-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b border-border flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-base font-semibold">Ajuda contextual</SheetTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(false)}
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </Button>
        </SheetHeader>

        {hasOpened && (
          <Suspense fallback={<ContentSkeleton />}>
            <HelpDrawerContent moduleSlug={resolvedModuleSlug} anchor={resolvedAnchor} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  );
}
