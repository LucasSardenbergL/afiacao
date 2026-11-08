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
import { Input } from '@/components/ui/input';
import { track } from '@/lib/analytics';
import { diaMesData, diasAte, hojeBRT, opcoesRetorno, retornoPadrao, retornoValido, RETORNO_MAX_DIAS, somarDias } from '@/lib/radar/retorno';
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

/** O que a ficha precisa saber depois do registro (pacote G4): avança e limpa a nota só com ela gravada. */
export interface RegistroInfo {
  /** O servidor reconheceu o mesmo registro de < 2 min e não gravou nada novo. */
  deduped: boolean;
  /** A nota enviada está gravada (registro novo, ou a mesma nota já estava). Banco anterior ao pacote G: dedupe com
   *  nota = não gravada (a regra de antes). */
  notaGravada: boolean;
  /** O texto exato que foi enviado — a ficha só apaga o rascunho se o campo ainda tem ESTE texto. */
  notaEnviada: string | undefined;
}

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
 * Pacote G1: "Em conversa" pede a data de retorno (sugestão marcada, de hoje a 60 dias); o servidor devolve a data
 * efetiva também do "não atendeu" (3/7/30 dias) e o toast a diz. G4: a ficha só apaga a nota com `notaGravada`.
 *
 * Resposta tardia não age sobre OUTRA ficha (Codex, código 2026-10-20): a ficha avança ou fecha enquanto a RPC
 * está em voo — o contato fica gravado (o toast diz), mas o `onRegistrado` não dispara sobre o lead errado.
 */
export function RadarOutcomeMenu({
  cnpj,
  empresa,
  nota,
  onRegistrado,
  onDesfeito,
}: {
  cnpj: string;
  /** Dados do lead — "Virou cliente" só aparece habilitado com o vínculo Omie. */
  empresa?: RadarEmpresa;
  /** Nota opcional do contato (B4). */
  nota?: string;
  /** Depois do registro: `notaGravada` diz se a ficha pode apagar o texto e seguir (pacote G4). */
  onRegistrado?: (acao: AcaoContato, info: RegistroInfo) => void;
  /** O contato foi desfeito (o status voltou): quem guardou estado otimista sobre ele o descarta. */
  onDesfeito?: () => void;
}) {
  const reg = useRegistrarContatoRadar();
  const undo = useDesfazerContatoRadar();
  const { isImpersonating } = useImpersonation();
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [motivo, setMotivo] = useState('');
  // G1: o passo "Quando retomar?" do "em conversa". A sugestão vem marcada (a mesma data que o servidor usaria).
  const [pedirRetorno, setPedirRetorno] = useState(false);
  const [hoje, setHoje] = useState(() => hojeBRT());
  const [retorno, setRetorno] = useState(() => retornoPadrao(hojeBRT()));
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
  const desfazer = async (id: string, alvo: string) => {
    try {
      const u = await undo.mutateAsync(id);
      if (u.deleted && aindaNoAlvo(alvo)) onDesfeito?.();
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

  const abrirRetorno = () => {
    const h = hojeBRT();
    setHoje(h);
    setRetorno(retornoPadrao(h));
    setPedirRetorno(true);
  };

  const registrar = async (acao: AcaoContato, texto?: string, dataRetorno?: string) => {
    const alvo = cnpj;
    const notaFinal = texto?.trim() || undefined;
    try {
      const r = await reg.mutateAsync({ cnpj: alvo, acao, nota: notaFinal, retorno: dataRetorno });
      // Banco anterior ao pacote G não diz: a dedupe não gravava nada, então com nota ela NÃO foi gravada.
      const notaGravada = r.notaGravada ?? !(r.deduped && notaFinal);
      const volta = r.retornoEm ? ` · volta para você em ${diaMesData(r.retornoEm)}` : '';
      if (!r.deduped) {
        // A conversão confirmada não se desfaz (RD006): o cliente continua no Omie.
        if (acao === 'virou_cliente') toast.success(LABEL_OK[acao]);
        else toast.success(LABEL_OK[acao] + volta, { action: { label: 'Desfazer', onClick: () => void desfazer(r.id, alvo) } });
      }
      if (!notaGravada && notaFinal) {
        // Nada se perde: a ficha não apaga o texto nem avança (Codex, código 2026-11-06, P2; pacote G4).
        toast.warning('A nota não foi gravada', {
          description: 'Este desfecho já tinha sido registrado agora há pouco. A nota continua no campo.',
        });
      }
      if (aindaNoAlvo(alvo)) onRegistrado?.(acao, { deduped: r.deduped, notaGravada, notaEnviada: notaFinal });
    } catch (e) {
      // Recusas de REGRA (pela SQLSTATE, nunca pela mensagem): nada foi gravado e repetir não muda a resposta.
      const estado = sqlstateDe(e);
      if (estado === 'RD005') {
        toast.warning('"Virou cliente" vem do cadastro no Omie', {
          description: 'O Radar só marca cliente com o cadastro confirmado pelo Omie (Oben): marque "em conversa" e cadastre pela ficha.',
        });
      } else if (estado === 'RD008') {
        toast.warning('Data de retorno fora do prazo', {
          description: `Escolha entre hoje e ${RETORNO_MAX_DIAS} dias. Nada foi gravado; a nota continua no campo.`,
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
              <DropdownMenuItem key={a.acao} onClick={() => (a.acao === 'em_conversa' ? abrirRetorno() : void registrar(a.acao, nota))}>
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

      <AlertDialog open={pedirRetorno} onOpenChange={setPedirRetorno}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quando retomar a conversa?</AlertDialogTitle>
            <AlertDialogDescription>
              Na data, o lead volta para você no "Prospectar hoje" e no e-mail da semana. O atendimento fica com você até lá.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Sugestões de data">
            {opcoesRetorno(hoje).map((o) => (
              <Button key={o.rotulo} type="button" size="sm" variant={retorno === o.dia ? 'secondary' : 'outline'}
                aria-pressed={retorno === o.dia} onClick={() => setRetorno(o.dia)}>
                {o.rotulo} <span className="ml-1 text-xs text-muted-foreground font-tabular">{diaMesData(o.dia)}</span>
              </Button>
            ))}
          </div>
          <Input type="date" aria-label="Data de retorno" value={retorno} min={hoje} max={somarDias(hoje, RETORNO_MAX_DIAS)}
            onChange={(e) => setRetorno(e.target.value)} />
          {!retornoValido(retorno, hoje) && (
            <p className="text-xs text-status-warning" data-testid="radar-retorno-invalido">
              Escolha uma data entre hoje e {RETORNO_MAX_DIAS} dias.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={!retornoValido(retorno, hoje)}
              onClick={() => {
                track('radar.retorno_definido', { dias: diasAte(retorno, hoje), sugestao_aceita: retorno === retornoPadrao(hoje) });
                void registrar('em_conversa', nota, retorno);
              }}
            >
              Marcar em conversa
            </AlertDialogAction>
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
            <AlertDialogAction onClick={() => void registrar('descartado', motivo.trim() || nota)}>
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
