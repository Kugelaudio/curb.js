import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'

/** The agent guide is the only source of the docs. */
export const GUIDE_DIR = '../packages/framework/docs/agent-guide'

export const collections = {
  guide: defineCollection({ loader: glob({ pattern: '**/*.md', base: GUIDE_DIR }) }),
  changelog: defineCollection({ loader: glob({ pattern: 'CHANGELOG.md', base: '..' }) }),
}
