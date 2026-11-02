// @ts-check
// The desktop setup page (DESIGN.md): the target picker rewrites the download
// links and commands, and the copy buttons copy a command. Nothing else.

{
  const buttons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.targets button')])
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'))
  let current = 'x86_64-unknown-linux-musl'
  /** The file as typed, shell-quoted when it needs it; `<FILE>` while empty. */
  const fileArg = () => {
    const f = fileInput.value.trim()
    if (!f) return '<FILE>'
    return /^[\w./+=@:,-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`
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
    set('cmd-run', `curl -fsSL ${base} | tar xz\n./diodecam-${target}/diodecam send ${fileArg()}`)
    set('cmd-fetch', `curl -fsSLO ${base}\ncurl -fsSLO ${base}.sha256`)
    set('cmd-verify', `sha256sum -c diodecam-${target}.tar.gz.sha256\ntar xzf diodecam-${target}.tar.gz`)
    set('cmd-xattr', `xattr -d com.apple.quarantine ./diodecam-${target}/diodecam`)
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
