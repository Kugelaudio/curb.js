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
    '> Curb is a React and TypeScript framework for production voice agents: the tree you render becomes the LLM context and tools.',
    '',
    'Curb runs on LiveKit Agents. You write an agent as React components, with skills, tools and state in plain code, and test whole conversations from the command line before they ship. It needs Node.js 22.12 or newer. Start a project with `npm create curb.js .`.',
    '',
    `Everything on one page: ${new URL('/llms-full.txt', site)}`,
    '',
    ...GUIDE_GROUPS.flatMap((group) => [`## ${group}`, ...section(group), '']),
  ].join('\n')
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
