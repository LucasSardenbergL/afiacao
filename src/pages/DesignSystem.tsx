import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  AlertCircle, CheckCircle, Info, AlertTriangle, Plus, Search,
  ArrowRight, Trash2, Edit, Phone, ShoppingCart, TrendingUp,
  Copy, ChevronRight, Loader2, X, Eye, EyeOff, MessageSquare,
  Star, Zap, Package, Users, BarChart3
} from 'lucide-react';

/* ─── Helpers ─── */
function TokenSwatch({ label, cssVar }: { label: string; cssVar: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-md border border-border shrink-0"
        style={{ backgroundColor: `hsl(var(${cssVar}))` }}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{label}</p>
        <p className="text-2xs text-muted-foreground font-mono truncate">{cssVar}</p>
      </div>
    </div>
  );
}

function Section({ id, title, description, children }: { id?: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-4">
      <div>
        <h2>{title}</h2>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {children}
      <Separator className="mt-8" />
    </section>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-sidebar text-sidebar-foreground rounded-lg p-4 text-xs font-mono overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-sidebar-accent text-sidebar-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Copiar código"
      >
        {copied ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

/* ─── Main ─── */
export default function DesignSystem() {
  const [density, setDensity] = useState<'compact' | 'comfortable'>('compact');

  const tocItems = [
    { id: 'cores', label: 'Cores' },
    { id: 'tipografia', label: 'Tipografia' },
    { id: 'espacamento', label: 'Espaçamento' },
    { id: 'radius-sombras', label: 'Radius & Sombras' },
    { id: 'motion', label: 'Motion' },
    { id: 'breakpoints', label: 'Breakpoints & Grid' },
    { id: 'buttons', label: 'Buttons' },
    { id: 'inputs', label: 'Inputs' },
    { id: 'badges', label: 'Badges' },
    { id: 'cards', label: 'Cards' },
    { id: 'modals-drawers', label: 'Modals & Drawers' },
    { id: 'feedback', label: 'Feedback & Loading' },
    { id: 'recommendation', label: 'RecommendationCard' },
    { id: 'density', label: 'Densidade' },
    { id: 'permissoes', label: 'Permissões' },
  ];

  return (
    <div className="flex gap-8 max-w-7xl mx-auto">
      {/* TOC sidebar */}
      <nav className="hidden xl:block w-48 shrink-0 sticky top-20 self-start space-y-0.5">
        <p className="overline mb-2">Nesta página</p>
        {tocItems.map(item => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="block text-sm text-muted-foreground hover:text-foreground py-1 transition-colors"
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-10 pb-16">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Design System</h1>
          <p className="text-muted-foreground mt-1">
            Tokens, componentes e padrões — HubSpot Canvas + Shopify Polaris + Gong
          </p>
          <div className="flex gap-2 mt-3">
            <Badge variant="info">v2.0</Badge>
            <Badge variant="secondary">PT-BR</Badge>
          </div>
        </div>

        {/* ─── 1. COLORS ─── */}
        <Section id="cores" title="Cores" description="Tokens semânticos HSL. Nunca use cores hard-coded em componentes.">
          <Tabs defaultValue="core">
            <TabsList>
              <TabsTrigger value="core">Core</TabsTrigger>
              <TabsTrigger value="status">Status</TabsTrigger>
              <TabsTrigger value="surfaces">Superfícies</TabsTrigger>
              <TabsTrigger value="text">Texto</TabsTrigger>
              <TabsTrigger value="sidebar">Sidebar</TabsTrigger>
            </TabsList>
            <TabsContent value="core" className="mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                <TokenSwatch label="Primary" cssVar="--primary" />
                <TokenSwatch label="Primary FG" cssVar="--primary-foreground" />
                <TokenSwatch label="Secondary" cssVar="--secondary" />
                <TokenSwatch label="Secondary FG" cssVar="--secondary-foreground" />
                <TokenSwatch label="Accent" cssVar="--accent" />
                <TokenSwatch label="Accent FG" cssVar="--accent-foreground" />
                <TokenSwatch label="Muted" cssVar="--muted" />
                <TokenSwatch label="Muted FG" cssVar="--muted-foreground" />
                <TokenSwatch label="Destructive" cssVar="--destructive" />
                <TokenSwatch label="Background" cssVar="--background" />
                <TokenSwatch label="Foreground" cssVar="--foreground" />
                <TokenSwatch label="Border" cssVar="--border" />
              </div>
            </TabsContent>
            <TabsContent value="status" className="mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                <TokenSwatch label="Success" cssVar="--status-success" />
                <TokenSwatch label="Success FG" cssVar="--status-success-foreground" />
                <TokenSwatch label="Success BG" cssVar="--status-success-bg" />
                <TokenSwatch label="Warning" cssVar="--status-warning" />
                <TokenSwatch label="Warning FG" cssVar="--status-warning-foreground" />
                <TokenSwatch label="Warning BG" cssVar="--status-warning-bg" />
                <TokenSwatch label="Error" cssVar="--status-error" />
                <TokenSwatch label="Error FG" cssVar="--status-error-foreground" />
                <TokenSwatch label="Error BG" cssVar="--status-error-bg" />
                <TokenSwatch label="Info" cssVar="--status-info" />
                <TokenSwatch label="Info FG" cssVar="--status-info-foreground" />
                <TokenSwatch label="Info BG" cssVar="--status-info-bg" />
                <TokenSwatch label="Purple" cssVar="--status-purple" />
                <TokenSwatch label="Indigo" cssVar="--status-indigo" />
              </div>
            </TabsContent>
            <TabsContent value="surfaces" className="mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <TokenSwatch label="Surface 0" cssVar="--surface-0" />
                <TokenSwatch label="Surface 1" cssVar="--surface-1" />
                <TokenSwatch label="Surface 2" cssVar="--surface-2" />
                <TokenSwatch label="Surface 3" cssVar="--surface-3" />
              </div>
            </TabsContent>
            <TabsContent value="text" className="mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <TokenSwatch label="Primary" cssVar="--text-primary" />
                <TokenSwatch label="Secondary" cssVar="--text-secondary" />
                <TokenSwatch label="Tertiary" cssVar="--text-tertiary" />
                <TokenSwatch label="Disabled" cssVar="--text-disabled" />
                <TokenSwatch label="Inverse" cssVar="--text-inverse" />
                <TokenSwatch label="Link" cssVar="--text-link" />
              </div>
            </TabsContent>
            <TabsContent value="sidebar" className="mt-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <TokenSwatch label="Background" cssVar="--sidebar-background" />
                <TokenSwatch label="Foreground" cssVar="--sidebar-foreground" />
                <TokenSwatch label="Primary" cssVar="--sidebar-primary" />
                <TokenSwatch label="Accent" cssVar="--sidebar-accent" />
                <TokenSwatch label="Border" cssVar="--sidebar-border" />
                <TokenSwatch label="Muted" cssVar="--sidebar-muted" />
              </div>
            </TabsContent>
          </Tabs>
          <CodeBlock code={`/* Uso correto */
<div className="bg-primary text-primary-foreground" />
<div className="bg-status-success-bg text-status-success-foreground" />

/* ERRADO — nunca use cores diretas */
<div className="bg-blue-500 text-white" /> ❌`} />
        </Section>

        {/* ─── 2. TYPOGRAPHY ─── */}
        <Section id="tipografia" title="Tipografia" description="Inter (body) · JetBrains Mono (code) · 14px base">
          <div className="surface-0 rounded-lg border border-border p-6 space-y-4">
            <div className="flex items-baseline justify-between">
              <p className="text-2xs text-muted-foreground">2xs — 10px</p>
              <span className="caption">Badges, captions compactas</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-muted-foreground">xs — 12px</p>
              <span className="caption">Labels, helper text</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-sm">sm — 13px</p>
              <span className="caption">UI compacta, tabelas</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-base">base — 14px</p>
              <span className="caption">Corpo padrão</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-lg font-medium">lg — 16px</p>
              <span className="caption">Subtítulos</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-xl font-semibold">xl — 18px</p>
              <span className="caption">Títulos de seção</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-2xl font-semibold tracking-tight">2xl — 20px</p>
              <span className="caption">Títulos de página</span>
            </div>
            <div className="flex items-baseline justify-between">
              <p className="text-3xl font-semibold tracking-tight">3xl — 24px</p>
              <span className="caption">Hero / Dashboard</span>
            </div>
          </div>

          <h3 className="mt-6">Classes utilitárias</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="caption">.caption — Texto auxiliar pequeno</p>
                <p className="overline mt-2">.overline — Label de seção</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <h1>H1 — Página principal</h1>
                <h2>H2 — Seção</h2>
                <h3>H3 — Subseção</h3>
                <h4>H4 — Item</h4>
              </CardContent>
            </Card>
          </div>

          <CodeBlock code={`/* Tipografia semântica */
<h1>Título da página</h1>         {/* 20px semibold */}
<h2>Seção</h2>                    {/* 18px semibold */}
<p className="caption">Auxiliar</p>
<p className="overline">LABEL</p>`} />
        </Section>

        {/* ─── 3. SPACING ─── */}
        <Section id="espacamento" title="Espaçamento" description="Escala em px: 2 · 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80 · 96">
          <div className="flex items-end gap-1.5 flex-wrap">
            {[2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48].map((px) => (
              <div key={px} className="flex flex-col items-center gap-1">
                <div className="bg-primary rounded-sm" style={{ width: px, height: px }} />
                <span className="text-2xs text-muted-foreground font-mono">{px}</span>
              </div>
            ))}
          </div>
          <Card>
            <CardContent className="p-4 text-sm space-y-2">
              <p><strong>Uso recomendado:</strong></p>
              <p className="text-muted-foreground">• 2–4px: gap entre ícone e texto, padding interno de badges</p>
              <p className="text-muted-foreground">• 8px: gap entre itens de lista compacta</p>
              <p className="text-muted-foreground">• 12–16px: padding de cards e inputs</p>
              <p className="text-muted-foreground">• 24–32px: margem entre seções</p>
              <p className="text-muted-foreground">• 48–64px: margem entre blocos de página</p>
            </CardContent>
          </Card>
        </Section>

        {/* ─── 4. RADIUS & SHADOWS ─── */}
        <Section id="radius-sombras" title="Radius & Sombras" description="3 níveis de radius + 5 níveis de sombra + focus ring">
          <h3>Border Radius</h3>
          <div className="flex gap-4">
            {[
              { label: 'sm', cls: 'rounded-sm', val: 'calc(0.5rem - 4px)' },
              { label: 'md', cls: 'rounded-md', val: 'calc(0.5rem - 2px)' },
              { label: 'lg', cls: 'rounded-lg', val: '0.5rem' },
              { label: 'full', cls: 'rounded-full', val: '9999px' },
            ].map(r => (
              <div key={r.label} className="text-center">
                <div className={cn('w-16 h-16 bg-primary/20 border-2 border-primary/40', r.cls)} />
                <p className="text-xs font-mono mt-1">{r.label}</p>
              </div>
            ))}
          </div>

          <h3 className="mt-6">Sombras</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl', 'shadow-focus'].map((s) => (
              <div key={s} className={cn('surface-0 rounded-lg p-4 border border-border', s)}>
                <p className="text-xs font-mono text-muted-foreground">{s}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ─── 5. MOTION ─── */}
        <Section id="motion" title="Motion" description="Durações, easing e padrões de animação">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { token: '--duration-fast', val: '100ms', use: 'Hover, focus, toggle' },
              { token: '--duration-normal', val: '200ms', use: 'Expand, collapse, modal, fade' },
              { token: '--duration-slow', val: '350ms', use: 'Page transition, skeleton' },
            ].map(m => (
              <Card key={m.token}>
                <CardContent className="p-4">
                  <p className="font-mono text-sm font-medium">{m.val}</p>
                  <p className="text-2xs text-muted-foreground font-mono">{m.token}</p>
                  <p className="text-xs text-muted-foreground mt-2">{m.use}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <h3 className="mt-4">Animações disponíveis</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { cls: 'animate-fade-in', label: 'fade-in' },
              { cls: 'animate-scale-in', label: 'scale-in' },
              { cls: 'animate-slide-up', label: 'slide-up' },
              { cls: 'animate-slide-down', label: 'slide-down' },
            ].map(a => (
              <div key={a.label} className="text-center">
                <div className={cn('w-12 h-12 bg-primary/20 rounded-lg mx-auto', a.cls)} />
                <p className="text-xs font-mono mt-2">{a.label}</p>
              </div>
            ))}
          </div>
          <CodeBlock code={`/* Easing */
--easing-default: cubic-bezier(0.4, 0, 0.2, 1)  /* entrada/saída */
--easing-spring:  cubic-bezier(0.34, 1.56, 0.64, 1) /* bounce sutil */
--easing-decel:   cubic-bezier(0, 0, 0.2, 1)     /* desaceleração */

/* Classes Tailwind */
.animate-fade-in    /* 200ms ease-out fade + slide up */
.animate-scale-in   /* 150ms ease-out scale + fade */
.animate-shimmer    /* skeleton loading effect */`} />
        </Section>

        {/* ─── 6. BREAKPOINTS ─── */}
        <Section id="breakpoints" title="Breakpoints & Grid" description="Responsive: 4 col mobile → 6 tablet → 12 desktop">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 font-medium">Breakpoint</th>
                  <th className="text-left py-2 font-medium">Min-width</th>
                  <th className="text-left py-2 font-medium">Colunas</th>
                  <th className="text-left py-2 font-medium">Uso</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b border-border/50"><td className="py-2 font-mono">base</td><td>0</td><td>4</td><td>Mobile portrait</td></tr>
                <tr className="border-b border-border/50"><td className="py-2 font-mono">sm</td><td>640px</td><td>4</td><td>Mobile landscape</td></tr>
                <tr className="border-b border-border/50"><td className="py-2 font-mono">md</td><td>768px</td><td>6</td><td>Tablet portrait</td></tr>
                <tr className="border-b border-border/50"><td className="py-2 font-mono">lg</td><td>1024px</td><td>12</td><td>Tablet landscape / Desktop</td></tr>
                <tr className="border-b border-border/50"><td className="py-2 font-mono">xl</td><td>1280px</td><td>12</td><td>Desktop wide</td></tr>
                <tr><td className="py-2 font-mono">2xl</td><td>1440px</td><td>12</td><td>Desktop ultra</td></tr>
              </tbody>
            </table>
          </div>
          <CodeBlock code={`/* Grid responsivo */
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {/* 1 col mobile → 2 tablet → 3 desktop */}
</div>

/* Container */
max-width: 1440px (2xl) com padding 1rem`} />
        </Section>

        {/* ─── 7. BUTTONS ─── */}
        <Section id="buttons" title="Buttons" description="7 variantes · 4 tamanhos · estados hover/focus/disabled/loading">
          <h3>Variantes</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button><Plus className="w-4 h-4" /> Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive"><Trash2 className="w-4 h-4" /> Destructive</Button>
            <Button variant="muted">Muted</Button>
            <Button variant="link">Link</Button>
          </div>
          <h3 className="mt-4">Tamanhos</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small (32px)</Button>
            <Button size="default">Default (36px)</Button>
            <Button size="lg">Large (40px)</Button>
            <Button size="icon"><Search className="w-4 h-4" /></Button>
          </div>
          <h3 className="mt-4">Estados</h3>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled>Disabled</Button>
            <Button disabled><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</Button>
          </div>
          <CodeBlock code={`<Button variant="primary">Finalizar pedido</Button>
<Button variant="ghost" size="icon">
  <Phone className="w-4 h-4" />
</Button>
<Button disabled>
  <Loader2 className="w-4 h-4 animate-spin" /> Processando...
</Button>`} />
        </Section>

        {/* ─── 8. INPUTS ─── */}
        <Section id="inputs" title="Inputs" description="Text, Search, Number, Textarea, Select">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
            <div className="space-y-1.5">
              <Label htmlFor="ds-name">Nome do cliente</Label>
              <Input id="ds-name" placeholder="Ex.: Metalúrgica Souza" />
              <p className="caption">Razão social ou nome fantasia</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-search">Buscar produto</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input id="ds-search" placeholder="SKU ou nome..." className="pl-8" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-qty">Quantidade</Label>
              <Input id="ds-qty" type="number" placeholder="0" min={0} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ds-notes">Observações</Label>
              <Textarea id="ds-notes" placeholder="Instruções especiais para o pedido..." rows={3} />
            </div>
            <div className="space-y-1.5">
              <Label>Frete</Label>
              <Select>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="coleta">Coleta na loja</SelectItem>
                  <SelectItem value="entrega">Entrega</SelectItem>
                  <SelectItem value="motoboy">Motoboy</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <h3 className="mt-4">Estado de erro</h3>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="ds-error">E-mail</Label>
            <Input id="ds-error" className="border-destructive focus-visible:ring-destructive" defaultValue="email-invalido" />
            <p className="text-xs text-destructive">Formato de e-mail inválido</p>
          </div>
        </Section>

        {/* ─── 9. BADGES ─── */}
        <Section id="badges" title="Badges / Tags" description="Status, risco, etapa de funil — sempre use variantes semânticas">
          <h3>Variantes base</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Primary</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
          <h3 className="mt-4">Status semânticos</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success"><CheckCircle className="w-3 h-3" /> Ativo</Badge>
            <Badge variant="warning"><AlertTriangle className="w-3 h-3" /> Em risco</Badge>
            <Badge variant="danger"><AlertCircle className="w-3 h-3" /> Churn</Badge>
            <Badge variant="info"><Info className="w-3 h-3" /> Novo</Badge>
            <Badge variant="purple"><Star className="w-3 h-3" /> Premium</Badge>
            <Badge variant="indigo"><Zap className="w-3 h-3" /> Triagem</Badge>
          </div>
          <CodeBlock code={`<Badge variant="success">Ativo</Badge>
<Badge variant="warning">Em risco</Badge>
<Badge variant="danger">Churn</Badge>
<Badge variant="info">Novo</Badge>

/* Classes CSS utilitárias (para spans custom) */
<span className="status-success border ...">Ativo</span>`} />
        </Section>

        {/* ─── 10. CARDS ─── */}
        <Section id="cards" title="Cards" description="Containers de conteúdo — cliente, recomendação, ação">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Client card */}
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Metalúrgica Souza</CardTitle>
                  <Badge variant="success" className="text-2xs">Ativo</Badge>
                </div>
                <CardDescription>Último pedido: 3 dias atrás</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Ticket médio</span>
                  <span className="font-semibold">R$ 2.340</span>
                </div>
              </CardContent>
              <CardFooter className="gap-2">
                <Button variant="outline" size="sm" className="flex-1"><Phone className="w-3.5 h-3.5" /> Ligar</Button>
                <Button size="sm" className="flex-1"><ShoppingCart className="w-3.5 h-3.5" /> Pedido</Button>
              </CardFooter>
            </Card>

            {/* Recommendation card */}
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
                <p className="text-2xs text-muted-foreground">
                  87% dos clientes similares compraram este item
                </p>
                <Button size="sm" className="w-full">
                  <ShoppingCart className="w-4 h-4" /> Adicionar ao pedido
                </Button>
              </CardContent>
            </Card>

            {/* Action card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Próxima ação</CardTitle>
                <CardDescription>Cliente prioritário — Score 92</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Phone className="w-4 h-4" /> Ligar para follow-up
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <Edit className="w-4 h-4" /> Registrar visita
                </Button>
                <Button variant="outline" size="sm" className="w-full justify-start">
                  <MessageSquare className="w-4 h-4" /> Enviar WhatsApp
                </Button>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── 11. MODALS & DRAWERS ─── */}
        <Section id="modals-drawers" title="Modals & Drawers" description="Dialog para confirmação, Sheet para painéis laterais">
          <div className="flex flex-wrap gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Abrir Modal</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirmar ação</DialogTitle>
                  <DialogDescription>Tem certeza que deseja excluir este pedido? Esta ação não pode ser desfeita.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline">Cancelar</Button>
                  <Button variant="destructive">Excluir pedido</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Abrir Painel Lateral</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Detalhes do cliente</SheetTitle>
                  <SheetDescription>Insights e próximos passos</SheetDescription>
                </SheetHeader>
                <div className="space-y-4 mt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Health Score</span>
                    <span className="font-semibold">78/100</span>
                  </div>
                  <Progress value={78} className="h-2" />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Risco de churn</span>
                    <Badge variant="warning">Médio</Badge>
                  </div>
                  <Separator />
                  <h4>Próximos passos</h4>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• Oferecer bundle de serras + discos</li>
                    <li>• Follow-up sobre orçamento pendente</li>
                    <li>• Apresentar linha premium</li>
                  </ul>
                </div>
              </SheetContent>
            </Sheet>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon"><Info className="w-4 h-4" /></Button>
              </TooltipTrigger>
              <TooltipContent>Informação adicional sobre o item</TooltipContent>
            </Tooltip>
          </div>
        </Section>

        {/* ─── 12. FEEDBACK & LOADING ─── */}
        <Section id="feedback" title="Feedback & Loading" description="Skeleton, progress, empty states, alertas">
          <h3>Skeleton Loading</h3>
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

          <h3 className="mt-4">Progress</h3>
          <div className="space-y-2 max-w-md">
            <Progress value={33} className="h-2" />
            <Progress value={66} className="h-2" />
            <Progress value={100} className="h-2" />
          </div>

          <h3 className="mt-4">Empty State</h3>
          <Card>
            <CardContent className="p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                <Search className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="font-semibold">Nenhum resultado encontrado</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Tente ajustar os filtros ou termos de busca para encontrar o que procura.
              </p>
              <Button variant="outline" size="sm">Limpar filtros</Button>
            </CardContent>
          </Card>

          <h3 className="mt-4">Alertas inline</h3>
          <div className="space-y-2 max-w-lg">
            <div className="flex items-start gap-3 p-3 rounded-lg status-success border">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Pedido finalizado com sucesso</p>
                <p className="text-xs opacity-80">O cliente receberá a confirmação por e-mail.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg status-pending border">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Estoque baixo</p>
                <p className="text-xs opacity-80">Apenas 3 unidades restantes. Considere ajustar a quantidade.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg status-danger border">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Preço indisponível</p>
                <p className="text-xs opacity-80">Não foi possível consultar o preço. <button className="underline font-medium">Tentar novamente</button> ou <button className="underline font-medium">usar último preço</button>.</p>
              </div>
            </div>
          </div>
        </Section>

        {/* ─── 13. RECOMMENDATION CARD ─── */}
        <Section id="recommendation" title="RecommendationCard" description="Cross-sell/upsell com CTA rápido, razão da sugestão e impacto no ticket">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Cross-sell: perfil do cliente */}
            <Card className="border-primary/20 bg-accent/30">
              <CardHeader className="pb-2">
                <p className="overline">O que está faltando</p>
                <CardTitle className="text-base">Disco de corte 14"</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  <TrendingUp className="w-3 h-3 inline mr-1" />
                  92% dos clientes deste segmento compram este item
                </p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Impacto no ticket</span>
                  <span className="font-bold text-primary">+R$ 245</span>
                </div>
                <Button size="sm" className="w-full"><Plus className="w-4 h-4" /> Adicionar</Button>
              </CardContent>
            </Card>

            {/* Cross-sell: carrinho */}
            <Card className="border-primary/20 bg-accent/30">
              <CardHeader className="pb-2">
                <p className="overline">Combine com</p>
                <CardTitle className="text-base">Fluido de corte 5L</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  <Zap className="w-3 h-3 inline mr-1" />
                  Frequentemente comprado junto com Serra circular
                </p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Impacto no ticket</span>
                  <span className="font-bold text-primary">+R$ 89</span>
                </div>
                <Button size="sm" className="w-full"><Plus className="w-4 h-4" /> Adicionar</Button>
              </CardContent>
            </Card>

            {/* Upsell: pós-pedido */}
            <Card className="border-status-success/20 bg-status-success-bg/30">
              <CardHeader className="pb-2">
                <p className="overline">Próxima compra provável</p>
                <CardTitle className="text-base">Kit manutenção trimestral</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  <BarChart3 className="w-3 h-3 inline mr-1" />
                  Baseado no ciclo de compra — previsão: 15 dias
                </p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Valor estimado</span>
                  <span className="font-bold text-status-success">R$ 520</span>
                </div>
                <Button size="sm" variant="outline" className="w-full"><ArrowRight className="w-4 h-4" /> Agendar contato</Button>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── 14. DENSITY ─── */}
        <Section id="density" title="Densidade" description="Compact (padrão) vs Comfortable — alterne por preferência do usuário">
          <div className="flex items-center gap-4 mb-4">
            <Label htmlFor="density-toggle">Modo confortável</Label>
            <Switch
              id="density-toggle"
              checked={density === 'comfortable'}
              onCheckedChange={(checked) => setDensity(checked ? 'comfortable' : 'compact')}
            />
            <Badge variant="secondary">{density}</Badge>
          </div>
          <div className={density === 'compact' ? 'density-compact' : 'density-comfortable'}>
            <Card>
              <CardContent className="p-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="font-medium py-2">Token</th>
                      <th className="font-medium py-2">Compact</th>
                      <th className="font-medium py-2">Comfortable</th>
                    </tr>
                  </thead>
                  <tbody className="text-muted-foreground">
                    <tr className="border-b border-border/50"><td className="py-2 font-mono">--table-row-height</td><td>36px</td><td>44px</td></tr>
                    <tr className="border-b border-border/50"><td className="py-2 font-mono">--input-height</td><td>32px</td><td>40px</td></tr>
                    <tr className="border-b border-border/50"><td className="py-2 font-mono">--card-padding</td><td>12px</td><td>16px</td></tr>
                    <tr><td className="py-2 font-mono">--list-gap</td><td>4px</td><td>8px</td></tr>
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── 15. PERMISSÕES ─── */}
        <Section id="permissoes" title="Permissões por papel" description="Feature flags por role — Vendedor vs Gestor">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <CardTitle className="text-base">Vendedor</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className="text-status-success-foreground">✓ Dashboard com tarefas e metas</p>
                <p className="text-status-success-foreground">✓ Lista de clientes e perfil 360</p>
                <p className="text-status-success-foreground">✓ Tomada de pedido + recomendações</p>
                <p className="text-status-success-foreground">✓ Ligações: player + transcrição</p>
                <p className="text-status-success-foreground">✓ Coaching: feedback essencial</p>
                <p className="text-destructive">✗ Relatórios avançados</p>
                <p className="text-destructive">✗ Configurações de algoritmo</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-muted-foreground" />
                  <CardTitle className="text-base">Gestor</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className="text-status-success-foreground">✓ Tudo do vendedor</p>
                <p className="text-status-success-foreground">✓ Métricas avançadas (IPF, IEE)</p>
                <p className="text-status-success-foreground">✓ Critérios e pesos do algoritmo</p>
                <p className="text-status-success-foreground">✓ Detalhes de scoring</p>
                <p className="text-status-success-foreground">✓ Auditoria de mudanças</p>
                <p className="text-status-success-foreground">✓ Relatórios consolidados</p>
                <p className="text-status-success-foreground">✓ Governança e configurações</p>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* ─── FOOTER ─── */}
        <div className="text-center text-xs text-muted-foreground pb-8 space-y-1">
          <p className="font-medium">Design System v2.0 — Colacor CRM</p>
          <p>Referências: HubSpot Canvas · Shopify Polaris · Gong</p>
          <p>Última atualização: Fev 2026</p>
        </div>
      </div>
    </div>
  );
}
