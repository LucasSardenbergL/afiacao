import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { usePrazoAviso, type ContaPedido } from '@/hooks/unifiedOrder/usePrazoAviso';
import { dominaCalendario, faixaVencido, parseCalendarioParcela, sugerirParcela, type FormaLegivel, type Sugestao } from '@/lib/unified-order/prazo-sugestao';
import type { PrazoDecisaoEstado } from '@/services/orderSubmission/prazoDecisao';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { track } from '@/lib/analytics';

/**
 * Aviso + sugestão de prazo ao lado do seletor de condição de pagamento (Frente B, PR1).
 *
 * Decisão do founder (2026-10-31): cliente com título VENCIDO em aberto → a tela AVISA (R$, nº de
 * títulos, dias, atraso médio do vencido, frescor do Omie) e SUGERE condição menor (um degrau
 * abaixo que ANTECIPA caixa, ou à vista); a vendedora decide — Aplicar ou Manter com motivo.
 * Nada trava: o gate de 60+ dias da fronteira segue igual.
 *
 * Precisão > recall: só renderiza aviso com evidência POSITIVA (`vencido > 0`); erro na fonte —
 * mesmo com dado anterior em cache — é INDISPONÍVEL (nada renderizado, nada publicado). Títulos com
 * dados inválidos/ambíguos no Omie aparecem como NOTA de qualidade, nunca somados nem com sugestão.
 *
 * Congelamento (achados Codex): até a vendedora INTERAGIR com o chip, a oferta segue a condição
 * selecionada (a habitual do cliente chega assíncrona e a vendedora pode trocar à mão); depois do
 * clique a oferta congela — aplicar 60 não vira "sugira 45". "Aplicar" só aparece se a sugerida
 * ainda ANTECIPA mais que a seleção atual (quem já pôs à vista não é empurrado para 30/60); formas
 * recarregadas com o código mudado de significado expiram a oferta.
 *
 * A decisão vai para `onEstado` e é gravada no ENVIO (submitOrder → venda_prazo_decisao_registrar),
 * com o desfecho real; o servidor reconfere pedido↔conta↔cliente e relê o vencido.
 */

const MOTIVOS_MANTER: ReadonlyArray<{ codigo: string; rotulo: string }> = [
  { codigo: 'cliente_combinou_pagamento', rotulo: 'Cliente combinou pagar o vencido' },
  { codigo: 'pagamento_em_transito', rotulo: 'Pagamento feito, aguardando baixa no Omie' },
  { codigo: 'erro_do_omie', rotulo: 'Título vencido está errado no Omie' },
  { codigo: 'decisao_gestor', rotulo: 'Gestor autorizou manter o prazo' },
  { codigo: 'outro', rotulo: 'Outro motivo' },
];

const ROTULO_CONTA: Record<ContaPedido, string> = { oben: 'Oben', colacor: 'Colacor' };
// Formatadores locais: `@/lib/reposicao` é de outro módulo (gate de fronteiras).
const formatBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (iso: string) => { const [a, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${a}`; };

export interface AvisoPrazoClienteProps {
  company: ContaPedido;
  codigo: number | null | undefined;
  nomeCliente: string | null;
  formas: FormaLegivel[];
  selected: string;
  onSelect: (codigo: string) => void;
  /** Estado da decisão (ou `null` quando não há aviso) — o envio grava. */
  onEstado: (company: ContaPedido, estado: PrazoDecisaoEstado | null) => void;
}

type Oferta = { chave: string; habitual: string; sugestao: Sugestao; sugeridaDescricao: string | null };

export function AvisoPrazoCliente({ company, codigo, nomeCliente, formas, selected, onSelect, onEstado }: AvisoPrazoClienteProps) {
  const { data, error } = usePrazoAviso(company, codigo);
  // Erro na fonte = indisponível, mesmo com dado anterior em cache (Codex P2 #12).
  const aviso = error ? null : data ?? null;
  const chave = codigo && codigo > 0 ? `${company}:${codigo}` : null;
  const lente = isLensActive();

  const [oferta, setOferta] = useState<Oferta | null>(null);
  const [interagiu, setInteragiu] = useState(false);
  const [manter, setManter] = useState(false);
  const [motivoCodigo, setMotivoCodigo] = useState<string>('');
  const [motivoTexto, setMotivoTexto] = useState('');
  const exibidoRef = useRef<string | null>(null);

  // Oferta: nasce/recalcula enquanto a vendedora não interagiu (segue a seleção); congela depois.
  useEffect(() => {
    if (!chave || !aviso || aviso.vencido <= 0 || formas.length === 0) return;
    const mesmaChave = oferta?.chave === chave;
    if (mesmaChave && (interagiu || oferta.habitual === selected)) return;
    const sugestao = sugerirParcela({ formas, parcelaAtual: selected, vencido: aviso.vencido, diasVencidoMax: aviso.diasVencidoMax });
    const sugeridaDescricao = sugestao.tipo === 'degrau' ? sugestao.sugerida.descricao : null;
    setOferta({ chave, habitual: selected, sugestao, sugeridaDescricao });
    if (!mesmaChave) {
      setInteragiu(false); setManter(false); setMotivoCodigo(''); setMotivoTexto('');
    }
    if (exibidoRef.current !== chave) {
      exibidoRef.current = chave;
      track('venda.prazo_aviso_exibido', {
        account: company,
        // sem hífen nas props do track (convenção do `track`): '16-45d' → '16_45d'
        faixa: faixaVencido(aviso.diasVencidoMax)?.replace(/-/g, '_') ?? null,
        com_sugestao: sugestao.tipo === 'degrau',
        motivo_sistema: sugestao.tipo === 'nenhuma' ? sugestao.motivoSistema : null,
        qualidade: aviso.qualidade,
      });
    }
  }, [chave, aviso, formas, selected, company, oferta, interagiu]);

  // Cliente trocou (ou saiu) → zera a oferta.
  useEffect(() => {
    if (oferta && oferta.chave !== chave) { setOferta(null); setInteragiu(false); setManter(false); setMotivoCodigo(''); setMotivoTexto(''); }
  }, [chave, oferta]);

  useEffect(() => {
    if (error) track('venda.prazo_aviso_erro', { account: company, message: error instanceof Error ? error.message : 'erro' });
  }, [error, company]);

  const motivo = useMemo(() => {
    if (!manter || !motivoCodigo) return null;
    if (motivoCodigo === 'outro') return motivoTexto.trim() ? `outro: ${motivoTexto.trim()}` : null;
    return motivoCodigo;
  }, [manter, motivoCodigo, motivoTexto]);

  // A oferta congelada ainda vale na lista vigente? (código presente e com a MESMA descrição)
  const sug = oferta?.sugestao ?? null;
  const sugeridaViva = useMemo(() => {
    if (!sug || sug.tipo !== 'degrau') return null;
    const f = formas.find((x) => x.codigo === sug.sugerida.codigo);
    return f && f.descricao === sug.sugerida.descricao ? f : null;
  }, [sug, formas]);
  const ofertaExpirou = !!sug && sug.tipo === 'degrau' && !sugeridaViva;

  // A seleção atual já antecipa tanto ou mais que a sugerida? Então não se oferece "Aplicar".
  const selecaoCobre = useMemo(() => {
    if (!sugeridaViva) return false;
    if (selected === sugeridaViva.codigo) return true;
    const cs = parseCalendarioParcela(formas.find((f) => f.codigo === selected)?.descricao);
    const cg = parseCalendarioParcela(sugeridaViva.descricao);
    return !!cs && !!cg && dominaCalendario(cs, cg);
  }, [sugeridaViva, selected, formas]);

  // Publica o estado para o envio sempre que muda (fonte única: o que a tela mostrou).
  const ultimoRef = useRef<string>('');
  useEffect(() => {
    const vivo = oferta && chave && oferta.chave === chave && aviso && aviso.vencido > 0;
    const estado: PrazoDecisaoEstado | null = vivo && codigo
      ? {
          company,
          codigo,
          nomeCliente,
          parcelaHabitual: oferta.habitual,
          sugerida: oferta.sugestao.tipo === 'degrau' ? oferta.sugestao.sugerida.codigo : null,
          sugeridaDescricao: oferta.sugeridaDescricao,
          motivoSistema: oferta.sugestao.tipo === 'nenhuma' ? oferta.sugestao.motivoSistema : null,
          interagiu,
          motivo,
        }
      : null;
    const assinatura = JSON.stringify(estado);
    if (assinatura === ultimoRef.current) return;
    ultimoRef.current = assinatura;
    onEstado(company, estado);
  }, [oferta, chave, aviso, codigo, company, nomeCliente, interagiu, motivo, onEstado]);

  if (!aviso || !chave) return null;

  // Sem vencido somável, mas com títulos inválidos/ambíguos no Omie: nota de qualidade, sem sugestão.
  if (aviso.vencido <= 0) {
    if (aviso.nInvalidos > 0 || aviso.nAmbiguos > 0) {
      return (
        <p className="text-[11px] text-muted-foreground" data-testid={`aviso-prazo-${company}-qualidade`}>
          {ROTULO_CONTA[company]}: {aviso.nInvalidos + aviso.nAmbiguos} título{aviso.nInvalidos + aviso.nAmbiguos > 1 ? 's' : ''} em aberto com dados
          {aviso.nInvalidos > 0 ? ' inválidos' : ''}{aviso.nInvalidos > 0 && aviso.nAmbiguos > 0 ? ' ou' : ''}{aviso.nAmbiguos > 0 ? ' de status incerto' : ''} no Omie — não somados; confira no Omie.
        </p>
      );
    }
    return null;
  }
  if (!oferta || oferta.chave !== chave || !sug) return null;

  const descricaoDe = (cod: string) => formas.find((f) => f.codigo === cod)?.descricao ?? cod;

  return (
    <div className="bg-status-warning/10 border border-status-warning/30 rounded-md p-2 text-xs" data-testid={`aviso-prazo-${company}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
        <div className="space-y-1 flex-1">
          <p className="font-semibold text-status-warning">
            {ROTULO_CONTA[company]}: {formatBRL(aviso.vencido)} vencido · {aviso.nTitulos} título{aviso.nTitulos > 1 ? 's' : ''}
            {aviso.diasVencidoMax !== null && <> · até {aviso.diasVencidoMax} dia{aviso.diasVencidoMax > 1 ? 's' : ''}</>}
          </p>
          <p className="text-muted-foreground">
            {aviso.atrasoMedioVencidoDias !== null && <>Atraso médio do vencido: {aviso.atrasoMedioVencidoDias.toLocaleString('pt-BR')} d</>}
            {aviso.vencimentoMaisAntigo && <> · mais antigo desde {formatDate(aviso.vencimentoMaisAntigo)}</>}
            {aviso.nAmbiguos > 0 && <> · {aviso.nAmbiguos} com status incerto (não somado)</>}
            {aviso.nInvalidos > 0 && <> · {aviso.nInvalidos} com dados inválidos (não somado)</>}
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Dados do Omie{aviso.syncEm ? ` sincronizados em ${formatDate(aviso.syncEm.slice(0, 10))}` : ''}.
            {aviso.qualidade !== 'ok' && (
              <span className="text-status-warning"> {aviso.qualidade === 'sem_sync' ? 'Sem registro de sync' : 'Sync há mais de 24h'} — confirme no Omie antes de decidir.</span>
            )}
          </p>

          {sug.tipo === 'degrau' && ofertaExpirou ? (
            <p className="text-muted-foreground pt-1" data-testid={`aviso-prazo-${company}-expirada`}>
              A lista de condições mudou — a sugestão anterior ({sug.sugerida.descricao}) não vale mais.
            </p>
          ) : sug.tipo === 'degrau' && sugeridaViva ? (
            <div className="pt-1 space-y-1.5">
              <p>
                Sugestão: <span className="font-medium">{sugeridaViva.descricao}</span>
                {' '}<span className="text-muted-foreground">(hoje: {descricaoDe(oferta.habitual)}{sug.motivo === 'vencido_60d' ? ' · vencido há mais de 60 dias' : ''})</span>
              </p>
              {selecaoCobre ? (
                <p className="text-status-success font-medium" data-testid={`aviso-prazo-${company}-aplicada`}>
                  {selected === sugeridaViva.codigo ? 'Sugestão aplicada.' : `Condição escolhida (${descricaoDe(selected)}) já antecipa mais que a sugestão.`}
                </p>
              ) : manter ? (
                <div className="flex flex-wrap items-center gap-2" data-testid={`aviso-prazo-${company}-manter`}>
                  <span>Mantendo {descricaoDe(selected)} — motivo:</span>
                  <Select value={motivoCodigo} onValueChange={setMotivoCodigo} disabled={lente}>
                    <SelectTrigger className="h-7 w-[260px] text-xs" aria-label="Motivo para manter o prazo"><SelectValue placeholder="Escolha o motivo" /></SelectTrigger>
                    <SelectContent>
                      {MOTIVOS_MANTER.map((m) => <SelectItem key={m.codigo} value={m.codigo} className="text-xs">{m.rotulo}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {motivoCodigo === 'outro' && (
                    <Input className="h-7 w-[220px] text-xs" placeholder="Descreva" value={motivoTexto} onChange={(e) => setMotivoTexto(e.target.value)} disabled={lente} aria-label="Outro motivo" />
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="default" className="h-7 text-xs" disabled={lente}
                    onClick={() => { setInteragiu(true); setManter(false); onSelect(sugeridaViva.codigo); track('venda.prazo_sugestao_aplicada', { account: company }); }}>
                    Aplicar sugestão
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={lente}
                    onClick={() => { setInteragiu(true); setManter(true); track('venda.prazo_sugestao_mantida', { account: company }); }}>
                    Manter {descricaoDe(selected)}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground pt-1" data-testid={`aviso-prazo-${company}-sem-sugestao`}>
              {sug.tipo === 'nenhuma' && sug.motivoSistema === 'ja_a_vista' && 'Condição já à vista — sem sugestão.'}
              {sug.tipo === 'nenhuma' && sug.motivoSistema === 'condicao_ilegivel' && 'Condição atual não lida como prazo em dias — avalie com o financeiro.'}
              {sug.tipo === 'nenhuma' && sug.motivoSistema === 'sem_forma_menor' && 'Nenhuma condição menor disponível nesta conta.'}
              {sug.tipo === 'nenhuma' && sug.motivoSistema === 'prazo_ja_curto' && 'Prazo já no degrau mínimo — sem sugestão automática.'}
              {sug.tipo === 'nenhuma' && sug.motivoSistema === null && 'Sem sugestão automática.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
