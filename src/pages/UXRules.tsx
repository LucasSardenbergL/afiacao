import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Search, Filter, MousePointerClick, PanelRightOpen, AlertTriangle,
  Target, Keyboard, Monitor, Smartphone, Tablet, Zap, RefreshCw,
  ShoppingCart, Phone, MessageSquare, BarChart3, Headphones, GraduationCap,
  ArrowRight, CheckCircle, XCircle, HelpCircle
} from 'lucide-react';

function Rule({ number, icon: Icon, title, children }: { number: number; icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <Card id={`rule-${number}`} className="scroll-mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <CardTitle className="text-base">
            <span className="text-muted-foreground mr-2">#{number}</span>
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-3">
        {children}
      </CardContent>
    </Card>
  );
}

function CopyExample({ label, good, bad }: { label: string; good: string; bad?: string }) {
  return (
    <div className="border border-border rounded-lg p-3 space-y-2">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <CheckCircle className="w-3.5 h-3.5 text-status-success mt-0.5 shrink-0" />
        <p className="text-sm">{good}</p>
      </div>
      {bad && (
        <div className="flex items-start gap-2">
          <XCircle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
          <p className="text-sm line-through opacity-60">{bad}</p>
        </div>
      )}
    </div>
  );
}

export default function UXRules() {
  const rules = [
    { num: 1, icon: Search, title: 'Busca global (⌘K)' },
    { num: 2, icon: Filter, title: 'Filtros persistentes' },
    { num: 3, icon: MousePointerClick, title: 'Ações rápidas em listas' },
    { num: 4, icon: PanelRightOpen, title: 'Painel lateral inteligente' },
    { num: 5, icon: AlertTriangle, title: 'Erros e recuperação' },
    { num: 6, icon: Target, title: 'CTA principal por tela' },
    { num: 7, icon: Keyboard, title: 'Acessibilidade' },
    { num: 8, icon: Zap, title: 'Performance percebida' },
    { num: 9, icon: Monitor, title: 'Responsividade' },
    { num: 10, icon: ShoppingCart, title: 'Mental model: Pedido' },
    { num: 11, icon: Headphones, title: 'Mental model: Ligações' },
    { num: 12, icon: GraduationCap, title: 'Mental model: Coaching' },
  ];

  return (
    <div className="flex gap-8 max-w-7xl mx-auto">
      {/* TOC */}
      <nav className="hidden xl:block w-48 shrink-0 sticky top-20 self-start space-y-0.5">
        <p className="overline mb-2">Regras de UX</p>
        {rules.map(r => (
          <a key={r.num} href={`#rule-${r.num}`} className="block text-sm text-muted-foreground hover:text-foreground py-1 transition-colors">
            {r.num}. {r.title}
          </a>
        ))}
        <Separator className="my-3" />
        <a href="#copy" className="block text-sm text-muted-foreground hover:text-foreground py-1">Copy & Microcopy</a>
        <a href="#mental-models" className="block text-sm text-muted-foreground hover:text-foreground py-1">Mental Models</a>
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-6 pb-16">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">UX Rules</h1>
          <p className="text-muted-foreground mt-1">
            Padrões de design, regras de interação e copy — guia para consistência do produto.
          </p>
          <div className="flex gap-2 mt-3">
            <Badge variant="info">12 regras</Badge>
            <Badge variant="secondary">PT-BR</Badge>
          </div>
        </div>

        {/* ─── RULE 1: Busca Global ─── */}
        <Rule number={1} icon={Search} title="Busca global (⌘K)">
          <p><strong>O que:</strong> Campo de busca unificado acessível via <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">⌘K</kbd> (Mac) ou <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">Ctrl+K</kbd> (Windows).</p>
          <p><strong>Busca em:</strong> Clientes, produtos, pedidos, ligações, configurações.</p>
          <p><strong>Comportamento:</strong></p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Resultados agrupados por tipo com ícones distintos</li>
            <li>Atalhos de teclado: ↑↓ para navegar, Enter para selecionar, Esc para fechar</li>
            <li>Debounce de 300ms no input</li>
            <li>Últimas 5 buscas salvas como sugestão</li>
          </ul>
        </Rule>

        {/* ─── RULE 2: Filtros ─── */}
        <Rule number={2} icon={Filter} title="Filtros persistentes">
          <p><strong>O que:</strong> Filtros aplicados pelo usuário são salvos por tela via localStorage.</p>
          <p><strong>Comportamento:</strong></p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Filtros ativos exibidos como chips com botão "×" para remover</li>
            <li>Botão "Limpar todos" quando há 2+ filtros ativos</li>
            <li>Contador de resultados atualizado em tempo real</li>
            <li>Persistência entre sessões (key: <code className="text-xs font-mono bg-muted px-1 rounded">filters:{'{'}tela{'}'}</code>)</li>
          </ul>
        </Rule>

        {/* ─── RULE 3: Ações rápidas ─── */}
        <Rule number={3} icon={MousePointerClick} title="Ações rápidas em listas">
          <p><strong>O que:</strong> Hover ou long-press revela ações contextuais sem sair da lista.</p>
          <p><strong>Ações padrão por contexto:</strong></p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground mb-1">Lista de clientes</p>
              <p className="text-xs">📞 Ligar · 💬 WhatsApp · 🛒 Novo pedido · ✏️ Registrar visita</p>
            </div>
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground mb-1">Lista de pedidos</p>
              <p className="text-xs">👁 Ver detalhes · 📋 Duplicar · 📤 Enviar por e-mail</p>
            </div>
          </div>
          <p><strong>Mobile:</strong> Swipe para direita revela ações, swipe esquerdo para ação destrutiva (com confirmação).</p>
        </Rule>

        {/* ─── RULE 4: Painel lateral ─── */}
        <Rule number={4} icon={PanelRightOpen} title="Painel lateral inteligente">
          <p><strong>O que:</strong> Drawer direito (320px) com insights e próximos passos. Abre ao clicar em um item sem sair da lista.</p>
          <p><strong>Conteúdo padrão:</strong></p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>KPIs resumidos (ticket médio, margem, health score)</li>
            <li>Recomendações contextuais ("O que falta neste cliente")</li>
            <li>Próximos passos sugeridos com CTAs</li>
            <li>Histórico recente (últimos 3 pedidos / ligações)</li>
          </ul>
          <p><strong>Regra:</strong> Desktop mostra painel + lista lado a lado. Tablet/mobile usa Sheet full-width.</p>
        </Rule>

        {/* ─── RULE 5: Erros ─── */}
        <Rule number={5} icon={AlertTriangle} title="Erros e recuperação">
          <p><strong>Princípio:</strong> Todo erro deve oferecer uma ação de recuperação. Nunca deixe o usuário em beco sem saída.</p>
          <div className="space-y-2">
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground">Erro não-bloqueante</p>
              <p className="text-xs">→ Toast com ação: "Falha ao salvar. <u>Tentar novamente</u>"</p>
            </div>
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground">Erro bloqueante</p>
              <p className="text-xs">→ Modal: "Preço indisponível para este produto. <u>Usar último preço</u> ou <u>Consultar gerente</u>"</p>
            </div>
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground">Erro de conexão</p>
              <p className="text-xs">→ Banner fixo: "Sem conexão. Alterações serão salvas quando a internet retornar."</p>
            </div>
            <div className="border border-border rounded-lg p-2.5">
              <p className="text-xs font-medium text-foreground">Estoque zerado</p>
              <p className="text-xs">→ Inline no item: "Sem estoque. <u>Notificar quando disponível</u> ou <u>Sugerir alternativa</u>"</p>
            </div>
          </div>
        </Rule>

        {/* ─── RULE 6: CTA principal ─── */}
        <Rule number={6} icon={Target} title="CTA principal por tela">
          <p><strong>Princípio:</strong> Cada tela tem UMA ação principal clara. Todas as outras são secundárias.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 font-medium">Tela</th>
                  <th className="text-left py-2 font-medium">CTA principal</th>
                  <th className="text-left py-2 font-medium">Variante</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50"><td className="py-2">Dashboard</td><td>Ver tarefas do dia</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
                <tr className="border-b border-border/50"><td className="py-2">Clientes</td><td>Novo pedido (para o cliente selecionado)</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
                <tr className="border-b border-border/50"><td className="py-2">Carrinho</td><td>Finalizar pedido</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
                <tr className="border-b border-border/50"><td className="py-2">Ligações</td><td>Iniciar ligação</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
                <tr className="border-b border-border/50"><td className="py-2">Coaching</td><td>Preparar próxima call</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
                <tr><td className="py-2">Recomendações</td><td>Adicionar ao pedido</td><td><Badge variant="info" className="text-2xs">Primary</Badge></td></tr>
              </tbody>
            </table>
          </div>
        </Rule>

        {/* ─── RULE 7: Acessibilidade ─── */}
        <Rule number={7} icon={Keyboard} title="Acessibilidade">
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li><strong>Contraste:</strong> WCAG AA (4.5:1 texto normal, 3:1 texto grande)</li>
            <li><strong>Focus ring:</strong> Ring de 2px com offset de 2px em todos os interativos (<code className="text-xs font-mono bg-muted px-1 rounded">:focus-visible</code>)</li>
            <li><strong>Teclado:</strong> Tab navega entre elementos, Enter/Space ativa, Esc fecha modais/dropdowns</li>
            <li><strong>Touch targets:</strong> Mínimo 32px (compact) / 44px (comfortable) em botões e links</li>
            <li><strong>Labels:</strong> Todo input tem <code className="text-xs font-mono bg-muted px-1 rounded">&lt;Label&gt;</code> associado via <code className="text-xs font-mono bg-muted px-1 rounded">htmlFor</code></li>
            <li><strong>aria-label:</strong> Obrigatório em icon buttons e ações sem texto visível</li>
            <li><strong>Leitores de tela:</strong> Status badges incluem texto descritivo, não apenas cor</li>
          </ul>
        </Rule>

        {/* ─── RULE 8: Performance ─── */}
        <Rule number={8} icon={Zap} title="Performance percebida">
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li><strong>Skeleton:</strong> Exibir placeholder de conteúdo imediatamente (antes do fetch)</li>
            <li><strong>Optimistic UI:</strong> Ações como "Adicionar ao carrinho" refletem instantaneamente</li>
            <li><strong>Transições:</strong> Usar <code className="text-xs font-mono bg-muted px-1 rounded">animate-fade-in</code> para entrada de conteúdo</li>
            <li><strong>Loading buttons:</strong> Substituir texto por spinner + "Salvando..." (disabled durante operação)</li>
            <li><strong>Shimmer:</strong> Usar <code className="text-xs font-mono bg-muted px-1 rounded">animate-shimmer</code> em tabelas e listas longas</li>
          </ul>
        </Rule>

        {/* ─── RULE 9: Responsividade ─── */}
        <Rule number={9} icon={Monitor} title="Responsividade">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center border border-border rounded-lg p-3">
              <Smartphone className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs font-medium">Mobile</p>
              <p className="text-2xs text-muted-foreground">1 coluna · Bottom nav · Sheets</p>
            </div>
            <div className="text-center border border-border rounded-lg p-3">
              <Tablet className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs font-medium">Tablet</p>
              <p className="text-2xs text-muted-foreground">2 colunas · Sidebar colapsada</p>
            </div>
            <div className="text-center border border-border rounded-lg p-3">
              <Monitor className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs font-medium">Desktop</p>
              <p className="text-2xs text-muted-foreground">3+ colunas · Sidebar + painel</p>
            </div>
          </div>
        </Rule>

        {/* ─── MENTAL MODELS ─── */}
        <Separator id="mental-models" className="scroll-mt-6" />
        <div>
          <h2>Mental Models</h2>
          <p className="text-sm text-muted-foreground mt-1">Como o vendedor pensa sobre cada fluxo</p>
        </div>

        {/* ─── RULE 10: Pedido ─── */}
        <Rule number={10} icon={ShoppingCart} title="Mental model: Pedido (Polaris)">
          <p><strong>Modelo mental:</strong> Admin de e-commerce. O vendedor é o "admin" criando pedido em nome do cliente.</p>
          <div className="flex items-center gap-2 flex-wrap text-xs font-medium">
            <Badge variant="secondary">1. Selecionar cliente</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="secondary">2. Buscar produtos</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="secondary">3. Montar carrinho</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="secondary">4. Recomendações</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="info">5. Finalizar</Badge>
          </div>
          <p className="mt-2"><strong>Cross-sell aparece em 3 pontos:</strong></p>
          <ol className="list-decimal list-inside space-y-1 ml-2">
            <li>Perfil do cliente — "O que está faltando"</li>
            <li>Durante o carrinho — "Combine com"</li>
            <li>Pós-pedido — "Próxima compra provável"</li>
          </ol>
          <p><strong>Cada recomendação mostra:</strong> produto, impacto no ticket, razão da sugestão, CTA "Adicionar".</p>
        </Rule>

        {/* ─── RULE 11: Ligações ─── */}
        <Rule number={11} icon={Headphones} title="Mental model: Ligações (Gong)">
          <p><strong>Modelo mental:</strong> Conversation intelligence. O vendedor revisa calls para melhorar performance.</p>
          <div className="flex items-center gap-2 flex-wrap text-xs font-medium">
            <Badge variant="secondary">1. Lista de calls</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="secondary">2. Player + Transcrição</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="secondary">3. Highlights + Tópicos</Badge>
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            <Badge variant="info">4. Insights + Próximos passos</Badge>
          </div>
          <p className="mt-2"><strong>Funcionalidades da transcrição:</strong></p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Timestamps clicáveis (pula para o momento no player)</li>
            <li>Busca por termos dentro da transcrição</li>
            <li>Highlights marcáveis (positivos e negativos)</li>
            <li>Resumo automático gerado por IA</li>
            <li>"Próximos passos" extraídos automaticamente</li>
          </ul>
        </Rule>

        {/* ─── RULE 12: Coaching ─── */}
        <Rule number={12} icon={GraduationCap} title="Mental model: Coaching SPIN">
          <p><strong>Modelo mental:</strong> O vendedor recebe coaching antes e depois de cada call.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="border border-border rounded-lg p-3">
              <p className="text-xs font-medium text-foreground mb-1">🎯 Antes da call</p>
              <ul className="text-xs space-y-0.5">
                <li>• Perguntas SPIN sugeridas por contexto</li>
                <li>• Objeções prováveis + respostas</li>
                <li>• Dados do cliente relevantes</li>
              </ul>
            </div>
            <div className="border border-border rounded-lg p-3">
              <p className="text-xs font-medium text-foreground mb-1">📊 Depois da call</p>
              <ul className="text-xs space-y-0.5">
                <li>• Score por critério SPIN (S/P/I/N)</li>
                <li>• "O que faltou" com sugestões</li>
                <li>• "Melhores perguntas" que funcionaram</li>
              </ul>
            </div>
          </div>
        </Rule>

        {/* ─── COPY & MICROCOPY ─── */}
        <Separator id="copy" className="scroll-mt-6" />
        <div>
          <h2>Copy & Microcopy (PT-BR)</h2>
          <p className="text-sm text-muted-foreground mt-1">Tom: direto, técnico, sem firulas. Sempre orientado à ação.</p>
        </div>

        <h3>CTAs</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyExample label="Botão principal" good="Finalizar pedido" bad="Clique aqui para finalizar" />
          <CopyExample label="Adicionar item" good="Adicionar ao pedido" bad="Adicionar este produto ao carrinho de compras" />
          <CopyExample label="Iniciar ligação" good="Ligar agora" bad="Fazer uma ligação" />
          <CopyExample label="Salvar" good="Salvar alterações" bad="Confirmar e salvar as suas alterações" />
        </div>

        <h3 className="mt-4">Labels</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyExample label="Campo de busca" good="Buscar por nome, SKU ou CNPJ" bad="Digite aqui para pesquisar" />
          <CopyExample label="Filtro de status" good="Status do pedido" bad="Filtre pelo status" />
          <CopyExample label="Campo vazio" good="Ex.: Metalúrgica Souza Ltda" bad="Nome da empresa" />
        </div>

        <h3 className="mt-4">Empty States</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyExample label="Sem pedidos" good="Nenhum pedido encontrado. Crie o primeiro pedido para este cliente." bad="Não há dados para exibir neste momento" />
          <CopyExample label="Sem resultados" good="Nenhum resultado para &quot;termo&quot;. Tente ajustar os filtros." bad="Sua busca não retornou resultados" />
          <CopyExample label="Sem ligações" good="Nenhuma ligação registrada. Inicie a primeira call." bad="Você ainda não tem ligações" />
        </div>

        <h3 className="mt-4">Mensagens de Erro</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyExample label="Falha ao salvar" good="Não foi possível salvar. Tentar novamente." bad="Ocorreu um erro inesperado" />
          <CopyExample label="Sem conexão" good="Sem conexão. Alterações serão salvas automaticamente." bad="Erro de rede" />
          <CopyExample label="Preço indisponível" good="Preço não encontrado. Usar último preço ou consultar gerente." bad="Erro ao buscar preço" />
          <CopyExample label="Estoque zerado" good="Sem estoque. Notificar quando disponível ou ver alternativas." bad="Produto indisponível" />
        </div>

        <h3 className="mt-4">Confirmações</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyExample label="Excluir pedido" good="Tem certeza? Esta ação não pode ser desfeita." bad="Você realmente deseja excluir?" />
          <CopyExample label="Pedido criado" good="Pedido #A1B2C3 criado com sucesso." bad="Seu pedido foi criado!" />
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-muted-foreground pb-8 space-y-1 mt-8">
          <p className="font-medium">UX Rules v2.0 — Colacor CRM</p>
          <p>Referências: HubSpot Canvas · Shopify Polaris · Gong</p>
          <p>Última atualização: Fev 2026</p>
        </div>
      </div>
    </div>
  );
}
