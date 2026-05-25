import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs } from "@/hooks/useBreadcrumbs";

/**
 * Breadcrumb global + "voltar" contextual, montado UMA vez no AppShell.
 * - Breadcrumb: trilha derivada do registry (useBreadcrumbs). Oculto com <=1 nível.
 * - Voltar: só aparece quando a folha tem backTo (páginas de detalhe/criação).
 *   Usa destino explícito (não navigate(-1), que é imprevisível após deep-link/
 *   reload/redirect).
 */
export function GlobalBreadcrumbs() {
  const crumbs = useBreadcrumbs();
  if (crumbs.length === 0) return null;

  const leaf = crumbs[crumbs.length - 1];
  const showBack = !!leaf.backTo;
  if (crumbs.length <= 1 && !showBack) return null;

  return (
    <div className="mb-3 space-y-2">
      {showBack && (
        <Link
          to={leaf.backTo!}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {leaf.backLabel ?? "Voltar"}
        </Link>
      )}
      {crumbs.length > 1 && (
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <Fragment key={c.href}>
                <BreadcrumbItem>
                  {c.isCurrent ? (
                    <BreadcrumbPage>{c.crumb}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={c.href}>{c.crumb}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {i < crumbs.length - 1 && <BreadcrumbSeparator />}
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
    </div>
  );
}
