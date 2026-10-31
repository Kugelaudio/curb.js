// @ts-check
import { defineConfig } from 'astro/config'
import { codeClasses, curbCodeTheme } from './src/code-theme.ts'
import { rehypeGuideLinks } from './src/guide-links.ts'

// Static output for GitHub Pages at the root of curbjs.com: no base path, so a *.github.io URL breaks.
export default defineConfig({
  site: 'https://curbjs.com',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    // No inline <style>: the CSP in Base.astro has no 'unsafe-inline'.
    inlineStylesheets: 'never',
  },
  markdown: {
    rehypePlugins: [rehypeGuideLinks],
    shikiConfig: { theme: curbCodeTheme, transformers: [codeClasses] },
  },
  vite: {
    build: {
      // No inline assets or scripts, for the same CSP.
      assetsInlineLimit: 0,
    },
  },
})
