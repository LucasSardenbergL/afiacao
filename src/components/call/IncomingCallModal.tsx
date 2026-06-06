import { useEffect, useState } from 'react';
import { useWebRTCCallContextOptional } from '@/contexts/WebRTCCallContext';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { formatBrPhone } from '@/lib/phone';
import { supabase } from '@/integrations/supabase/client';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';
import { classificarRealceDono, type RealceDono } from '@/lib/call-session/owner-highlight';
import { useAuth } from '@/contexts/AuthContext';

// Label amigável pra cargo (PR-CONTACTS) — mantido inline pra evitar dep direta de types
const CARGO_FRIENDLY: Record<string, string> = {
  dono: 'Dono',
  socio: 'Sócio',
  gerente: 'Gerente',
  comprador: 'Comprador',
  secretaria: 'Secretaria',
  aplicador: 'Aplicador',
  tecnico: 'Técnico',
  outro: 'Outro',
};

/**
 * Modal centralizado que aparece quando uma chamada inbound chega no ramal SIP
 * do vendedor (PR-INBOUND-CALLS).
 *
 * Identifica cliente automaticamente via match de telefone em profiles.
 * Frente 1 degradada: destaca se o cliente é da carteira do vendedor logado
 * (⭐ "seu cliente") vs de outra ("cliente da Regina") vs sem dono — via wa_owner_efetivo
 * (dono efetivo, considera cobertura de férias). Como todas as vendas tocam juntas
 * (ring-all no Nvoip), o realce direciona socialmente sem owner-first "duro".
 *
 * Vendedor clica Atender → mesmo fluxo de áudio do outbound:
 * - rawMic + preroll LGPD da Sara mixado
 * - transcript Deepgram + copilot SPIN automáticos
 * - persistência em farmer_calls automática
 */
export function IncomingCallModal() {
  const ctx = useWebRTCCallContextOptional();
  const incomingCall = ctx?.incomingCall ?? null;
  const acceptIncoming = ctx?.acceptIncoming;
  const rejectIncoming = ctx?.rejectIncoming;
  const { user } = useAuth();
  const [resolvedCompany, setResolvedCompany] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [contactCargo, setContactCargo] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [realce, setRealce] = useState<RealceDono>('desconhecido');
  const [donoNome, setDonoNome] = useState<string | null>(null);

  // Tenta identificar cliente + contato pelo telefone, e o dono efetivo (realce)
  useEffect(() => {
    if (!incomingCall) {
      setResolvedCompany(null);
      setContactName(null);
      setContactCargo(null);
      setRealce('desconhecido');
      setDonoNome(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resolved = await resolveCustomerByPhone(incomingCall.phone);
        if (cancelled) return;
        // PR-CONTACTS: contactName + cargo vêm direto se identificou via customer_contacts
        if (resolved.contactName) setContactName(resolved.contactName);
        if (resolved.contactCargo) setContactCargo(resolved.contactCargo);
        if (!resolved.customerUserId) {
          if (!cancelled) setRealce('desconhecido');
          return;
        }

        const { data } = await supabase.from('profiles')
          .select('name, razao_social')
          .eq('user_id', resolved.customerUserId)
          .maybeSingle();
        if (!cancelled && data) {
          setResolvedCompany(data.razao_social || data.name);
        }

        // Frente 1 degradada: dono efetivo (com cobertura de férias) → realça meu/outro/sem-dono
        const { data: ownerId } = await supabase.rpc('wa_owner_efetivo', { p_customer: resolved.customerUserId });
        if (cancelled) return;
        const owner = (ownerId as string | null) ?? null;
        setRealce(classificarRealceDono({ ownerUserId: owner, currentUserId: user?.id ?? null, customerUserId: resolved.customerUserId }));
        if (owner && owner !== user?.id) {
          const { data: dono } = await supabase.from('profiles').select('name').eq('user_id', owner).maybeSingle();
          if (!cancelled && dono?.name) setDonoNome(dono.name);
        }
      } catch {
        // ignore — modal mostra só telefone (degradação honesta: realce fica 'desconhecido')
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [incomingCall, user?.id]);

  if (!incomingCall) return null;

  // Hierarquia de exibição:
  // 1. Nome do contato + cargo (se identificado via customer_contacts) — PR-CONTACTS
  // 2. Razão social da empresa (se cliente identificado em profiles)
  // 3. Display name do SIP FROM
  // 4. Telefone formatado
  const primaryLabel = contactName ?? resolvedCompany ?? incomingCall.displayName ?? formatBrPhone(incomingCall.phone);
  const secondaryLabel = contactName && resolvedCompany ? resolvedCompany : null;
  const cargoLabel = contactCargo ? CARGO_FRIENDLY[contactCargo] ?? contactCargo : null;

  const handleAccept = async () => {
    setAccepting(true);
    try {
      await acceptIncoming?.();
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && rejectIncoming?.()}>
      <DialogContent
        className="max-w-md text-center"
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-center gap-2 text-base">
            <Phone className="w-4 h-4 animate-pulse text-status-success" />
            Chamada entrando
          </DialogTitle>
          <DialogDescription className="space-y-2 pt-4">
            {realce === 'meu' && (
              <span className="block rounded-md bg-status-success-bg px-3 py-1.5 text-sm font-semibold text-status-success">
                ⭐ Seu cliente — atenda
              </span>
            )}
            {realce === 'outro' && (
              <span className="block rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
                Cliente {donoNome ? `da ${donoNome}` : 'de outra carteira'}
              </span>
            )}
            <span className="block text-2xl font-semibold text-foreground">
              {primaryLabel}
              {cargoLabel && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({cargoLabel})
                </span>
              )}
            </span>
            {secondaryLabel && (
              <span className="block text-xs text-foreground/70">{secondaryLabel}</span>
            )}
            {(contactName || resolvedCompany) && (
              <span className="block text-xs text-muted-foreground">
                {formatBrPhone(incomingCall.phone)}
              </span>
            )}
            {!contactName && !resolvedCompany && (
              <span className="block text-2xs text-status-warning">
                Cliente não identificado — após atender, cadastre novo prospect
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-3 pt-4">
          <Button
            variant="outline"
            size="lg"
            className="gap-2 border-status-error text-status-error hover:bg-status-error-bg"
            onClick={rejectIncoming}
            disabled={accepting}
          >
            <PhoneOff className="w-4 h-4" />
            Rejeitar
          </Button>
          <Button
            size="lg"
            className="gap-2 bg-status-success hover:bg-status-success/90"
            onClick={handleAccept}
            disabled={accepting}
          >
            {accepting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Phone className="w-4 h-4" />
            )}
            Atender
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
