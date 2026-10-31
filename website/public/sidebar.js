/* Keeps the docs sidebar as the reader left it from page to page. It loads before the first paint,
   so nothing flickers; without it, or without storage, each page opens with the defaults. */
;(() => {
  const SECTIONS = 'curb-docs-sections'
  const SCROLL = 'curb-docs-sidebar-scroll'
  const read = (key) => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }
  const write = (key, value) => {
    try {
      window.sessionStorage.setItem(key, value)
    } catch {
      // Storage is off: the sidebar still works, and each page opens with the defaults.
    }
  }

  const sections = JSON.parse(read(SECTIONS) ?? '{}')
  for (const section of document.querySelectorAll('.docs-section')) {
    const { group } = section.dataset
    const holdsThisPage = section.querySelector('[aria-current]') !== null
    if (!holdsThisPage && group in sections) section.open = sections[group]
    section.addEventListener('toggle', () => {
      sections[group] = section.open
      write(SECTIONS, JSON.stringify(sections))
    })
  }

  const nav = document.querySelector('.docs-nav')
  if (nav) {
    nav.scrollTop = Number(read(SCROLL) ?? 0)
    window.addEventListener('pagehide', () => write(SCROLL, String(nav.scrollTop)))
  }
})()
