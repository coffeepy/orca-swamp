// Every CSS variable the panel styles through. A palette missing one is a type error.
export const TOKENS = [
  'panel', 'raised', 'deep', 'border', 'border-strong', 'text', 'muted', 'dim', 'dim-fill',
  'accent', 'on-accent', 'ring', 'ok', 'ok-bg', 'fail', 'fail-bg', 'run', 'gold', 'gold-bg', 'on-gold', 'warm'
] as const
export type Token = (typeof TOKENS)[number]
export type Palette = { label: string; blurb: string; mode: 'dark' | 'light'; tokens: Record<Token, string> }

// Meanings hold in every palette: ok is green, fail red, run blue, gold waits on a person.
export const PALETTES = {
  swamp: {
    label: 'Swamp',
    blurb: 'Moss and lantern light',
    mode: 'dark',
    tokens: {
      panel: '#111c15', raised: '#16241b', deep: '#0b130e', border: '#25392c', 'border-strong': '#3a5443',
      text: '#e2ead6', muted: '#97ab92', dim: '#5d7362', 'dim-fill': '#2f4536',
      accent: '#9bd36a', 'on-accent': '#0e1a08', ring: '#9bd36a',
      ok: '#7cc95a', 'ok-bg': '#16261a', fail: '#f2775f', 'fail-bg': '#2a1612', run: '#6cc4e0',
      gold: '#e3b341', 'gold-bg': '#231f0e', 'on-gold': '#1a1405', warm: '#d9a35b'
    }
  },
  bayou: {
    label: 'Bayou Night',
    blurb: 'Black water, lavender moon',
    mode: 'dark',
    tokens: {
      panel: '#0a1417', raised: '#112026', deep: '#060d10', border: '#1d343d', 'border-strong': '#2f5260',
      text: '#dce8ec', muted: '#8eaab4', dim: '#557582', 'dim-fill': '#1b313a',
      accent: '#b8b0f7', 'on-accent': '#17123d', ring: '#b8b0f7',
      ok: '#5fd3a0', 'ok-bg': '#0d2724', fail: '#ff7f8a', 'fail-bg': '#2a1219', run: '#6fb2ff',
      gold: '#f2c55c', 'gold-bg': '#241f10', 'on-gold': '#1c1505', warm: '#e8a06e'
    }
  },
  peat: {
    label: 'Peat Bog',
    blurb: 'Dark earth and fireflies',
    mode: 'dark',
    tokens: {
      panel: '#19130f', raised: '#231a14', deep: '#110c09', border: '#3a2b20', 'border-strong': '#56412f',
      text: '#f0e4d2', muted: '#b9a28b', dim: '#7c6654', 'dim-fill': '#35281e',
      accent: '#d9ef5b', 'on-accent': '#1d2104', ring: '#d9ef5b',
      ok: '#9fcf67', 'ok-bg': '#1d2213', fail: '#f06c5b', 'fail-bg': '#2d1511', run: '#86b9ea',
      gold: '#f3b23b', 'gold-bg': '#2a1e0c', 'on-gold': '#1f1403', warm: '#e58a4e'
    }
  },
  lily: {
    label: 'Lily Pad',
    blurb: 'Leaf paper, deep green ink',
    mode: 'light',
    tokens: {
      panel: '#f2f6ea', raised: '#fbfdf6', deep: '#e7eedc', border: '#cfdcc2', 'border-strong': '#a3b996',
      text: '#1b2c1d', muted: '#4b614c', dim: '#7c927b', 'dim-fill': '#d9e4cd',
      accent: '#2d7a37', 'on-accent': '#ffffff', ring: '#2d7a37',
      ok: '#23763a', 'ok-bg': '#e1f0d9', fail: '#bb3626', 'fail-bg': '#fae6e0', run: '#1c67a8',
      gold: '#8f6200', 'gold-bg': '#f8eecd', 'on-gold': '#ffffff', warm: '#a65522'
    }
  },
  // From swamp-club/swamp-themes (swamp-hud): Tailwind 400 accents on near-black, cyan as the HUD primary.
  club: {
    label: 'Swamp Club',
    blurb: 'Neon HUD on black glass',
    mode: 'dark',
    tokens: {
      panel: '#0a0a0a', raised: '#1a1a1a', deep: '#050505', border: '#262626', 'border-strong': '#374151',
      text: '#d1d5db', muted: '#9ca3af', dim: '#4b5563', 'dim-fill': '#262626',
      accent: '#22d3ee', 'on-accent': '#0a0a0a', ring: '#22d3ee',
      ok: '#4ade80', 'ok-bg': '#0d1f14', fail: '#f87171', 'fail-bg': '#2a1212', run: '#60a5fa',
      gold: '#fbbf24', 'gold-bg': '#231c0a', 'on-gold': '#0a0a0a', warm: '#fb923c'
    }
  }
} satisfies Record<string, Palette>

// Follow Orca keeps Orca's own surfaces; these status hues sit on them, one set per Orca mode.
const ORCA_DARK = { ok: '#3fb950', fail: '#f85149', run: '#58a6ff', gold: '#e3b341', warm: '#d98a5b', onGold: '#1a1405' }
const ORCA_LIGHT = { ok: '#1a7f37', fail: '#cf222e', run: '#0969da', gold: '#9a6700', warm: '#bc4c00', onGold: '#ffffff' }
export const ORCA_STATUS = { dark: ORCA_DARK, light: ORCA_LIGHT }

export type PaletteId = keyof typeof PALETTES
export type ThemeId = 'orca' | PaletteId
export const THEME_IDS: readonly ThemeId[] = ['orca', ...(Object.keys(PALETTES) as PaletteId[])]

export const parseThemeId = (x: unknown): ThemeId => (THEME_IDS.includes(x as ThemeId) ? (x as ThemeId) : 'orca')

/** Each palette as a `[data-theme]` rule that overrides the Orca-mapped `:root` tokens. */
export const paletteCss = (): string =>
  Object.entries(PALETTES)
    .map(([id, p]) => `:root[data-theme="${id}"] { color-scheme: ${p.mode}; ${TOKENS.map((t) => `--${t}: ${p.tokens[t]};`).join(' ')} }`)
    .join('\n')

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
