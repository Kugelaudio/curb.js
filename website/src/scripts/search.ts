/** The docs search: `/` or Cmd+K opens it. Without JavaScript the button stays hidden and the sidebar is the way in. */
import { search, snippet, type SearchSection } from '../search-index'

const dialog = document.querySelector<HTMLDialogElement>('[data-search]')
const input = dialog?.querySelector('input')
const results = dialog?.querySelector('ul')
const openers = document.querySelectorAll<HTMLButtonElement>('[data-search-open]')

let sections: Promise<SearchSection[]> | undefined

function load(): Promise<SearchSection[]> {
  sections ??= fetch('/search-index.json').then((response) => {
    if (!response.ok) throw new Error(`The search index answered ${response.status}`)
    return response.json() as Promise<SearchSection[]>
  })
  return sections
}

function links(): HTMLAnchorElement[] {
  return [...(results?.querySelectorAll('a') ?? [])]
}

function select(link: HTMLAnchorElement | undefined): void {
  for (const other of links()) other.removeAttribute('aria-current')
  link?.setAttribute('aria-current', 'true')
  link?.scrollIntoView({ block: 'nearest' })
}

function message(text: string): void {
  const item = document.createElement('li')
  item.className = 'search-empty'
  item.textContent = text
  results?.replaceChildren(item)
}

function show(query: string, hits: SearchSection[]): void {
  if (!query.trim()) return results?.replaceChildren()
  if (hits.length === 0) return message(`Nothing found for “${query}”.`)
  results?.replaceChildren(
    ...hits.map((hit) => {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = hit.url
      const title = document.createElement('strong')
      title.textContent = hit.heading === hit.page ? hit.page : `${hit.page}: ${hit.heading}`
      const line = document.createElement('span')
      line.textContent = snippet(hit, query)
      link.append(title, line)
      link.addEventListener('click', () => dialog?.close())
      item.append(link)
      return item
    }),
  )
  select(links()[0])
}

async function update(): Promise<void> {
  const query = input?.value ?? ''
  try {
    const all = await load()
    if (query === input?.value) show(query, search(all, query))
  } catch (error) {
    sections = undefined
    message('Search could not load. Reload the page to try again.')
    console.error(error)
  }
}

function open(): void {
  dialog?.showModal()
  input?.select()
  void update()
}

function move(step: number): void {
  const all = links()
  const at = all.findIndex((link) => link.hasAttribute('aria-current'))
  select(all[Math.min(Math.max(at + step, 0), all.length - 1)])
}

if (dialog && input) {
  for (const opener of openers) {
    opener.hidden = false
    opener.addEventListener('click', open)
  }
  input.addEventListener('input', () => void update())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      results?.querySelector<HTMLAnchorElement>('a[aria-current]')?.click()
    }
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, [contenteditable]')
    if ((event.key === '/' && !typing) || (event.key === 'k' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      if (!dialog.open) open()
    }
  })
}
