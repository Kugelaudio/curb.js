import type { APIRoute } from 'astro'
import { render } from 'astro:content'
import { pageUrl } from '../guide'
import { guideEntries } from '../guide-entries'
import { sectionsOf } from '../search-index'

export const GET: APIRoute = async () => {
  const entries = await guideEntries()
  const pages = await Promise.all(
    entries.map(async ({ page, entry }) => {
      const { headings } = await render(entry)
      return sectionsOf(page.title, pageUrl(page.id), entry.body ?? '', headings)
    }),
  )
  return new Response(JSON.stringify(pages.flat()), { headers: { 'Content-Type': 'application/json' } })
}
