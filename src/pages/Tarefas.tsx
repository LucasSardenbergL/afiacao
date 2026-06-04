import { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useTarefasQueCriei, useTarefaMutations } from '@/hooks/useTarefas';
import { useSalespeople } from '@/hooks/useCoverage';
import { useBuscaClienteOmie, type ClienteBusca } from '@/hooks/useBuscaClienteOmie';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, Loader2 } from 'lucide-react';
import { CriarTarefaDialog } from '@/components/tarefas/CriarTarefaDialog';

/**
 * Página do founder: "Tarefas que criei".
 * Lista as tarefas criadas pelo usuário (com status, atraso, escalada, sugestão,
 * origem de conclusão) + cancelar. Gated a master/gestor comercial.
 *
 * O fluxo "Nova tarefa" escolhe cliente (busca Omie, mesmo padrão de FarmerCalls)
 * + vendedora responsável (useSalespeople) e abre o CriarTarefaDialog já munido.
 */
export default function Tarefas() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeGerir = isMaster || isGestorComercial;

  const { data: tarefas = [], isLoading } = useTarefasQueCriei('todas');
  const { cancelar } = useTarefaMutations();
  const { data: salespeople = [] } = useSalespeople();
  const { buscar, resolver } = useBuscaClienteOmie();

  // Estado do fluxo de criação
  const [abrirPicker, setAbrirPicker] = useState(false);
  const [abrirCriar, setAbrirCriar] = useState(false);
  const [cliente, setCliente] = useState<{ customer_user_id: string; nome: string } | null>(null);
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [empresa, setEmpresa] = useState<string>('oben');

  // Busca de cliente (mesma fonte que Vendas/Ligações: Omie via edge function)
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<ClienteBusca[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [resolvendo, setResolvendo] = useState(false);

  const buscarClientes = useCallback(async (query: string) => {
    if (query.length < 2) { setResultados([]); return; }
    setBuscando(true);
    try { setResultados(await buscar(query)); }
    finally { setBuscando(false); }
  }, [buscar]);

  useEffect(() => {
    const t = setTimeout(() => buscarClientes(busca), 300);
    return () => clearTimeout(t);
  }, [busca, buscarClientes]);

  /** Resolve o user_id local (igual ao save do FarmerCalls) e abre o dialog. */
  const selecionarCliente = async (c: ClienteBusca) => {
    setResolvendo(true);
    try {
      const customerUserId = await resolver(c);
      if (!customerUserId) {
        toast.error('Cliente sem cadastro local', {
          description: 'Esse cliente Omie ainda não tem perfil no app. Crie um pedido primeiro para vinculá-lo.',
        });
        return;
      }
      setCliente({ customer_user_id: customerUserId, nome: c.nome });
      setBusca(''); setResultados([]);
      setAbrirPicker(false);
      setAbrirCriar(true);
    } finally {
      setResolvendo(false);
    }
  };

  const abrirNovaTarefa = () => {
    setCliente(null);
    setBusca(''); setResultados([]);
    setAbrirPicker(true);
  };

  if (!podeGerir) return <Navigate to="/" replace />;

  return (
    <div className="container py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl">Tarefas que criei</h1>
        <Button onClick={abrirNovaTarefa}>Nova tarefa</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : tarefas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Você ainda não criou nenhuma tarefa.</p>
      ) : (
        <ul className="space-y-2">
          {tarefas.map(t => (
            <li key={t.id}>
              <Card className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{t.descricao}</p>
                  <p className="text-2xs text-muted-foreground">
                    {t.categoria} · vence {t.effective_due} · resp. {t.responsavel_efetivo.slice(0, 8)}
                    {t.conclusao_origem && ` · concluída (${t.conclusao_origem})`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {t.status === 'aberta' && t.atrasada && <Badge variant="destructive">atrasada</Badge>}
                  {t.escalado_em && <Badge variant="outline">escalada</Badge>}
                  {t.tem_sugestao_pendente && <Badge>sugestão</Badge>}
                  {t.status === 'concluida' && <Badge variant="secondary">concluída</Badge>}
                  {t.status === 'cancelada' && <Badge variant="outline">cancelada</Badge>}
                  {t.status === 'aberta' && (
                    <Button size="sm" variant="ghost" onClick={() => {
                      const motivo = window.prompt('Motivo do cancelamento?');
                      if (motivo) cancelar(t.id, motivo);
                    }}>Cancelar</Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* Passo 1: escolher cliente + vendedora responsável + empresa */}
      <Dialog open={abrirPicker} onOpenChange={setAbrirPicker}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Nova tarefa — escolher cliente</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Vendedora responsável</label>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione a vendedora" /></SelectTrigger>
                <SelectContent>
                  {salespeople.map(s => (
                    <SelectItem key={s.user_id} value={s.user_id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium">Empresa</label>
              <Select value={empresa} onValueChange={setEmpresa}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="oben">Oben Comercial</SelectItem>
                  <SelectItem value="colacor">Colacor</SelectItem>
                  <SelectItem value="colacor_sc">Colacor SC</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium">Cliente</label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Buscar cliente..." value={busca}
                  onChange={e => setBusca(e.target.value)} className="pl-9 h-9"
                  disabled={!assignedTo} />
              </div>
              {!assignedTo && <p className="text-2xs text-muted-foreground mt-1">Escolha a vendedora primeiro.</p>}
              {(buscando || resolvendo) && <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin" /></div>}
              {resultados.length > 0 && (
                <div className="border rounded-lg mt-1 max-h-60 overflow-y-auto">
                  {resultados.map((c, idx) => (
                    <button key={`${c.user_id || c.omie_codigo_cliente || c.documento}-${idx}`}
                      onClick={() => selecionarCliente(c)}
                      disabled={resolvendo}
                      className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm border-b last:border-b-0 disabled:opacity-50">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium truncate">{c.nome}</p>
                        {c.omie_codigo_cliente && <Badge variant="outline" className="text-[10px] shrink-0">Omie</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {[c.documento, c.telefone, c.email].filter(Boolean).join(' · ') || 'Sem contato'}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Passo 2: detalhes da(s) tarefa(s) — dialog já existente */}
      <CriarTarefaDialog
        open={abrirCriar}
        onOpenChange={(o) => { setAbrirCriar(o); if (!o) setCliente(null); }}
        cliente={cliente}
        assignedTo={assignedTo}
        empresa={empresa}
      />

    </div>
  );
}
