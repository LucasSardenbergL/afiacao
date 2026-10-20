import { useState } from 'react';
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
import { useRadarCadastrarOmie } from '@/queries/useRadarAcoesLead';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ACOES_CONTATO, type AcaoContato } from '@/lib/radar/ui-helpers';
import { elegivelCadastroPosSinal } from '@/lib/radar/sugeridos';
import { FalhaCadastro } from '@/lib/radar/cadastro-omie';
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

/**
 * Menu "Registrar contato" do lead. Com `empresa` em mãos (ficha), marcar `em_conversa` num lead
 * cadastrável OFERECE "Cadastrar no Omie (Oben) agora" — bloco 5: qualificação + aprovação em 1
 * clique, nunca cadastro silencioso. Sem `empresa` (card da rota) não há oferta: o payload do
 * cadastro precisa do endereço/telefone, não só do CNPJ.
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
  // SNAPSHOT do lead ofertado: a ficha pode trocar de lead (onProximo) enquanto o diálogo está
  // aberto — o clique cadastra ESTE, nunca a `empresa` corrente da prop.
  const [oferta, setOferta] = useState<RadarEmpresa | null>(null);

  const registrar = async (acao: AcaoContato, nota?: string) => {
    try {
      const r = await reg.mutateAsync({ cnpj, acao, nota });
      // Sinal comercial num lead cadastrável: oferece o cadastro e ADIA o avanço da ficha até o
      // gestor responder (aceitar ou não). Registro que falhou nunca chega aqui.
      if (acao === 'em_conversa' && empresa && elegivelCadastroPosSinal(empresa)) {
        setOferta(empresa);
      } else {
        onRegistrado?.(acao);
      }
      if (!r.deduped) {
        toast.success(LABEL_OK[acao], {
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
    } catch {
      toast.error('Não foi possível registrar');
    }
  };

  const responderOferta = async (aceitou: boolean) => {
    const alvo = oferta;
    setOferta(null);
    if (!alvo) return;
    track('radar.cadastro_pos_sinal', { aceitou, origem: 'ficha' });
    if (aceitou) {
      try {
        const r = await cadastrar.mutateAsync({ empresa: alvo });
        toast.success(
          r.jaExistia ? `Já era cliente no Omie (Oben) — reconciliado · cód. ${r.codigo}` : `Cadastrado no Omie (Oben) · cód. ${r.codigo}`,
          { description: alvo.razao_social ?? alvo.cnpj },
        );
      } catch (e) {
        const msg = mensagemDeErro(e) ?? 'erro desconhecido';
        if (/OMIE_RESPOSTA_INDETERMINADA/.test(msg)) {
          // Resultado INDETERMINADO ≠ erro: o Omie pode ter criado sem devolver o código. O lead
          // fica na fila (nada foi gravado no Radar) — conferir no Omie antes de repetir.
          toast.warning('Cadastro não confirmado pelo Omie', { description: 'O Omie não devolveu o código do cliente. O lead continua na fila — confira no Omie (Oben) antes de repetir.' });
        } else if (e instanceof FalhaCadastro && e.etapa === 'radar' && e.codigo) {
          toast.error(`Cadastrado no Omie (cód. ${e.codigo}), mas o Radar não gravou o vínculo`, { description: `${msg}. Repita pela ficha: a retomada relê o vínculo antes de tocar o Omie.` });
        } else {
          toast.error('Não foi possível cadastrar', { description: msg });
        }
      }
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
            disabled={reg.isPending || isImpersonating}
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

      <AlertDialog open={oferta != null} onOpenChange={(o) => { if (!o) void responderOferta(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cadastrar no Omie (Oben) agora?</AlertDialogTitle>
            <AlertDialogDescription>
              {oferta?.razao_social ?? oferta?.cnpj} entrou em conversa e ainda não é cliente. Um clique cria o cadastro na Oben
              (anti-duplicata pelo CNPJ) e tira o lead da fila. Nada é cadastrado sem este clique.
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
