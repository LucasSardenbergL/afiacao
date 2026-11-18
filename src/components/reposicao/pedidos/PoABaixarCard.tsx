import { useState } from 'react';
import { ChevronDown, ChevronRight, PackageCheck } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { track } from '@/lib/analytics';
import { motivoLegivel, passosDaAcao, resumirFila, type ItemPoABaixar } from './po-a-baixar';

// Fila "PO a baixar no Omie" (Fase 1 da baixa automática — spec baixa-pedido-compra §19). SÓ LEITURA:
// a API do Omie não encerra PO, e associar/concluir automaticamente foi recusado no parecer do Codex
// (associar antes da entrada física tira saldo do "a caminho"; concluir antecipa estoque e contas a pagar).
// O card mostra a evidência e o passo no Omie; quem decide é a equipe.
//
// Lista vazia some (como o PoSumidoCard quando fresco): os dois tipos vêm do último run VÁLIDO do motor e
// da sombra — linha velha não some, vem MARCADA —, então vazio significa "nada a baixar na última leitura".
// Falha de apuração NUNCA some: "não consegui apurar" ≠ "não há nada" (money-path).
const TITULO = 'PO a baixar no Omie';

function dataCurta(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? format(new Date(t), 'dd/MM') : '—';
}

function Linha({ item }: { item: ItemPoABaixar }) {
  const contado = item.tipo === 'po_contado_com_nf';
  return (
    <li className="border-b border-border last:border-b-0 py-3 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {contado ? (
          <>
            <span className="font-medium">PO {item.numeroPedido ?? '—'}</span>
            <span className="text-muted-foreground">· NF {item.numeroNfe ?? '—'} recebida em {dataCurta(item.nfRecebidaEm)}</span>
            {item.unidadesContadas != null && (
              <Badge variant="outline" className="text-status-warning border-status-warning/40">
                motor ainda conta {item.unidadesContadas.toLocaleString('pt-BR')} un. a caminho
              </Badge>
            )}
          </>
        ) : (
          <>
            <span className="font-medium">NF {item.numeroNfe ?? '—'}</span>
            <span className="text-muted-foreground">· pendente no Omie</span>
            {item.evidenciaDesatualizada && (
              <Badge variant="outline" className="text-muted-foreground">
                última leitura {dataCurta(item.evidenciaEm)} — confira no Omie se ainda está pendente
              </Badge>
            )}
          </>
        )}
        {item.fornecedorNome && <span className="text-muted-foreground">· {item.fornecedorNome}</span>}
      </div>
      <p className="text-sm">{passosDaAcao(item)}</p>
      {item.motivos.length > 0 && (
        <p className="text-xs text-muted-foreground">Por que não é automático: {item.motivos.map(motivoLegivel).join('; ')}.</p>
      )}
    </li>
  );
}

export function PoABaixarCard({
  itens,
  falhaApuracao = false,
  apurando = false,
}: {
  itens: ItemPoABaixar[];
  /** A RPC falhou por motivo que NÃO é o gate de permissão. */
  falhaApuracao?: boolean;
  apurando?: boolean;
}) {
  const [aberto, setAberto] = useState(false);

  if (falhaApuracao && itens.length === 0) {
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
            <PackageCheck className="w-4 h-4" />
            {TITULO} — não foi possível apurar
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A verificação de pedidos com NF já recebida falhou agora. Isso <strong>não</strong> significa que
            está tudo baixado — significa que não sabemos. Recarregue a página; se persistir, avise o time técnico.
          </p>
        </CardHeader>
      </Card>
    );
  }
  // "ainda não sei" ≠ "não há": enquanto a 1ª apuração não volta, o card diz que está apurando.
  if (apurando) {
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
            <PackageCheck className="w-4 h-4" />
            {TITULO} — apurando…
          </CardTitle>
        </CardHeader>
      </Card>
    );
  }
  if (itens.length === 0) return null;

  const { contados, pendentes } = resumirFila(itens);
  const alternar = () => {
    setAberto((v) => {
      if (!v) track('reposicao.po_a_baixar_aberto', { contados, pendentes });
      return !v;
    });
  };

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer select-none" onClick={alternar}>
        <CardTitle className="text-base flex flex-wrap items-center gap-2 text-muted-foreground">
          {aberto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <PackageCheck className="w-4 h-4" />
          {TITULO} ({itens.length})
          {contados > 0 && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              {contados} com NF já recebida
            </Badge>
          )}
          {pendentes > 0 && <Badge variant="outline">{pendentes} NF pendente{pendentes > 1 ? 's' : ''}</Badge>}
        </CardTitle>
        {falhaApuracao && (
          <p className="text-sm text-status-warning">
            A última atualização falhou — a lista abaixo pode estar desatualizada.
          </p>
        )}
      </CardHeader>
      {aberto && (
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Nada aqui é feito no Omie automaticamente. A baixa acontece quando a NF é associada ao pedido no
            recebimento do Omie, ou quando o pedido é encerrado lá (irreversível — só com entrega total).
          </p>
          <ul>
            {itens.map((i) => (
              <Linha key={`${i.tipo}:${i.numeroPedido ?? ''}:${i.nidReceb ?? ''}`} item={i} />
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
