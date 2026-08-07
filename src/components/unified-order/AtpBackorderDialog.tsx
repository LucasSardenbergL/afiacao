import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle } from 'lucide-react';
import type { BloqueioAtpPedido } from '@/services/orderSubmission';

/**
 * ATP fase 2 — painel de DECISÃO da recusa de estoque (nunca silencioso).
 * O PV Oben NÃO foi criado; o vendedor decide explicitamente:
 *  - recusa de saldo → backorder com MOTIVO (auditado server-side), ou voltar;
 *  - verificação indisponível → "Tentar novamente" é a ação primária; o
 *    backorder de contingência fica secundário com fricção (parecer Codex);
 *  - semOverride (bug/autorização) → sem saída de backorder: avisar a equipe.
 */
interface AtpBackorderDialogProps {
  bloqueio: BloqueioAtpPedido | null;
  /** descrição por omie_codigo_produto p/ nomear produtos (fallback: o código). */
  descricaoPorSku: Map<number, string>;
  enviando: boolean;
  onAutorizar: (motivo: string) => void;
  onTentarNovamente: () => void;
  onFechar: () => void;
}

const MOTIVO_MIN = 5;

export function AtpBackorderDialog({
  bloqueio, descricaoPorSku, enviando, onAutorizar, onTentarNovamente, onFechar,
}: AtpBackorderDialogProps) {
  const [motivo, setMotivo] = useState('');
  const [mostrarContingencia, setMostrarContingencia] = useState(false);
  const motivoValido = motivo.trim().length >= MOTIVO_MIN;

  if (!bloqueio) return null;
  const ehVerificacao = bloqueio.tipo === 'verificacao_indisponivel';

  const fechar = () => {
    setMotivo('');
    setMostrarContingencia(false);
    onFechar();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) fechar(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-status-warning" aria-hidden />
            {ehVerificacao ? 'Não foi possível verificar o estoque' : 'Sem estoque disponível (Oben)'}
          </DialogTitle>
          <DialogDescription>
            O pedido Oben <strong>não foi enviado</strong> ao Omie.{' '}
            {ehVerificacao
              ? 'A verificação de disponibilidade falhou — o pedido ficou salvo para reenvio.'
              : 'A reserva de estoque foi recusada — decida como seguir.'}
          </DialogDescription>
        </DialogHeader>

        {!ehVerificacao && bloqueio.recusas.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="px-3 py-2 font-medium">Produto</th>
                  <th className="px-3 py-2 text-right font-medium">Pedido</th>
                  <th className="px-3 py-2 text-right font-medium">Disponível</th>
                </tr>
              </thead>
              <tbody>
                {bloqueio.recusas.map((r) => (
                  <tr key={r.omie_codigo_produto} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {descricaoPorSku.get(r.omie_codigo_produto) ?? String(r.omie_codigo_produto)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.solicitado ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-status-error">
                      {/* null = sem posição confiável (ausente ≠ zero) */}
                      {r.disponivel ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {ehVerificacao && bloqueio.detalhe && (
          <p className="text-sm text-muted-foreground">{bloqueio.detalhe}</p>
        )}

        {bloqueio.semOverride ? (
          <p className="text-sm text-status-error">
            Esta falha é do sistema (não é falta de saldo) e não aceita envio forçado.
            Tente de novo em instantes; se persistir, avise a equipe.
          </p>
        ) : (
          (!ehVerificacao || mostrarContingencia) && (
            <div className="space-y-1.5">
              <label htmlFor="atp-motivo" className="text-sm font-medium">
                Motivo do backorder <span className="text-muted-foreground">(obrigatório — fica registrado)</span>
              </label>
              <Textarea
                id="atp-motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ex.: cliente aceita aguardar a reposição; entrega parcial combinada…"
                rows={2}
              />
            </div>
          )
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={fechar} disabled={enviando}>
            Voltar
          </Button>
          {ehVerificacao && (
            <Button size="touch" onClick={onTentarNovamente} disabled={enviando}>
              Tentar novamente
            </Button>
          )}
          {!bloqueio.semOverride && ehVerificacao && !mostrarContingencia && (
            <Button variant="outline" onClick={() => setMostrarContingencia(true)} disabled={enviando}>
              Enviar mesmo assim…
            </Button>
          )}
          {!bloqueio.semOverride && (!ehVerificacao || mostrarContingencia) && (
            <Button
              size="touch"
              variant={ehVerificacao ? 'outline' : 'default'}
              onClick={() => onAutorizar(motivo)}
              disabled={enviando || !motivoValido}
            >
              Enviar como backorder
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
