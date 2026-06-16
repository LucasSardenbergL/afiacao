import { describe, it, expect } from 'vitest';
import { fmt, getToolName, formatDuration } from '../helpers';
import { type UserTool } from '../types';

const baseTool: UserTool = {
  id: 't1',
  tool_category_id: 'c1',
  generated_name: null,
  custom_name: null,
  quantity: null,
  tool_categories: null,
};

describe('fmt', () => {
  it('formata como moeda BRL', () => {
    const s = fmt(10);
    expect(s).toContain('R$');
    expect(s).toContain('10,00');
  });
});

describe('getToolName', () => {
  it('prioriza generated_name', () => {
    expect(getToolName({ ...baseTool, generated_name: 'Gerado', custom_name: 'Custom' })).toBe('Gerado');
  });
  it('cai para custom_name', () => {
    expect(getToolName({ ...baseTool, custom_name: 'Custom' })).toBe('Custom');
  });
  it('cai para tool_categories.name', () => {
    expect(getToolName({ ...baseTool, tool_categories: { name: 'Serra' } })).toBe('Serra');
  });
  it('fallback Ferramenta', () => {
    expect(getToolName(baseTool)).toBe('Ferramenta');
  });
});

describe('formatDuration', () => {
  it('formata mm:ss com padding', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(125)).toBe('2:05');
  });
});
