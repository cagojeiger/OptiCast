// @ts-check
// The desktop setup page (DESIGN.md): the target picker and the file field rewrite
// the commands, and the copy buttons copy one. Nothing else.

{
  const buttons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.targets button')])
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'))
  let current = 'x86_64-unknown-linux-musl'
  /**
   * The file as typed, so the copied command runs as is: `<FILE>` while empty (a
   * syntax error, so it fails loudly); a leading `~/` left for the shell to expand;
   * `./` in front of a name the CLI or zsh would read as an option (`-V`, `help`,
   * `=x`); single quotes around anything else that is not a plain path.
   */
  const fileArg = () => {
    const f = fileInput.value.trim()
    if (!f) return '<FILE>'
    const home = f.startsWith('~/') ? '~/' : ''
    let rest = f.slice(home.length)
    if (!home && /^(-|=|help$|-h$|-V$|--help$|--version$)/.test(rest)) rest = `./${rest}`
    const quoted = /^[\w./+@:,-]+$/.test(rest) ? rest : `'${rest.replace(/'/g, "'\\''")}'`
    return home + quoted
  }
  /** @param {string} target */
  const choose = (target) => {
    current = target
    const base = `https://github.com/cagojeiger/diodecam/releases/latest/download/diodecam-${target}.tar.gz`
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.target === target))
    const set = (/** @type {string} */ id, /** @type {string} */ text) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    set('cmd-curl', `curl -fsSL ${base} | tar xz`)
    set('cmd-run', `./diodecam-${target}/diodecam send ${fileArg()}`)
    set('cmd-fetch', `curl -fsSLO ${base}\ncurl -fsSLO ${base}.sha256`)
    set('cmd-verify', `sha256sum -c diodecam-${target}.tar.gz.sha256\ntar xzf diodecam-${target}.tar.gz`)
  }
  // The sender runs on the server, usually Linux: x86_64 stays the default; the last choice is remembered.
  const KEY = 'diodecam.target'
  for (const b of buttons)
    b.addEventListener('click', () => {
      choose(b.dataset.target ?? '')
      try {
        localStorage.setItem(KEY, b.dataset.target ?? '')
      } catch {
        // not remembered
      }
    })
  fileInput.addEventListener('input', () => choose(current))
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && buttons.some((b) => b.dataset.target === saved)) choose(saved)
  } catch {
    // not remembered
  }
  // Theme: one button cycles auto → light → dark. A choice is stored and applied before
  // paint by the head script; 'auto' clears it.
  const THEME_KEY = 'diodecam.theme'
  const themeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('theme-btn'))
  const half = /** @type {SVGPathElement} */ (/** @type {unknown} */ (document.getElementById('theme-half')))
  const showTheme = () => {
    const chosen = document.documentElement.dataset.theme ?? 'auto'
    themeBtn.setAttribute('aria-label', `Theme: ${chosen}`)
    themeBtn.title = `Theme: ${chosen} (click to change)`
    // auto: half disc · light: empty ring · dark: full disc
    half.setAttribute('d', chosen === 'auto' ? 'M12 3.5a8.5 8.5 0 0 1 0 17z' : chosen === 'dark' ? 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17z' : '')
    const dark = chosen === 'dark' || (chosen === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', dark ? '#171717' : '#ffffff')
  }
  themeBtn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark']
    const next = order[(order.indexOf(document.documentElement.dataset.theme ?? 'auto') + 1) % order.length] ?? 'auto'
    if (next === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    try {
      if (next === 'auto') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // not remembered
    }
    showTheme()
  })
  showTheme()
  for (const b of /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button.copy')])) {
    b.addEventListener('click', async () => {
      const text = document.getElementById(b.dataset.copy ?? '')?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(text)
        b.textContent = 'Copied'
      } catch {
        // No clipboard: select the command so ⌘C works.
        const pre = document.getElementById(b.dataset.copy ?? '')
        if (pre) getSelection()?.selectAllChildren(pre)
        b.textContent = 'Selected'
      }
      setTimeout(() => (b.textContent = 'Copy'), 2000)
    })
  }
}
