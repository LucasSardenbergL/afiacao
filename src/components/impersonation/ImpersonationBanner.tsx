import { useEffect } from 'react';
import { Eye, X } from 'lucide-react';
import { toast } from 'sonner';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';

export function ImpersonationBanner() {
  const { isImpersonating, target, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  const { data: perfil, isError } = useImpersonatedAccessProfile();

  // Auto-saída em falha PERSISTENTE da RPC get_user_access_profile_for: sem o perfil
  // do alvo a lente não reflete o acesso dele (rebaixaria fail-closed e confundiria).
  // Sai da lente e avisa, em vez de deixar um menu vazio. isError só dispara depois
  // dos retries do React Query (blip transitório se auto-recupera, não chega aqui).
  // Mount único (banner no AppShell) → um toast por falha; isImpersonating vira false
  // no render seguinte, então o guard impede toast duplicado.
  useEffect(() => {
    if (isImpersonating && isError) {
      toast.error('Não foi possível carregar a visão dessa pessoa. Saindo da lente.');
      void stopImpersonation();
    }
  }, [isImpersonating, isError, stopImpersonation]);

  if (!isImpersonating || !target) return null;
  const contexto = [perfil?.commercialRole, perfil?.department].filter(Boolean).join(' · ');
  return (
    <div className="fixed top-0 inset-x-0 z-50 h-7 bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 px-3">
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
