// ⚠️ Radix Select NÃO aceita SelectItem com value="" (erro de runtime).
// Usamos sentinels '__todas_ufs__' e '__fila__' para os valores "vazio"
// e convertemos de volta para '' na lógica de set().

import type { ReactNode } from 'react';
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
import { UFS_BR, UFS_ATUACAO, ROTULO_PRESET, type PresetRadar } from '@/lib/radar/ui-helpers';
import type { LoteIngest } from '@/lib/radar/lote-vigente';
import { track } from '@/lib/analytics';
import { RadarBuscaCnae } from '@/components/radar/RadarBuscaCnae';

// Sentinel para "todas as UFs" (substitui value="" que Radix rejeita).
const SENTINEL_UF = '__todas_ufs__';
// Sentinel para "fila default / qualquer status ativo" (substitui value="").
const SENTINEL_STATUS = '__fila__';


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
  lote = null,
  acoes,
}: {
  filtros: Filtros;
  set: (next: Partial<Filtros>) => void;
  /** Lote vigente — só para os sensores dos toggles de lote levarem o mês junto. */
  lote?: LoteIngest | null;
  /** Ações à direita da linha de modos (favoritos). */
  acoes?: ReactNode;
}) {
  const regiao = filtros.regiao ?? 'brasil';
  const escolherRegiao = (r: 'atuacao' | 'brasil') => {
    if (r === regiao) return;
    track('radar.regiao_trocada', { regiao: r, uf: filtros.uf || null });
    set({ regiao: r });
  };
  return (
    <div className="space-y-3">
      {/* Modos de ordenação (rótulo = a ordem que a fila tem) */}
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          variant={filtros.preset === 'score' ? 'default' : 'outline'}
          size="sm"
          onClick={() => set({ preset: 'score' as PresetRadar })}
          title="Ordena pelo score de lead (0–100, recalculado 1×/dia); quem não tem score fica por último"
        >
          {ROTULO_PRESET.score}
        </Button>
        <Button
          variant={filtros.preset === 'novas' ? 'default' : 'outline'}
          size="sm"
          onClick={() => set({ preset: 'novas' as PresetRadar })}
          title="Ordena pela data de abertura na RFB, da mais recente para a mais antiga (não filtra o lote)"
        >
          {ROTULO_PRESET.novas}
        </Button>
        <Button
          variant={filtros.preset === 'estabelecidas' ? 'default' : 'outline'}
          size="sm"
          onClick={() => set({ preset: 'estabelecidas' as PresetRadar })}
          title="Abertas há 5 anos ou mais, por capital social"
        >
          {ROTULO_PRESET.estabelecidas}
        </Button>
        {acoes && <div className="ml-auto flex gap-2">{acoes}</div>}
      </div>

      {/* Filtros principais */}
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-xs"
          placeholder="Buscar razão social / fantasia…"
          value={filtros.busca}
          onChange={(e) => set({ busca: e.target.value })}
        />

        {/* Região: abre em MG e vizinhos (onde está a carteira); Brasil a 1 clique. UF escolhida vence. */}
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Região">
          <Button
            variant={regiao === 'atuacao' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7"
            aria-pressed={regiao === 'atuacao'}
            title={`MG e vizinhos: ${UFS_ATUACAO.join(', ')}`}
            onClick={() => escolherRegiao('atuacao')}
          >
            MG e vizinhos
          </Button>
          <Button
            variant={regiao === 'brasil' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7"
            aria-pressed={regiao === 'brasil'}
            onClick={() => escolherRegiao('brasil')}
          >
            Brasil
          </Button>
        </div>

        {/* Select de UF — usa sentinel para o valor "todas" */}
        <Select
          value={filtros.uf || SENTINEL_UF}
          onValueChange={(v) => set({ uf: v === SENTINEL_UF ? '' : v })}
        >
          <SelectTrigger className="w-28">
            <SelectValue placeholder="UF" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SENTINEL_UF}>{regiao === 'atuacao' ? 'Toda a região' : 'Todas UFs'}</SelectItem>
            {UFS_BR.map((u) => (
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

        <RadarBuscaCnae valor={filtros.cnae} onChange={(cnae) => set({ cnae })} />

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

        {/* Lead sem telefone E sem e-mail não tem por onde ser trabalhado: fica fora por padrão. */}
        <div className="flex items-center gap-2">
          <Switch
            id="radar-sem-contato"
            checked={filtros.incluirSemContato === true}
            onCheckedChange={(checked) => {
              track('radar.sem_contato_toggle', { ativo: checked });
              set({ incluirSemContato: checked });
            }}
          />
          <Label htmlFor="radar-sem-contato" className="text-sm cursor-pointer" title="Inclui quem não tem telefone nem e-mail na RFB">
            Incluir sem contato
          </Label>
        </div>

        {/* Toggle de LOTE: a fila é a FOTO VIGENTE (ultimo_lote = lote vigente); quem saiu do dump só entra
            se pedido. "Só inéditos" e "só sugeridos" são os chips do placar (RadarChipsLote). */}
        <div className="flex items-center gap-2">
          <Switch
            id="radar-saiu-do-dump"
            checked={filtros.incluirSaiuDoDump}
            onCheckedChange={(checked) => {
              track('radar.saiu_do_dump_toggle', { ativo: checked, lote: lote?.mes_referencia ?? null });
              set({ incluirSaiuDoDump: checked });
            }}
          />
          <Label htmlFor="radar-saiu-do-dump" className="text-sm cursor-pointer">
            Incluir quem saiu do dump
          </Label>
        </div>

      </div>
    </div>
  );
}
