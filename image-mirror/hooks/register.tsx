import type { Register } from 'claude-code'

// Image takes at most 2 MiB of decoded PNG: 4/3 of that in base64.
const MAX_BASE64 = Math.floor((2 * 1024 * 1024 * 4) / 3)
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
// Columns the tool row's indent takes before the picture.
const INDENT = 8
const MAX_COLUMNS = 100
const MAX_ROWS = 30

type ReadImage = { type?: string; file?: { type?: string; base64?: string } }

// The base64 PNG a Read call returned; undefined for any other tool or result.
const pngOf = (tool: string, output: unknown) => {
  const read = output as ReadImage | null | undefined
  const base64 = read?.file?.base64
  const isPng =
    tool === 'Read' &&
    read?.type === 'image' &&
    read.file?.type === 'image/png' &&
    base64 !== undefined &&
    base64.length <= MAX_BASE64
  const retval = isPng ? base64 : undefined
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
  const retval = { width: Math.max(1, u32(16)), height: Math.max(1, u32(20)) }
  return retval
}

// The cell box that keeps the picture's aspect: as wide as the transcript
// allows, at most MAX_COLUMNS by MAX_ROWS.
const boxFor = (width: number, height: number, viewportColumns: number) => {
  const wide = Math.max(10, Math.min(MAX_COLUMNS, viewportColumns - INDENT))
  const tall = Math.max(1, Math.round((wide * height) / width / CELL_ASPECT))
  const rows = Math.min(MAX_ROWS, tall)
  const columns =
    tall > MAX_ROWS ? Math.max(1, Math.round((rows * width * CELL_ASPECT) / height)) : wide
  const retval = { columns, rows }
  return retval
}

export const register: Register = on => {
  // A run of reads folds into one count line. Unfold a run holding a PNG so
  // each call draws as its own ToolUse row, which the hook below extends.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const hasPng =
      e.surface === 'terminal' &&
      e.props.calls.some(call => pngOf(call.tool, call.output) !== undefined)
    const retval = await next(hasPng ? { ...e, props: { ...e.props, isExpanded: true } } : e)
    return retval
  })

  // A Read row whose result is a PNG: the engine's row, the picture under it.
  on('ui.render', { component: 'ToolUse', props: { tool: 'Read' } }, async ($, e, next) => {
    const base64 = pngOf(e.props.tool, e.props.output)
    let retval = await next(e)
    if (e.surface === 'terminal' && base64 !== undefined) {
      const { Box, Image } = $.ui.resolve(e)
      const { width, height } = sizeOf(base64)
      const { columns, rows } = boxFor(width, height, e.viewport?.columns ?? 80)
      retval = (
        <Box flexDirection="column">
          {retval}
          <Image
            source={{ png: base64 }}
            columns={columns}
            rows={rows}
            alt={`PNG ${width}x${height}`}
          />
        </Box>
      )
    }
    return retval
  })
}
