import { useState } from 'react';
import { toast } from 'sonner';
import { Building2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { cadastravelNoOmie, type MotivoNaoCadastravel } from '@/lib/radar/sugeridos';
import { lerLeadParaCadastro } from '@/queries/useRadarAcoesLead';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { useCadastroOmieComRecuperacao } from './useCadastroOmieComRecuperacao';

const MOTIVO_NAO_CADASTRAVEL: Record<MotivoNaoCadastravel, string> = {
  ja_cliente: 'Já é cliente do grupo — não precisa de cadastro novo.',
  ja_vinculado_omie: 'Já vinculado a um cliente no Omie.',
  rfb_nao_ativa: 'Situação na Receita não está ativa — o Omie não deve receber este cadastro.',
  cnpj_invalido: 'CNPJ fora do formato que o Omie aceita.',
};

/**
 * Cadastro no Omie (Oben) pela ficha. Pacote A4: o botão abria a confirmação mesmo com o lead já no Omie e não
 * conferia `cadastravelNoOmie` (um lead BAIXADO na RFB ia direto à edge). Agora:
 *  · já no Omie → só informa o código (nada a clicar);
 *  · não cadastrável → desabilitado, com o motivo ESCRITO (o `title` não aparece no toque);
 *  · confirmar → relê o lead (o snapshot da lista identifica o alvo, não prova elegibilidade) e cadastra pelo
 *    MESMO tratamento de resultado e recuperação do menu de contato (`useCadastroOmieComRecuperacao`).
 * O "Criar tarefa pra mim" saiu (A7): o módulo de tarefas está congelado até 10/01/2027.
 */
export function RadarAcoesLead({ empresa }: { empresa: RadarEmpresa }) {
  const { isImpersonating } = useImpersonation();
  const cadastro = useCadastroOmieComRecuperacao(empresa.cnpj);
  const [confirmOmie, setConfirmOmie] = useState(false);

  if (empresa.omie_codigo_cliente) {
    return (
      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="radar-ficha-no-omie">
        <Building2 className="w-3.5 h-3.5" /> No Omie (Oben) · cód. <span className="font-tabular">{empresa.omie_codigo_cliente}</span>
      </p>
    );
  }

  const veredito = cadastravelNoOmie(empresa);
  const ocupado = cadastro.cadastrando;

  // A releitura roda DENTRO da trava do cadastro (por CNPJ): confirmar de novo ou o retry de um toast antigo
  // durante ela não abre uma 2ª tentativa concorrente (Codex, código 2026-11-06, P2).
  const doCadastrar = () => {
    setConfirmOmie(false);
    void cadastro.executar(empresa, {
      verificar: async () => {
        const atual = await lerLeadParaCadastro(empresa.cnpj);
        const agora = atual ? cadastravelNoOmie(atual) : null;
        if (agora?.ok) return true;
        toast.info('Não cadastrei: o lead mudou', {
          description: agora ? MOTIVO_NAO_CADASTRAVEL[agora.motivo] : 'Não encontrei mais esta empresa no Radar.',
        });
        return false;
      },
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={isImpersonating || ocupado || !veredito.ok} onClick={() => setConfirmOmie(true)}
        title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}>
        {ocupado ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Building2 className="w-4 h-4 mr-1" />}
        Cadastrar no Omie (Oben)
      </Button>
      {!veredito.ok && (
        <span className="text-xs text-muted-foreground" data-testid="radar-ficha-nao-cadastravel">
          {MOTIVO_NAO_CADASTRAVEL[veredito.motivo]}
        </span>
      )}

      <AlertDialog open={confirmOmie} onOpenChange={setConfirmOmie}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar no Omie (Oben)?</AlertDialogTitle>
            <AlertDialogDescription>
              {empresa.razao_social || empresa.cnpj} será cadastrada como cliente na conta <strong>Oben</strong>.
              Se o CNPJ já existir lá, apenas reconcilia (marca como já-cliente). Não cadastra nas outras empresas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doCadastrar}>Cadastrar na Oben</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
