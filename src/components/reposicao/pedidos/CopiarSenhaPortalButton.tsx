import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Mensagem para o toast a partir do erro da RPC — NUNCA contém a senha (a RPC só devolve a senha no
 * sucesso). Os prefixos são os RAISE de `sayerlack_senha_portal_copiar` (migration 20261120160000).
 */
export function mensagemErroCopiarSenha(erro: { message?: string } | null | undefined): string {
  const m = erro?.message ?? '';
  if (m.includes('TROCA_EM_ANDAMENTO')) return 'A senha do portal está sendo trocada agora. Tente de novo em alguns minutos.';
  if (m.includes('SEM_SENHA_NO_VAULT')) return 'A senha do portal ainda não está no Vault.';
  if (m.includes('APENAS_MASTER')) return 'Só o master pode copiar a senha do portal.';
  return 'Não foi possível copiar a senha do portal.';
}

/**
 * "Copiar senha do portal" — só master. Lê a senha ATIVA do Vault pela RPC (que audita quem leu) e põe na área
 * de transferência. A senha nunca vai para tela, toast, console nem analytics.
 */
export function CopiarSenhaPortalButton() {
  const { isMaster } = useAuth();
  const [copiando, setCopiando] = useState(false);
  if (!isMaster) return null;

  const copiar = async () => {
    setCopiando(true);
    try {
      const { data, error } = await supabase.rpc('sayerlack_senha_portal_copiar');
      if (error || typeof data !== 'string' || data.length === 0) {
        toast.error(mensagemErroCopiarSenha(error));
        return;
      }
      try {
        await navigator.clipboard.writeText(data);
      } catch {
        toast.error('O navegador não deixou copiar para a área de transferência.');
        return;
      }
      toast.success('Senha copiada');
    } finally {
      setCopiando(false);
    }
  };

  return (
    <Button size="sm" variant="outline" onClick={() => void copiar()} disabled={copiando} data-testid="copiar-senha-portal">
      <KeyRound className="w-3.5 h-3.5 mr-1" aria-hidden />
      Copiar senha do portal
    </Button>
  );
}
