import { test, expect } from 'claude-code/testing'

test('band draws on the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  const ui = await $.ui.mount({
    plugin: 'burnbaby',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 160 } as never,
  })
  const tree = await ui.drawn()
  expect(JSON.stringify(tree)).toContain('Context')
})

test('details pane draws on the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('session.usage', () => ({ value: { startedAt: 1_699_999_000_000, context: { window: 1_000_000 }, rateLimits: [] } }) as never)
  const ui = await $.ui.mount({
    plugin: 'burnbaby',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'burnbaby',
    props: { title: 'Usage meter', isFocused: false, bodyColumns: 100 } as never,
  })
  expect(JSON.stringify(await ui.drawn())).toContain('PACE')
})
