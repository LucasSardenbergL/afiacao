import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  useCustomerContacts, useSaveContact, useDeleteContact,
} from '@/hooks/useCustomerContacts';
import {
  Phone, Mail, Plus, Pencil, Trash2, Loader2, Star, Crown,
  MessageCircle, Cake, User as UserIcon,
} from 'lucide-react';
import { formatBrPhone } from '@/lib/phone';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CARGO_LABEL, type ContactCargo, type CustomerContact,
} from '@/lib/customer-contact/types';

interface Props {
  customerId: string;
}

/**
 * Tab "Contatos" do cliente — múltiplos telefones por cliente.
 * Quanto mais contatos cadastrados, mais o copilot identifica automaticamente
 * quem está ligando (resolveCustomerByPhone busca em customer_contacts primeiro).
 */
export function CustomerContactsTab({ customerId }: Props) {
  const { data, isLoading } = useCustomerContacts(customerId);
  const [editing, setEditing] = useState<CustomerContact | null>(null);
  const [open, setOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">Contatos do cliente</h3>
          <p className="text-2xs text-muted-foreground">
            Cadastre todos os telefones que este cliente usa pra ligar. Quanto mais cadastrado, mais a IA identifica quem está ligando automaticamente.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5" onClick={handleNew}>
              <Plus className="w-3.5 h-3.5" />
              Novo contato
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Editar contato' : 'Novo contato'}</DialogTitle>
            </DialogHeader>
            <ContactForm
              customerId={customerId}
              initial={editing}
              onSaved={() => {
                setOpen(false);
                setEditing(null);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {!data || data.length === 0 ? (
        <Card className="p-8 text-center text-xs text-muted-foreground">
          <UserIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
          Nenhum contato cadastrado ainda. Adicione o primeiro pra começar.
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((c) => (
            <ContactRow key={c.id} contact={c} onEdit={() => handleEdit(c)} />
          ))}
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
          <span className="text-sm font-medium">
            {contact.nome || formatBrPhone(contact.phone)}
          </span>
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
          <span className="flex items-center gap-1">
            <Phone className="w-3 h-3" />
            {formatBrPhone(contact.phone)}
          </span>
          {contact.email && (
            <span className="flex items-center gap-1">
              <Mail className="w-3 h-3" />
              {contact.email}
            </span>
          )}
          {contact.birthday && (
            <span className="flex items-center gap-1">
              <Cake className="w-3 h-3" />
              {format(new Date(contact.birthday), 'dd/MM', { locale: ptBR })}
            </span>
          )}
        </div>
        {contact.notas && (
          <div className="text-2xs text-muted-foreground italic">{contact.notas}</div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-status-error"
          onClick={() => del.mutate({ id: contact.id, customerId: contact.customer_user_id })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </Card>
  );
}

function ContactForm({
  customerId,
  initial,
  onSaved,
}: {
  customerId: string;
  initial: CustomerContact | null;
  onSaved: () => void;
}) {
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
          <Label className="text-xs flex items-center gap-1">
            <Cake className="w-3 h-3" />
            Aniversário
          </Label>
          <Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </div>
      </div>
      <div className="space-y-2 p-2 rounded border border-border">
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
