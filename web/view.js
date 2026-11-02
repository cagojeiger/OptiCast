// @ts-check
// What the receiver shows for a state (DESIGN.md "Interaction states") and what
// `Copy diagnostics` copies (docs/web.md §6). Pure functions of plain objects, so
// they are unit-tested without a browser: main.js gathers the inputs and applies
// the result to the page.

import { HINT_TEXT, formatSeconds, fps, hint, quantile, recognition, thousands, tooLargeText, trim } from './metrics.js?v=__V__'

/** @import { FrameSample, Hint } from './metrics.js' */
/** @import { ReceiverStats } from './wasm.js' */

/**
 * Everything the screen depends on, as plain values.
 * @typedef {object} ViewState
 * @property {boolean} scanning The camera is running.
 * @property {boolean} starting The camera is being opened.
 * @property {string} fatal Why the decoder is gone ('' while it works); only a reload helps.
 * @property {{ text: string, tone: 'warn' | 'bad' } | null} notice What the last action failed on.
 * @property {{ saved: boolean, restored: boolean, at: number, canShare: boolean } | null} offer The verified file on offer.
 * @property {Pick<ReceiverStats, 'meta' | 'done' | 'symbols' | 'too_large' | 'limit'> | null} stats The decoder's last answer.
 * @property {number} resumed Pieces brought back from the saved progress.
 * @property {string} workerError A decoder message that does not stop reception.
 * @property {number | null} rate Tiles read in the recent frames, 0–1.
 * @property {number | null} left Seconds to go at the recent rate.
 * @property {Hint | null} hint The advice for the recent frames.
 * @property {boolean} gridSeen A grid was found in the recent frames.
 */

/** @typedef {'idle' | 'receiving' | 'done' | 'error'} StripState */

/**
 * @typedef {object} View
 * @property {{ state: StripState, label: string, symbols: string, extra: string, right: string }} strip
 * @property {{ text: string, tone: 'ok' | 'warn' | 'bad' | '' }} status The line over the camera.
 * @property {{ text: string, tone: 'ok' | 'warn' | '' }} hint The line under the strip.
 * @property {{
 *   start: { label: 'Start' | 'Stop' | 'Reload', enabled: boolean, primary: boolean },
 *   download: { enabled: boolean, primary: boolean },
 *   share: { enabled: boolean, primary: boolean },
 *   reset: { enabled: boolean },
 * }} buttons Always present; enabled when they can act.
 * @property {number} fraction Progress of the bar and the ring, 0–1.
 * @property {boolean} complete The bar is full and green.
 * @property {boolean} ring The progress ring is over the camera.
 * @property {boolean} tick The ✓ disc is over the camera.
 * @property {boolean} prompt The prompt (icon and status line) is over the camera.
 */

/**
 * The screen for a state: one strip, four colours; the buttons stay in place and only their
 * enablement changes.
 * @param {ViewState} v
 * @returns {View}
 */
export function view(v) {
  const s = v.stats
  const offer = v.offer
  const need = s?.symbols.need ?? null
  const have = s?.symbols.have ?? 0
  const fraction = need ? Math.min(1, have / need) : 0
  const percent = `${Math.floor(fraction * 100)}%`
  const count = `${thousands(have)} / ${need === null ? '?' : thousands(need)}`
  const error = v.notice?.tone === 'bad' || v.fatal !== ''
  const done = !!offer && !v.scanning && !error
  const receiving = v.scanning && !!s?.meta && !s.done

  /** @type {View['strip']} */
  let strip
  if (error) {
    strip = { state: 'error', label: '✕ Error', symbols: '', extra: v.fatal || v.notice?.text || '', right: '' }
  } else if (done && offer) {
    const at = new Date(offer.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    strip = { state: 'done', label: '✓ Received', symbols: 'SHA-256 verified', extra: '', right: `at ${at}` }
  } else if (receiving) {
    const read = v.rate === null ? '' : `${Math.round(v.rate * 100)}% read`
    const resumed = v.resumed > 0 ? ` · ${thousands(v.resumed)} resumed` : ''
    strip = { state: 'receiving', label: '● Receiving', symbols: count, extra: `${read}${resumed}`, right: v.left === null ? percent : `${formatSeconds(v.left)} left` }
  } else {
    const label = v.scanning ? '○ Looking' : s?.meta ? '○ Paused' : '○ Idle'
    strip = { state: 'idle', label, symbols: s?.meta ? count : '', extra: '', right: percent }
  }

  const canShare = !!offer && offer.canShare
  const buttons = {
    // The decoder is gone: Start becomes Reload in the same place (the home-screen app has no reload control).
    start: v.fatal
      ? { label: /** @type {const} */ ('Reload'), enabled: true, primary: !offer }
      : { label: v.scanning ? /** @type {const} */ ('Stop') : /** @type {const} */ ('Start'), enabled: !v.starting, primary: !v.scanning && !offer && !error },
    download: { enabled: !!offer && !receiving, primary: !!offer && !canShare },
    share: { enabled: canShare && !receiving, primary: canShare },
    reset: { enabled: !!offer || !!s?.meta || v.scanning || error },
  }

  // The hint line: the advice while reading, else the reason a control is off.
  const advice = v.scanning && !s?.done ? v.hint : null
  /** @type {View['hint']} */
  let line
  if (advice) line = { text: `⚠ ${HINT_TEXT[advice]}`, tone: advice === 'faster' ? 'ok' : 'warn' }
  else if (v.workerError) line = { text: v.workerError, tone: 'warn' }
  else if (done) line = { text: offer?.saved ? 'Saved. You can start the next file.' : 'Save it, then press q in the terminal', tone: '' }
  else line = { text: v.resumed > 0 ? `${thousands(v.resumed)} pieces resumed from the last session` : 'Share · Save turns on when the file is complete', tone: '' }

  // The line over the camera: the one with the highest priority (docs/web.md §2).
  /** @type {View['status']} */
  let status
  if (v.fatal) status = { text: v.fatal, tone: 'bad' }
  else if (v.notice) status = { text: v.notice.text, tone: v.notice.tone }
  else if (v.starting) status = { text: 'Opening the camera…', tone: '' }
  else if (s?.too_large && !s.meta) status = { text: `${tooLargeText(s.too_large.size, s.limit)} · id ${s.too_large.id}`, tone: 'bad' }
  else if (!v.scanning) {
    const text = offer
      ? offer.restored
        ? 'The file from last time is still here. Save or share it.'
        : 'Received. Save the file.'
      : s?.meta
        ? 'Paused. Start the camera to continue.'
        : 'Start the camera and frame the whole sender screen'
    status = { text, tone: '' }
  } else if (!s?.meta) status = { text: v.gridSeen ? 'Grid found. Waiting for the file header…' : 'Frame the whole sender screen', tone: '' }
  else status = { text: `${thousands(Math.max(0, (need ?? 0) - have))} pieces to go${v.left === null ? '' : ` · about ${formatSeconds(v.left)}`}`, tone: '' }

  return { strip, status, hint: line, buttons, fraction: done ? 1 : fraction, complete: done, ring: receiving, tick: done, prompt: !done }
}

/**
 * Diagnostics since the camera started: where frames stopped, and how good the grids were.
 * @typedef {object} Session
 * @property {number} started performance.now() when the camera started.
 * @property {number} frames Decoder answers.
 * @property {Record<string, number>} stages Answers by the stage the frame stopped at.
 * @property {number} detections
 * @property {number} tracked
 * @property {number} corrected
 * @property {number[]} modules Pixels per module of the grids found (the latest few hundred).
 * @property {number[]} residuals
 * @property {number | null} lastFrame performance.now() of the newest camera frame.
 * @property {{ count: number, ms: number, longest: number, last: { at: number, ms: number }[] }} gaps
 *   Stretches without a camera frame for over 500 ms (a rotation, the camera muted or taken);
 *   `last` holds the latest ten, `at` being when the frames stopped.
 */

/**
 * What main.js hands to `diagnostics`: plain values read off the page, the camera and the decoder.
 * It may hold more than is copied (the decoder's answer names the file); `diagnostics` picks.
 * @typedef {object} DiagnosticsSnapshot
 * @property {string} app
 * @property {string} at ISO time.
 * @property {number} now performance.now() when taken.
 * @property {string} agent
 * @property {boolean} standalone
 * @property {string} viewport
 * @property {string} lens The camera's own name.
 * @property {boolean} manualCamera A camera was chosen under Stats.
 * @property {{ width: number, height: number }} video
 * @property {{ width: number, height: number }} scan
 * @property {MediaTrackSettings | null} settings Read from the track when taken.
 * @property {MediaTrackCapabilities | null} capabilities
 * @property {Session} session
 * @property {boolean} scanning
 * @property {FrameSample[]} frames The recent decoder answers (cut to the last 2 s at `now` here).
 * @property {number[]} captureTimes Camera frame times (cut likewise).
 * @property {number[]} resultTimes Decoder answer times (cut likewise).
 * @property {number} decodeMs
 * @property {ReceiverStats | null} stats
 */

/**
 * What `Copy diagnostics` copies: device, camera and recognition numbers. Never the file's
 * name, content or size, the transfer ID (with the exact size it could identify the file),
 * or device IDs: the fields are picked, not filtered.
 * @param {DiagnosticsSnapshot} d
 */
export function diagnostics(d) {
  /** @param {object | null} o */
  const withoutIds = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'deviceId' && k !== 'groupId')) : null)
  /** @param {number[]} v @param {number} q */
  const at = (v, q) => {
    const x = quantile(v, q)
    return x === null ? null : Math.round(x * 100) / 100
  }
  const s = d.stats
  // The recent windows end at `now`: copied while frames have stopped, they are empty, not stale.
  const frames = trim(d.frames, 2000, d.now)
  const rate = recognition(frames)
  const capture = fps(d.captureTimes.filter((t) => t > d.now - 2000))
  const processed = fps(d.resultTimes.filter((t) => t > d.now - 2000))
  const g = d.session.gaps
  return {
    app: d.app,
    at: d.at,
    agent: d.agent,
    standalone: d.standalone,
    viewport: d.viewport,
    camera: {
      lens: d.lens || null,
      chosen: d.manualCamera ? 'manual' : 'auto',
      video: `${d.video.width}×${d.video.height}`,
      settings: withoutIds(d.settings),
      capabilities: withoutIds(d.capabilities),
    },
    scan: `${d.scan.width}×${d.scan.height}`,
    session: {
      seconds: Math.round((d.now - d.session.started) / 1000),
      frames: d.session.frames,
      stages: d.session.stages,
      grids: d.session.detections,
      tracked: d.session.tracked,
      corrected: d.session.corrected,
      module_px: { p10: at(d.session.modules, 0.1), p50: at(d.session.modules, 0.5), p90: at(d.session.modules, 0.9) },
      residual_p50: at(d.session.residuals, 0.5),
      gaps: {
        count: g.count,
        total_ms: Math.round(g.ms),
        longest_ms: Math.round(g.longest),
        last: g.last.map((x) => ({ at_s: Math.round((x.at - d.session.started) / 100) / 10, ms: Math.round(x.ms) })),
      },
    },
    recent: {
      capture_fps: capture && Math.round(capture),
      process_fps: processed && Math.round(processed),
      decode_ms: Math.round(d.decodeMs * 10) / 10,
      recognition: rate === null ? null : Math.round(rate * 1000) / 1000,
      hint: d.scanning ? hint(frames, d.video.height > d.video.width) : null,
      // How old these numbers are: a copy made while frames had stopped says so.
      last_frame_ms: d.session.lastFrame === null ? null : Math.round(d.now - d.session.lastFrame),
    },
    grid: s?.grid ? { w: s.grid.w, h: s.grid.h, profile: s.grid.profile } : null,
    // Progress only: the transfer ID and exact size together could identify the file.
    transfer: s?.meta
      ? { progress: Math.round((s.symbols.have / (s.symbols.need || 1)) * 100) / 100, foreign: s.foreign, invalid: s.invalid, failed: s.failed, done: s.done }
      : null,
  }
}
