import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, FileInput, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';
import { formatBRL } from '@/components/reposicao/pedidos/shared';
import {
  corpoDoErroEdge, interpretarErroEdge, interpretarRespostaImportacao, lerNumerosPortal, linkDoPedido, MAX_NUMEROS_POR_VEZ,
  respostaIndeterminada, statusDoErroEdge, type ResultadoTela,
} from './importar-portal';

/**
 * O painel do portal fica sob o prefixo `pedidos-ciclo` (toda ação de Gerir pedidos já invalida esse prefixo), então
 * invalidar `pedidos-ciclo` atualiza a lista do ciclo E o card do portal.
 */
const CHAVE_INVALIDAR = ['pedidos-ciclo'] as const;

/** Um número na fila do diálogo: cada um tem o SEU resultado e a SUA recuperação (8.5). */
interface ItemFila {
  numero: string;
  estado: 'aguardando' | 'importando' | 'feito' | 'nao_chamado';
  resultado: ResultadoTela | null;
}

/** Chama a importadora para UM número e traduz o desfecho. Nunca lança: falha vira "não sei se entrou". */
async function importarUm(numero: string): Promise<ResultadoTela> {
  try {
    const { data, error } = await supabase.functions.invoke('sayerlack-importar-pedido-portal', { body: { protocolo: numero } });
    if (error) {
      // O corpo estruturado vale também em 500: carrega o #id do pedido já gravado (Codex P2, 2026-11-07). Sem
      // contrato reconhecido, é "não sei" — nunca "não foi importado" (revisão 2, B7).
      const corpo = await corpoDoErroEdge(error);
      const msg = corpo ? null : await mensagemDoErroEdge(error);
      return interpretarErroEdge(corpo, statusDoErroEdge(error), msg, numero, error.message);
    }
    return interpretarRespostaImportacao(data, numero);
  } catch (e) {
    return respostaIndeterminada(numero, e instanceof Error ? e.message : null);
  }
}

/**
 * Pedido digitado DIRETO no portal Sayerlack → pedido de compra no Omie, informando só o número (ou vários).
 * A edge lê o pedido no portal, grava no app (mesma prova de custo/IPI do fluxo normal, condição de pagamento lida do
 * portal) e cria o pedido de compra. Bloqueia e mostra o motivo se algo não bater.
 * Vários números rodam UM POR VEZ (cada um abre uma sessão do navegador remoto; paralelo estouraria a cota).
 *
 * Sem `open`/`onOpenChange` é um botão com estado próprio; controlado (o card do portal) abre já com `protocoloInicial`.
 */
export function ImportarPedidoPortalDialog({
  open: openExterno,
  onOpenChange,
  protocoloInicial,
}: {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  protocoloInicial?: string;
} = {}) {
  const queryClient = useQueryClient();
  const controlado = openExterno !== undefined;
  const [openInterno, setOpenInterno] = useState(false);
  const open = controlado ? openExterno : openInterno;
  const [entrada, setEntrada] = useState(protocoloInicial ?? '');
  const [fila, setFila] = useState<ItemFila[]>([]);
  const [rodando, setRodando] = useState(false);
  const pararRef = useRef(false);
  const resultadoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && protocoloInicial) setEntrada(protocoloInicial);
  }, [open, protocoloInicial]);

  const atualizar = (numero: string, patch: Partial<ItemFila>) =>
    setFila((f) => f.map((it) => (it.numero === numero ? { ...it, ...patch } : it)));

  /** Laço SEQUENCIAL: um número por vez; "Parar" vale a partir do próximo (o que está no servidor não para). */
  const executar = useCallback(async (numeros: string[]) => {
    pararRef.current = false;
    setRodando(true);
    try {
      for (const numero of numeros) {
        if (pararRef.current) { atualizar(numero, { estado: 'nao_chamado', resultado: null }); continue; }
        atualizar(numero, { estado: 'importando', resultado: null });
        const r = await importarUm(numero);
        atualizar(numero, { estado: 'feito', resultado: r });
        track('reposicao.importar_portal', { tom: r.tom, n_itens: r.itens.length, protocolo: numero, lote: numeros.length });
        void queryClient.invalidateQueries({ queryKey: [...CHAVE_INVALIDAR] });
      }
    } finally {
      setRodando(false);
    }
  }, [queryClient]);

  // Tempo decorrido do número em andamento: leitura do portal + Omie passam de 1 minuto às vezes.
  const emAndamento = fila.find((it) => it.estado === 'importando')?.numero ?? null;
  const [segundos, setSegundos] = useState(0);
  useEffect(() => {
    setSegundos(0);
    if (!emAndamento) return;
    const id = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [emAndamento]);

  const terminou = !rodando && fila.length > 0;
  useEffect(() => {
    if (terminou) resultadoRef.current?.focus();
  }, [terminou]);

  const mudarAberto = (v: boolean) => {
    if (rodando) return; // a leitura no servidor não para; fechar só perderia o resultado
    if (controlado) onOpenChange?.(v); else setOpenInterno(v);
    if (!v) { setFila([]); setEntrada(''); }
  };

  const lidos = lerNumerosPortal(entrada);
  const valido = lidos.validos.length > 0 && lidos.invalidos.length === 0 && lidos.excedentes.length === 0;
  const enviar = () => {
    if (!valido || rodando) return;
    setFila(lidos.validos.map((numero) => ({ numero, estado: 'aguardando', resultado: null })));
    void executar(lidos.validos);
  };
  const feitos = fila.filter((it) => it.estado === 'feito').length;

  return (
    <Dialog open={open} onOpenChange={mudarAberto}>
      {!controlado && (
        <DialogTrigger asChild>
          <Button variant="outline" title="Pedido que você digitou direto no portal Sayerlack: informe o número e o app cria o pedido de compra no Omie.">
            <FileInput className="w-4 h-4 mr-1" /> Importar do portal
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="sm:max-w-lg max-h-[90dvh] overflow-y-auto"
        ocultarFechar={rodando}
        onEscapeKeyDown={(e) => { if (rodando) e.preventDefault(); }}
        onInteractOutside={(e) => { if (rodando) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Importar pedido do portal Sayerlack</DialogTitle>
          <DialogDescription>
            Para pedido que você digitou direto no portal. Informe o número (ou vários, um por linha ou separados por
            vírgula); eu leio cada pedido (itens, total e condição de pagamento) e crio o pedido de compra no Omie. Se algo
            não bater, eu mostro o motivo daquele número.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); enviar(); }}
        >
          <div className="space-y-1">
            <Label htmlFor="protocolo-portal">Nº do pedido no portal</Label>
            <Textarea
              id="protocolo-portal"
              inputMode="decimal"
              autoComplete="off"
              rows={2}
              placeholder="ex.: 2140603"
              value={entrada}
              onChange={(e) => setEntrada(e.target.value.replace(/[^\d\s,;]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }}
              disabled={rodando}
              autoFocus
              className="min-h-[44px] resize-y"
              aria-describedby="protocolo-portal-ajuda"
            />
            <p id="protocolo-portal-ajuda" className="text-xs text-muted-foreground">
              {lidos.invalidos.length > 0
                ? <span className="text-status-error">Não é número do portal (3 a 12 dígitos): {lidos.invalidos.join(', ')}</span>
                : lidos.excedentes.length > 0
                  ? <span className="text-status-error">No máximo {MAX_NUMEROS_POR_VEZ} por vez — tire {lidos.excedentes.length}.</span>
                  : lidos.validos.length > 1
                    ? `${lidos.validos.length} pedidos, importados um de cada vez.`
                    : 'Enter importa; Shift+Enter quebra a linha.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="touch" disabled={!valido || rodando}>
              {rodando ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null}
              {rodando ? 'Importando…' : lidos.validos.length > 1 ? `Importar ${lidos.validos.length}` : 'Importar'}
            </Button>
            {rodando && fila.length > 1 && (
              <Button type="button" size="touch" variant="outline" onClick={() => { pararRef.current = true; }}>
                Parar depois deste
              </Button>
            )}
          </div>
        </form>

        <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {emAndamento && (
            <p>
              {fila.length > 1 ? `Pedido ${emAndamento} (${feitos + 1} de ${fila.length}): ` : ''}
              lendo o portal e criando o pedido de compra — costuma levar 1 a 2 minutos ({segundos}s). Não feche esta
              janela: o processo continua no servidor, mas você perderia o resultado.
            </p>
          )}
        </div>

        {fila.length > 0 && (
          <div ref={resultadoRef} tabIndex={-1} className="space-y-2 outline-none">
            {fila.map((it) => (
              <ItemDaFila
                key={it.numero}
                item={it}
                mostrarNumero={fila.length > 1}
                podeRepetir={!rodando}
                aoRepetir={() => void executar([it.numero])}
                aoAbrirPedido={() => mudarAberto(false)}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ItemDaFila({ item, mostrarNumero, podeRepetir, aoRepetir, aoAbrirPedido }: {
  item: ItemFila; mostrarNumero: boolean; podeRepetir: boolean; aoRepetir: () => void; aoAbrirPedido: () => void;
}) {
  if (item.estado === 'feito' && item.resultado) {
    return (
      <ResultadoImportacao
        r={item.resultado}
        aoAbrirPedido={aoAbrirPedido}
        aoRepetir={item.resultado.tom !== 'sucesso' && podeRepetir ? aoRepetir : null}
      />
    );
  }
  if (!mostrarNumero) return null;
  const texto = item.estado === 'importando' ? 'importando…'
    : item.estado === 'nao_chamado' ? 'não importei (você parou antes) — nada foi chamado para este número'
    : 'na fila';
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm" data-testid="importar-portal-fila" data-estado={item.estado}>
      <span>
        Pedido {item.numero} · <span className="text-muted-foreground">{texto}</span>
      </span>
      {item.estado === 'importando' && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-hidden />}
      {item.estado === 'nao_chamado' && podeRepetir && (
        <Button size="sm" variant="outline" onClick={aoRepetir}>Importar</Button>
      )}
    </div>
  );
}

function ResultadoImportacao({ r, aoAbrirPedido, aoRepetir }: { r: ResultadoTela; aoAbrirPedido: () => void; aoRepetir: (() => void) | null }) {
  const Icone = r.tom === 'sucesso' ? CheckCircle2 : r.tom === 'aviso' ? AlertTriangle : XCircle;
  const cor = r.tom === 'sucesso' ? 'text-status-success' : r.tom === 'aviso' ? 'text-status-warning' : 'text-status-error';
  return (
    <div
      className="space-y-3 rounded-md border p-3"
      data-testid="importar-portal-resultado"
      data-tom={r.tom}
      role={r.tom === 'erro' ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-2">
        <Icone className={`w-4 h-4 mt-0.5 shrink-0 ${cor}`} aria-hidden />
        <div className="space-y-1">
          <p className={`text-sm font-medium ${cor}`}>{r.titulo}</p>
          <p className="text-sm text-muted-foreground break-words">{r.mensagem}</p>
        </div>
      </div>
      {r.avisoSituacao && (
        <p className="flex items-start gap-1 text-xs text-status-warning" data-testid="importar-portal-aviso-situacao">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden /> {r.avisoSituacao}
        </p>
      )}
      {(r.pedidoId != null || r.acao || aoRepetir) && (
        <div className="flex flex-wrap gap-2">
          {aoRepetir && (
            <Button size="sm" variant="outline" onClick={aoRepetir}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" aria-hidden /> Importar de novo
            </Button>
          )}
          {r.pedidoId != null && (
            <Button asChild size="sm" variant="outline">
              <Link to={linkDoPedido(r.pedidoId)} onClick={aoAbrirPedido}>
                <ExternalLink className="w-3.5 h-3.5 mr-1" aria-hidden /> Abrir pedido #{r.pedidoId}
              </Link>
            </Button>
          )}
          {r.acao && (
            <Button asChild size="sm" variant="outline">
              <Link to={r.acao.href} onClick={aoAbrirPedido}>{r.acao.rotulo}</Link>
            </Button>
          )}
        </div>
      )}
      {(r.omieNumero || r.situacaoPortal || r.valorTotal != null || r.condicao) && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {r.omieNumero && (
            <>
              <dt className="text-muted-foreground">Pedido de compra Omie</dt>
              <dd className="flex items-center gap-1">
                {r.omieNumero}
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Copiar nº do pedido de compra ${r.omieNumero}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(r.omieNumero ?? '').then(() => toast.success('Nº do pedido de compra copiado'));
                  }}
                >
                  <Copy className="w-3.5 h-3.5" aria-hidden />
                </button>
              </dd>
            </>
          )}
          {r.condicao && (<><dt className="text-muted-foreground">Condição de pagamento</dt><dd>{r.condicao}</dd></>)}
          {r.situacaoPortal && (<><dt className="text-muted-foreground">Situação no portal</dt><dd>{r.situacaoPortal}</dd></>)}
          {r.valorTotal != null && (<><dt className="text-muted-foreground">Total com IPI</dt><dd>{formatBRL(r.valorTotal)}</dd></>)}
        </dl>
      )}
      {r.tom === 'erro' && r.detalheTecnico && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Detalhes técnicos (para o suporte)</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{r.detalheTecnico}</pre>
        </details>
      )}
      {r.itens.length > 0 && (
        <ul className="text-xs divide-y">
          {r.itens.map((it) => (
            <li key={it.sku_portal} className="flex justify-between gap-2 py-1">
              <span className="min-w-0 break-words">{it.sku_portal} — {it.descricao}</span>
              <span className="shrink-0 tabular-nums">{it.qtde_portal} emb · {formatBRL(it.valor_mercadoria)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
