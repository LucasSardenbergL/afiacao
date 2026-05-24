import { useLocation, matchPath } from "react-router-dom";
import { ROUTE_CRUMBS, type RouteCrumb } from "@/lib/routeCrumbs";

export type Crumb = {
  crumb: string;
  href: string;
  isCurrent: boolean;
  backTo?: string;
  backLabel?: string;
};

function cleanPath(pathname: string): string {
  return pathname.split("?")[0].replace(/\/+$/, "") || "/";
}

/** Lista de prefixes acumulativos: "/a/b/c" -> ["/a","/a/b","/a/b/c"]. "/" -> ["/"]. */
function prefixesFor(pathname: string): string[] {
  if (pathname === "/") return ["/"];
  const segs = pathname.split("/").filter(Boolean);
  return segs.map((_, i) => `/${segs.slice(0, i + 1).join("/")}`);
}

/** Acha a entrada do registry que casa exatamente este prefixo (com :id dinâmico). */
function matchMeta(prefix: string): RouteCrumb | undefined {
  return ROUTE_CRUMBS.find((meta) => matchPath({ path: meta.path, end: true }, prefix));
}

/**
 * Resolve a trilha hierárquica de breadcrumbs para um pathname. Constrói os
 * prefixos do path e casa cada um contra o registry via matchPath (end:true),
 * que lida com segmentos dinâmicos (:id). Função pura — testável sem Router.
 */
export function resolveBreadcrumbs(pathname: string): Crumb[] {
  const clean = cleanPath(pathname);
  const trail = prefixesFor(clean)
    .map((href) => {
      const meta = matchMeta(href);
      return meta ? { meta, href } : null;
    })
    .filter((x): x is { meta: RouteCrumb; href: string } => x !== null);

  return trail.map(({ meta, href }, i, arr) => {
    const isCurrent = i === arr.length - 1;
    return {
      crumb: meta.crumb,
      href,
      isCurrent,
      backTo: isCurrent ? meta.backTo : undefined,
      backLabel: isCurrent ? meta.backLabel : undefined,
    };
  });
}

export function useBreadcrumbs(): Crumb[] {
  return resolveBreadcrumbs(useLocation().pathname);
}
