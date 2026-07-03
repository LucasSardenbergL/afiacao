import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  usePedidosProgramadosConfig,
  usePedidosProgramadosMutations,
  type PedidoProgramadoConfig,
} from '@/hooks/usePedidosProgramados';

function FormConta({ cfg, onSave, saving }: {
  cfg: PedidoProgramadoConfig;
  onSave: (c: PedidoProgramadoConfig) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => setDraft(cfg), [cfg]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Código do cliente no Omie</Label>
          <Input
            value={draft.codigo_cliente_omie ?? ''}
            onChange={(e) => setDraft({ ...draft, codigo_cliente_omie: e.target.value ? Number(e.target.value) : null })}
            inputMode="numeric"
          />
        </div>
        <div>
          <Label className="text-xs">Código da parcela (Omie, opcional)</Label>
          <Input
            value={draft.codigo_parcela ?? ''}
            onChange={(e) => setDraft({ ...draft, codigo_parcela: e.target.value || null })}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">Observações do pedido (NÃO sai na NF)</Label>
        <Textarea
          rows={6}
          value={draft.obs_venda ?? ''}
          onChange={(e) => setDraft({ ...draft, obs_venda: e.target.value || null })}
        />
      </div>
      <div>
        <Label className="text-xs">
          Dados Adicionais da NF (sai nas informações complementares; o nº do PC é acrescentado automaticamente na frente)
        </Label>
        <Textarea
          rows={6}
          value={draft.dados_adicionais_nf ?? ''}
          onChange={(e) => setDraft({ ...draft, dados_adicionais_nf: e.target.value || null })}
        />
      </div>
      <Button size="sm" onClick={() => onSave(draft)} disabled={saving}>Salvar</Button>
    </div>
  );
}

export function PedidosProgramadosConfigDialog({ children }: { children: React.ReactNode }) {
  const { data: configs } = usePedidosProgramadosConfig();
  const { salvarConfig } = usePedidosProgramadosMutations();
  const porConta = (acc: 'oben' | 'colacor'): PedidoProgramadoConfig =>
    configs?.find((c) => c.account === acc) ?? {
      account: acc,
      codigo_cliente_omie: null,
      customer_user_id: null,
      obs_venda: null,
      dados_adicionais_nf: null,
      codigo_parcela: null,
    };
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">Config — pedidos programados (Lider)</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="oben">
          <TabsList>
            <TabsTrigger value="oben">Oben</TabsTrigger>
            <TabsTrigger value="colacor">Colacor</TabsTrigger>
          </TabsList>
          <TabsContent value="oben">
            <FormConta cfg={porConta('oben')} onSave={(c) => salvarConfig.mutate(c)} saving={salvarConfig.isPending} />
          </TabsContent>
          <TabsContent value="colacor">
            <FormConta cfg={porConta('colacor')} onSave={(c) => salvarConfig.mutate(c)} saving={salvarConfig.isPending} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
