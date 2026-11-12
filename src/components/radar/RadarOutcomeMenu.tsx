import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { onlineManager } from '@tanstack/react-query';
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
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { textoPosseDoContato } from '@/lib/radar/atendimento';
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
 *
 * Revisão 2026-11-11 (item 2): os diálogos ("Quando retomar?", "Descartar") só fecham com o servidor CONFIRMANDO. Antes
 * o `AlertDialogAction` fechava no clique, a falha virava um toast genérico e reabrir o descarte apagava o motivo
 * digitado. Agora: o botão fica em "Gravando…", a falha aparece DENTRO do diálogo (`mensagemDeErro`) com "Tentar de
 * novo", o motivo só some quando o descarte grava, e sem rede o texto é próprio — nada é enviado (a mutação ficaria
 * pausada sem resposta). Item 21: o "hoje" é o da PÁGINA (`hojeISO`) e "Amanhã" respeita o dia útil.
 */
export function RadarOutcomeMenu({
  cnpj,
  empresa,
  nota,
  onRegistrado,
  onDesfeito,
  hojeISO,
  variante = 'menu',
}: {
  cnpj: string;
  /** Dia BRT da página (`useHojeBRT`). Ausente: o dia BRT pelo relógio do aparelho, na hora de abrir. */
  hojeISO?: string;
  /** 'botoes' (modo discagem, revisão 2026-11-11, item 11): os desfechos da ligação como botões diretos — um toque, não
   *  abrir um menu a cada lead. 'menu' (padrão): o dropdown "Registrar contato". */
  variante?: 'menu' | 'botoes';
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
  /** Falha do último envio feito por um diálogo — fica nele, ao lado do "Tentar de novo". */
  const [falhaDialogo, setFalhaDialogo] = useState<string | null>(null);
  // G1: o passo "Quando retomar?" do "em conversa". A sugestão vem marcada (a mesma data que o servidor usaria).
  const [pedirRetorno, setPedirRetorno] = useState(false);
  const diaDaPagina = () => hojeISO ?? hojeBRT();
  const [hoje, setHoje] = useState(diaDaPagina);
  const [retorno, setRetorno] = useState(() => retornoPadrao(diaDaPagina()));
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
      const u = await undo.mutateAsync({ id, cnpj: alvo });
      if (u.deleted && aindaNoAlvo(alvo)) onDesfeito?.();
      if (!u.deleted) toast.error('Não foi possível desfazer');
      else if (u.statusRestaurado === false) {
        toast.info('Registro removido; status preservado', {
          description: 'O lead mudou depois deste registro, e o status atual foi mantido.',
        });
      } else if (u.posseDesfeita) toast.success('Desfeito', { description: 'O lead voltou a ficar livre.' });
      else toast.success('Desfeito');
    } catch (e) {
      toast.error('Não foi possível desfazer', {
        description: descreverFalha(e),
        action: { label: 'Tentar de novo', onClick: () => void desfazer(id, alvo) },
      });
    }
  };

  const abrirRetorno = () => {
    const h = diaDaPagina();
    setHoje(h);
    setRetorno(retornoPadrao(h));
    setFalhaDialogo(null);
    setPedirRetorno(true);
  };

  /**
   * Grava o desfecho. `true` = o servidor respondeu (gravou, deduplicou ou recusou por REGRA — a resposta não muda
   * repetindo, então o diálogo fecha e o toast diz o porquê); `false` = não houve resposta utilizável (sem rede, erro):
   * o diálogo de origem segue aberto com o texto, e a falha fica nele (`noDialogo`) ou num toast com "Tentar de novo".
   */
  const registrar = async (acao: AcaoContato, texto?: string, dataRetorno?: string, noDialogo = false): Promise<boolean> => {
    const alvo = cnpj;
    const notaFinal = texto?.trim() || undefined;
    const falhar = (descricao: string) => {
      if (noDialogo) setFalhaDialogo(descricao);
      else toast.error('Não foi possível registrar', {
        description: descricao,
        action: { label: 'Tentar de novo', onClick: () => void registrar(acao, texto, dataRetorno) },
      });
      return false;
    };
    // Sem rede a mutação PAUSA (networkMode 'online') e a promessa não volta até a rede voltar: o diálogo ficaria
    // "Gravando…" sem fim. Nada é enviado; o texto fica onde está.
    if (!onlineManager.isOnline()) return falhar(TEXTO_SEM_REDE);
    try {
      const r = await reg.mutateAsync({ cnpj: alvo, acao, nota: notaFinal, retorno: dataRetorno });
      // Banco anterior ao pacote G não diz: a dedupe não gravava nada, então com nota ela NÃO foi gravada.
      const notaGravada = r.notaGravada ?? !(r.deduped && notaFinal);
      const volta = r.retornoEm ? ` · volta para você em ${diaMesData(r.retornoEm)}` : '';
      if (!r.deduped) {
        // A conversão confirmada não se desfaz (RD006): o cliente continua no Omie.
        if (acao === 'virou_cliente') toast.success(LABEL_OK[acao]);
        else toast.success(LABEL_OK[acao] + volta, {
          // Pacote L: o "em conversa"/"não atendeu" também dá a posse — e a tela DIZ o que aconteceu com ela.
          description: textoPosseDoContato(r.posse) ?? undefined,
          action: { label: 'Desfazer', onClick: () => void desfazer(r.id, alvo) },
        });
      }
      if (!notaGravada && notaFinal) {
        // Nada se perde: a ficha não apaga o texto nem avança (Codex, código 2026-11-06, P2; pacote G4).
        toast.warning('A nota não foi gravada', {
          description: 'Este desfecho já tinha sido registrado agora há pouco. A nota continua no campo.',
        });
      }
      if (aindaNoAlvo(alvo)) onRegistrado?.(acao, { deduped: r.deduped, notaGravada, notaEnviada: notaFinal });
      return true;
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
        return falhar(descreverFalha(e));
      }
      return true;
    }
  };

  /** Botão de confirmação dos diálogos: segura o diálogo aberto até a resposta; fecha só quando houve resposta. */
  const confirmar = (envio: () => Promise<boolean>, fechar: () => void) => async (ev: MouseEvent) => {
    ev.preventDefault();
    setFalhaDialogo(null);
    if (await envio()) fechar();
  };
  const rotuloConfirmar = (padrao: string) => (reg.isPending ? 'Gravando…' : falhaDialogo ? 'Tentar de novo' : padrao);
  const avisoFalha = falhaDialogo && (
    <p className="text-xs text-status-error" role="alert" data-testid="radar-desfecho-falha">{falhaDialogo}</p>
  );

  const abrirDescarte = () => {
    // O motivo NÃO é apagado aqui: depois de uma falha, reabrir traz o texto de volta (item 2).
    setFalhaDialogo(null);
    setConfirmDescartar(true);
  };
  const bloqueado = reg.isPending || isImpersonating;
  const tituloBloqueado = isImpersonating ? 'Indisponível em modo Ver como' : undefined;

  return (
    <>
      {variante === 'botoes' ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Desfecho da ligação" data-testid="radar-desfechos-diretos">
          <Button type="button" variant="outline" className="min-h-11" disabled={bloqueado} title={tituloBloqueado}
            onClick={() => void registrar('contatado_sem_resposta', nota)}>
            <PhoneMissed className="w-4 h-4 mr-2" /> Não atendeu
          </Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={bloqueado} title={tituloBloqueado} onClick={abrirRetorno}>
            <MessageCircle className="w-4 h-4 mr-2" /> Em conversa…
          </Button>
          <Button type="button" variant="outline" className="min-h-11 text-status-error" disabled={bloqueado} title={tituloBloqueado} onClick={abrirDescarte}>
            <Ban className="w-4 h-4 mr-2" /> Descartar
          </Button>
        </div>
      ) : (
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
          <DropdownMenuItem className="text-status-error" onClick={abrirDescarte}>
            <Ban className="w-4 h-4 mr-2" /> Descartar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      )}

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
          {avisoFalha}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reg.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={!retornoValido(retorno, hoje) || reg.isPending}
              onClick={confirmar(async () => {
                const ok = await registrar('em_conversa', nota, retorno, true);
                if (ok) track('radar.retorno_definido', { dias: diasAte(retorno, hoje), sugestao_aceita: retorno === retornoPadrao(hoje) });
                return ok;
              }, () => setPedirRetorno(false))}
            >
              {rotuloConfirmar('Marcar em conversa')}
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
          {avisoFalha}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reg.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={reg.isPending}
              onClick={confirmar(async () => {
                const ok = await registrar('descartado', motivo.trim() || nota, undefined, true);
                if (ok) setMotivo('');
                return ok;
              }, () => setConfirmDescartar(false))}
            >
              {rotuloConfirmar('Descartar')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Texto de quem tentou registrar sem rede: diz que NADA foi enviado e o que fazer. */
export const TEXTO_SEM_REDE = 'Sem conexão: nada foi enviado. O texto continua aqui — tente de novo quando a rede voltar.';

/** A descrição acionável da falha: o que o servidor disse, ou a queda de rede no meio do envio. */
function descreverFalha(e: unknown): string {
  if (!onlineManager.isOnline()) return TEXTO_SEM_REDE;
  return mensagemDeErro(e) ?? 'Erro desconhecido. Tente de novo em instantes.';
}
