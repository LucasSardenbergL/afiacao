import eventosComerciaisRaw from './eventos-comerciais.md?raw';
import type { HelpModule } from '@/lib/help-utils';

/**
 * Registry of help modules. Add new entries here as more `.md` files are created.
 */
export const helpModules: HelpModule[] = [
  {
    slug: 'eventos-comerciais',
    title: 'Eventos Comerciais',
    content: eventosComerciaisRaw,
  },
];

export function getHelpModule(slug: string): HelpModule | undefined {
  return helpModules.find((m) => m.slug === slug);
}

export const defaultHelpModule = helpModules[0];
