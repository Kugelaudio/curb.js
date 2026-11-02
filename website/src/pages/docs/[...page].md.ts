import type { APIRoute } from 'astro'
import { guideEntries } from '../../guide-entries'

export async function getStaticPaths() {
  return (await guideEntries()).map(({ page, entry }) => ({
    params: { page: page.id === 'readme' ? 'index' : page.id },
    props: { body: entry.body ?? '' },
  }))
}

export const GET: APIRoute = ({ props }) =>
  new Response(props.body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
