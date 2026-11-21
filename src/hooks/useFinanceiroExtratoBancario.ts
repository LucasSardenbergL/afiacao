import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMutationComRegistro } from '@/components/execucoes/useMutationComRegistro';
import { ACAO_IMPORTAR_EXTRATO } from '@/components/financeiro/extrato/UploadExtrato';
import { track } from '@/lib/analytics';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import {
  ErroAncora,
  ErroEnvioExtrato,
  enviarExtrato,
  listarAncoras,
  listarArquivos,
  listarContasBancarias,
  marcarConferido,
  registrarAncoraManual,
  resumoDia,
  textoDoMotivoDesconhecido,
  type BancoConta,
  type RespostaImport,
} from '@/services/financeiroExtratoBancario';

const CHAVE = ['financeiro', 'extrato-bancario'] as const;

export function useContasBancarias() {
  return useQuery({ queryKey: [...CHAVE, 'contas'], queryFn: listarContasBancarias });
}

export function useArquivosExtrato(contaId: string | null) {
  return useQuery({
    queryKey: [...CHAVE, 'arquivos', contaId],
    queryFn: () => listarArquivos(contaId as string),
    enabled: contaId !== null,
  });
}

export function useAncorasConta(contaId: string | null) {
  return useQuery({
    queryKey: [...CHAVE, 'ancoras', contaId],
    queryFn: () => listarAncoras(contaId as string),
    enabled: contaId !== null,
  });
}

function avisarErroAncora(e: unknown): void {
  if (e instanceof ErroAncora) {
    toast.error(e.message);
    return;
  }
  toast.error(`Falha ao registrar o saldo de referência: ${mensagemDeErro(e) ?? 'erro desconhecido'}`);
}

/** Escrita com a identidade REAL da sessão (a RPC usa auth.uid()); na lente "Ver como" o write-guard bloqueia. */
export function useRegistrarAncora(contaId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { data: string; saldoCentavos: number }) => {
      if (contaId === null) throw new Error('Escolha uma conta bancária.');
      return registrarAncoraManual(contaId, v.data, v.saldoCentavos);
    },
    onSuccess: () => {
      toast.success('Saldo de referência registrado. Se havia um extrato pendente, agora reenvie o arquivo.');
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: avisarErroAncora,
  });
}

export function useResumoDiarioExtrato(contaId: string | null, de: string, ate: string) {
  return useQuery({
    queryKey: [...CHAVE, 'resumo', contaId, de, ate],
    queryFn: () => resumoDia(contaId as string, de, ate),
    enabled: contaId !== null,
  });
}

/** Toast por status/motivo (texto pt-BR). Falha de infra nunca é apresentada como "arquivo recusado". */
function avisarResultadoImport(r: RespostaImport): void {
  const motivo = textoDoMotivoDesconhecido(r.motivo);
  switch (r.status) {
    case 'aceito':
      toast.success(`Extrato importado: ${r.qtdLinhasNovas ?? 0} linha(s) nova(s).`);
      return;
    case 'ja_importado':
      toast.info('Este arquivo já tinha sido importado. Nada mudou.');
      return;
    case 'pendente_revisao':
      toast.warning(motivo ?? 'Extrato pendente de revisão.');
      return;
    case 'recusado':
      toast.error(motivo ?? 'Extrato recusado.');
      return;
    default: {
      const _nunca: never = r.status;
      return _nunca;
    }
  }
}

function avisarErroEnvio(e: unknown): void {
  if (e instanceof ErroEnvioExtrato) {
    switch (e.classe) {
      case 'parse':
        toast.error(`Arquivo recusado: ${textoDoMotivoDesconhecido(e.motivo) ?? e.message}`);
        return;
      case 'interno':
        toast.error('Falha interna ao importar o extrato. Avise o suporte.');
        return;
      case 'acesso':
        toast.error(e.message);
        return;
      case 'requisicao':
        toast.error(e.message);
        return;
      default: {
        const _nunca: never = e.classe;
        return _nunca;
      }
    }
  }
  toast.error(`Falha ao importar o extrato: ${mensagemDeErro(e) ?? 'erro desconhecido'}`);
}

export function useImportarExtrato(conta: BancoConta | null) {
  const qc = useQueryClient();
  return useMutationComRegistro<RespostaImport, File>({
    acao: ACAO_IMPORTAR_EXTRATO,
    mutationFn: (file) => {
      if (!conta) throw new Error('Escolha uma conta bancária.');
      return enviarExtrato(file, conta);
    },
    detalhes: (r) => ({ status: r.status, linhas_novas: r.qtdLinhasNovas }),
    onSuccess: (r) => {
      avisarResultadoImport(r);
      if (r.status === 'aceito' && r.arquivoId) {
        track('banco.extrato_importado', { status: r.status, linhas_novas: r.qtdLinhasNovas ?? 0 });
        void registrarNoLedger('banco.extrato_importado', r.arquivoId, { linhas_novas: r.qtdLinhasNovas });
      }
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: avisarErroEnvio,
  });
}

export function useMarcarConferido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arquivoId: string) => marcarConferido(arquivoId).then(() => arquivoId),
    onSuccess: (arquivoId) => {
      toast.success('Extrato marcado como conferido.');
      track('banco.extrato_conferido', { arquivo_id: arquivoId });
      void registrarNoLedger('banco.extrato_conferido', arquivoId);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (e) => toast.error(`Falha ao marcar como conferido: ${mensagemDeErro(e) ?? 'erro desconhecido'}`),
  });
}
