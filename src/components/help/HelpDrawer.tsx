import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { HelpCircle, X, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownContent } from './MarkdownContent';
import { defaultHelpModule } from '@/content/help';
import { extractSection, getHelpAnchorForRoute, slugify } from '@/lib/help-utils';

interface HelpDrawerProps {
  /** Override the route-based anchor */
  anchor?: string;
  /** Custom trigger; defaults to a "?" icon button */
  trigger?: React.ReactNode;
}

/**
 * Side drawer that shows the contextual help section for the current route.
 */
export function HelpDrawer({ anchor, trigger }: HelpDrawerProps) {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  const resolvedAnchor = anchor ?? getHelpAnchorForRoute(location.pathname);
  const sectionContent = extractSection(defaultHelpModule.content, resolvedAnchor);

  // ESC closes (Sheet handles it natively, kept here for completeness)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const fullDocsUrl = `/admin/ajuda?modulo=${defaultHelpModule.slug}#${slugify(
    sectionContent.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? resolvedAnchor,
  )}`;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
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

        <div className="px-6 py-3 border-b border-border bg-muted/30">
          <a
            href={fullDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Ver documentação completa
          </a>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-6 py-6">
            {sectionContent ? (
              <MarkdownContent content={sectionContent} className="prose-sm" />
            ) : (
              <p className="text-sm text-muted-foreground">
                Nenhuma seção de ajuda encontrada para esta tela.
              </p>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
