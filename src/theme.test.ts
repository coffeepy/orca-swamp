import { assert, test } from 'orca/testing'
import { contrast, ORCA_STATUS, PALETTES, paletteCss, parseThemeId, TOKENS, type Token } from './theme'

// [foreground, background, minimum]: 4.5 where the pair carries body or small text, 3 for icons and large marks.
const PAIRS: [Token, Token, number][] = [
  ...(['panel', 'raised', 'deep', 'ok-bg', 'fail-bg', 'gold-bg'] as const).map((bg): [Token, Token, number] => ['text', bg, 7]),
  ...(['panel', 'raised', 'deep', 'gold-bg', 'fail-bg'] as const).map((bg): [Token, Token, number] => ['muted', bg, 4.5]),
  ['on-accent', 'accent', 4.5],
  ['on-gold', 'gold', 4.5],
  ...(['accent', 'ok', 'fail', 'run', 'gold', 'warm'] as const).flatMap((fg): [Token, Token, number][] => [
    [fg, 'panel', 4.5],
    [fg, 'raised', 4.5]
  ]),
  ['ok', 'ok-bg', 4.5],
  ['fail', 'fail-bg', 4.5],
  ['gold', 'gold-bg', 4.5],
  ['dim', 'panel', 2.5],
  ['dim', 'deep', 2.5]
]

test('every theme keeps text, buttons and status colors readable', () => {
  const low = Object.entries(PALETTES).flatMap(([id, p]) =>
    PAIRS.map(([fg, bg, min]) => ({ id, fg, bg, min, ratio: contrast(p.tokens[fg], p.tokens[bg]) }))
      .filter((x) => x.ratio < x.min)
      .map((x) => `${x.id}: ${x.fg} on ${x.bg} is ${x.ratio.toFixed(2)}, needs ${x.min}`)
  )
  assert.deepEqual(low, [])
})

test('contrast matches WCAG for black on white', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21)
  assert.equal(contrast('#777777', '#777777'), 1)
})

test('each palette sets every token as a hex color', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const t of TOKENS) assert.match(p.tokens[t], /^#[0-9a-f]{6}$/, `${id} ${t}`)
    assert.ok(paletteCss().includes(`[data-theme="${id}"] { color-scheme: ${p.mode};`))
  }
})

test('an unknown or missing saved theme falls back to following Orca', () => {
  assert.equal(parseThemeId('bayou'), 'bayou')
  assert.equal(parseThemeId('neon'), 'orca')
  assert.equal(parseThemeId(undefined), 'orca')
})

test('Follow Orca keeps status colors readable on a light and a dark Orca background', () => {
  const low = (['light', 'dark'] as const).flatMap((mode) => {
    const c = ORCA_STATUS[mode]
    const bg = mode === 'light' ? '#ffffff' : '#0a0a0a'
    return [...(['ok', 'fail', 'run', 'gold', 'warm'] as const).map((k) => [k, c[k], bg] as const), ['onGold', c.onGold, c.gold] as const]
      .filter(([, fg, b]) => contrast(fg, b) < 4.5)
      .map(([k, fg, b]) => `${mode}: ${k} ${fg} on ${b} is ${contrast(fg, b).toFixed(2)}`)
  })
  assert.deepEqual(low, [])
})
