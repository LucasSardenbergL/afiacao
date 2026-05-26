import { Eye, X } from 'lucide-react';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';

export function ImpersonationBanner() {
  const { isImpersonating, target, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  if (!isImpersonating || !target) return null;
  return (
    <div className="w-full bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 py-1 px-3">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Vendo como <strong>{target.nome}</strong> · você é {user?.email ?? 'master'} — <strong>somente leitura</strong>
      </span>
      <button onClick={() => stopImpersonation()} className="flex items-center gap-1 underline shrink-0">
        <X className="w-3.5 h-3.5" /> Sair
      </button>
    </div>
  );
}
