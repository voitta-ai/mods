import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Chart } from '../types'

type Widget = Record<string, unknown>

const PANE = 'cw-chart'
const chart = atom({ plugin: 'cw-chart', key: 'chart' } as const, null)

// The widget size asked of CloudWatch when the spec names none.
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 420
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
const HOUR = 3_600_000
const LIVE_REFRESH_MS = 60_000
// ponytail: guessed plot area of a CloudWatch PNG, as fractions of its width,
// so a click on the strip maps to an approximate time. Exact times need the
// data itself (drawing the chart ourselves).
const PLOT_LEFT = 0.05
const PLOT_RIGHT = 0.95

const iso = (ms: number) => {
  const retval = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return retval
}

const hhmm = (ms: number) => {
  const retval = `${iso(ms).slice(11, 16)}Z`
  return retval
}

const numberOr = (value: unknown, fallback: number) => {
  const retval = typeof value === 'number' ? value : fallback
  return retval
}

const firstLine = (text: string) => {
  const retval = text.trim().split('\n')[0] ?? ''
  return retval
}

const messageOf = (thrown: unknown) => {
  const retval = thrown instanceof Error ? thrown.message : String(thrown)
  return retval
}

// Width and height from the PNG's IHDR chunk: bytes 16-23 of the file, the
// first 32 base64 characters.
const sizeOf = (base64: string) => {
  const head = atob(base64.slice(0, 32))
  const u32 = (at: number) => {
    const value =
      ((head.charCodeAt(at) << 24) |
        (head.charCodeAt(at + 1) << 16) |
        (head.charCodeAt(at + 2) << 8) |
        head.charCodeAt(at + 3)) >>>
      0
    return value
  }
  const retval = { width: u32(16), height: u32(20) }
  return retval
}

// A chart from a widget spec: an absolute start and end give a fixed window,
// anything else the last three hours, live.
const chartOf = (widget: Widget, fallbackTitle: string) => {
  const start = typeof widget.start === 'string' ? Date.parse(widget.start) : Number.NaN
  const end = typeof widget.end === 'string' ? Date.parse(widget.end) : Number.NaN
  const isFixed = Number.isFinite(start) && Number.isFinite(end) && end > start
  const sized = {
    ...widget,
    width: numberOr(widget.width, DEFAULT_WIDTH),
    height: numberOr(widget.height, DEFAULT_HEIGHT),
  }
  const retval: Chart = {
    title: typeof widget.title === 'string' ? widget.title : fallbackTitle,
    widget: JSON.stringify(sized),
    rangeMs: isFixed ? end - start : 3 * HOUR,
    endMs: isFixed ? end : null,
    png: null,
    renderedAt: null,
    error: null,
    isRendering: false,
  }
  return retval
}

// Asks CloudWatch for the chart's window as a PNG. A PNG of another size than
// asked is refused: a 200 with the wrong picture is the failure to catch.
const fetchPng = async ($: EngineInterface, asked: Chart, now: number) => {
  const end = asked.endMs ?? now
  const widget: Widget = {
    ...(JSON.parse(asked.widget) as Widget),
    start: iso(end - asked.rangeMs),
    end: iso(end),
  }
  const region = typeof widget.region === 'string' ? widget.region : 'us-east-1'
  let retval: { png: string | null; error: string | null }
  try {
    const ran = await $.process.run(
      [
        'aws',
        '--no-cli-pager',
        'cloudwatch',
        'get-metric-widget-image',
        '--region',
        region,
        '--metric-widget',
        JSON.stringify(widget),
        '--output-format',
        'png',
        '--query',
        'MetricWidgetImage',
        '--output',
        'text',
      ],
      { timeoutMs: 60_000 },
    )
    const png = ran.stdout.trim()
    const size = ran.exitCode === 0 ? sizeOf(png) : null
    const isExpected =
      size !== null && size.width === widget.width && size.height === widget.height
    if (isExpected) {
      retval = { png, error: null }
    } else if (size === null) {
      retval = { png: null, error: firstLine(ran.stderr) || `aws exited ${ran.exitCode}` }
    } else {
      retval = {
        png: null,
        error: `CloudWatch returned ${size.width}x${size.height}, not ${String(widget.width)}x${String(widget.height)}`,
      }
    }
  } catch (thrown) {
    retval = { png: null, error: messageOf(thrown) }
  }
  return retval
}

// Renders the chart's current window and stores the picture, or why it
// failed, keeping the last good one. A render whose window changed meanwhile
// is dropped; the render the change started lands instead.
const renderChart = async ($: EngineInterface) => {
  const asked = await read($, chart)
  if (asked === null) {
    return
  }
  await update($, chart, c => {
    const retval = c === null ? c : { ...c, isRendering: true }
    return retval
  })
  const now = await $.clock.now()
  const { png, error } = await fetchPng($, asked, now)
  await update($, chart, c => {
    const isStale =
      c === null ||
      c.widget !== asked.widget ||
      c.rangeMs !== asked.rangeMs ||
      c.endMs !== asked.endMs
    const retval = isStale
      ? c
      : { ...c, isRendering: false, renderedAt: now, error, png: png ?? c.png }
    return retval
  })
}

const setWindow = async (
  $: EngineInterface,
  change: (c: Chart, now: number) => Pick<Chart, 'rangeMs' | 'endMs'>,
) => {
  const now = await $.clock.now()
  await update($, chart, c => {
    const retval = c === null ? c : { ...c, ...change(c, now) }
    return retval
  })
  await renderChart($)
}

const live = (rangeMs: number) => () => {
  const retval = { rangeMs, endMs: null }
  return retval
}

// Moves the window by half its length; reaching now goes live again.
const shift = (sign: number) => (c: Chart, now: number) => {
  const end = (c.endMs ?? now) + (sign * c.rangeMs) / 2
  const retval = { rangeMs: c.rangeMs, endMs: end >= now ? null : end }
  return retval
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cw-chart',
      description: 'Open a CloudWatch metric widget JSON file as a live chart pane',
      argumentHint: '<widget.json>',
    })
    $.clock.every(LIVE_REFRESH_MS, () => {
      void (async () => {
        const current = await read($, chart)
        if (current !== null && current.endMs === null) {
          await renderChart($)
        }
      })()
    })
    const retval = await next(e)
    return retval
  })

  on('command.run', { command: 'cw-chart' }, async ($, e) => {
    const path = e.args.trim()
    let retval = { text: 'Usage: /cw-chart <path to a CloudWatch metric widget JSON file>' }
    if (path !== '') {
      try {
        const widget = JSON.parse(await $.fs.read(path)) as Widget
        const opened = chartOf(widget, path.split('/').pop() ?? path)
        await update($, chart, () => opened)
        await $.ui.open({ id: PANE, title: opened.title })
        await renderChart($)
        retval = { text: `Opened ${opened.title} in the chart pane.` }
      } catch (thrown) {
        retval = { text: `cw-chart: ${messageOf(thrown)}` }
      }
    }
    return retval
  })

  // Closing the pane drops the chart, which stops its refresh.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, chart, () => null)
    const retval = await next(e)
    return retval
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const c = await read($, chart)
    let retval: RenderElement
    if (e.surface !== 'terminal' || c === null) {
      const { Text } = $.ui.resolve(e)
      retval = (
        <Text dimColor>
          {c === null ? 'No chart. Run /cw-chart <widget.json>.' : 'The chart draws in the terminal only.'}
        </Text>
      )
    } else {
      const { Box, Button, Image, Text } = $.ui.resolve(e)
      const widget = JSON.parse(c.widget) as Widget
      const width = numberOr(widget.width, DEFAULT_WIDTH)
      const height = numberOr(widget.height, DEFAULT_HEIGHT)
      const columns = Math.max(20, Math.min(255, e.props.bodyColumns))
      const rows = Math.max(4, Math.min(255, Math.round((columns * height) / width / CELL_ASPECT)))
      const end = c.endMs ?? c.renderedAt ?? (await $.clock.now())
      const start = end - c.rangeMs
      const segments = Math.floor(columns / 2)
      const timeAt = (i: number) => {
        const fraction = ((i + 0.5) / segments - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)
        const at = fraction < 0 || fraction > 1 ? null : start + fraction * c.rangeMs
        return at
      }
      const status = [
        c.endMs === null ? 'live, every 60s' : 'fixed window',
        `${hhmm(start)}-${hhmm(end)}`,
        c.renderedAt === null ? 'not rendered yet' : `rendered ${iso(c.renderedAt).slice(11)}`,
        ...(c.isRendering ? ['rendering...'] : []),
      ].join(' | ')
      retval = (
        <Box flexDirection="column">
          {c.png === null ? (
            <Text dimColor>{c.isRendering ? 'Rendering...' : 'No picture yet.'}</Text>
          ) : (
            <Image key="chart" source={{ png: c.png }} columns={columns} rows={rows} alt={c.title} />
          )}
          <Box>
            {Array.from({ length: segments }, (_, i) => {
              const at = timeAt(i)
              const cell =
                at === null ? (
                  <Text>{'  '}</Text>
                ) : (
                  <Box key={`s${i}`}>
                    <Button
                      key={`t${i}`}
                      label=".."
                      plain
                      onPress={async () => {
                        await $.prompt.fill({ text: `[${c.title} @ ${iso(at)}] `, mode: 'insert' })
                      }}
                    />
                    <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
                      <Text inverse>{` ${hhmm(at)} `}</Text>
                    </Box>
                  </Box>
                )
              return cell
            })}
          </Box>
          <Box gap={1}>
            <Button key="r1" label="1h" hotkey="1" onPress={() => setWindow($, live(HOUR))} />
            <Button key="r6" label="6h" hotkey="6" onPress={() => setWindow($, live(6 * HOUR))} />
            <Button key="r24" label="24h" hotkey="d" onPress={() => setWindow($, live(24 * HOUR))} />
            <Button key="back" label="<" hotkey="h" onPress={() => setWindow($, shift(-1))} />
            <Button key="fwd" label=">" hotkey="l" onPress={() => setWindow($, shift(1))} />
            <Button key="refresh" label="refresh" hotkey="r" onPress={() => renderChart($)} />
          </Box>
          <Text dimColor>{status}</Text>
          {c.error !== null && <Text color="red">{c.error}</Text>}
        </Box>
      )
    }
    return retval
  })
}
