# mods

Claude Code mods: plugins of function hooks that draw inside a terminal
session.

| Mod | What it does |
|---|---|
| `cw-chart` | `/cw-chart <widget.json>` opens a CloudWatch metric widget in a pane. The pane has 1h/6h/24h ranges, pan, refresh, and a strip you click to put a timestamp in the prompt. A widget with a fixed `start`/`end` opens as that window. Without them, or after you pick a range, it is live and re-fetches every minute. |
| `image-mirror` | Draws each PNG that Claude reads inline in the transcript, under its Read row. |

## Install

At the prompt of a terminal session:

```
/plugin install cw-chart --marketplace voitta-ai/mods
/plugin install image-mirror --marketplace voitta-ai/mods
```

Answer `y` to add the marketplace, then choose a scope.

## Requirements

- Pictures need a terminal with the kitty graphics protocol (kitty, Ghostty).
  Other terminals show the picture's alt text.
- `cw-chart` runs `aws cloudwatch get-metric-widget-image` with your default
  AWS credentials. They need `cloudwatch:GetMetricWidgetImage`.

## Developing

Run a mod from its folder with `claude --plugin-dir <mod folder>`, or link it
into the session's dev-mods folder for hot reload. Check a mod with
`claude plugin validate <mod folder>`. CI runs the same check on every push
and pull request.

## Releasing

A mod's `version` in its `.claude-plugin/plugin.json` is the cache key that
installs use. A PR that changes a mod must bump that mod's version, or CI
fails the PR. When the PR merges, CI tags `<mod>-v<version>` and creates a
GitHub release. The release notes are the titles of the merged PRs, so write
each PR title as a release note.

## License

MIT
