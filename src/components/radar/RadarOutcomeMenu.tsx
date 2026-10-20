import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, MessageCircle, PhoneMissed, Ban, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  useRegistrarContatoRadar,
  useDesfazerContatoRadar,
} from '@/queries/useRegistrarContatoRadar';
import { useRadarCadastrarOmie, lerLeadParaCadastro } from '@/queries/useRadarAcoesLead';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ACOES_CONTATO, type AcaoContato } from '@/lib/radar/ui-helpers';
import { cadastravelNoOmie } from '@/lib/radar/sugeridos';
import { FalhaCadastro, type OpcoesCadastro } from '@/lib/radar/cadastro-omie';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { track } from '@/lib/analytics';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const ICON_MAP = {
  message: MessageCircle,
  'phone-missed': PhoneMissed,
  check: CheckCircle2,
  ban: Ban,
} as const;

const LABEL_OK: Record<AcaoContato, string> = {
  em_conversa: 'Marcado: em conversa',
  contatado_sem_resposta: 'Marcado: não atendeu',
  virou_cliente: 'Marcado: virou cliente',
  descartado: 'Lead descartado',
};

type ResultadoPosSinal = 'sucesso' | 'ja_existia' | 'indeterminado' | 'erro' | 'lead_mudou';

/** A oferta aberta: o lead (SNAPSHOT) e o id do toast "Marcado: em conversa" (para tirar o Desfazer). */
interface Oferta { empresa: RadarEmpresa; toastId: string | number | null }

/**
 * Menu "Registrar contato" do lead. Com `empresa` em mãos (ficha), marcar `em_conversa` num lead
 * cadastrável OFERECE "Cadastrar no Omie (Oben) agora" — bloco 5: qualificação + aprovação em 1
 * clique, nunca cadastro silencioso. Sem `empresa` (card da rota) não há oferta: o payload do
 * cadastro precisa do endereço/telefone, não só do CNPJ.
 *
 * Parecer Codex (desenho, 2026-10-20) incorporado:
 *  · a oferta é consumida UMA vez, por ref síncrona — o clique em "Cadastrar agora" e o
 *    `onOpenChange(false)` do Radix chegam no mesmo tick e os dois viam `oferta` preenchida;
 *  · registro DEDUPLICADO (2 min) não oferece: o 1º clique já ofereceu e o status gravado pode
 *    não ser mais `em_conversa` (em_conversa → descartado → em_conversa em 2 min);
 *  · antes do efeito o lead é RELIDO (`lerLeadParaCadastro`): o snapshot identifica o alvo, não
 *    prova elegibilidade — um lote em outra aba pode tê-lo cadastrado, ou ele foi descartado;
 *  · aceitar o cadastro tira o "Desfazer" do toast do contato: desfazer o contato não desfaz o
 *    cadastro no Omie, e o rótulo mentiria;
 *  · falha na gravação do Radar com código Omie confirmado e resposta INDETERMINADA ganham
 *    "Tentar de novo" com `codigoConhecido`/`retentativa` de verdade (a lib relê o vínculo antes
 *    de tocar o Omie) — não um "repita pela ficha" que não fazia isso.
 */
export function RadarOutcomeMenu({
  cnpj,
  empresa,
  onRegistrado,
}: {
  cnpj: string;
  /** Dados do lead — habilita a oferta pós-sinal. */
  empresa?: RadarEmpresa;
  onRegistrado?: (acao: AcaoContato) => void;
}) {
  const reg = useRegistrarContatoRadar();
  const undo = useDesfazerContatoRadar();
  const cadastrar = useRadarCadastrarOmie();
  const { isImpersonating } = useImpersonation();
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [motivo, setMotivo] = useState('');
  // State abre/fecha o diálogo; a REF é a verdade de "ainda há oferta a responder" (síncrona).
  const [ofertaAberta, setOfertaAberta] = useState<Oferta | null>(null);
  const ofertaRef = useRef<Oferta | null>(null);
  const [cadastrando, setCadastrando] = useState(false);

  const registrar = async (acao: AcaoContato, nota?: string) => {
    try {
      const r = await reg.mutateAsync({ cnpj, acao, nota });
      let toastId: string | number | null = null;
      if (!r.deduped) {
        toastId = toast.success(LABEL_OK[acao], {
          action: {
            label: 'Desfazer',
            onClick: async () => {
              const u = await undo.mutateAsync(r.id);
              toast[u.deleted ? 'success' : 'error'](
                u.deleted ? 'Desfeito' : 'Não foi possível desfazer',
              );
            },
          },
        });
      }
      // Sinal comercial num lead cadastrável: oferece o cadastro e ADIA o avanço da ficha até o
      // gestor responder. Registro que falhou nunca chega aqui; deduplicado não reoferece.
      if (acao === 'em_conversa' && !r.deduped && empresa && cadastravelNoOmie(empresa).ok) {
        const oferta: Oferta = { empresa, toastId };
        ofertaRef.current = oferta;
        setOfertaAberta(oferta);
      } else {
        onRegistrado?.(acao);
      }
    } catch {
      toast.error('Não foi possível registrar');
    }
  };

  const registrarResultado = (resultado: ResultadoPosSinal) =>
    track('radar.cadastro_pos_sinal_resultado', { resultado, origem: 'ficha' });

  const executarCadastro = async (alvo: RadarEmpresa, opcoes?: OpcoesCadastro) => {
    setCadastrando(true);
    try {
      const atual = await lerLeadParaCadastro(alvo.cnpj);
      const elegivel = atual != null && atual.prospeccao_status === 'em_conversa' && cadastravelNoOmie(atual).ok;
      if (!elegivel) {
        registrarResultado('lead_mudou');
        toast.info('Não cadastrei: o lead mudou desde o sinal', {
          description: atual == null ? 'Não encontrei mais esta empresa no Radar.'
            : atual.ja_cliente || atual.omie_codigo_cliente ? 'Já consta como cliente / vinculado ao Omie.'
            : atual.prospeccao_status !== 'em_conversa' ? `Status atual: ${atual.prospeccao_status ?? '—'} (não é mais "em conversa").`
            : 'Situação cadastral na RFB não está ativa.',
        });
        return;
      }
      const r = await cadastrar.mutateAsync({ empresa: alvo, opcoes });
      registrarResultado(r.jaExistia ? 'ja_existia' : 'sucesso');
      toast.success(
        r.jaExistia ? `Já era cliente no Omie (Oben) — reconciliado · cód. ${r.codigo}` : `Cadastrado no Omie (Oben) · cód. ${r.codigo}`,
        { description: alvo.razao_social ?? alvo.cnpj },
      );
    } catch (e) {
      const msg = mensagemDeErro(e) ?? 'erro desconhecido';
      if (/OMIE_RESPOSTA_INDETERMINADA/.test(msg)) {
        // INDETERMINADO ≠ erro: o Omie pode ter criado sem devolver o código. Nada foi gravado no
        // Radar (o lead segue na fila); a retentativa RELÊ o vínculo antes de tocar o Omie.
        registrarResultado('indeterminado');
        toast.warning('Cadastro não confirmado pelo Omie', {
          description: 'O Omie não devolveu o código do cliente. O lead continua na fila.',
          action: { label: 'Tentar de novo', onClick: () => void executarCadastro(alvo, { retentativa: true }) },
        });
      } else if (e instanceof FalhaCadastro && e.etapa === 'radar' && e.codigo) {
        registrarResultado('erro');
        const codigo = e.codigo;
        toast.error(`Cadastrado no Omie (cód. ${codigo}), mas o Radar não gravou o vínculo`, {
          description: msg,
          action: { label: 'Gravar de novo', onClick: () => void executarCadastro(alvo, { codigoConhecido: codigo }) },
        });
      } else {
        registrarResultado('erro');
        toast.error('Não foi possível cadastrar', { description: msg });
      }
    } finally {
      setCadastrando(false);
    }
  };

  /** Consome a oferta UMA vez (clique e fechamento do Radix chegam juntos). */
  const responderOferta = async (aceitou: boolean) => {
    const oferta = ofertaRef.current;
    ofertaRef.current = null;
    setOfertaAberta(null);
    if (!oferta) return;
    track('radar.cadastro_pos_sinal', { aceitou, origem: 'ficha' });
    if (aceitou) {
      if (oferta.toastId != null) toast.dismiss(oferta.toastId); // "Desfazer" o contato não desfaz o Omie
      await executarCadastro(oferta.empresa);
    }
    onRegistrado?.('em_conversa');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={reg.isPending || cadastrando || isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Registrar contato'}
          >
            <ClipboardCheck className="w-4 h-4 mr-2" /> Registrar contato
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {ACOES_CONTATO.filter((a) => !a.confirmar).map((a) => {
            const Icon = ICON_MAP[a.icon];
            return (
              <DropdownMenuItem key={a.acao} onClick={() => registrar(a.acao)}>
                <Icon className="w-4 h-4 mr-2" /> {a.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-status-error"
            onClick={() => {
              setMotivo('');
              setConfirmDescartar(true);
            }}
          >
            <Ban className="w-4 h-4 mr-2" /> Descartar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={ofertaAberta != null} onOpenChange={(o) => { if (!o) void responderOferta(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar no Omie (Oben) agora?</AlertDialogTitle>
            <AlertDialogDescription>
              {ofertaAberta?.empresa.razao_social ?? ofertaAberta?.empresa.cnpj} entrou em conversa e ainda não é cliente.
              Um clique cria o cadastro na Oben (anti-duplicata pelo CNPJ) e tira o lead da fila. Nada é cadastrado
              sem este clique.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => void responderOferta(false)}>Agora não</AlertDialogCancel>
            <AlertDialogAction onClick={() => void responderOferta(true)}>Cadastrar agora</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDescartar} onOpenChange={setConfirmDescartar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar este lead?</AlertDialogTitle>
            <AlertDialogDescription>
              Sai da fila de prospecção. Você pode anotar o motivo (opcional).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo (opcional)"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => registrar('descartado', motivo || undefined)}>
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
