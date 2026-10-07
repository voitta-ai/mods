export type Chart = {
  title: string
  /** The CloudWatch metric widget as JSON text; each render sets its start and end. */
  widget: string
  rangeMs: number
  /** The window's end, ms since the epoch; null follows now and refreshes every minute. */
  endMs: number | null
  /** The last good render, a base64 PNG. */
  png: string | null
  renderedAt: number | null
  /** Why the last render failed. */
  error: string | null
  isRendering: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cw-chart': { chart: Chart | null }
  }
}
