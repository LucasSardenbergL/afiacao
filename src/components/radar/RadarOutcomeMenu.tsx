import { useEffect, useRef, useState } from 'react';
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
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ACOES_CONTATO, type AcaoContato } from '@/lib/radar/ui-helpers';
import { sqlstateDe } from '@/lib/radar/conflito-cadastro';
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
 * Menu "Registrar contato" do lead. Pacote B6: marcar `em_conversa` NÃO abre mais a janela "Cadastrar no Omie
 * agora?" — ela interrompia toda conversa registrada. O cadastro virou ação CONTEXTUAL da ficha (RadarAcoesLead),
 * com a mesma confirmação manual e o mesmo tratamento de recuperação; quem decide avançar ou ficar na ficha
 * depois do registro é quem chama (`onRegistrado`).
 *
 * Pacote B4: `nota` (opcional, digitada na ficha) vai junto do registro — quem atendeu, o que precisa, próximo
 * passo. No descarte, o motivo do diálogo vence; sem motivo, a nota vale como motivo.
 *
 * Resposta tardia não age sobre OUTRA ficha (Codex, código 2026-10-20): a ficha avança ou fecha enquanto a RPC
 * está em voo — o contato fica gravado (o toast diz), mas o `onRegistrado` não dispara sobre o lead errado.
 */
export function RadarOutcomeMenu({
  cnpj,
  empresa,
  nota,
  onRegistrado,
}: {
  cnpj: string;
  /** Dados do lead — "Virou cliente" só aparece habilitado com o vínculo Omie. */
  empresa?: RadarEmpresa;
  /** Nota opcional do contato (B4). */
  nota?: string;
  onRegistrado?: (acao: AcaoContato) => void;
}) {
  const reg = useRegistrarContatoRadar();
  const undo = useDesfazerContatoRadar();
  const { isImpersonating } = useImpersonation();
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [motivo, setMotivo] = useState('');
  const cnpjAtualRef = useRef(cnpj);
  cnpjAtualRef.current = cnpj;
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => { montadoRef.current = false; };
  }, []);
  const aindaNoAlvo = (alvo: string) => montadoRef.current && cnpjAtualRef.current === alvo;

  // O servidor só restaura o status quando o contato desfeito ainda é o DONO dele (20261031111000). Removido sem
  // restaurar não é "desfeito": o lead mudou depois (outro vendedor, o cadastro, a RFB) e o status atual ficou.
  const desfazer = async (id: string) => {
    try {
      const u = await undo.mutateAsync(id);
      if (!u.deleted) toast.error('Não foi possível desfazer');
      else if (u.statusRestaurado === false) {
        toast.info('Registro removido; status preservado', {
          description: 'O lead mudou depois deste registro, e o status atual foi mantido.',
        });
      } else toast.success('Desfeito');
    } catch {
      toast.error('Não foi possível desfazer');
    }
  };

  const registrar = async (acao: AcaoContato, texto?: string) => {
    const alvo = cnpj;
    const notaFinal = texto?.trim() || undefined;
    try {
      const r = await reg.mutateAsync({ cnpj: alvo, acao, nota: notaFinal });
      if (!r.deduped) {
        // A conversão confirmada não se desfaz (RD006): o cliente continua no Omie.
        if (acao === 'virou_cliente') toast.success(LABEL_OK[acao]);
        else toast.success(LABEL_OK[acao], { action: { label: 'Desfazer', onClick: () => void desfazer(r.id) } });
      }
      if (aindaNoAlvo(alvo)) onRegistrado?.(acao);
    } catch (e) {
      // Recusas de REGRA (pela SQLSTATE, nunca pela mensagem): nada foi gravado e repetir não muda a resposta.
      const estado = sqlstateDe(e);
      if (estado === 'RD005') {
        toast.warning('"Virou cliente" vem do cadastro no Omie', {
          description: 'O Radar só marca cliente com o cadastro confirmado pelo Omie (Oben): marque "em conversa" e cadastre pela ficha.',
        });
      } else if (estado === 'RD007') {
        toast.warning('Já é cliente confirmado no Omie', {
          description: 'Só o gestor muda o status de um cliente cadastrado.',
        });
      } else {
        toast.error('Não foi possível registrar');
      }
    }
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
            // "Virou cliente" só com o vínculo Omie (o servidor exige a confirmação do ledger — RD005). Fica
            // visível e desabilitado para dizer o caminho: o cadastro pela ficha.
            if (a.acao === 'virou_cliente' && !empresa?.omie_codigo_cliente) {
              return (
                <DropdownMenuItem key={a.acao} disabled title="Vira cliente quando o cadastro no Omie (Oben) é confirmado">
                  <Icon className="w-4 h-4 mr-2" /> {a.label} (pelo cadastro no Omie)
                </DropdownMenuItem>
              );
            }
            return (
              <DropdownMenuItem key={a.acao} onClick={() => void registrar(a.acao, nota)}>
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
            <AlertDialogAction onClick={() => void registrar('descartado', motivo.trim() || nota)}>
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
