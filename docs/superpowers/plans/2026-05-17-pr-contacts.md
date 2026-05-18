# PR-CONTACTS — Múltiplos telefones + aniversários por cliente

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cliente pode ter N contatos (cada um com phone, nome, cargo, email, aniversário). `resolveCustomerByPhone` busca também em `customer_contacts` → **identifica cliente em qualquer número conhecido** durante chamada inbound. `company_profiles` ganha `data_fundacao` pra empresa também ter aniversário. Foundation pra automação de aniversários (próximo PR).

**Architecture:**
- Migration: `customer_contacts` table + ALTER `company_profiles` ADD `data_fundacao`
- Hook `useCustomerContacts(customerId)` + `useSaveContact` + `useDeleteContact`
- `resolveCustomerByPhone` (PR4) busca em `customer_contacts.phone` UNION `profiles.phone`
- Resultado da resolve agora retorna `{ customerUserId, phoneDialed, contactName? }` pra UI mostrar quem ligou
- Componente `CustomerContactsTab` — nova aba "Contatos" em AdminCustomers (próximo a "Processo")
- `IncomingCallModal` mostra nome do contato + cargo quando identificado

---

## Tasks

### Task 1: Migration

```sql
-- PR-CONTACTS: múltiplos contatos por cliente + aniversário da empresa

CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Telefone (campo principal pra busca)
  phone text NOT NULL,                          -- formato livre; normalizado no client

  -- Identificação
  nome text,                                     -- "João da Silva"
  cargo text CHECK (cargo IN ('dono', 'socio', 'gerente', 'comprador', 'secretaria', 'aplicador', 'tecnico', 'outro')),
  email text,

  -- Sinais
  is_decision_maker boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,    -- contato principal pra ligar/whatsapp
  whatsapp_only boolean NOT NULL DEFAULT false, -- só atende WhatsApp, não liga

  -- Relacionamento
  birthday date,                                 -- aniversário pessoal (pra automação)
  notas text,                                    -- contexto livre: "gosta de futebol, time Cruzeiro"

  -- Auditoria
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'omie', 'auto_detected_call', 'auto_import')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer
  ON public.customer_contacts (customer_user_id, is_primary DESC);

-- Index pra busca por telefone (resolveCustomerByPhone)
-- ILIKE em phone com últimos 8 dígitos é fast com trgm; criamos índice convencional + trgm
CREATE INDEX IF NOT EXISTS idx_customer_contacts_phone
  ON public.customer_contacts (phone);

-- Garante 1 primary por cliente (se setar 2, último ganha — UI controla)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_contacts_one_primary
  ON public.customer_contacts (customer_user_id)
  WHERE is_primary = true;

-- Birthday index pra cron diária buscar aniversariantes (PR-BIRTHDAYS no futuro)
CREATE INDEX IF NOT EXISTS idx_customer_contacts_birthday
  ON public.customer_contacts ((extract(month from birthday)), (extract(day from birthday)))
  WHERE birthday IS NOT NULL;

DROP TRIGGER IF EXISTS trg_customer_contacts_updated_at ON public.customer_contacts;
CREATE TRIGGER trg_customer_contacts_updated_at
  BEFORE UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- RLS staff-only
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_contacts_select_staff" ON public.customer_contacts
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_insert_staff" ON public.customer_contacts
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_update_staff" ON public.customer_contacts
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "customer_contacts_delete_master" ON public.customer_contacts
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- Aniversário da empresa
ALTER TABLE public.company_profiles
  ADD COLUMN IF NOT EXISTS data_fundacao date;

COMMENT ON TABLE public.customer_contacts IS 'Múltiplos contatos por cliente (dono, gerente, comprador, etc) com aniversário e cargo. Usado em resolveCustomerByPhone pra auto-identificar caller na chamada inbound.';
```

Commit: `feat(contacts): migration customer_contacts + company_profiles.data_fundacao`

---

### Task 2: Types + helper resolve atualizado

`src/lib/customer-contact/types.ts`:

```ts
export type ContactCargo = 'dono' | 'socio' | 'gerente' | 'comprador' | 'secretaria' | 'aplicador' | 'tecnico' | 'outro';

export interface CustomerContact {
  id: string;
  customer_user_id: string;
  phone: string;
  nome: string | null;
  cargo: ContactCargo | null;
  email: string | null;
  is_decision_maker: boolean;
  is_primary: boolean;
  whatsapp_only: boolean;
  birthday: string | null;       // YYYY-MM-DD
  notas: string | null;
  source: 'manual' | 'omie' | 'auto_detected_call' | 'auto_import';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const CARGO_LABEL: Record<ContactCargo, string> = {
  dono: 'Dono',
  socio: 'Sócio',
  gerente: 'Gerente',
  comprador: 'Comprador',
  secretaria: 'Secretaria',
  aplicador: 'Aplicador',
  tecnico: 'Técnico',
  outro: 'Outro',
};
```

Atualizar `src/lib/call-session/resolve-customer.ts`:

```ts
export interface ResolvedCustomer {
  customerUserId: string | null;
  phoneDialed: string;
  // NOVO: nome + cargo do contato identificado (se via customer_contacts)
  contactName?: string;
  contactCargo?: string;
}

export async function resolveCustomerByPhone(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');
  if (!phoneDialed) return { customerUserId: null, phoneDialed: '' };

  const last8 = phoneDialed.slice(-8);

  try {
    // 1. Tenta customer_contacts primeiro (mais específico)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: contact } = await (supabase.from('customer_contacts') as any)
      .select('customer_user_id, nome, cargo')
      .filter('phone', 'ilike', `%${last8}%`)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contact?.customer_user_id) {
      return {
        customerUserId: contact.customer_user_id,
        phoneDialed,
        contactName: contact.nome ?? undefined,
        contactCargo: contact.cargo ?? undefined,
      };
    }

    // 2. Fallback pra profiles.phone (compat com PR4)
    const { data: profile } = await supabase
      .from('profiles')
      .select('user_id')
      .filter('phone', 'ilike', `%${last8}%`)
      .maybeSingle();

    if (profile?.user_id) return { customerUserId: profile.user_id, phoneDialed };

    return { customerUserId: null, phoneDialed };
  } catch {
    return { customerUserId: null, phoneDialed };
  }
}
```

**ATUALIZAR TESTES** de `resolve-customer.test.ts` pra mockar busca em customer_contacts primeiro.

Commit: `feat(contacts): types + resolveCustomerByPhone busca customer_contacts primeiro`

---

### Task 3: Hooks

`src/hooks/useCustomerContacts.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { CustomerContact, ContactCargo } from '@/lib/customer-contact/types';

export function useCustomerContacts(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-contacts', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async (): Promise<CustomerContact[]> => {
      if (!customerId) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('customer_contacts') as any)
        .select('*')
        .eq('customer_user_id', customerId)
        .order('is_primary', { ascending: false })
        .order('nome', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CustomerContact[];
    },
  });
}

interface SaveInput {
  id?: string;
  customer_user_id: string;
  phone: string;
  nome?: string;
  cargo?: ContactCargo;
  email?: string;
  is_decision_maker?: boolean;
  is_primary?: boolean;
  whatsapp_only?: boolean;
  birthday?: string | null;
  notas?: string;
  source?: 'manual' | 'omie' | 'auto_detected_call' | 'auto_import';
}

export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<CustomerContact> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Se setar is_primary=true, desliga primary de outros do mesmo cliente primeiro
      if (input.is_primary) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase.from('customer_contacts') as any)
          .update({ is_primary: false })
          .eq('customer_user_id', input.customer_user_id);
      }

      const payload = {
        customer_user_id: input.customer_user_id,
        phone: input.phone.replace(/\s+/g, ' ').trim(),
        nome: input.nome ?? null,
        cargo: input.cargo ?? null,
        email: input.email ?? null,
        is_decision_maker: input.is_decision_maker ?? false,
        is_primary: input.is_primary ?? false,
        whatsapp_only: input.whatsapp_only ?? false,
        birthday: input.birthday ?? null,
        notas: input.notas ?? null,
        source: input.source ?? 'manual',
        created_by: user.id,
      };

      if (input.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('customer_contacts') as any)
          .update(payload).eq('id', input.id).select().single();
        if (error) throw error;
        return data as CustomerContact;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('customer_contacts') as any)
        .insert(payload).select().single();
      if (error) throw error;
      return data as CustomerContact;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customer-contacts', data.customer_user_id] });
      toast.success('Contato salvo');
    },
    onError: (err) => toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, customerId }: { id: string; customerId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('customer_contacts') as any).delete().eq('id', id);
      if (error) throw error;
      return customerId;
    },
    onSuccess: (customerId) => {
      qc.invalidateQueries({ queryKey: ['customer-contacts', customerId] });
      toast.success('Contato removido');
    },
    onError: (err) => toast.error('Erro ao remover', { description: err instanceof Error ? err.message : '' }),
  });
}
```

Commit: `feat(contacts): useCustomerContacts + useSaveContact + useDeleteContact hooks`

---

### Task 4: Componente CustomerContactsTab

`src/components/customer/CustomerContactsTab.tsx`:

```tsx
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useCustomerContacts, useSaveContact, useDeleteContact } from '@/hooks/useCustomerContacts';
import {
  Phone, Mail, Plus, Pencil, Trash2, Loader2, Star, Crown,
  MessageCircle, Cake, User as UserIcon,
} from 'lucide-react';
import { formatBrPhone } from '@/lib/phone';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CARGO_LABEL, type ContactCargo, type CustomerContact } from '@/lib/customer-contact/types';

interface Props {
  customerId: string;
}

export function CustomerContactsTab({ customerId }: Props) {
  const { data, isLoading } = useCustomerContacts(customerId);
  const [editing, setEditing] = useState<CustomerContact | null>(null);
  const [open, setOpen] = useState(false);

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const handleEdit = (c: CustomerContact) => {
    setEditing(c);
    setOpen(true);
  };

  const handleNew = () => {
    setEditing(null);
    setOpen(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Contatos do cliente</h3>
          <p className="text-2xs text-muted-foreground">
            Cadastre todos os telefones que esse cliente usa pra ligar. Quanto mais cadastrado, mais a IA identifica automaticamente quem está ligando.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5" onClick={handleNew}>
              <Plus className="w-3.5 h-3.5" />
              Novo contato
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editing ? 'Editar contato' : 'Novo contato'}</DialogTitle>
            </DialogHeader>
            <ContactForm
              customerId={customerId}
              initial={editing}
              onSaved={() => { setOpen(false); setEditing(null); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {!data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          <UserIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
          Nenhum contato cadastrado ainda.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((c) => <ContactRow key={c.id} contact={c} onEdit={() => handleEdit(c)} />)}
        </div>
      )}
    </div>
  );
}

function ContactRow({ contact, onEdit }: { contact: CustomerContact; onEdit: () => void }) {
  const del = useDeleteContact();
  return (
    <Card className="p-3 flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{contact.nome || formatBrPhone(contact.phone)}</span>
          {contact.is_primary && (
            <Badge variant="outline" className="text-2xs gap-1 border-status-success text-status-success">
              <Star className="w-2.5 h-2.5" />
              Principal
            </Badge>
          )}
          {contact.is_decision_maker && (
            <Badge variant="outline" className="text-2xs gap-1 border-status-warning text-status-warning">
              <Crown className="w-2.5 h-2.5" />
              Decisor
            </Badge>
          )}
          {contact.cargo && (
            <Badge variant="outline" className="text-2xs">{CARGO_LABEL[contact.cargo]}</Badge>
          )}
          {contact.whatsapp_only && (
            <Badge variant="outline" className="text-2xs gap-1">
              <MessageCircle className="w-2.5 h-2.5" />
              WhatsApp
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-2xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{formatBrPhone(contact.phone)}</span>
          {contact.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{contact.email}</span>}
          {contact.birthday && (
            <span className="flex items-center gap-1">
              <Cake className="w-3 h-3" />
              {format(new Date(contact.birthday), 'dd/MM', { locale: ptBR })}
            </span>
          )}
        </div>
        {contact.notas && <div className="text-2xs text-muted-foreground italic">{contact.notas}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-status-error"
          onClick={() => del.mutate({ id: contact.id, customerId: contact.customer_user_id })}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </Card>
  );
}

function ContactForm({ customerId, initial, onSaved }: { customerId: string; initial: CustomerContact | null; onSaved: () => void }) {
  const save = useSaveContact();
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [nome, setNome] = useState(initial?.nome ?? '');
  const [cargo, setCargo] = useState<ContactCargo | ''>(initial?.cargo ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [isDecisionMaker, setIsDecisionMaker] = useState(initial?.is_decision_maker ?? false);
  const [isPrimary, setIsPrimary] = useState(initial?.is_primary ?? false);
  const [whatsappOnly, setWhatsappOnly] = useState(initial?.whatsapp_only ?? false);
  const [birthday, setBirthday] = useState(initial?.birthday ?? '');
  const [notas, setNotas] = useState(initial?.notas ?? '');

  const handleSave = () => {
    if (!phone.trim()) return;
    save.mutate(
      {
        id: initial?.id,
        customer_user_id: customerId,
        phone: phone.trim(),
        nome: nome.trim() || undefined,
        cargo: (cargo || undefined) as ContactCargo | undefined,
        email: email.trim() || undefined,
        is_decision_maker: isDecisionMaker,
        is_primary: isPrimary,
        whatsapp_only: whatsappOnly,
        birthday: birthday || null,
        notas: notas.trim() || undefined,
      },
      { onSuccess: () => onSaved() }
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">Telefone *</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(31) 99999-1234" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Nome</Label>
          <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="João da Silva" />
        </div>
        <div>
          <Label className="text-xs">Cargo</Label>
          <Select value={cargo} onValueChange={(v) => setCargo(v as ContactCargo)}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {Object.entries(CARGO_LABEL).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="joao@empresa.com" />
        </div>
        <div>
          <Label className="text-xs flex items-center gap-1"><Cake className="w-3 h-3" />Aniversário</Label>
          <Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(!!v)} />
          <Star className="w-3 h-3 text-status-success" />
          Contato principal (default pra ligações)
        </label>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={isDecisionMaker} onCheckedChange={(v) => setIsDecisionMaker(!!v)} />
          <Crown className="w-3 h-3 text-status-warning" />
          Decisor (assina compra)
        </label>
        <label className="flex items-center gap-2 text-xs cursor-pointer">
          <Checkbox checked={whatsappOnly} onCheckedChange={(v) => setWhatsappOnly(!!v)} />
          <MessageCircle className="w-3 h-3" />
          Só WhatsApp (não ligar)
        </label>
      </div>
      <div>
        <Label className="text-xs">Notas</Label>
        <Textarea
          rows={2}
          value={notas}
          onChange={(e) => setNotas(e.target.value)}
          placeholder="gosta de futebol, time Cruzeiro; prefere ligação pela manhã"
        />
      </div>
      <Button onClick={handleSave} disabled={!phone.trim() || save.isPending} className="w-full">
        {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />}
        Salvar contato
      </Button>
    </div>
  );
}
```

Commit: `feat(contacts): CustomerContactsTab + ContactForm component`

---

### Task 5: Wire em AdminCustomers + IncomingCallModal

**AdminCustomers**: adicionar tab "Contatos" entre Processo e Chamadas.

**IncomingCallModal**: usar `contactName`/`contactCargo` do resolveCustomerByPhone se disponível.

Commit: `feat(contacts): wire em AdminCustomers (nova tab) + IncomingCallModal (nome+cargo)`

---

### Task 6: QA + PR
