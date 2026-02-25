import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  AlertCircle, CheckCircle, Info, AlertTriangle, Plus, Search, 
  ArrowRight, Trash2, Edit, Phone, ShoppingCart, TrendingUp 
} from 'lucide-react';

/* ─── Token display helper ─── */
function TokenSwatch({ label, cssVar, className }: { label: string; cssVar: string; className?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-md border border-border shrink-0 ${className || ''}`} 
        style={{ backgroundColor: `hsl(var(${cssVar}))` }} 
      />
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground font-mono">{cssVar}</p>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {children}
      <Separator className="mt-8" />
    </section>
  );
}

export default function DesignSystem() {
  return (
    <div className="max-w-5xl mx-auto space-y-10">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Design System</h1>
          <p className="text-muted-foreground mt-1">
            Tokens, componentes e regras de UX — Referência: HubSpot Canvas + Shopify Polaris + Gong
          </p>
        </div>

        {/* ─── 1. COLORS ─── */}
        <Section title="Cores" description="Tokens semânticos. Nunca use cores hard-coded em componentes.">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <TokenSwatch label="Primary" cssVar="--primary" />
            <TokenSwatch label="Background" cssVar="--background" />
            <TokenSwatch label="Foreground" cssVar="--foreground" />
            <TokenSwatch label="Card" cssVar="--card" />
            <TokenSwatch label="Muted" cssVar="--muted" />
            <TokenSwatch label="Accent" cssVar="--accent" />
            <TokenSwatch label="Secondary" cssVar="--secondary" />
            <TokenSwatch label="Destructive" cssVar="--destructive" />
            <TokenSwatch label="Border" cssVar="--border" />
          </div>
          <h3 className="text-base font-semibold mt-6">Status</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <TokenSwatch label="Success" cssVar="--status-success" />
            <TokenSwatch label="Warning" cssVar="--status-warning" />
            <TokenSwatch label="Error" cssVar="--status-error" />
            <TokenSwatch label="Info" cssVar="--status-info" />
          </div>
          <h3 className="text-base font-semibold mt-6">Superfícies</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <TokenSwatch label="Surface 0" cssVar="--surface-0" />
            <TokenSwatch label="Surface 1" cssVar="--surface-1" />
            <TokenSwatch label="Surface 2" cssVar="--surface-2" />
            <TokenSwatch label="Surface 3" cssVar="--surface-3" />
          </div>
          <h3 className="text-base font-semibold mt-6">Texto</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <TokenSwatch label="Primary" cssVar="--text-primary" />
            <TokenSwatch label="Secondary" cssVar="--text-secondary" />
            <TokenSwatch label="Tertiary" cssVar="--text-tertiary" />
            <TokenSwatch label="Disabled" cssVar="--text-disabled" />
          </div>
        </Section>

        {/* ─── 2. TYPOGRAPHY ─── */}
        <Section title="Tipografia" description="Inter (body) · 14px base · Scale: 10-36px">
          <div className="space-y-3 surface-0 rounded-lg border border-border p-4">
            <p className="text-2xs text-muted-foreground">2xs — 10px · Captions, badges</p>
            <p className="text-xs text-muted-foreground">xs — 12px · Labels, helper text</p>
            <p className="text-sm">sm — 13px · Compact UI text</p>
            <p className="text-base">base — 14px · Corpo padrão</p>
            <p className="text-md">md — 15px · Corpo enfatizado</p>
            <p className="text-lg font-medium">lg — 16px · Subtítulos</p>
            <p className="text-xl font-semibold">xl — 18px · Títulos de seção</p>
            <p className="text-2xl font-semibold">2xl — 20px · Títulos de página</p>
            <p className="text-3xl font-semibold tracking-tight">3xl — 24px · Hero</p>
          </div>
        </Section>

        {/* ─── 3. SPACING ─── */}
        <Section title="Espaçamento" description="Escala: 2 / 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 80 / 96">
          <div className="flex items-end gap-1">
            {[2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48].map((px) => (
              <div key={px} className="flex flex-col items-center gap-1">
                <div className="bg-primary rounded-sm" style={{ width: px, height: px }} />
                <span className="text-2xs text-muted-foreground">{px}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── 4. SHADOWS ─── */}
        <Section title="Sombras" description="5 níveis + focus ring">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-focus'].map((s) => (
              <div key={s} className={`surface-0 rounded-lg p-4 border border-border ${s}`}>
                <p className="text-xs font-mono text-muted-foreground">{s}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── 5. BUTTONS ─── */}
        <Section title="Buttons" description="Primary / Secondary / Outline / Ghost / Destructive / Muted">
          <div className="flex flex-wrap items-center gap-3">
            <Button><Plus className="w-4 h-4" /> Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive"><Trash2 className="w-4 h-4" /> Destructive</Button>
            <Button variant="muted">Muted</Button>
            <Button variant="link">Link</Button>
          </div>
          <h3 className="text-base font-semibold mt-4">Tamanhos</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon"><Search className="w-4 h-4" /></Button>
          </div>
          <h3 className="text-base font-semibold mt-4">Estados</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled>Disabled</Button>
            <Button className="opacity-80">Loading...</Button>
          </div>
        </Section>

        {/* ─── 6. INPUTS ─── */}
        <Section title="Inputs" description="Text, Search, Number, Textarea">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-3xl">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Nome do cliente</label>
              <Input placeholder="Ex.: Metalúrgica Souza" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Buscar produto</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="SKU ou nome..." className="pl-8" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Quantidade</label>
              <Input type="number" placeholder="0" />
            </div>
          </div>
        </Section>

        {/* ─── 7. BADGES ─── */}
        <Section title="Badges / Tags" description="Status, risco, etapa de funil">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Padrão</Badge>
            <Badge variant="secondary">Secundário</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Crítico</Badge>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium status-success border">
              <CheckCircle className="w-3 h-3" /> Ativo
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium status-pending border">
              <AlertTriangle className="w-3 h-3" /> Em risco
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium status-danger border">
              <AlertCircle className="w-3 h-3" /> Churn
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium status-progress border">
              <Info className="w-3 h-3" /> Novo
            </span>
          </div>
        </Section>

        {/* ─── 8. CARDS ─── */}
        <Section title="Cards" description="Container principal de conteúdo">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Metalúrgica Souza</CardTitle>
                <CardDescription>Último pedido: 3 dias atrás</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Ticket médio</span>
                  <span className="font-semibold">R$ 2.340</span>
                </div>
              </CardContent>
            </Card>

            {/* Recommendation Card */}
            <Card className="border-primary/20 bg-accent/30">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  <CardTitle className="text-base">Cross-sell sugerido</CardTitle>
                </div>
                <CardDescription>Baseado no histórico de compra</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Serra circular 10"</span>
                  <span className="font-semibold text-primary">+R$ 180</span>
                </div>
                <Button size="sm" className="w-full">
                  <ShoppingCart className="w-4 h-4" /> Adicionar ao pedido
                </Button>
              </CardContent>
            </Card>

            {/* Action Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Próxima ação</CardTitle>
                <CardDescription>Cliente prioritário</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Phone className="w-4 h-4" /> Ligar para follow-up
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Edit className="w-4 h-4" /> Registrar visita
                </Button>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── 9. SKELETONS ─── */}
        <Section title="Skeletons / Loading" description="Placeholder enquanto carrega dados">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </CardContent>
          </Card>
        </Section>

        {/* ─── 10. EMPTY STATES ─── */}
        <Section title="Empty States" description="Quando não há dados para exibir">
          <Card>
            <CardContent className="p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                <Search className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="font-semibold">Nenhum resultado encontrado</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Tente ajustar os filtros ou termos de busca para encontrar o que procura.
              </p>
              <Button variant="outline" size="sm">
                Limpar filtros
              </Button>
            </CardContent>
          </Card>
        </Section>

        {/* ─── 11. UX RULES ─── */}
        <Section title="Regras de UX" description="Padrões de design e decisões">
          <div className="space-y-4 text-sm">
            <Card>
              <CardContent className="p-4 space-y-3">
                <h4 className="font-semibold">1. Densidade</h4>
                <p className="text-muted-foreground">Modo <strong>compacto</strong> por padrão (row height 36px, input 32px). Alternar para confortável via configurações.</p>
                
                <h4 className="font-semibold">2. Navegação</h4>
                <p className="text-muted-foreground">Sidebar fixa com seções: Dashboard, Clientes, Pedidos, Ligações, Coaching, Relatórios. Colapsável em desktop, drawer em mobile.</p>
                
                <h4 className="font-semibold">3. Hierarquia de ação</h4>
                <p className="text-muted-foreground">Sempre priorizar o CTA principal ("próxima ação") em cada tela. Ações secundárias em menus dropdown.</p>
                
                <h4 className="font-semibold">4. Busca global (⌘K)</h4>
                <p className="text-muted-foreground">Busca unificada: clientes, produtos, pedidos, ligações. Resultados agrupados por tipo com atalhos de teclado.</p>
                
                <h4 className="font-semibold">5. Filtros persistentes</h4>
                <p className="text-muted-foreground">Filtros salvos por usuário/tela via localStorage. Chips visíveis com "x" para remover. Botão "Limpar todos".</p>
                
                <h4 className="font-semibold">6. Ações rápidas em lista</h4>
                <p className="text-muted-foreground">Hover/swipe revela: Criar pedido, Ligar, WhatsApp, Registrar visita. Ícones com tooltip.</p>
                
                <h4 className="font-semibold">7. Painel lateral inteligente</h4>
                <p className="text-muted-foreground">Drawer direito com insights e próximos passos. Abre ao clicar em um cliente/pedido sem sair da lista.</p>
                
                <h4 className="font-semibold">8. Erros e recuperação</h4>
                <p className="text-muted-foreground">
                  Toast para erros não-bloqueantes. Modal para erros críticos (ex.: preço indisponível, estoque zerado). 
                  Sempre oferecer ação de recuperação ("Tentar novamente", "Usar último preço").
                </p>
                
                <h4 className="font-semibold">9. Acessibilidade</h4>
                <p className="text-muted-foreground">Contraste WCAG AA. Focus ring visível. Navegação por teclado em todos os componentes interativos. aria-labels em ícones.</p>
                
                <h4 className="font-semibold">10. Motion</h4>
                <p className="text-muted-foreground">
                  Fast (100ms): hover, focus states. Normal (200ms): expand/collapse, modals. Slow (350ms): page transitions, skeleton loading. 
                  Easing: ease-out para entrada, ease-in para saída.
                </p>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── 12. PERMISSÕES ─── */}
        <Section title="Permissões por papel" description="Controle de acesso por role">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Vendedor</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-1">
                <p>✓ Dashboard com tarefas e metas</p>
                <p>✓ Lista de clientes e perfil 360</p>
                <p>✓ Tomada de pedido + recomendações</p>
                <p>✓ Ligações: player + transcrição</p>
                <p>✓ Coaching: feedback essencial</p>
                <p>✗ Relatórios avançados</p>
                <p>✗ Configurações de algoritmo</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Gestor</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-1">
                <p>✓ Tudo do vendedor</p>
                <p>✓ Métricas avançadas (IPF, IEE)</p>
                <p>✓ Critérios e pesos do algoritmo</p>
                <p>✓ Detalhes de scoring</p>
                <p>✓ Auditoria de mudanças</p>
                <p>✓ Relatórios consolidados</p>
                <p>✓ Governança e configurações</p>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── FOOTER ─── */}
        <div className="text-center text-xs text-muted-foreground pb-8">
          <p>Design System v1.0 — Colacor CRM</p>
          <p>Referências: HubSpot Canvas · Shopify Polaris · Gong</p>
        </div>
    </div>
  );
}
