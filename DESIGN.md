# Design

## Source of truth

- Status: Active · 2026-11-02. The tokens are shipped; the layout, components, desktop page and
  English copy below are the target that the next changes implement.
- Scope: the receiver page (`web/`) on phones and the setup page on desktops. The sender CLI's
  terminal output is specified in `docs/cli.md`.
- Tokens: `web/style.css` `:root` is the canonical value of every color and spacing token. This
  document names the roles; when the two disagree, the stylesheet wins and this file is updated in
  the same change.
- Mockups: the "DiodeCam screens" canvas (private) holds one artboard per state in both modes.
- References: iOS camera and code-scanner views for the viewfinder; hardware-wallet animated-QR
  scanners (progress fills frame by frame, a stalled bar means "change angle or distance") for the
  progress and hint pattern; VS Code's status bar for "same strip, color changes with state".

## Brand

A quiet tool that sits next to a terminal. Neutral gray in light and dark, one signal hue, no
decoration. The grid-finder motif from the frame's corner marks is the icon.

## Product goals

| Goal | Done when |
| --- | --- |
| Receive a file with one hand while watching a terminal | Everything fits in iPhone SE Safari's 375×553 without scrolling; the thumb never hunts for a button |
| The phone is the receiver, the desktop is the setup | A desktop visitor sees install steps, downloads and a QR; a phone visitor sees the camera |
| Nothing moves | Controls keep position and size across every state; only fill, text and enablement change |
| The air-gapped path is the default | Download + sha256 + offline verify comes before the `curl` one-liner |

Non-goals: a desktop camera receiver; a general file manager; any upload.

## Personas and jobs

An engineer at an SSH terminal on an isolated server wants one file on their phone. They install
the sender on the server, point the phone at the terminal, and save the result, usually while
still looking at the terminal rather than the phone.

## Information architecture

```text
Phone (portrait, one screen)
  header      title · [sender] [reset] [info]        44 px, icon buttons, no borders
  camera      fills the remaining height             guides, detected outline, progress ring
  file        name · size                            22 px
  progress    4 px bar
  status      ○ Idle | ● Receiving | ✓ Received | ✕ Error   28 px strip, color = state
  hint        one line, always reserved              20 px
  actions     [Start/Stop] [Download] [Share · Save] 52 px
Phone (landscape): camera left, the rest in a 250 px column on the right.
Sheets (from the bottom): Get the sender · Stats and diagnostics / camera picker.

Desktop (pointer: fine, hover: hover)
  1 Install the sender   target picker · air-gapped (default) · internet
  2 Send                 the command
  3 Receive on a phone   QR · add-to-home-screen · practice screen
  footer                 version · "uploads nothing" · policy note
```

## Design principles

| Principle | Applied |
| --- | --- |
| Fixed layout | Every control exists in every state. Unavailable = disabled, never hidden. Buttons always carry a 1 px border (same as the fill when filled) so enabling changes no size. |
| One hue, one meaning | Green means "the grid is being read" (camera outline, ring) and "complete" (status, ✓). Nothing else is green. Actions are inverted gray, never a hue. |
| State on the strip | The status strip keeps its place and changes color: gray idle, inverted receiving, green done, red error. |
| Camera is always dark | Guides, ring and outline use the dark tokens in both modes so they read against the video. |
| Say why | A disabled control's reason is the hint line: "Share · Save turns on when the file is complete". |
| Reserve the line | The hint line is always 20 px tall, so a hint appearing never shifts the buttons. |

## Visual language

Neutral gray ramp (Tailwind `neutral`, MIT) in two modes following `prefers-color-scheme`; light is
the desktop default. System sans for UI, `ui-monospace` for commands. Sizes 13 / 15 / 16 / 17 on
the phone, 14 / 15 / 18 / 26 on the desktop. Spacing on an 8 px grid (4 for hairlines). Radii: 4
progress bar · 8 status strip, icon buttons · 10 buttons, inputs, code · 12 camera, cards · 16
sheet top · full circle only for the ring, step badges and pills. No shadows: a sheet dims what is
behind it (35 % light, 60 % dark). Borders are 1 px structural lines only; 2 px is reserved for
keyboard focus and the detected-grid outline.

Roles (values in `web/style.css`): `bg`, `panel`, `surface`, `line`, `text`, `text-2`, `muted`,
`disabled`, `link`, `invert-bg`/`invert-text` (primary action and the receiving strip), `secondary`,
`signal` (green on the camera), `done`, `warn`, `bad`, `camera`.

## Components

- Icon button: 44×44, no border, `text` color; `disabled` color when unavailable.
- Primary button: `invert-bg` fill, `invert-text`, 1 px border in the fill color.
- Secondary button: `secondary` fill, `text`, 1 px border in the fill color.
- Disabled button: transparent, 1 px `line` border, `disabled` text.
- Status strip: 28 px, radius 8, text 13 px; background by state (see principles).
- Progress bar: 4 px, `line` track, `invert-bg` fill; `done` when complete.
- Progress ring: 84 px over the camera, `signal` arc, dark inner disc, 20 px label.
- Camera guides: four 26 px corners, 2 px, `#4a4a4a` idle, `signal` when a grid is detected.
- Sheet: radius 16 on top, handle, title row with a close icon button, 44 px rows.
- Code box: `surface` background, 1 px `line`, mono 13 px, a `Copy` button that never shrinks.

## Accessibility

Touch targets ≥ 44 px, action buttons 52 px. Text contrast ≥ 4.5:1 in both modes for every
enabled text role (`muted`, `warn`, `done`, `bad` on `bg`; strip text on each strip color); disabled
controls are exempt by WCAG and sit at about 3:1 so they still read. State is never
color alone: the strip carries ○ ● ✓ ✕ and words. Focus is a 2 px outline in `text`. Every icon
button has an `aria-label`; the status strip is `role="status"`.

## Responsive behavior

Phone portrait is the base (375×553 fits, larger phones gain camera height only). Landscape
`(orientation: landscape) and (max-height: 540px)` splits camera left / column right. Desktop is
`(hover: hover) and (pointer: fine)`: it shows the setup page and no camera; `?receiver=1` forces
the receiver (used by the e2e in desktop Chrome).

## Interaction states

| State | Camera | Strip | Start/Stop | Download | Share · Save | Reset |
| --- | --- | --- | --- | --- | --- | --- |
| Idle | guides, prompt | ○ gray | Start (primary) | disabled | disabled | disabled |
| Receiving | video, outline, ring | ● inverted | Stop (secondary) | disabled | disabled | enabled |
| Done | ✓ disc | ✓ green | Start (secondary) | enabled | enabled (primary) | enabled |
| Error | guides | ✕ red | Start (secondary) | by kept file | by kept file | enabled |

Reset asks once when an unsaved file exists.

## Content voice

English, short, concrete. Sentence case. Name the next action, not the mechanism: "Share · Save
turns on when the file is complete", "Hold the phone sideways for a larger grid", "Save it, then
press q in the terminal". Never "please", never exclamation marks.

## Implementation constraints

No build step and no CSS framework: tokens are custom properties in `web/style.css`, icons are
inline SVG so the page works offline. The service-worker cache stays small, so system fonts only.
Nothing is uploaded; the page never opens the received file.

## Open questions

- Whether the desktop page also offers a built-in practice screen for lens diagnostics without a
  server (planned, not yet designed in detail).
- The QR (`web/qr.svg`, from `tools/qr.ts`) encodes the github.io address; regenerate it if a custom domain is chosen.
