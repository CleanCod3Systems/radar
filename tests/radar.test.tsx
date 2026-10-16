import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Claude por dentro',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
} as never

test('a tool call shows in the "Ahora" tab and tabs switch', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  const clock = mock.clock(on)
  await $.command.run({ command: 'panel', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    expect((await ui.find({ key: 'now' }))?.props.label).toBe('Ahora')

    await $.tool.call({ tool: 'Read', file_path: '/tmp/demo.ts' } as never)
    await clock.advance(400)
    expect((await ui.find({ text: /Read/ }))?.text).toMatch(/demo\.ts/)

    await ui.press({ key: 'context' })
    expect(await ui.find({ text: /Contexto|Cargando/ })).toBeDefined()
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})

test('the "Cargado" tab draws sections and groups fold', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    await ui.press({ key: 'loaded' })
    const drawn = await ui.find({ text: /Instrucciones|Cargando/ })
    expect(drawn).toBeDefined()
    if (drawn?.text.includes('Instrucciones')) {
      expect(await ui.find({ key: 'tools:all' })).toBeDefined()
      await ui.press({ key: 'tools:all' })
      expect((await ui.find({ key: 'tools:all' }))?.text).toMatch(/ocultar/)
      await ui.press({ key: 'tools:all' })
    }
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})

test('the "Historial" tab draws and keeps the tabs reachable', async ($, on) => {
  on('tool.call', () => ({ result: {} as never }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'radar', surface, component: 'Pane', requestId: 'radar', props: PANE_PROPS })
    await ui.press({ key: 'history' })
    expect((await ui.find({ key: 'history' }))?.props.variant).toBe('primary')
    expect(await ui.find({ text: /Historial|Skills|Herramientas|sin usar/ })).toBeDefined()
    await ui.press({ key: 'now' })
    await ui.unmount()
  }
})
