import type { APIRoute } from 'astro'
import { GUIDE_GROUPS, GUIDE_PAGES, markdownUrl } from '../guide'

export const GET: APIRoute = ({ site }) => {
  const section = (group: (typeof GUIDE_GROUPS)[number]) =>
    GUIDE_PAGES.filter((page) => page.group === group).map(
      (page) => `- [${page.title}](${new URL(markdownUrl(page.id), site)}): ${page.description}`,
    )
  const text = [
    '# Curb',
    '',
    '> Curb is a React framework for voice agents: the tree you render becomes the LLM context and tools.',
    '',
    `Everything on one page: ${new URL('/llms-full.txt', site)}`,
    '',
    ...GUIDE_GROUPS.flatMap((group) => [`## ${group}`, ...section(group), '']),
  ].join('\n')
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
