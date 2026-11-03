# Design

The phone receives one file while its user watches a terminal; the desktop page helps set up the transfer.

## Sources

- [web/style.css](web/style.css): tokens, component sizes, themes and responsive layout.
- [web/index.html](web/index.html) and [web/setup.js](web/setup.js): page structure and setup flow.
- [web/view.js](web/view.js) and [web/metrics.js](web/metrics.js): states, controls, hints and exact copy.
- [test/receiver.test.ts](test/receiver.test.ts): interaction cases and page checks.
- [docs/web.md](docs/web.md): receiver use, storage and diagnostics.

## Brand

A quiet tool next to a terminal: neutral gray in light and dark, one signal hue, no decoration.
The black-and-white lens-and-grid icon is identity ([tools/icons.ts](tools/icons.ts)); green signals recognition or completion. Actions use neutral colors. The camera stays dark in both themes.

## Product goals

- Fit iPhone SE Safari's 375×553 viewport without scrolling; keep primary actions within one-hand reach. Landscape puts the camera beside the controls.
- On desktop, show four setup steps: Download, Send, Open the receiver, Receive. Fit without scrolling from 1024×700; smaller windows may scroll.
- Keep controls in place across states. Disable unavailable actions and reserve space for hints so feedback never moves the buttons.
- Keep the product focused on one file: no file manager or upload. Desktop camera access is a testing override, not the main flow.

## Interaction states

The state model and button rules live in [web/view.js](web/view.js), covered by [test/receiver.test.ts](test/receiver.test.ts).
Keep state feedback on one strip, with text and symbols as well as color. Explain unavailable actions and the next step in the hint or error line.
Completion means a verified file is available; starting a download does not prove it was saved. User-facing behavior is described in [docs/web.md](docs/web.md#2-states).

## Accessibility

Touch targets are at least 44 px; main action buttons are 52 px. Enabled text must meet 4.5:1 contrast in both themes.
Support keyboard focus, accessible names for icon buttons and announced status changes. Never communicate state through color alone.

## Content voice

Use short, concrete English in sentence case. Name the next action rather than the mechanism. No “please” or exclamation marks.
Keep exact wording in the UI code.

## Implementation constraints

Use browser-native ES modules, CSS custom properties, system fonts and inline SVG. No frontend build step or CSS framework; the receiver must work from its offline cache.
