import { useEffect } from 'react';
import { Eye, X, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';
import { useImpersonationTargets } from '@/hooks/useImpersonationTargets';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function ImpersonationBanner() {
  const { isImpersonating, target, startImpersonation, stopImpersonation } = useImpersonation();
  const { user } = useAuth();
  const { data: perfil, isError } = useImpersonatedAccessProfile();
  const { data: targets = [] } = useImpersonationTargets();

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
  // Outras pessoas pra trocar direto pelo banner (a lista já exclui o próprio master).
  const outros = targets.filter((t) => t.id !== target.id);
  return (
    <div className="fixed top-0 inset-x-0 z-50 h-7 bg-status-warning-bold text-white text-xs flex items-center justify-center gap-3 px-3">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        Vendo como <strong>{target.nome}</strong>
        {contexto ? ` (${contexto})` : ''} · somente leitura · RLS: {user?.email ?? 'master'}
      </span>
      {outros.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1 underline shrink-0 outline-none">
            Trocar <ChevronDown className="w-3 h-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            {outros.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => startImpersonation(t, 'Troca via banner da lente')}>
                <span className="truncate">{t.nome}</span>
                {t.grupo && <span className="ml-2 text-2xs text-muted-foreground shrink-0">{t.grupo}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button onClick={() => stopImpersonation()} className="flex items-center gap-1 underline shrink-0">
        <X className="w-3.5 h-3.5" /> Sair
      </button>
    </div>
  );
}
