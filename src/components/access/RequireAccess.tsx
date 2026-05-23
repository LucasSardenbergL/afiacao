import type { ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAccess } from '@/hooks/useAccess';
import type { SectionId } from '@/lib/access/types';

interface Props {
  section: SectionId;
  children?: ReactNode;
  /** Pra onde redirecionar quando sem acesso. Default '/'. */
  redirectTo?: string;
}

/**
 * Guard de rota por seção de acesso. Bloqueia URL digitada na mão (não só esconde menu).
 * Enquanto carrega o acesso, não decide (evita flash de redirect). Use como wrapper de
 * grupo de rotas (com <Outlet/>) ou de uma rota única (com children).
 */
export function RequireAccess({ section, children, redirectTo = '/' }: Props) {
  const { loading, can } = useAccess();
  if (loading) return null;
  if (!can(section)) return <Navigate to={redirectTo} replace />;
  return <>{children ?? <Outlet />}</>;
}
