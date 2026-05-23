// Coluna de identidade (Contato, Contatos extras, Endereço, Score comercial) do Customer 360.
// Extraída de src/pages/Customer360.tsx (god-component split).
import { Link } from 'react-router-dom';
import { Mail, Phone, Building2, User, Users, MapPin, Heart } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { DataRow, ContactRow, ScoreRow } from './components';
import {
  formatBRL, splitEmails, formatCustomerType, formatPhone, formatCep,
} from './format';
import type { Customer, CustomerScore, AddressQuery, ContactsQuery } from './viewTypes';

export function IdentityColumn({
  customer, isPj, customerId, contacts, address, score: s,
}: {
  customer: Customer;
  isPj: boolean;
  customerId: string | undefined;
  contacts: ContactsQuery;
  address: AddressQuery;
  score: CustomerScore;
}) {
  return (
    <div className="lg:col-span-1 space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Mail className="w-4 h-4 text-muted-foreground" />
            Contato
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {/* F1: profile.email frequentemente vem concatenado por vírgula vindo do Omie.
              Split + render como lista. Cada email vira `mailto:` clicável. */}
          {(() => {
            const emails = splitEmails(customer.email);
            if (emails.length === 0) {
              return <DataRow icon={Mail} label="E-mail" value={null} />;
            }
            if (emails.length === 1) {
              return (
                <DataRow
                  icon={Mail}
                  label="E-mail"
                  value={emails[0]}
                  href={`mailto:${emails[0]}`}
                />
              );
            }
            return (
              <div className="flex items-start gap-3">
                <Mail className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-muted-foreground">
                    E-mails <span className="font-tabular">({emails.length})</span>
                  </div>
                  <ul className="space-y-0.5 mt-0.5">
                    {emails.map((e) => (
                      <li key={e}>
                        <a
                          href={`mailto:${e}`}
                          className="text-sm text-foreground hover:underline truncate block"
                        >
                          {e}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })()}
          <DataRow
            icon={Phone}
            label="Telefone"
            value={customer.phone ? formatPhone(customer.phone) : null}
          />
          {/* F9: icon contextual ao tipo (PJ vs PF) em vez de Sparkles decorativo.
              F3: customer_type traduzido pra rótulo humano. */}
          <DataRow
            icon={isPj ? Building2 : User}
            label="Tipo"
            value={formatCustomerType(customer.customer_type) || (isPj ? 'PJ' : 'PF')}
          />
        </CardContent>
      </Card>

      {/* Contatos extras (PR-CONTACTS) — dono, gerente, comprador, etc.
          Edição completa em /admin/customers detail. Aqui é leitura compacta. */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center gap-2 space-y-0">
          <Users className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium flex-1">
            Contatos extras
          </CardTitle>
          <Badge variant="outline" className="text-[10px] uppercase font-tabular">
            {contacts.data?.length ?? 0}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {contacts.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-10 bg-muted/40 rounded animate-pulse" />
              ))}
            </div>
          ) : contacts.data && contacts.data.length > 0 ? (
            <>
              <ul className="space-y-2.5 divide-y divide-border -my-1">
                {contacts.data.slice(0, 5).map((c) => (
                  <ContactRow key={c.id} contact={c} />
                ))}
              </ul>
              <Separator className="my-2" />
              <div className="text-right">
                <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                  <Link to={`/admin/customers/${customerId}`}>
                    Gerenciar contatos
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <div className="text-center py-4 space-y-2">
              <p className="text-xs text-muted-foreground">
                Nenhum contato extra cadastrado.
              </p>
              <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                <Link to={`/admin/customers/${customerId}`}>
                  Adicionar contato
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <MapPin className="w-4 h-4 text-muted-foreground" />
            Endereço
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {address.data && address.data.length > 0 ? (
            address.data.slice(0, 2).map((a, i) => {
              // F2: "OMIE" e "padrão" são labels técnicos do ERP. Pro usuário, o que
              // importa é se é o endereço padrão ou não. Se for padrão, mostra "Principal".
              // Caso contrário, usa label custom OU "Endereço N" como fallback.
              const isFirstShown = i === 0;
              const isOmieLabel = (a.label ?? '').toUpperCase() === 'OMIE';
              const displayLabel = a.is_default
                ? 'Principal'
                : isOmieLabel
                  ? `Endereço ${i + 1}`
                  : (a.label || `Endereço ${i + 1}`);
              return (
                <div key={i} className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {displayLabel}
                    </span>
                    {a.is_default && !isFirstShown && (
                      <Badge variant="outline" className="text-[9px] uppercase">
                        Padrão
                      </Badge>
                    )}
                  </div>
                  <div className="text-foreground leading-snug">
                    {a.street}, {a.number}
                    {a.complement && <span className="text-muted-foreground"> · {a.complement}</span>}
                  </div>
                  <div className="text-muted-foreground">
                    {a.neighborhood} · {a.city}/{a.state} · {formatCep(a.zip_code)}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground">Nenhum endereço cadastrado.</p>
          )}
        </CardContent>
      </Card>

      {s && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Heart className="w-4 h-4 text-muted-foreground" />
              Score comercial
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            {/* F8: layout label-esquerda / valor-direita em mono, p/ valores
                numéricos saltarem na varredura. Score é dado denso, não prosa. */}
            <ScoreRow
              label="Prioridade"
              value={s.priority_score != null ? Math.round(s.priority_score).toString() : '—'}
              hint="0–100"
            />
            <ScoreRow
              label="Expansão"
              value={s.expansion_score != null ? Math.round(s.expansion_score).toString() : '—'}
              hint="potencial"
            />
            <ScoreRow
              label="Receita potencial"
              value={s.revenue_potential != null ? formatBRL(s.revenue_potential) : '—'}
            />
            <ScoreRow
              label="Gasto mensal (180d)"
              value={s.avg_monthly_spend_180d != null ? formatBRL(s.avg_monthly_spend_180d) : '—'}
            />
            <ScoreRow
              label="Categorias compradas"
              value={s.category_count != null ? String(s.category_count) : '—'}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
