import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, FileInput, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';
import { formatBRL } from '@/components/reposicao/pedidos/shared';
import {
  interpretarRespostaImportacao, linkDoPedido, PROTOCOLO_PORTAL_RE, respostaIndeterminada, type ResultadoTela,
} from './importar-portal';

/** Chaves que o painel do portal e a lista do ciclo leem — a importação muda as duas. */
const CHAVES_INVALIDAR = [['pedidos-ciclo'], ['portal-sayerlack-painel']] as const;

/**
 * Pedido digitado DIRETO no portal Sayerlack → pedido de compra no Omie, informando só o número.
 * A edge lê o pedido no portal, grava no app (mesma prova de custo/IPI do fluxo normal, condição de pagamento lida do
 * portal) e cria o PO. Bloqueia e mostra o motivo se algo não bater — nada é gravado.
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
  const [protocolo, setProtocolo] = useState(protocoloInicial ?? '');
  const [resultado, setResultado] = useState<ResultadoTela | null>(null);
  const resultadoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && protocoloInicial) setProtocolo(protocoloInicial);
  }, [open, protocoloInicial]);

  const importar = useMutation({
    mutationFn: async (numero: string) => {
      const { data, error } = await supabase.functions.invoke('sayerlack-importar-pedido-portal', { body: { protocolo: numero } });
      if (error) {
        // Com corpo, a edge disse o motivo (recusa antes de gravar). Sem corpo (prazo do gateway, rede) o PO PODE ter
        // saído depois: é "não sei", nunca "não foi importado" (revisão Fable+Codex 2026-11).
        const msg = await mensagemDoErroEdge(error);
        return msg
          ? interpretarRespostaImportacao({ ok: false, etapa: 'importacao', mensagem: msg }, numero)
          : respostaIndeterminada(numero, error.message);
      }
      return interpretarRespostaImportacao(data, numero);
    },
    onSuccess: (r, numero) => {
      setResultado(r);
      track('reposicao.importar_portal', { tom: r.tom, n_itens: r.itens.length, protocolo: numero });
      for (const queryKey of CHAVES_INVALIDAR) void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    },
    onError: (e: Error, numero) => {
      setResultado(respostaIndeterminada(numero, e.message));
      track('reposicao.importar_portal', { tom: 'aviso', n_itens: 0, protocolo: numero });
    },
  });

  // Tempo decorrido: a leitura do portal + o Omie passam de 1 minuto às vezes — o operador vê que não travou.
  const [segundos, setSegundos] = useState(0);
  useEffect(() => {
    if (!importar.isPending) { setSegundos(0); return; }
    const id = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [importar.isPending]);

  useEffect(() => {
    if (resultado) resultadoRef.current?.focus();
  }, [resultado]);

  const mudarAberto = (v: boolean) => {
    if (importar.isPending) return; // a leitura no servidor não para; fechar só perderia o resultado
    if (controlado) onOpenChange?.(v); else setOpenInterno(v);
    if (!v) { setResultado(null); setProtocolo(''); }
  };

  const numero = protocolo.trim();
  const valido = PROTOCOLO_PORTAL_RE.test(numero);

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
        ocultarFechar={importar.isPending}
        onEscapeKeyDown={(e) => { if (importar.isPending) e.preventDefault(); }}
        onInteractOutside={(e) => { if (importar.isPending) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>Importar pedido do portal Sayerlack</DialogTitle>
          <DialogDescription>
            Para pedido que você digitou direto no portal. Informe o número; eu leio o pedido (itens, total e condição de
            pagamento) e crio o pedido de compra no Omie. Se algo não bater, nada é gravado e eu mostro o motivo.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valido || importar.isPending) return;
            setResultado(null);
            importar.mutate(numero);
          }}
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor="protocolo-portal">Nº do pedido no portal</Label>
            <Input
              id="protocolo-portal"
              inputMode="numeric"
              autoComplete="off"
              placeholder="ex.: 2140603"
              value={protocolo}
              onChange={(e) => setProtocolo(e.target.value.replace(/\D/g, ''))}
              disabled={importar.isPending}
              autoFocus
            />
          </div>
          <Button type="submit" disabled={!valido || importar.isPending}>
            {importar.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null}
            {importar.isPending ? 'Importando…' : 'Importar'}
          </Button>
        </form>

        <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {importar.isPending && (
            <p>
              Lendo o portal e criando o pedido de compra — costuma levar 1 a 2 minutos ({segundos}s). Não feche esta janela:
              o processo continua no servidor, mas você perderia o resultado.
            </p>
          )}
        </div>

        {resultado && (
          <div ref={resultadoRef} tabIndex={-1} className="outline-none">
            <ResultadoImportacao r={resultado} aoAbrirPedido={() => mudarAberto(false)} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResultadoImportacao({ r, aoAbrirPedido }: { r: ResultadoTela; aoAbrirPedido: () => void }) {
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
      {(r.pedidoId != null || r.acao) && (
        <div className="flex flex-wrap gap-2">
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
