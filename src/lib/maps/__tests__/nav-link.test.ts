import { describe, it, expect } from 'vitest';
import { navLink } from '../nav-link';

describe('navLink', () => {
  it('com coords → Waze por lat/lng', () => {
    expect(navLink('Rua X, 10, Divinópolis, MG', -20.1, -44.9))
      .toBe('https://waze.com/ul?ll=-20.1,-44.9&navigate=yes');
  });
  it('sem coords mas com endereço → Waze por query', () => {
    expect(navLink('Rua X, 10, Divinópolis, MG', null, null))
      .toBe('https://waze.com/ul?q=Rua%20X%2C%2010%2C%20Divin%C3%B3polis%2C%20MG&navigate=yes');
  });
  it('sem coords e sem endereço → null', () => {
    expect(navLink(null)).toBeNull();
    expect(navLink('   ')).toBeNull();
    expect(navLink('', null, null)).toBeNull();
  });
});
