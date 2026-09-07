import { useState, useEffect } from 'react';
import { Tag, Pencil, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { useClienteTier, useDefinirTier, type Conta } from '@/hooks/useClienteTier';
import type { Tier } from '@/lib/pricing/precoPartida';
import { track } from '@/lib/analytics';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';

const CONTAS: { key: Conta; label: string }[] = [
  { key: 'oben', label: 'Oben' },
  { key: 'colacor', label: 'Colacor' },
];
const TIERS: Tier[] = ['A', 'B', 'C'];

/**
 * Badge do tier comercial (A/B/C) no header do cliente do wizard. Staff vê; só gestão
 * (master/gestor comercial) edita — o badge vira botão que abre o dialog. A escrita real
 * é gateada pela RLS (pode_ver_carteira_completa); este gate é defense-in-depth de UI.
 * O tier orienta o preço de PARTIDA e o piso do cockpit — nunca é inferido, é decisão humana.
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md), aqui na variante
 * mais cara: a falha de leitura não só escondia o badge de quem não edita (`semTier &&
 * !podeEditar → null`) como AFIRMAVA "Definir tier" para quem edita — e o dialog abria com
 * os selects vazios, de onde um Salvar sobrescreveria, via upsert, o tier vigente que o
 * componente não conseguiu ler. Fabricar "não há tier" a partir de "não consegui ler" num
 * campo que orienta preço é o §2 do money-path (ausente ≠ zero) na camada de UI.
 * Fail-CLOSED: sem leitura não se edita. `cliente_tier_preco` tem 0 linhas hoje (psql-ro,
 * 2026-08-23), então o dano ainda não aconteceu — o gatilho é o PRIMEIRO tier cadastrado,
 * mesmo critério pelo qual o #1886 quitou o `useMyActiveCoverage`.
 */
export function TierClienteBadge({
  customerUserId,
  customerName,
}: {
  customerUserId: string | null | undefined;
  customerName?: string | null;
}) {
  const { isMaster, isGestorComercial } = useAuth();
  const podeEditar = isMaster || isGestorComercial;
  const q = useClienteTier(customerUserId);
  const { data: tier } = q;
  const estado = estadoDeLeitura(q);
  // Sem NADA em mãos, "não consegui ler" NUNCA pode virar "sem tier".
  const leituraFalhou = naoConsegui(estado) && !tier;
  // Com o tier em cache e um refetch que falhou, o badge FICA (apagá-lo tiraria do
  // vendedor a informação que ele já tinha) — só declara que pode estar desatualizado.
  const velho = desatualizado(q, Boolean(tier));
  const definir = useDefinirTier();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ oben: Tier | ''; colacor: Tier | '' }>({ oben: '', colacor: '' });
  const [motivo, setMotivo] = useState('');

  // Ao abrir, pré-carrega os tiers vigentes.
  useEffect(() => {
    if (open) {
      setSel({ oben: tier?.oben ?? '', colacor: tier?.colacor ?? '' });
      setMotivo('');
    }
  }, [open, tier]);

  if (!customerUserId) return null;

  const temOben = !!tier?.oben;
  const temColacor = !!tier?.colacor;
  // `semTier` é uma AFIRMAÇÃO e só a leitura PRONTA a sustenta. Antes disto o estado
  // `carregando` também caía aqui e o badge dizia "Definir tier" antes de saber — a mesma
  // classe, no quarto estado: convidava a ESCREVER tier sobre uma leitura que não chegou.
  const semTier = estado === 'pronta' && !temOben && !temColacor;

  // A leitura não aconteceu: o badge fala em vez de sumir OU de afirmar "Definir tier",
  // e não abre o dialog — editar exigiria conhecer o tier vigente, que é justamente o que
  // falta. Vale inclusive para quem não edita: aqui a ausência não é "nada a mostrar".
  // Carregando: nada a afirmar ainda. Transitório e auto-resolvido (o helper trata este
  // estado à parte de propósito), e um badge vazio pisca menos que um convite errado.
  if (estado === 'carregando') return null;

  if (leituraFalhou) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[11px] font-medium text-status-warning border-status-warning/30"
        data-testid="tier-cliente-badge"
        title={
          (estado === 'sem-rede'
            ? 'Sem conexão — não foi possível ler o tier deste cliente. '
            : 'Não foi possível ler o tier deste cliente. ') +
          'Isto NÃO quer dizer que ele não tem tier: como o tier orienta o preço de partida, ' +
          'a edição fica bloqueada até a leitura voltar.'
        }
      >
        <AlertTriangle className="w-3 h-3" />
        Tier indisponível
      </Badge>
    );
  }

  // Nada a mostrar e não pode editar → não ocupa espaço. (Agora um vazio VERIFICADO.)
  if (semTier && !podeEditar) return null;

  const resumo = semTier
    ? 'Definir tier'
    : [temOben && `Oben ${tier!.oben}`, temColacor && `Colacor ${tier!.colacor}`]
        .filter(Boolean)
        .join(' · ');

  const salvar = async () => {
    if (!customerUserId) return;
    const alvos: { company: Conta; tier: Tier }[] = [];
    for (const { key } of CONTAS) {
      const novo = sel[key];
      if (novo && novo !== (tier?.[key] ?? '')) alvos.push({ company: key, tier: novo });
    }
    if (alvos.length === 0) {
      setOpen(false);
      return;
    }
    try {
      for (const a of alvos) {
        await definir.mutateAsync({
          company: a.company,
          customerUserId,
          tier: a.tier,
          motivo: motivo || null,
        });
      }
      track('venda.tier_definido', { contas: alvos.length });
      toast.success('Tier atualizado', {
        description: alvos.map((a) => `${a.company === 'oben' ? 'Oben' : 'Colacor'}: ${a.tier}`).join(' · '),
      });
      setOpen(false);
    } catch (e) {
      toast.error('Não foi possível salvar o tier', {
        description: e instanceof Error ? e.message : 'Verifique sua permissão (só gestão define tier).',
      });
    }
  };

  const badge = (
    <Badge
      variant={semTier ? 'outline' : 'secondary'}
      className="gap-1 text-[11px] font-medium"
      data-testid="tier-cliente-badge"
      title={velho ? 'Esta leitura pode estar desatualizada — a última tentativa de atualizar o tier falhou.' : undefined}
    >
      <Tag className="w-3 h-3" />
      {resumo}
      {velho && <AlertTriangle className="w-2.5 h-2.5 text-status-warning" />}
      {podeEditar && <Pencil className="w-2.5 h-2.5 opacity-60" />}
    </Badge>
  );

  return (
    <>
      {podeEditar ? (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex" aria-label="Editar tier do cliente">
          {badge}
        </button>
      ) : (
        badge
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tier comercial{customerName ? ` — ${customerName}` : ''}</DialogTitle>
            <DialogDescription>
              O tier A/B/C orienta o preço de partida e o piso do cockpit por conta. Decisão de gestão,
              auditada. Não altera preços já negociados.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {CONTAS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <Label className="text-sm">{label}</Label>
                <Select
                  value={sel[key]}
                  onValueChange={(v) => setSel((p) => ({ ...p, [key]: v as Tier }))}
                >
                  <SelectTrigger className="w-32" data-testid={`tier-select-${key}`}>
                    <SelectValue placeholder="Sem tier" />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        Tier {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}

            <div className="space-y-1">
              <Label htmlFor="tier-motivo" className="text-sm">
                Motivo <span className="text-muted-foreground">(opcional)</span>
              </Label>
              <Textarea
                id="tier-motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ex.: volume anual, estratégico, margem histórica…"
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={definir.isPending}>
              {definir.isPending ? 'Salvando…' : 'Salvar tier'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
