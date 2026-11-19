import { useState } from 'react';
import { ChevronDown, ChevronRight, PackageCheck } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { track } from '@/lib/analytics';
import {
  decisaoLegivel,
  decisoesDoTipo,
  motivoLegivel,
  passosDaAcao,
  resumirFila,
  type DecisaoPoABaixar,
  type ItemPoABaixar,
  type ParPoABaixar,
} from './po-a-baixar';

// Fila "PO a baixar no Omie" (Fase 1 da baixa automática — spec baixa-pedido-compra §19). SÓ LEITURA:
// a API do Omie não encerra PO, e associar/concluir automaticamente foi recusado no parecer do Codex
// (associar antes da entrada física tira saldo do "a caminho"; concluir antecipa estoque e contas a pagar).
// O card mostra a evidência e o passo no Omie; quem decide é a equipe.
//
// Entrega A: para NF `associavel` fresca, os PARES item a item que a sombra já calculou (a equipe copia na tela
// "Associar Pedido" do Omie); para ambígua/órfã/velha, só candidatos + motivos. E o REGISTRO da decisão — sensor
// com denominador: marcar aqui não muda o Omie, o motor nem a fila (a fila só sai quando o Omie for relido).
// Sem link para o Omie: não há URL estável verificada para a NF/PO, e link quebrado ensina a ignorar o card.
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

function texto(v: string | number | null): string {
  if (v == null) return '—';
  return typeof v === 'number' ? v.toLocaleString('pt-BR') : v;
}

function TabelaPares({ pares }: { pares: ParPoABaixar[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-normal">Seq. NF</th>
            <th className="py-1 pr-3 font-normal">PO</th>
            <th className="py-1 pr-3 font-normal">Item do PO</th>
            <th className="py-1 pr-3 font-normal">Produto</th>
            <th className="py-1 pr-3 font-normal text-right">Qtde</th>
            <th className="py-1 font-normal">Cobertura do PO</th>
          </tr>
        </thead>
        <tbody>
          {pares.map((p, i) => (
            <tr key={`${p.seqNf ?? 'x'}:${p.numeroPedido ?? ''}:${p.itemPo ?? ''}:${i}`} className="border-t border-border">
              <td className="py-1 pr-3 tabular-nums">{texto(p.seqNf)}</td>
              <td className="py-1 pr-3 tabular-nums">{texto(p.numeroPedido)}</td>
              <td className="py-1 pr-3 tabular-nums">{p.itemPo != null ? `${p.itemPo}º` : '—'}</td>
              <td className="py-1 pr-3">
                {p.codigoProduto ?? '—'}
                {p.descricao && <span className="text-muted-foreground"> · {p.descricao}</span>}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {texto(p.quantidade)} {p.unidade ?? ''}
              </td>
              <td className="py-1">{p.cobertura === 'total' ? 'total' : p.cobertura === 'parcial' ? 'parcial — sobra saldo' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Decisao({
  item,
  onDecidir,
  emVoo,
}: {
  item: ItemPoABaixar;
  onDecidir: (item: ItemPoABaixar, decisao: DecisaoPoABaixar) => void;
  emVoo: boolean;
}) {
  // sem identidade/versão não há o que registrar com honestidade (o banco recusaria): não oferece o botão
  if (!item.chave || !item.propostaVersao) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {item.decisaoVigente && (
        <span className="text-xs text-muted-foreground">
          Marcado: <strong>{decisaoLegivel(item.decisaoVigente)}</strong> em {dataCurta(item.decisaoVigenteEm)} — a
          fila sai quando o Omie for relido.
        </span>
      )}
      {decisoesDoTipo(item.tipo).map((d) => (
        <Button
          key={d}
          type="button"
          size="sm"
          variant={item.decisaoVigente === d ? 'secondary' : 'outline'}
          disabled={emVoo}
          onClick={() => onDecidir(item, d)}
        >
          {decisaoLegivel(d)}
        </Button>
      ))}
    </div>
  );
}

function Linha({
  item,
  onDecidir,
  decidindo,
}: {
  item: ItemPoABaixar;
  onDecidir?: (item: ItemPoABaixar, decisao: DecisaoPoABaixar) => void;
  decidindo?: string | null;
}) {
  const contado = item.tipo === 'po_contado_com_nf';
  const comPares = item.pares != null && item.pares.length > 0;
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
      {comPares && item.pares && <TabelaPares pares={item.pares} />}
      {item.paresRetidos === 'po_encerrado_no_omie' && (
        <p className="text-xs text-status-warning">
          Par item a item retido: um PO do par consta como ENCERRADO no Omie. Confira o PO antes de associar.
        </p>
      )}
      {item.paresRetidos === 'evidencia_desatualizada' && (
        <p className="text-xs text-muted-foreground">
          Par item a item retido: a última leitura desta NF é antiga. Confira no Omie antes de associar.
        </p>
      )}
      {!contado && !comPares && item.pedidosSugeridos.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Candidatos: PO {item.pedidosSugeridos.join(', ')} — sem par item a item, confira no Omie.
        </p>
      )}
      {item.motivos.length > 0 && (
        <p className="text-xs text-muted-foreground">Por que não é automático: {item.motivos.map(motivoLegivel).join('; ')}.</p>
      )}
      {onDecidir && (
        <Decisao item={item} onDecidir={onDecidir} emVoo={decidindo === `${item.tipo}:${item.chave}`} />
      )}
    </li>
  );
}

export function PoABaixarCard({
  itens,
  falhaApuracao = false,
  apurando = false,
  onDecidir,
  decidindo = null,
}: {
  itens: ItemPoABaixar[];
  /** Registrar a decisão da equipe (sensor). Ausente = card só de leitura. */
  onDecidir?: (item: ItemPoABaixar, decisao: DecisaoPoABaixar) => void;
  /** `tipo:chave` do item com registro em voo. */
  decidindo?: string | null;
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
            Os botões só registram o que você fez — não mudam nada no Omie nem no cálculo de compra.
          </p>
          <ul>
            {itens.map((i) => (
              <Linha
                key={`${i.tipo}:${i.chave ?? i.numeroPedido ?? ''}:${i.nidReceb ?? ''}`}
                item={i}
                onDecidir={onDecidir}
                decidindo={decidindo}
              />
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
