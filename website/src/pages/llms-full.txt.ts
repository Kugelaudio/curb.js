import type { APIRoute } from 'astro'
import { guideEntries } from '../guide-entries'

export const GET: APIRoute = async () => {
  const text = (await guideEntries()).map(({ entry }) => entry.body ?? '').join('\n\n---\n\n')
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
