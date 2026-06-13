// ⚠️ Radix Select NÃO aceita SelectItem com value="" (erro de runtime).
// Usamos sentinels '__todas_ufs__' e '__fila__' para os valores "vazio"
// e convertemos de volta para '' na lógica de set().

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { RadarFiltros as Filtros } from '@/queries/useRadarLista';
import type { PresetRadar } from '@/lib/radar/ui-helpers';

// Sentinel para "todas as UFs" (substitui value="" que Radix rejeita).
const SENTINEL_UF = '__todas_ufs__';
// Sentinel para "fila default / qualquer status ativo" (substitui value="").
const SENTINEL_STATUS = '__fila__';

const UFS = ['MG', 'SP', 'RJ', 'ES', 'PR', 'SC', 'RS', 'GO', 'BA', 'PE', 'CE'];

const STATUS_OPTIONS = [
  { v: SENTINEL_STATUS, label: 'Fila (ativos)' },
  { v: 'a_contatar', label: 'A contatar' },
  { v: 'em_conversa', label: 'Em conversa' },
  { v: 'contatado_sem_resposta', label: 'Não atendeu' },
  { v: 'virou_cliente', label: 'Virou cliente' },
  { v: 'descartado', label: 'Descartados' },
];

export function RadarFiltros({
  filtros,
  set,
}: {
  filtros: Filtros;
  set: (next: Partial<Filtros>) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Presets */}
      <div className="flex gap-2">
        <Button
          variant={filtros.preset === 'novas' ? 'default' : 'outline'}
          size="sm"
          onClick={() => set({ preset: 'novas' as PresetRadar })}
        >
          Novas do lote
        </Button>
        <Button
          variant={filtros.preset === 'estabelecidas' ? 'default' : 'outline'}
          size="sm"
          onClick={() => set({ preset: 'estabelecidas' as PresetRadar })}
        >
          Estabelecidas
        </Button>
      </div>

      {/* Filtros principais */}
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-xs"
          placeholder="Buscar razão social / fantasia…"
          value={filtros.busca}
          onChange={(e) => set({ busca: e.target.value })}
        />

        {/* Select de UF — usa sentinel para o valor "todas" */}
        <Select
          value={filtros.uf || SENTINEL_UF}
          onValueChange={(v) => set({ uf: v === SENTINEL_UF ? '' : v })}
        >
          <SelectTrigger className="w-28">
            <SelectValue placeholder="UF" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SENTINEL_UF}>Todas UFs</SelectItem>
            {UFS.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-36"
          placeholder="Município"
          value={filtros.municipio}
          onChange={(e) => set({ municipio: e.target.value })}
        />

        <Input
          className="w-40"
          placeholder="CNAE (ex.: 3101-2/00)"
          value={filtros.cnae}
          onChange={(e) => set({ cnae: e.target.value })}
        />

        {/* Select de status — usa sentinel para o valor "fila" */}
        <Select
          value={filtros.status || SENTINEL_STATUS}
          onValueChange={(v) => set({ status: v === SENTINEL_STATUS ? '' : v })}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.v} value={s.v}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Toggle incluir já-clientes */}
        <div className="flex items-center gap-2">
          <Switch
            id="radar-ja-clientes"
            checked={filtros.incluirJaClientes}
            onCheckedChange={(checked) => set({ incluirJaClientes: checked })}
          />
          <Label htmlFor="radar-ja-clientes" className="text-sm cursor-pointer">
            Incluir já-clientes
          </Label>
        </div>

        {/* Toggle só com telefone */}
        <div className="flex items-center gap-2">
          <Switch
            id="radar-com-telefone"
            checked={filtros.comTelefone}
            onCheckedChange={(checked) => set({ comTelefone: checked })}
          />
          <Label htmlFor="radar-com-telefone" className="text-sm cursor-pointer">
            Só com telefone
          </Label>
        </div>
      </div>
    </div>
  );
}
