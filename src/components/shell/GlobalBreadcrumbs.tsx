import { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs } from "@/hooks/useBreadcrumbs";

/**
 * Breadcrumb global, montado UMA vez no AppShell. Renderiza a trilha derivada
 * do registry de rotas (useBreadcrumbs). Fica oculto quando há 0 ou 1 nível
 * (página top-level não precisa de trilha — o sidebar já indica onde está).
 * Uma linha, baixo contraste, denso — não compete com o conteúdo.
 */
export function GlobalBreadcrumbs() {
  const crumbs = useBreadcrumbs();
  if (crumbs.length <= 1) return null;

  return (
    <Breadcrumb className="mb-3">
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
  );
}
