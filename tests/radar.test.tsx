import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Radar',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
} as never

test('a tool call shows in the "Now" tab and tabs switch', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const clock = mock.clock(on)
  await $.command.run({ command: 'panel', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    expect((await ui.find({ key: 'now' }))?.props.label).toBe('Now')

    await $.tool.call({ tool: 'Read', file_path: '/tmp/demo.ts' } as never)
    await clock.advance(400)
    expect((await ui.find({ text: /Read/ }))?.text).toMatch(/demo\.ts/)

    await ui.press({ key: 'context' })
    expect(await ui.find({ text: /Where the context goes|Loading/ })).toBeDefined()
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})

test('the "Loaded" tab draws sections and groups fold', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    await ui.press({ key: 'loaded' })
    const drawn = await ui.find({ text: /Instructions|Loading/ })
    expect(drawn).toBeDefined()
    if (drawn?.text.includes('Instructions')) {
      expect((await ui.find({ key: 'tools:all' }))?.text).toMatch(/show list/)
      await ui.press({ key: 'tools:all' })
      expect((await ui.find({ key: 'tools:all' }))?.text).toMatch(/hide list/)
      await ui.press({ key: 'tools:all' })
    }
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})

test('the "History" tab draws and keeps the tabs reachable', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    await ui.press({ key: 'history' })
    expect((await ui.find({ key: 'history' }))?.props.variant).toBe('primary')
    expect(await ui.find({ text: /History|Skills|Tools|Unused/ })).toBeDefined()
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})
