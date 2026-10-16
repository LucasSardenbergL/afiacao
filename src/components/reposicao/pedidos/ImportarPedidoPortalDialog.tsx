import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileInput, Loader2, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';
import { formatBRL } from '@/components/reposicao/pedidos/shared';
import { interpretarRespostaImportacao, PROTOCOLO_PORTAL_RE, type ResultadoTela } from './importar-portal';

/**
 * Pedido digitado DIRETO no portal Sayerlack → pedido de compra no Omie, informando só o número.
 * A edge lê o pedido no portal, grava no app (com a mesma prova de custo/IPI do fluxo normal) e cria o PO.
 * Bloqueia e mostra o motivo se algo não bater (SKU sem de-para, total que não fecha…) — nada é gravado.
 */
export function ImportarPedidoPortalDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [protocolo, setProtocolo] = useState('');
  const [resultado, setResultado] = useState<ResultadoTela | null>(null);

  const importar = useMutation({
    mutationFn: async (numero: string) => {
      const { data, error } = await supabase.functions.invoke('sayerlack-importar-pedido-portal', { body: { protocolo: numero } });
      if (error) {
        // 4xx/5xx: a edge manda o motivo no corpo (o error.message do supabase-js é genérico).
        const msg = await mensagemDoErroEdge(error);
        return interpretarRespostaImportacao({ ok: false, etapa: 'importacao', mensagem: msg ?? error.message }, numero);
      }
      return interpretarRespostaImportacao(data, numero);
    },
    onSuccess: (r, numero) => {
      setResultado(r);
      track('reposicao.importar_portal', { tom: r.tom, n_itens: r.itens.length, protocolo: numero });
      if (r.pedidoId != null) void queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
    },
    onError: (e: Error, numero) => {
      setResultado(interpretarRespostaImportacao({ ok: false, mensagem: e.message }, numero));
      track('reposicao.importar_portal', { tom: 'erro', n_itens: 0, protocolo: numero });
    },
  });

  const numero = protocolo.trim();
  const valido = PROTOCOLO_PORTAL_RE.test(numero);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (importar.isPending) return; // não fecha no meio da leitura do portal
        setOpen(v);
        if (!v) { setResultado(null); setProtocolo(''); }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" title="Pedido que você digitou direto no portal Sayerlack: informe o número e o app cria o pedido de compra no Omie.">
          <FileInput className="w-4 h-4 mr-1" /> Importar do portal
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Importar pedido do portal Sayerlack</DialogTitle>
          <DialogDescription>
            Para pedido que você digitou direto no portal. Informe o número; eu leio o pedido na Consulta Pedidos
            (cliente OBEN) e crio o pedido de compra no Omie. Se algum item não bater, nada é gravado e eu mostro o motivo.
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
            {importar.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            {importar.isPending ? 'Lendo o portal…' : 'Importar'}
          </Button>
        </form>
        {importar.isPending && (
          <p className="text-xs text-muted-foreground">Abrindo o portal e lendo o pedido — leva até ~1 minuto.</p>
        )}

        {resultado && <ResultadoImportacao r={resultado} />}
      </DialogContent>
    </Dialog>
  );
}

function ResultadoImportacao({ r }: { r: ResultadoTela }) {
  const Icone = r.tom === 'sucesso' ? CheckCircle2 : r.tom === 'aviso' ? AlertTriangle : XCircle;
  const cor = r.tom === 'sucesso' ? 'text-status-success' : r.tom === 'aviso' ? 'text-status-warning' : 'text-status-error';
  return (
    <div className="space-y-3 rounded-md border p-3" data-testid="importar-portal-resultado" data-tom={r.tom}>
      <div className="flex items-start gap-2">
        <Icone className={`w-4 h-4 mt-0.5 shrink-0 ${cor}`} />
        <div className="space-y-1">
          <p className={`text-sm font-medium ${cor}`}>{r.titulo}</p>
          <p className="text-sm text-muted-foreground break-words">{r.mensagem}</p>
        </div>
      </div>
      {(r.pedidoId != null || r.situacaoPortal || r.valorTotal != null) && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {r.pedidoId != null && (<><dt className="text-muted-foreground">Pedido no app</dt><dd>#{r.pedidoId}</dd></>)}
          {r.omieNumero && (<><dt className="text-muted-foreground">Pedido de compra Omie</dt><dd>{r.omieNumero}</dd></>)}
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
              <span className="truncate">{it.sku_portal} — {it.descricao}</span>
              <span className="shrink-0 tabular-nums">{it.qtde_portal} emb · {formatBRL(it.valor_mercadoria)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
