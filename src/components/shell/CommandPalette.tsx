import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  LayoutDashboard, ShoppingCart, Users, Wrench, Package, Truck,
  BarChart3, DollarSign, Palette, Settings, BookOpen, PlusCircle,
  ClipboardList, FileCheck, Boxes, Beaker, Shield,
} from 'lucide-react';
import {
  useCommandsRegistry,
  useRegisterCommands,
  type Command,
} from './CommandsRegistry';
import { useRegisterShortcuts } from './ShortcutsRegistry';

/**
 * Palette aberta com Cmd+K / Ctrl+K (atalho registrado abaixo).
 * Mostra navegação para rotas + ações contextuais contribuídas pela página atual.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { open, setOpen, commands: dynamicCommands } = useCommandsRegistry();

  const close = () => setOpen(false);

  // Atalho global Cmd+K / Ctrl+K
  useRegisterShortcuts(
    useMemo(
      () => [
        {
          keys: 'mod+k',
          label: 'Buscar e navegar',
          group: 'Global',
          scope: 'global',
          allowInInput: true,
          handler: () => setOpen((v) => !v),
        },
      ],
      [setOpen],
    ),
  );

  // Comandos estáticos de navegação — base do app
  const staticCommands: Command[] = useMemo(() => {
    const go = (path: string) => () => {
      navigate(path);
      close();
    };
    return [
      // Navegar — Principal
      { id: 'nav.dashboard', label: 'Ir para Dashboard', group: 'Navegar', icon: LayoutDashboard, perform: go('/') },
      { id: 'nav.clientes', label: 'Ir para Clientes', group: 'Navegar', icon: Users, keywords: ['CRM', 'carteira'], perform: go('/admin/customers') },
      // Vendas
      { id: 'nav.sales', label: 'Pedidos de venda', group: 'Vendas', icon: ShoppingCart, perform: go('/sales') },
      { id: 'action.new-order', label: 'Novo pedido', group: 'Vendas', icon: PlusCircle, hint: 'Criar pedido', perform: go('/sales/new') },
      { id: 'nav.quotes', label: 'Cotações', group: 'Vendas', icon: ClipboardList, perform: go('/sales/quotes') },
      // Estoque
      { id: 'nav.picking', label: 'Picking & Estoque', group: 'Estoque', icon: Package, perform: go('/admin/estoque/picking') },
      { id: 'nav.recebimento', label: 'Recebimento NF-e', group: 'Estoque', icon: FileCheck, perform: go('/recebimento') },
      { id: 'nav.estoque-recebimento', label: 'Recebimento (gestão)', group: 'Estoque', icon: Boxes, perform: go('/admin/estoque/recebimento') },
      // Reposição
      { id: 'nav.repo-cockpit', label: 'Cockpit de Reposição', group: 'Reposição', icon: LayoutDashboard, keywords: ['compras', 'comprador'], perform: go('/admin/reposicao/cockpit') },
      { id: 'nav.repo-pedidos', label: 'Pedidos de compra sugeridos', group: 'Reposição', icon: Truck, perform: go('/admin/reposicao/pedidos') },
      { id: 'nav.repo-alertas', label: 'Alertas de reposição', group: 'Reposição', icon: BarChart3, perform: go('/admin/reposicao/alertas') },
      // Financeiro
      { id: 'nav.fin-cockpit', label: 'Cockpit CFO', group: 'Financeiro', icon: Shield, keywords: ['CFO', 'caixa'], perform: go('/financeiro/cockpit') },
      { id: 'nav.fin-gestao', label: 'Gestão financeira', group: 'Financeiro', icon: DollarSign, perform: go('/financeiro/gestao') },
      // Tintométrico
      { id: 'nav.tint-formulas', label: 'Buscar fórmula tintométrica', group: 'Tintométrico', icon: Beaker, keywords: ['cor', 'tinta', 'verniz', 'sayer'], perform: go('/tintometrico/formulas') },
      { id: 'nav.tint-catalogo', label: 'Catálogo tintométrico', group: 'Tintométrico', icon: Palette, perform: go('/tintometrico/catalogo') },
      // Documentação
      { id: 'nav.design-system', label: 'Design System', group: 'Documentação', icon: BookOpen, perform: go('/design-system') },
      { id: 'nav.settings', label: 'Configurações', group: 'Documentação', icon: Settings, perform: go('/settings') },
      // Ferramentas (cliente)
      { id: 'nav.tools', label: 'Minhas ferramentas', group: 'Afiação', icon: Wrench, perform: go('/tools') },
    ];
  }, [navigate]);

  // Registra os estáticos no registry para que o ShortcutsDialog/help possam listá-los se quiser
  useRegisterCommands(staticCommands);

  // Mescla estáticos + dinâmicos
  const allCommands = useMemo(() => {
    // dedupe por id (dinâmicos sobrescrevem estáticos com mesmo id)
    const map = new Map<string, Command>();
    [...staticCommands, ...dynamicCommands].forEach((c) => map.set(c.id, c));
    return Array.from(map.values());
  }, [staticCommands, dynamicCommands]);

  // Agrupa por `group`
  const groups = useMemo(() => {
    const m = new Map<string, Command[]>();
    for (const c of allCommands) {
      const g = c.group ?? 'Outros';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(c);
    }
    return Array.from(m.entries());
  }, [allCommands]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Buscar telas, ações, fórmulas, pedidos..." />
      <CommandList>
        <CommandEmpty>Nada encontrado.</CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((cmd) => {
              const Icon = cmd.icon;
              return (
                <CommandItem
                  key={cmd.id}
                  value={[cmd.label, cmd.group, ...(cmd.keywords ?? [])].filter(Boolean).join(' ')}
                  onSelect={() => cmd.perform(close)}
                >
                  {Icon && <Icon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className="flex-1">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="ml-2 text-xs text-muted-foreground">{cmd.hint}</span>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
