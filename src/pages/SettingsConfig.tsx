import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  Settings, Sliders, Shield, Users, Link2, Brain,
  Save, RotateCcw, AlertTriangle, CheckCircle2, Info,
  Lock, Eye, EyeOff, Zap, Target, TrendingUp, BarChart3,
  Package, Phone, Award, Database, Webhook,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUserRole } from '@/hooks/useUserRole';

/* ─── Types ─── */
interface WeightConfig {
  key: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  category: string;
}

/* ─── Mock Config ─── */
const defaultWeights: WeightConfig[] = [
  { key: 'health_w_rf', label: 'Peso Recência/Frequência', description: 'Influência de recência e frequência no Health Score', value: 0.25, min: 0, max: 1, step: 0.05, category: 'health' },
  { key: 'health_w_m', label: 'Peso Monetário', description: 'Influência do valor monetário no Health Score', value: 0.25, min: 0, max: 1, step: 0.05, category: 'health' },
  { key: 'health_w_g', label: 'Peso Margem', description: 'Influência da margem bruta no Health Score', value: 0.20, min: 0, max: 1, step: 0.05, category: 'health' },
  { key: 'health_w_x', label: 'Peso Mix (Categorias)', description: 'Influência da diversificação de mix no Health Score', value: 0.15, min: 0, max: 1, step: 0.05, category: 'health' },
  { key: 'health_w_s', label: 'Peso Responsividade', description: 'Influência da taxa de resposta no Health Score', value: 0.15, min: 0, max: 1, step: 0.05, category: 'health' },
  { key: 'priority_w_churn', label: 'Peso Risco Churn', description: 'Prioridade para clientes em risco de churn', value: 0.35, min: 0, max: 1, step: 0.05, category: 'priority' },
  { key: 'priority_w_recover', label: 'Peso Recuperação', description: 'Prioridade para recuperação de clientes inativos', value: 0.25, min: 0, max: 1, step: 0.05, category: 'priority' },
  { key: 'priority_w_expansion', label: 'Peso Expansão', description: 'Prioridade para expandir mix de clientes ativos', value: 0.25, min: 0, max: 1, step: 0.05, category: 'priority' },
  { key: 'priority_w_eff', label: 'Peso Eficiência', description: 'Prioridade baseada em margem por hora investida', value: 0.15, min: 0, max: 1, step: 0.05, category: 'priority' },
  { key: 'agenda_pct_risco', label: 'Quota Risco (%)', description: 'Percentual da agenda dedicado a clientes em risco', value: 40, min: 0, max: 100, step: 5, category: 'agenda' },
  { key: 'agenda_pct_expansao', label: 'Quota Expansão (%)', description: 'Percentual da agenda dedicado a expansão de mix', value: 35, min: 0, max: 100, step: 5, category: 'agenda' },
  { key: 'agenda_pct_followup', label: 'Quota Follow-up (%)', description: 'Percentual da agenda dedicado a follow-ups', value: 25, min: 0, max: 100, step: 5, category: 'agenda' },
];

interface IntegrationItem {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  status: 'connected' | 'disconnected' | 'error';
  lastSync?: string;
}

const integrations: IntegrationItem[] = [
  { id: 'omie', name: 'Omie ERP', description: 'Sincronização de clientes, produtos e pedidos', icon: Database, status: 'connected', lastSync: '2026-02-24T09:30:00' },
  { id: 'elevenlabs', name: 'ElevenLabs', description: 'Transcrição de áudio em tempo real', icon: Phone, status: 'connected', lastSync: '2026-02-24T10:15:00' },
  { id: 'whatsapp', name: 'WhatsApp Business', description: 'Envio de mensagens e follow-ups', icon: Webhook, status: 'disconnected' },
];

interface PermissionConfig {
  key: string;
  label: string;
  description: string;
  vendedor: boolean;
  gestor: boolean;
}

const permissions: PermissionConfig[] = [
  { key: 'view_recommendations', label: 'Ver recomendações', description: 'Acesso às sugestões de cross-sell e upsell', vendedor: true, gestor: true },
  { key: 'view_coaching', label: 'Coaching SPIN', description: 'Análise pós-call e perguntas sugeridas', vendedor: true, gestor: true },
  { key: 'view_scoring_details', label: 'Detalhes de scoring', description: 'Pesos, fórmulas e critérios de pontuação', vendedor: false, gestor: true },
  { key: 'view_metrics', label: 'Métricas avançadas', description: 'IPF, IEE, margem/hora, LTV e projeções', vendedor: false, gestor: true },
  { key: 'edit_weights', label: 'Editar pesos', description: 'Alterar pesos do algoritmo de priorização', vendedor: false, gestor: true },
  { key: 'view_audit', label: 'Auditoria', description: 'Log de mudanças nos parâmetros', vendedor: false, gestor: true },
  { key: 'manage_governance', label: 'Governança', description: 'Aprovar/rejeitar propostas de ajuste', vendedor: false, gestor: true },
  { key: 'export_data', label: 'Exportar dados', description: 'Download de relatórios e dados de clientes', vendedor: false, gestor: true },
];

/* ─── Main Component ─── */
const SettingsConfig = () => {
  const { isAdmin } = useUserRole();
  const [weights, setWeights] = useState(defaultWeights);
  const [activeTab, setActiveTab] = useState('recommendations');
  const [hasChanges, setHasChanges] = useState(false);

  const updateWeight = (key: string, value: number) => {
    setWeights(prev => prev.map(w => w.key === key ? { ...w, value } : w));
    setHasChanges(true);
  };

  const resetWeights = () => {
    setWeights(defaultWeights);
    setHasChanges(false);
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'connected': return <Badge className="text-2xs bg-success/10 text-success border-success/20"><CheckCircle2 className="w-3 h-3 mr-1" />Conectado</Badge>;
      case 'error': return <Badge variant="destructive" className="text-2xs"><AlertTriangle className="w-3 h-3 mr-1" />Erro</Badge>;
      default: return <Badge variant="secondary" className="text-2xs">Desconectado</Badge>;
    }
  };

  return (
    <div className="space-y-4">
        {/* Prototype Warning */}
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Tela prototípica — alterações não são salvas</p>
            <p className="text-xs text-amber-600/80 dark:text-amber-400/70">
              Os controles abaixo são simulações visuais para validação de UX. Para ajustar parâmetros reais, use{' '}
              <span className="font-medium">Governança → Parâmetros</span>.
            </p>
          </div>
        </div>

        {/* Page Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Configurações <Badge variant="outline" className="ml-2 text-2xs text-amber-600 border-amber-500/30">Protótipo</Badge></h1>
            <p className="text-sm text-muted-foreground">Regras de recomendação, pesos, permissões e integrações (visualização)</p>
          </div>
          {hasChanges && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetWeights} className="gap-1">
                <RotateCcw className="w-3 h-3" /> Desfazer
              </Button>
              <Button size="sm" className="gap-1" disabled title="Tela prototípica — alterações não são persistidas">
                <Save className="w-3 h-3" /> Salvar alterações
              </Button>
            </div>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-4 w-full max-w-2xl">
            <TabsTrigger value="recommendations" className="gap-1.5 text-xs">
              <Sliders className="w-3.5 h-3.5" /> Regras
            </TabsTrigger>
            <TabsTrigger value="weights" className="gap-1.5 text-xs">
              <BarChart3 className="w-3.5 h-3.5" /> Pesos
            </TabsTrigger>
            <TabsTrigger value="permissions" className="gap-1.5 text-xs">
              <Shield className="w-3.5 h-3.5" /> Permissões
            </TabsTrigger>
            <TabsTrigger value="integrations" className="gap-1.5 text-xs">
              <Link2 className="w-3.5 h-3.5" /> Integrações
            </TabsTrigger>
          </TabsList>

          {/* ─── RECOMMENDATION RULES ─── */}
          <TabsContent value="recommendations" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="w-4 h-4 text-primary" />
                  Regras de Cross-sell / Upsell
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Confiança mínima (P<sub>ij</sub>)</label>
                    <p className="text-2xs text-muted-foreground">Probabilidade mínima para exibir uma recomendação</p>
                    <div className="flex items-center gap-3">
                      <Slider defaultValue={[30]} max={100} step={5} className="flex-1" />
                      <span className="text-xs font-mono w-10 text-right">30%</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">LIE mínimo</label>
                    <p className="text-2xs text-muted-foreground">Lucro incremental mínimo para exibir recomendação</p>
                    <div className="flex items-center gap-3">
                      <Slider defaultValue={[50]} max={500} step={10} className="flex-1" />
                      <span className="text-xs font-mono w-14 text-right">R$ 50</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Máx. recomendações por cliente</label>
                    <p className="text-2xs text-muted-foreground">Limite de sugestões exibidas por vez</p>
                    <Select defaultValue="5">
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3">3 recomendações</SelectItem>
                        <SelectItem value="5">5 recomendações</SelectItem>
                        <SelectItem value="10">10 recomendações</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium">Cooldown após rejeição</label>
                    <p className="text-2xs text-muted-foreground">Dias antes de re-sugerir produto rejeitado</p>
                    <Select defaultValue="30">
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="7">7 dias</SelectItem>
                        <SelectItem value="15">15 dias</SelectItem>
                        <SelectItem value="30">30 dias</SelectItem>
                        <SelectItem value="60">60 dias</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xs font-medium mb-2">Pontos de exibição</h3>
                  <div className="space-y-2">
                    {[
                      { label: 'Perfil do cliente — "O que falta"', desc: 'Mostrar gap de mix no perfil 360', enabled: true },
                      { label: 'Carrinho — "Combine com"', desc: 'Sugestões contextuais durante pedido', enabled: true },
                      { label: 'Pós-pedido — "Próxima compra provável"', desc: 'Recomendações após finalizar pedido', enabled: true },
                    ].map(item => (
                      <div key={item.label} className="flex items-center justify-between bg-muted/30 rounded-lg p-3">
                        <div>
                          <p className="text-xs font-medium">{item.label}</p>
                          <p className="text-2xs text-muted-foreground">{item.desc}</p>
                        </div>
                        <Switch defaultChecked={item.enabled} />
                      </div>
                    ))}
                  </div>
                </div>

                <Separator />

                <div>
                  <h3 className="text-xs font-medium mb-2">Modelo de explicação</h3>
                  <p className="text-2xs text-muted-foreground mb-2">Cada recomendação mostrará automaticamente:</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { icon: Package, label: 'Produto sugerido', desc: 'Nome e especificações' },
                      { icon: TrendingUp, label: 'Impacto no ticket', desc: 'Valor incremental estimado' },
                      { icon: Brain, label: 'Razão da sugestão', desc: 'Por que este produto para este cliente' },
                      { icon: Zap, label: 'CTA "Adicionar"', desc: 'Ação rápida de um clique' },
                    ].map(item => (
                      <div key={item.label} className="flex items-center gap-2 bg-primary/5 rounded-lg p-2.5 border border-primary/10">
                        <item.icon className="w-4 h-4 text-primary shrink-0" />
                        <div>
                          <p className="text-xs font-medium">{item.label}</p>
                          <p className="text-2xs text-muted-foreground">{item.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── WEIGHTS ─── */}
          <TabsContent value="weights" className="mt-4 space-y-4">
            {['health', 'priority', 'agenda'].map(category => {
              const categoryLabel = category === 'health' ? 'Health Score' : category === 'priority' ? 'Priorização' : 'Agenda';
              const categoryIcon = category === 'health' ? Award : category === 'priority' ? Target : BarChart3;
              const CatIcon = categoryIcon;
              const catWeights = weights.filter(w => w.category === category);
              const sum = catWeights.reduce((a, w) => a + w.value, 0);
              const isNormalized = category !== 'agenda' && Math.abs(sum - 1) > 0.01;

              return (
                <Card key={category}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <CatIcon className="w-4 h-4 text-primary" />
                        {categoryLabel}
                      </CardTitle>
                      {category !== 'agenda' && (
                        <Badge variant={isNormalized ? 'destructive' : 'outline'} className="text-2xs">
                          Σ = {sum.toFixed(2)} {isNormalized && '⚠ deve ser 1.0'}
                        </Badge>
                      )}
                      {category === 'agenda' && (
                        <Badge variant={sum !== 100 ? 'destructive' : 'outline'} className="text-2xs">
                          Σ = {sum}% {sum !== 100 && '⚠ deve ser 100%'}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {catWeights.map(w => (
                      <div key={w.key} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-medium">{w.label}</p>
                            <p className="text-2xs text-muted-foreground">{w.description}</p>
                          </div>
                          <span className="text-sm font-mono font-semibold w-14 text-right">
                            {category === 'agenda' ? `${w.value}%` : w.value.toFixed(2)}
                          </span>
                        </div>
                        <Slider
                          value={[w.value]}
                          min={w.min}
                          max={w.max}
                          step={w.step}
                          onValueChange={([v]) => updateWeight(w.key, v)}
                        />
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}
          </TabsContent>

          {/* ─── PERMISSIONS ─── */}
          <TabsContent value="permissions" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  Permissões por Perfil
                </CardTitle>
                <p className="text-2xs text-muted-foreground">
                  Controle o que cada perfil pode ver e editar. Features de "Gestor" ficam ocultas para vendedores por padrão.
                </p>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Funcionalidade</th>
                        <th className="text-center py-2 px-4 font-medium text-muted-foreground w-24">
                          <div className="flex items-center justify-center gap-1">
                            <Users className="w-3 h-3" /> Vendedor
                          </div>
                        </th>
                        <th className="text-center py-2 px-4 font-medium text-muted-foreground w-24">
                          <div className="flex items-center justify-center gap-1">
                            <Shield className="w-3 h-3" /> Gestor
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {permissions.map(p => (
                        <tr key={p.key} className="border-b border-border/50">
                          <td className="py-2.5 pr-4">
                            <p className="font-medium">{p.label}</p>
                            <p className="text-2xs text-muted-foreground">{p.description}</p>
                          </td>
                          <td className="text-center py-2.5 px-4">
                            {p.vendedor ? (
                              <Eye className="w-4 h-4 text-success mx-auto" />
                            ) : (
                              <EyeOff className="w-4 h-4 text-muted-foreground/30 mx-auto" />
                            )}
                          </td>
                          <td className="text-center py-2.5 px-4">
                            {p.gestor ? (
                              <Eye className="w-4 h-4 text-success mx-auto" />
                            ) : (
                              <EyeOff className="w-4 h-4 text-muted-foreground/30 mx-auto" />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 bg-muted/30 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div>
                      <p className="text-xs font-medium">Feature Flags</p>
                      <p className="text-2xs text-muted-foreground">
                        As funcionalidades marcadas como "Gestor only" permanecem implementadas no código mas ficam ocultas
                        na interface do vendedor. Isso permite ativar gradualmente sem deploy.
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── INTEGRATIONS ─── */}
          <TabsContent value="integrations" className="mt-4 space-y-4">
            {integrations.map(integration => {
              const IntIcon = integration.icon;
              return (
                <Card key={integration.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                          <IntIcon className="w-5 h-5 text-foreground" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{integration.name}</p>
                          <p className="text-2xs text-muted-foreground">{integration.description}</p>
                          {integration.lastSync && (
                            <p className="text-2xs text-muted-foreground mt-0.5">
                              Última sync: {new Date(integration.lastSync).toLocaleString('pt-BR')}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {statusBadge(integration.status)}
                        <Button
                          variant={integration.status === 'connected' ? 'outline' : 'default'}
                          size="sm"
                          className="text-xs"
                        >
                          {integration.status === 'connected' ? 'Configurar' : 'Conectar'}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <Card className="border-dashed">
              <CardContent className="p-6 text-center">
                <Link2 className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm font-medium text-muted-foreground">Precisa de outra integração?</p>
                <p className="text-2xs text-muted-foreground mt-1">Entre em contato com o suporte para solicitar novas integrações.</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
    </div>
  );
};

export default SettingsConfig;
