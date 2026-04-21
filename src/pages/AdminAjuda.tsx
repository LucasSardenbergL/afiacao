import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen, Printer, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { MarkdownContent } from '@/components/help/MarkdownContent';
import { helpModules, getHelpModule, defaultHelpModule } from '@/content/help';
import { extractToc, slugify } from '@/lib/help-utils';

export default function AdminAjuda() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSlug = searchParams.get('modulo') ?? defaultHelpModule.slug;
  const [activeSlug, setActiveSlug] = useState(initialSlug);
  const [search, setSearch] = useState('');
  const [activeAnchor, setActiveAnchor] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);

  const activeModule = getHelpModule(activeSlug) ?? defaultHelpModule;
  const toc = useMemo(() => extractToc(activeModule.content), [activeModule.content]);

  // Filter TOC by search
  const filteredToc = useMemo(() => {
    if (!search.trim()) return toc;
    const q = search.toLowerCase();
    return toc.filter((t) => t.text.toLowerCase().includes(q));
  }, [toc, search]);

  // Sync URL on module change
  useEffect(() => {
    if (activeSlug !== searchParams.get('modulo')) {
      const next = new URLSearchParams(searchParams);
      next.set('modulo', activeSlug);
      setSearchParams(next, { replace: true });
    }
  }, [activeSlug, searchParams, setSearchParams]);

  // Scroll to hash anchor on mount / hash change
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const t = setTimeout(() => {
      const el = document.getElementById(hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveAnchor(hash);
      }
    }, 100);
    return () => clearTimeout(t);
  }, [activeSlug]);

  // IntersectionObserver to highlight current section in TOC
  useEffect(() => {
    if (!contentRef.current) return;
    const headings = contentRef.current.querySelectorAll('h2, h3');
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveAnchor(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [activeModule.content]);

  const scrollToAnchor = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveAnchor(id);
      window.history.replaceState(null, '', `#${id}`);
    }
  };

  const handlePrint = () => window.print();

  // Highlight matched terms in content
  const displayContent = useMemo(() => {
    if (!search.trim()) return activeModule.content;
    // mark search hits with <mark> via simple replacement (avoid touching code blocks)
    const lines = activeModule.content.split('\n');
    let inCode = false;
    const safe = lines.map((line) => {
      if (line.trim().startsWith('```')) {
        inCode = !inCode;
        return line;
      }
      if (inCode) return line;
      const re = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      return line.replace(re, '<mark>$1</mark>');
    });
    return safe.join('\n');
  }, [activeModule.content, search]);

  return (
    <div className="flex h-[calc(100vh-var(--topbar-height,3.5rem))] -m-4 lg:-m-6 print:m-0 print:h-auto print:block">
      {/* Sidebar */}
      <aside className="hidden md:flex w-[260px] shrink-0 flex-col border-r border-border bg-card print:hidden">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-foreground">Documentação</h2>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-3 py-3">
            {/* Modules list */}
            <div className="mb-4">
              <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Módulos
              </div>
              {helpModules.map((m) => (
                <button
                  key={m.slug}
                  onClick={() => setActiveSlug(m.slug)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md text-sm transition-colors',
                    activeSlug === m.slug
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  {m.title}
                </button>
              ))}
            </div>

            {/* TOC */}
            <div>
              <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sumário
              </div>
              {filteredToc.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">Nenhum resultado.</p>
              ) : (
                filteredToc.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => scrollToAnchor(item.id)}
                    className={cn(
                      'w-full text-left rounded-md text-sm transition-colors block py-1',
                      item.level === 3 ? 'pl-6 pr-2 text-xs' : 'px-2',
                      activeAnchor === item.id
                        ? 'text-primary font-medium bg-primary/5'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                  >
                    {item.text}
                  </button>
                ))
              )}
            </div>
          </div>
        </ScrollArea>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden print:overflow-visible">
        <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-background print:hidden">
          <h1 className="text-base font-semibold text-foreground">{activeModule.title}</h1>
          <Button variant="outline" size="sm" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" />
            Imprimir
          </Button>
        </div>

        <ScrollArea className="flex-1 print:overflow-visible">
          <div ref={contentRef} className="mx-auto max-w-[800px] px-6 py-8 print:max-w-none print:py-2">
            <MarkdownContent content={displayContent} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
