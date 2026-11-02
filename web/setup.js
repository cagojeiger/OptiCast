// @ts-check
// The desktop setup page (DESIGN.md): the target picker rewrites the download
// links and commands, and the copy buttons copy a command. Nothing else.

{
  const buttons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.targets button')])
  /** @param {string} target */
  const choose = (target) => {
    const base = `https://github.com/cagojeiger/diodecam/releases/latest/download/diodecam-${target}.tar.gz`
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.target === target))
    const tar = /** @type {HTMLAnchorElement} */ (document.getElementById('dl-tar'))
    const sha = /** @type {HTMLAnchorElement} */ (document.getElementById('dl-sha'))
    tar.href = base
    sha.href = `${base}.sha256`
    const set = (/** @type {string} */ id, /** @type {string} */ text) => {
      const el = document.getElementById(id)
      if (el) el.textContent = text
    }
    set('cmd-verify', `sha256sum -c diodecam-${target}.tar.gz.sha256\ntar xzf diodecam-${target}.tar.gz`)
    set('cmd-curl', `curl -fsSL ${base} | tar xz`)
    set('cmd-send', `./diodecam-${target}/diodecam send report.pdf`)
  }
  for (const b of buttons) b.addEventListener('click', () => choose(b.dataset.target ?? ''))
  // macOS visitors most likely send from a Mac too.
  if (/Mac/.test(navigator.platform)) choose('aarch64-apple-darwin')
  for (const b of /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button.copy')])) {
    b.addEventListener('click', async () => {
      const text = document.getElementById(b.dataset.copy ?? '')?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(text)
        b.textContent = 'Copied'
      } catch {
        b.textContent = 'Select and copy'
      }
      setTimeout(() => (b.textContent = 'Copy'), 2000)
    })
  }
}
