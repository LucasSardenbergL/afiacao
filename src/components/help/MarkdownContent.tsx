import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { cn } from '@/lib/utils';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * Renders markdown with GitHub-flavored extensions and slugged headings.
 * Wrapped in Tailwind Typography (`prose`) for consistent typography.
 */
export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        'prose prose-sm md:prose-base max-w-none',
        'prose-headings:scroll-mt-24 prose-headings:font-semibold prose-headings:text-foreground',
        'prose-h1:text-3xl prose-h1:mb-6 prose-h1:mt-0',
        'prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-b prose-h2:border-border prose-h2:pb-2',
        'prose-h3:text-xl prose-h3:mt-6 prose-h3:mb-3',
        'prose-h4:text-base prose-h4:mt-4 prose-h4:mb-2',
        'prose-p:text-foreground prose-p:leading-relaxed',
        'prose-strong:text-foreground prose-strong:font-semibold',
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
        'prose-code:text-foreground prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono prose-code:before:content-none prose-code:after:content-none',
        'prose-pre:bg-muted prose-pre:border prose-pre:border-border',
        'prose-ul:text-foreground prose-ol:text-foreground prose-li:text-foreground',
        'prose-blockquote:border-l-primary prose-blockquote:bg-muted/50 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:not-italic prose-blockquote:text-muted-foreground',
        'prose-hr:border-border',
        'prose-table:text-sm',
        'prose-th:bg-muted prose-th:text-foreground prose-th:font-semibold prose-th:px-3 prose-th:py-2 prose-th:border prose-th:border-border',
        'prose-td:px-3 prose-td:py-2 prose-td:border prose-td:border-border',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
