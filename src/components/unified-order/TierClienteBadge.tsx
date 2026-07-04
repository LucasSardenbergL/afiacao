import { useState, useEffect } from 'react';
import { Tag, Pencil } from 'lucide-react';
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
  const { data: tier } = useClienteTier(customerUserId);
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
  const semTier = !temOben && !temColacor;

  // Nada a mostrar e não pode editar → não ocupa espaço.
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
    >
      <Tag className="w-3 h-3" />
      {resumo}
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
