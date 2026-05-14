import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useTheme } from 'next-themes';
import { Sun, Moon, Wallet, TrendingUp, AlertTriangle, CheckCircle2, Info, XCircle, Clock, Inbox } from 'lucide-react';

/**
 * Showcase isolado dos tokens novos. Permite validar visualmente sem abrir 5 telas.
 * Acesse via /design-preview.
 *
 * Cobre: paleta, tipografia, hierarquia, botões (incl. variantes touch),
 * cards, KPIs (.kpi-value), badges, status colors, dialog, tabela,
 * empty state, skeleton, dark/light toggle inline.
 */
export default function DesignPreview() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="max-w-6xl mx-auto pb-24 space-y-12">
      {/* HEADER */}
      <header className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h1>Design Preview</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Showcase dos tokens novos. Use o toggle ao lado pra alternar light/dark.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="gap-2"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <Badge variant="outline">v3 — Vercel/Mercury direction</Badge>
          <Badge variant="secondary">Tema atual: {theme}</Badge>
          <Badge variant="secondary">Resolved: {resolvedTheme}</Badge>
        </div>
      </header>

      {/* PALETA NEUTRA */}
      <section className="space-y-3">
        <h2>Paleta neutra</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          <Swatch token="background" cssVar="--background" />
          <Swatch token="foreground" cssVar="--foreground" />
          <Swatch token="card" cssVar="--card" />
          <Swatch token="muted" cssVar="--muted" />
          <Swatch token="muted-fg" cssVar="--muted-foreground" />
          <Swatch token="border" cssVar="--border" />
          <Swatch token="primary" cssVar="--primary" />
          <Swatch token="primary-fg" cssVar="--primary-foreground" />
        </div>
      </section>

      {/* STATUS COLORS */}
      <section className="space-y-3">
        <h2>Status colors (low-fatigue)</h2>
        <p className="text-sm text-muted-foreground">
          Dessaturadas pra uso 8h. Sempre usar par <code className="text-xs bg-muted px-1.5 py-0.5 rounded">text-status-*-fg + bg-status-*-bg</code> em texto pequeno.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <StatusBlock tone="success" icon={CheckCircle2} label="Sucesso" desc="Pedido enviado · Conferido · Aprovado" />
          <StatusBlock tone="warning" icon={AlertTriangle} label="Atenção" desc="Aguardando aprovação · Lote diferente do FEFO" />
          <StatusBlock tone="error" icon={XCircle} label="Erro" desc="Falha no envio · Estoque negativo · Bloqueado" />
          <StatusBlock tone="info" icon={Info} label="Info" desc="Sincronizando · Em rota · Em análise" />
        </div>
      </section>

      {/* TIPOGRAFIA */}
      <section className="space-y-4">
        <h2>Tipografia (Geist Sans)</h2>
        <div className="space-y-3 border border-border rounded-md p-6 bg-card">
          <div>
            <h1>Heading 1 — 24px / 600 / -2% tracking</h1>
            <p className="text-xs text-muted-foreground mt-1">h1</p>
          </div>
          <div>
            <h2>Heading 2 — 20px / 600 / -2% tracking</h2>
            <p className="text-xs text-muted-foreground mt-1">h2</p>
          </div>
          <div>
            <h3>Heading 3 — 16px / 600</h3>
            <p className="text-xs text-muted-foreground mt-1">h3</p>
          </div>
          <div>
            <h4>Heading 4 — 14px / 600</h4>
            <p className="text-xs text-muted-foreground mt-1">h4</p>
          </div>
          <div className="pt-2 border-t border-border">
            <p className="text-base">
              Body normal — 14px Geist com <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">font-feature-settings: 'tnum'</code> ativo. Os números 1234567890 alinham perfeitamente.
            </p>
            <p className="text-sm text-muted-foreground mt-2">Body muted — secundário, contraste 4.86:1</p>
            <p className="text-xs text-muted-foreground mt-2">Caption — 12px, terciário</p>
            <p className="overline mt-2">Overline — 10px uppercase tracking</p>
          </div>
        </div>
      </section>

      {/* KPI VALUE */}
      <section className="space-y-3">
        <h2>KPI utility (.kpi-value — Geist Mono)</h2>
        <p className="text-sm text-muted-foreground">
          Para valores grandes em cockpits financeiros e operacionais.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Caixa Disponível" value="R$ 1.2M" icon={Wallet} positive />
          <KpiCard label="Margem Bruta" value="32.4%" icon={TrendingUp} positive />
          <KpiCard label="Inadimplência" value="8.7%" icon={AlertTriangle} positive={false} />
          <KpiCard label="SKUs Críticos" value="14" icon={Inbox} positive={false} />
        </div>
      </section>

      {/* BUTTONS */}
      <section className="space-y-3">
        <h2>Buttons</h2>
        <div className="space-y-4 border border-border rounded-md p-6 bg-card">
          <div className="flex flex-wrap gap-2 items-center">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button variant="destructive">Destructive</Button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm">Small (32px)</Button>
            <Button>Default (36px)</Button>
            <Button size="lg">Large (40px)</Button>
            <Button size="touch">Touch (44px) — separador / vendedor</Button>
            <Button size="balcao">Balcão (56px) — operador tintométrico</Button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>Outline disabled</Button>
          </div>
        </div>
      </section>

      {/* CARDS + INPUTS */}
      <section className="space-y-3">
        <h2>Cards e Inputs</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Card padrão</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="demo-input">Email</Label>
                <Input id="demo-input" type="email" placeholder="seu@email.com" />
              </div>
              <div className="flex items-center gap-2">
                <Switch id="demo-switch" />
                <Label htmlFor="demo-switch">Notificar por email</Label>
              </div>
              <Button className="w-full">Salvar alterações</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Card com tabs</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="aba1">
                <TabsList className="grid grid-cols-3 w-full">
                  <TabsTrigger value="aba1">Resumo</TabsTrigger>
                  <TabsTrigger value="aba2">Itens</TabsTrigger>
                  <TabsTrigger value="aba3">Histórico</TabsTrigger>
                </TabsList>
                <TabsContent value="aba1" className="pt-4 text-sm text-muted-foreground">
                  Conteúdo da aba Resumo. Lorem ipsum dolor sit amet.
                </TabsContent>
                <TabsContent value="aba2" className="pt-4 text-sm text-muted-foreground">
                  Conteúdo da aba Itens.
                </TabsContent>
                <TabsContent value="aba3" className="pt-4 text-sm text-muted-foreground">
                  Conteúdo da aba Histórico.
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* TABELA */}
      <section className="space-y-3">
        <h2>Tabela</h2>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead className="text-right">Vencimento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Marcenaria São José</TableCell>
                  <TableCell><Badge className="bg-status-success-bg text-status-success-fg border-status-success/20">Pago</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">R$ 1.234,56</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">10/05/2026</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Móveis Planejados Ltda</TableCell>
                  <TableCell><Badge className="bg-status-warning-bg text-status-warning-fg border-status-warning/20">Aguardando</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">R$ 8.901,23</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">15/05/2026</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Serralheria Norte SA</TableCell>
                  <TableCell><Badge className="bg-status-error-bg text-status-error-fg border-status-error/20">Vencido</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">R$ 23.456,78</TableCell>
                  <TableCell className="text-right tabular-nums text-status-error">02/05/2026</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      {/* DIALOG */}
      <section className="space-y-3">
        <h2>Dialog</h2>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">Abrir Dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirmar exclusão</DialogTitle>
              <DialogDescription>
                Esta ação não pode ser desfeita. O pedido será removido permanentemente.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button variant="destructive" onClick={() => setDialogOpen(false)}>Excluir</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </section>

      {/* EMPTY STATE */}
      <section className="space-y-3">
        <h2>Empty States</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-dashed border-border rounded-md p-2">
            <p className="text-xs text-muted-foreground mb-1 px-2">tone="operational" (default B2B)</p>
            <EmptyState
              icon={Inbox}
              title="Nenhum pedido encontrado"
              description="Tente ajustar os filtros ou criar um novo pedido."
              actionLabel="Criar pedido"
              onAction={() => undefined}
              secondaryActionLabel="Limpar filtros"
              onSecondaryAction={() => undefined}
            />
          </div>
          <div className="border border-dashed border-border rounded-md p-2">
            <p className="text-xs text-muted-foreground mb-1 px-2">tone="friendly" (customer)</p>
            <EmptyState
              tone="friendly"
              icon={Clock}
              title="Aguardando primeira coleta"
              description="Sua próxima coleta está agendada. Em breve faremos contato."
              actionLabel="Ver detalhes"
              onAction={() => undefined}
            />
          </div>
        </div>
      </section>

      {/* SKELETON */}
      <section className="space-y-3">
        <h2>Skeletons</h2>
        <Tabs defaultValue="cockpit">
          <TabsList>
            <TabsTrigger value="cockpit">Cockpit</TabsTrigger>
            <TabsTrigger value="list">List</TabsTrigger>
            <TabsTrigger value="form">Form</TabsTrigger>
            <TabsTrigger value="detail">Detail</TabsTrigger>
          </TabsList>
          <TabsContent value="cockpit"><PageSkeleton variant="cockpit" /></TabsContent>
          <TabsContent value="list"><PageSkeleton variant="list" /></TabsContent>
          <TabsContent value="form"><PageSkeleton variant="form" /></TabsContent>
          <TabsContent value="detail"><PageSkeleton variant="detail" /></TabsContent>
        </Tabs>
      </section>

      {/* MOTION */}
      <section className="space-y-3">
        <h2>Motion (easing Vercel)</h2>
        <div className="border border-border rounded-md p-6 bg-card flex flex-wrap gap-3">
          <button className="px-4 py-2 rounded-md bg-muted hover:bg-foreground hover:text-background transition-colors">
            Hover invertido
          </button>
          <button className="px-4 py-2 rounded-md border border-border hover:border-foreground transition-colors">
            Hover border
          </button>
          <button className="px-4 py-2 rounded-md border border-border hover:scale-[1.02] transition-transform">
            Hover scale
          </button>
        </div>
      </section>

      <p className="text-xs text-muted-foreground border-t border-border pt-4">
        Tokens definidos em <code className="font-mono">src/index.css</code>.
        Spec em <code className="font-mono">docs/visual-direction/02-tokens.md</code>.
      </p>
    </div>
  );
}

/* ─── helpers ─── */

function Swatch({ token, cssVar }: { token: string; cssVar: string }) {
  return (
    <div className="space-y-1">
      <div
        className="h-12 rounded-md border border-border"
        style={{ backgroundColor: `hsl(var(${cssVar}))` }}
      />
      <div className="text-xs">
        <p className="font-medium truncate">{token}</p>
        <p className="font-mono text-[10px] text-muted-foreground truncate">{cssVar}</p>
      </div>
    </div>
  );
}

function StatusBlock({
  tone,
  icon: Icon,
  label,
  desc,
}: {
  tone: 'success' | 'warning' | 'error' | 'info';
  icon: React.ElementType;
  label: string;
  desc: string;
}) {
  const cls = {
    success: 'bg-status-success-bg border-status-success/20 text-status-success-fg',
    warning: 'bg-status-warning-bg border-status-warning/20 text-status-warning-fg',
    error: 'bg-status-error-bg border-status-error/20 text-status-error-fg',
    info: 'bg-status-info-bg border-status-info/20 text-status-info-fg',
  }[tone];
  const iconCls = {
    success: 'text-status-success',
    warning: 'text-status-warning',
    error: 'text-status-error',
    info: 'text-status-info',
  }[tone];
  return (
    <div className={`border rounded-md p-4 flex items-start gap-3 ${cls}`}>
      <Icon className={`w-5 h-5 shrink-0 ${iconCls}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs opacity-80 mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  positive,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  positive: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
            <p className={`kpi-value text-3xl mt-2 ${positive ? 'text-status-success' : 'text-status-error'}`}>{value}</p>
          </div>
          <div className={`p-2.5 rounded-md ${positive ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
            <Icon className={`w-4 h-4 ${positive ? 'text-status-success' : 'text-status-error'}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
