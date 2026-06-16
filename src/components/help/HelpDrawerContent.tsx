import { ExternalLink } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownContent } from './MarkdownContent';
import { getHelpModule, defaultHelpModule } from '@/content/help';
import { extractSection, slugify } from '@/lib/help-utils';

interface HelpDrawerContentProps {
  moduleSlug: string;
  anchor: string;
}

/**
 * Corpo pesado do HelpDrawer: pipeline react-markdown/remark/rehype + os
 * manuais `.md` inteiros em string (via `?raw`). Vive num chunk próprio,
 * carregado por React.lazy SÓ no primeiro open do drawer — antes entrava no
 * chunk inicial do app (~50KB gzip de markdown + ~60KB de manuais) pra um
 * drawer que raramente abre.
 */
export default function HelpDrawerContent({ moduleSlug, anchor }: HelpDrawerContentProps) {
  const activeModule = getHelpModule(moduleSlug) ?? defaultHelpModule;
  const sectionContent = extractSection(activeModule.content, anchor);

  const fullDocsUrl = `/admin/ajuda?modulo=${activeModule.slug}#${slugify(
    sectionContent.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? anchor,
  )}`;

  return (
    <>
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
    </>
  );
}
