import { expect, mock, test } from 'claude-code/testing'

const progress = {
  runId: 'r-1', label: 'PR #412', size: 'quick', agents: 3, startedAt: new Date(Date.now() - 60000).toISOString(),
  phases: [
    { name: 'gather', status: 'done' }, { name: 'read-code', status: 'done' }, { name: 'explore', status: 'active', pct: 62 },
    { name: 'verdicts', status: 'pending' }, { name: 'refute', status: 'pending' }, { name: 'clean-up', status: 'pending' },
  ],
  active: [{ persona: 'customer', doing: 'opening /cart' }],
  counts: { checked: 0, passed: 0, passRate: 0, conflicts: 1, product: 0, unspecced: 0, unverified: 0, skipped: 0 },
}

const BAND = {
  plugin: 'baseline', component: 'AbovePrompt', surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

function files(on: any, map: Record<string, string>) {
  const hit = (p: string) => Object.keys(map).find((k) => p.endsWith(k))
  on('fs.exists', ($: any, e: any) => ({ value: !!hit(e.path) }))
  on('fs.read', ($: any, e: any) => { const k = hit(e.path); return k ? { value: map[k] } : { deny: 'missing' } })
  on('session.cwd', () => ({ value: '/work' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
}

test('draws live progress in the band, in the theme colours', async ($, on) => {
  mock.clock(on)
  files(on, {
    '/.baseline/config.json': JSON.stringify({ theme: 'dark' }),
    '/.baseline/active-run': '/work/.baseline/sessions/s/runs/r-1',
    '/runs/r-1/progress.json': JSON.stringify(progress),
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /62%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /opening \/cart/ })).toBeDefined()
  const accent = await ui.find({ type: 'Text', text: /█/ })
  expect(accent?.props?.color).toBe('#7aa7ff')
  await ui.unmount()
})

test('draws nothing of its own with no run', async ($, on) => {
  mock.clock(on)
  files(on, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Baseline/ })).toBeUndefined()
  await ui.unmount()
})
