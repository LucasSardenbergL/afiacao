import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { mensagemErroRepasse, useAprovarRepasse } from '@/hooks/useVendaPainel';
import {
  formatarPreco,
  lerPreco,
  somarDias,
  validarAprovacao,
  type CandidatoRepasse,
} from '@/lib/venda-cliente/painel';

interface Props {
  candidato: CandidatoRepasse;
  nomeComprador: string;
  /** data de hoje no calendário de SP (vinda do servidor) */
  hoje: string;
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
}

/** Validade padrão: 90 dias — um ciclo de recompra típico, dentro do teto de 1 ano da RPC. */
const VALIDADE_PADRAO_DIAS = 90;

export function DialogAprovarRepasse({ candidato, nomeComprador, hoje, aberto, onAbertoChange }: Props) {
  const [precoTexto, setPrecoTexto] = useState(
    candidato.preco_sugerido !== null ? candidato.preco_sugerido.toFixed(2).replace('.', ',') : '',
  );
  const [validoAte, setValidoAte] = useState(somarDias(hoje, VALIDADE_PADRAO_DIAS));
  const aprovar = useAprovarRepasse();

  const precoAlvo = lerPreco(precoTexto);
  const validacao = validarAprovacao({ precoAlvo, ultimoPreco: candidato.ultimo_preco, validoAte, hoje });

  const confirmar = () => {
    if (!validacao.ok || precoAlvo === null) return;
    aprovar.mutate(
      {
        comprador: candidato.comprador_id,
        codigo: candidato.omie_codigo_produto,
        precoAlvo,
        validoAte,
        substitui: candidato.repasse_atual?.id ?? null,
      },
      {
        onSuccess: () => {
          toast.success('Repasse aprovado', { description: `${nomeComprador} · alvo ${formatarPreco(precoAlvo)}` });
          onAbertoChange(false);
        },
        onError: (e) => toast.error('Repasse não aprovado', { description: mensagemErroRepasse(e) }),
      },
    );
  };

  return (
    <Dialog open={aberto} onOpenChange={onAbertoChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Aprovar repasse</DialogTitle>
          <DialogDescription>
            {nomeComprador} · {candidato.descricao ?? `SKU ${candidato.omie_codigo_produto}`}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Último preço praticado</dt>
          <dd className="text-right tabular-nums">{formatarPreco(candidato.ultimo_preco)}</dd>
          <dt className="text-muted-foreground">Sugerido pela regra</dt>
          <dd className="text-right tabular-nums">{formatarPreco(candidato.preco_sugerido)}</dd>
        </dl>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="repasse-preco-alvo">Preço alvo (R$)</Label>
            <Input
              id="repasse-preco-alvo"
              inputMode="decimal"
              autoComplete="off"
              value={precoTexto}
              onChange={(e) => setPrecoTexto(e.target.value)}
              className="tabular-nums"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="repasse-validade">Válido até</Label>
            <Input
              id="repasse-validade"
              type="date"
              min={somarDias(hoje, 1)}
              max={somarDias(hoje, 365)}
              value={validoAte}
              onChange={(e) => setValidoAte(e.target.value)}
            />
          </div>
          {!validacao.ok && (
            <p role="alert" className="text-sm text-status-error">
              {validacao.motivo}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            A farmer verá este alvo ao lado do último preço, sem custo. Aprovar de novo substitui o alvo vigente.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onAbertoChange(false)}>
            Cancelar
          </Button>
          <Button onClick={confirmar} disabled={!validacao.ok || aprovar.isPending}>
            {aprovar.isPending ? 'Aprovando…' : 'Aprovar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
