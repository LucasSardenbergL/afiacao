import { Eye, X } from 'lucide-react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';

export function ImpersonationBanner() {
  const { isImpersonating, target, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  const { data: perfil } = useImpersonatedAccessProfile();
  if (!isImpersonating || !target) return null;
  const contexto = [perfil?.commercialRole, perfil?.department].filter(Boolean).join(' · ');
  return (
    <div className="w-full bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 py-1 px-3">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Lente de navegação/leitura como <strong>{target.nome}</strong>
        {contexto ? ` (${contexto})` : ''} · escritas bloqueadas · RLS continua sendo {user?.email ?? 'master'}
      </span>
      <button onClick={() => stopImpersonation()} className="flex items-center gap-1 underline shrink-0">
        <X className="w-3.5 h-3.5" /> Sair
      </button>
    </div>
  );
}
