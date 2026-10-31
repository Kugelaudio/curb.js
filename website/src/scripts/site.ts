/** Tabs, copy buttons and motion. Without JavaScript every panel stays visible and every command stays selectable. */

const moves = window.matchMedia('(prefers-reduced-motion: no-preference)').matches

/** Runs a callback whenever an element enters or leaves the viewport. */
function inView(element: Element, onChange: (visible: boolean) => void): void {
  new IntersectionObserver(([entry]) => onChange(entry!.isIntersecting)).observe(element)
}

function copyButton(button: HTMLButtonElement, text: () => string): void {
  button.hidden = false
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(text()).then(
      () => flash(button, 'Copied'),
      () => flash(button, 'Copy failed'),
    )
  })
}

function flash(button: HTMLButtonElement, label: string): void {
  button.textContent = label
  window.setTimeout(() => (button.textContent = 'Copy'), 1600)
}

function enhanceTabs(root: HTMLElement): void {
  const list = root.querySelector<HTMLElement>('[role="tablist"]')
  if (!list) return
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')]

  const select = (tab: HTMLButtonElement, focus = false): void => {
    for (const other of tabs) {
      const active = other === tab
      other.setAttribute('aria-selected', String(active))
      other.tabIndex = active ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute('aria-controls')
    if (focus) tab.focus()
  }

  list.hidden = false
  root.dataset.enhanced = 'true'
  select(tabs[0]!)
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab))
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (step === 0) return
      event.preventDefault()
      select(tabs[(index + step + tabs.length) % tabs.length]!, true)
    })
  })
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  copyButton(button, () => button.dataset.copy ?? '')
}

for (const pre of document.querySelectorAll<HTMLElement>('.prose pre')) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'copy copy-code'
  button.textContent = 'Copy'
  // The pre scrolls sideways, so the button sits beside it in a box that does not.
  const block = document.createElement('div')
  block.className = 'code-block'
  pre.replaceWith(block)
  block.append(pre, button)
  copyButton(button, () => pre.querySelector('code')?.textContent ?? '')
}

document.querySelectorAll<HTMLElement>('[data-tabs]').forEach(enhanceTabs)

/**
 * Plays a call on a loop while it is in view: the caller speaks, the variable changes, the lines that no
 * longer render are struck out and leave, and the new ones arrive. Choosing a step stops the loop.
 */
function enhanceStory(root: HTMLElement): void {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-step-to]')]
  const lines = [...root.querySelectorAll<HTMLElement>('.live-line')]
  const pause = root.querySelector<HTMLButtonElement>('[data-story-pause]')!
  const values = root.querySelector<HTMLElement>('[data-story-values]')!
  const valueSteps = JSON.parse(values.dataset.storyValues ?? '[]') as [string, string][][]
  const beats = moves ? { call: 900, swap: 1800, next: 4600, rest: 2200 } : { call: 0, swap: 0, next: 0, rest: 0 }
  let timers: number[] = []
  let playing = false
  let visible = false

  const later = (wait: number, run: () => void): void => {
    if (wait === 0) run()
    else timers.push(window.setTimeout(run, wait))
  }
  const stop = (): void => {
    timers.forEach((timer) => window.clearTimeout(timer))
    timers = []
    for (const line of lines) line.classList.remove('is-new', 'is-leaving')
  }
  const mark = (step: number): void => {
    root.dataset.step = String(step)
    buttons.forEach((button, index) => {
      if (index === step - 1) button.setAttribute('aria-current', 'step')
      else button.removeAttribute('aria-current')
    })
  }
  const setValues = (step: number): void => {
    for (const [name, value] of valueSteps[Math.max(step - 1, 0)] ?? []) {
      const shown = values.querySelector<HTMLElement>(`[data-value="${name}"]`)!
      shown.classList.toggle('is-changed', shown.textContent !== value)
      shown.textContent = value
    }
  }
  const swap = (step: number): void => {
    for (const line of lines) {
      line.classList.remove('is-leaving')
      const on = line.dataset.on === String(step)
      line.classList.toggle('is-new', on && !line.classList.contains('is-on'))
      line.classList.toggle('is-on', on)
    }
    root.dataset.lit = String(step)
  }
  const play = (step: number, loop: boolean): void => {
    stop()
    delete root.dataset.clock
    void root.offsetWidth
    root.dataset.clock = String(loop)
    mark(step)
    later(beats.call, () => {
      setValues(step)
      for (const line of lines) if (line.classList.contains('is-on')) line.classList.add('is-leaving')
    })
    later(beats.swap, () => swap(step))
    if (!loop) return
    if (step < buttons.length) later(beats.next, () => play(step + 1, true))
    else later(beats.next + beats.rest, restart)
  }
  const restart = (): void => {
    stop()
    swap(0)
    setValues(0)
    later(600, () => play(1, true))
  }
  const run = (): void => {
    stop()
    delete root.dataset.clock
    if (playing && visible) restart()
  }

  for (const [index, button] of buttons.entries()) {
    button.disabled = false
    button.addEventListener('click', () => {
      playing = false
      pause.textContent = 'Play'
      play(index + 1, false)
    })
  }
  if (!moves) return
  pause.hidden = false
  pause.addEventListener('click', () => {
    playing = !playing
    pause.textContent = playing ? 'Pause' : 'Play'
    run()
  })
  playing = true
  new IntersectionObserver(
    ([entry]) => {
      if (entry!.isIntersecting === visible) return
      visible = entry!.isIntersecting
      run()
    },
    { threshold: 0.2 },
  ).observe(root)
}

document.querySelectorAll<HTMLElement>('[data-story]').forEach(enhanceStory)

if (moves) {
  for (const diagram of document.querySelectorAll('.diagram')) {
    inView(diagram, (visible) => diagram.classList.toggle('is-live', visible))
  }
  for (const playback of document.querySelectorAll<HTMLElement>('[data-playback]')) {
    playback.querySelectorAll<HTMLElement>('.line').forEach((line, index) => line.style.setProperty('--line', String(index)))
    inView(playback, (visible) => playback.classList.toggle('is-playing', visible))
  }
}

/** The docs' table of contents follows the reading position. */
const tocLinks = new Map(
  [...document.querySelectorAll<HTMLAnchorElement>('.docs-toc a[href^="#"]')].map((link) => [decodeURIComponent(link.hash.slice(1)), link]),
)
if (tocLinks.size > 0) {
  const reading = new IntersectionObserver(
    (entries) => {
      const current = entries.find((entry) => entry.isIntersecting)
      if (!current) return
      for (const link of tocLinks.values()) link.removeAttribute('aria-current')
      tocLinks.get(current.target.id)?.setAttribute('aria-current', 'location')
    },
    { rootMargin: '-10% 0px -75% 0px' },
  )
  for (const id of tocLinks.keys()) {
    const heading = document.getElementById(id)
    if (heading) reading.observe(heading)
  }
}
