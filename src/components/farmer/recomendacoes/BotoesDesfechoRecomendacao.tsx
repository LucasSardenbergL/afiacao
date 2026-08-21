// Registro de desfecho em 1 toque, na FACE do card de recomendação.
//
// Espelha o BotoesDesfecho do plano tático (src/components/farmer/tacticalPlan/):
// mesmo formato de alvo, mesma trava durante a gravação, mesmo bloqueio sob a
// lente. A diferença é o motivo OBRIGATÓRIO na recusa — no plano tático o desfecho
// é o fato; aqui o PORQUÊ é o que calibra o motor, e sem ele o sinal não ensina.
import { useState } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  useFarmerDesfecho, MOTIVOS_RECUSA, chaveDoAlvo,
  type AlvoDesfecho, type MotivoRecusa,
} from '@/hooks/useFarmerDesfecho';

type Registro = ReturnType<typeof useFarmerDesfecho>;

export const BotoesDesfechoRecomendacao = ({
  alvo,
  registro,
}: {
  alvo: AlvoDesfecho;
  /** O hook vem de CIMA: um escritor por tela, não um por card. */
  registro: Registro;
}) => {
  const { registrar, registrados, registrando, bloqueadoPelaLente } = registro;
  const [pedindoMotivo, setPedindoMotivo] = useState(false);

  const chave = chaveDoAlvo(alvo);
  const jaRegistrado = registrados[chave];
  const gravando = registrando === chave;

  // Já registrado: o card mostra o FATO e some com os botões. Reabrir a decisão
  // seria oferecer uma ação que o banco recusa (o desfecho é imutável — trigger
  // trg_frec_desfecho_imutavel), e o toast de erro puniria quem só se enganou.
  if (jaRegistrado) {
    return (
      <p className="mt-2 text-[10px] text-muted-foreground flex items-center gap-1">
        {jaRegistrado === 'aceito'
          ? <><Check className="w-3 h-3 text-status-success" /> Venda registrada</>
          : <><X className="w-3 h-3 text-status-error" /> Recusa registrada</>}
      </p>
    );
  }

  const desabilitado = !!registrando || bloqueadoPelaLente;

  return (
    <>
      <div
        className="grid grid-cols-2 gap-1 mt-2"
        title={bloqueadoPelaLente ? 'Indisponível em modo Ver como' : undefined}
      >
        <Button
          variant="outline"
          size="touch"
          // `size="touch"` pelo alvo de 44px (WCAG AA / uso no balcão e na rua);
          // o padding da variante é grande demais para dois alvos na largura do card.
          className="px-1 text-[10px] gap-1 min-w-0"
          disabled={desabilitado}
          aria-label="Cliente comprou"
          onClick={() => registrar(alvo, 'aceito')}
        >
          {gravando
            ? <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            : <Check className="w-3 h-3 shrink-0 text-status-success" />}
          <span className="truncate">Comprou</span>
        </Button>
        <Button
          variant="outline"
          size="touch"
          className="px-1 text-[10px] gap-1 min-w-0"
          disabled={desabilitado}
          aria-label="Cliente recusou"
          // Recusa NÃO grava direto: abre o motivo. A RPC recusa (FD003) uma
          // rejeição sem porquê, e é de propósito — recusa sem motivo entra na
          // taxa e não ensina nada a quem for calibrar o gate.
          onClick={() => setPedindoMotivo(true)}
        >
          <X className="w-3 h-3 shrink-0 text-status-error" />
          <span className="truncate">Recusou</span>
        </Button>
      </div>

      <Dialog open={pedindoMotivo} onOpenChange={setPedindoMotivo}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Por que o cliente recusou?</DialogTitle>
            <DialogDescription>
              É o motivo que ensina o motor — a recusa sozinha só diz que erramos, não onde.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {MOTIVOS_RECUSA.map((m) => (
              <Button
                key={m.valor}
                variant="outline"
                size="touch"
                className="text-xs"
                disabled={!!registrando}
                onClick={async () => {
                  const ok = await registrar(alvo, 'rejeitado', m.valor as MotivoRecusa);
                  // Fecha SÓ no sucesso: se o banco recusou (oferta expirada,
                  // chave ambígua), fechar o dialog esconderia o toast de erro
                  // atrás do card e a vendedora acharia que registrou.
                  if (ok) setPedindoMotivo(false);
                }}
              >
                {m.rotulo}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
