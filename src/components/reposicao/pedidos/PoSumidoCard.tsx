import { useState } from 'react';
import { ChevronDown, ChevronRight, FileSearch } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBRL } from './shared';
import { acaoSugerida, type PoCandidato } from './po-sumido';

// Seção NEUTRA (recolhida) da fila de atenção: pedidos `disparado` cujo PO NÃO apareceu no último run
// VÁLIDO do omie-sync-pedidos-compra — ou seja, o PO sumiu do Omie mas o pedido segue disparado aqui.
// Enquanto está DENTRO da janela de 7d isso infla o estoque efetivo (a CTE em_transito re-soma as
// unidades) e o item some do cockpit; fora dela é sujeira — o motor já voltou a sugerir o SKU.
//
// ⚠️ COPY HONESTA (a lição que custou 16 rodadas de review): "PO sumiu do Omie" NÃO prova "a compra não
// existe". O disparo aciona o PORTAL DO FORNECEDOR **antes** de criar o PO no Omie, então o fornecedor
// pode estar com o pedido protocolado mesmo sem PO. Por isso este card NUNCA sugere cancelar: mostra a
// EVIDÊNCIA (protocolo, canal, status) e deixa a decisão com quem sabe o contexto. Cancelar um pedido
// que o fornecedor tem = o motor re-sugere = compra duplicada.
export function PoSumidoCard({
  candidatos,
  falhaApuracao = false,
}: {
  candidatos: PoCandidato[];
  /** A RPC não respondeu (erro que NÃO é falta de permissão). Ver comentário abaixo. */
  falhaApuracao?: boolean;
}) {
  const [aberto, setAberto] = useState(false);

  // "Não consegui apurar" ≠ "não há nada" (money-path). Se a RPC falhou, sumir em silêncio faria o
  // detector parecer saudável justamente quando ele está cego — o mesmo tipo de silêncio que deixou o
  // PO fantasma passar 7 dias despercebido. Então falha vira aviso VISÍVEL, não ausência.
  if (falhaApuracao) {
    return (
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
            <FileSearch className="w-4 h-4" />
            Pedido sem PO no Omie — não foi possível apurar
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A verificação de pedidos disparados sem PO no Omie falhou agora. Isso <strong>não</strong>{' '}
            significa que está tudo certo — significa que não sabemos. Recarregue a página; se persistir,
            avise o time técnico.
          </p>
        </CardHeader>
      </Card>
    );
  }

  if (candidatos.length === 0) return null;

  const comDanoAtivo = candidatos.filter((c) => c.na_janela_7d).length;
  // valor_total é NULL quando algum item não tem preço — somar tratando null como 0 seria fabricar
  // número (money-path: ausente ≠ zero). Só somamos o que é conhecido e sinalizamos se houver lacuna.
  const conhecidos = candidatos.filter((c) => c.valor_total != null);
  const total = conhecidos.reduce((s, c) => s + Number(c.valor_total), 0);
  const temValorDesconhecido = conhecidos.length < candidatos.length;

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer select-none" onClick={() => setAberto((v) => !v)}>
        <CardTitle className="text-base flex items-center gap-2 text-muted-foreground">
          {aberto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <FileSearch className="w-4 h-4" />
          Pedido sem PO no Omie ({candidatos.length})
          {comDanoAtivo > 0 && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              {comDanoAtivo} na janela de 7 dias
            </Badge>
          )}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          O pedido está <strong>disparado</strong> aqui, mas o PO não apareceu na última varredura do
          Omie. Dentro da janela de 7 dias isso infla o estoque e o item some do cockpit; fora dela, o
          motor já voltou a sugerir o SKU.{' '}
          <strong>Não cancele sem conferir</strong> — o fornecedor pode estar com o pedido (o portal é
          acionado antes do Omie). Total conhecido {formatBRL(total)}
          {temValorDesconhecido && ' (há pedido com item sem preço)'}.
        </p>
      </CardHeader>
      {aberto && (
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ciclo</TableHead>
                <TableHead>Fornecedor / Canal</TableHead>
                <TableHead>Evidência</TableHead>
                <TableHead>O que fazer</TableHead>
                <TableHead className="text-right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidatos.map((c) => {
                const acao = acaoSugerida(c);
                return (
                  <TableRow key={c.pedido_id}>
                    <TableCell className="text-xs tabular-nums whitespace-nowrap">
                      {format(new Date(c.data_ciclo + 'T12:00:00'), 'dd/MM/yyyy')}
                      <div className="text-muted-foreground">
                        {c.idade_dias}d{c.na_janela_7d && ' · na janela'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.fornecedor_nome ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{c.canal_usado ?? '—'}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.portal_protocolo && (
                        <div>
                          protocolo <span className="font-medium tabular-nums">{c.portal_protocolo}</span>
                        </div>
                      )}
                      {c.status_envio_portal && (
                        <div className="text-muted-foreground">{c.status_envio_portal}</div>
                      )}
                      {!c.algum_sinal_de_canal && (
                        <span className="text-muted-foreground">sem sinal de canal</span>
                      )}
                      <div className="text-muted-foreground">PO {c.omie_codigo_pedido}</div>
                    </TableCell>
                    <TableCell className="text-xs max-w-[22rem]">{acao}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {c.valor_total == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatBRL(c.valor_total)
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}
