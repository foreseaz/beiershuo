/**
 * The opening screen lives in index.html (#boot, styled there), so it shows before any script arrives. Its stage is
 * kept on <html data-boot>:
 *  - loading: the boot's seven points breathe, and the app keeps the map and its controls out of sight.
 *  - unfolding: the map has drawn its first frame. The points swell and fade while the nebulae spread to their places,
 *    then the titles, the sub-topics and the controls come in (styles.css). After that the boot is removed.
 *  - failed: the data didn't load; the boot stays, still, with the reason.
 */
const root = document.documentElement
// Long enough for the last entrance in styles.css (the sub-topic labels) to finish.
const UNFOLDING_MS = 2600

export function finishBoot() {
  if (root.dataset.boot !== 'loading') return
  root.dataset.boot = 'unfolding'
  window.setTimeout(() => {
    document.getElementById('boot')?.remove()
    delete root.dataset.boot
  }, UNFOLDING_MS)
}

export function failBoot(message: string) {
  if (!root.dataset.boot) return
  const text = document.querySelector('#boot .boot-text')
  if (text) text.textContent = message
  root.dataset.boot = 'failed'
}
