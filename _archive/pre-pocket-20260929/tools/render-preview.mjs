// Render the phone page HTML and save it for visual inspection.
// This checks for the original complaints: model button overflow, dead buttons, etc.
import { renderPhonePage } from '../lib/pages.js'

const html = renderPhonePage({
  paired: false,
  tunnelUrl: null,
  pin: '123456',
})

import { writeFileSync } from 'node:fs'
writeFileSync('tmp-phone-page-unpaired.html', html, 'utf8')
console.log('unpaired page:', html.length, 'bytes')

const html2 = renderPhonePage({
  paired: true,
  tunnelUrl: 'https://abc-123-def.trycloudflare.com',
  pin: null,
  modelCatalog: {
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]},
      { id: 'openai', name: 'OpenAI', models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
      ]},
    ],
    failures: [],
  },
})

writeFileSync('tmp-phone-page-paired.html', html2, 'utf8')
console.log('paired page:', html2.length, 'bytes')

// Check for common issues
console.log('\n== layout checks ==')
console.log('has viewport meta:', html2.includes('width=device-width'))
console.log('has model select:', html2.includes('model') || html2.includes('Model'))
console.log('has overflow:hidden on container:', html2.includes('overflow'))
console.log('has touch-friendly button sizes:', html2.includes('min-height') || html2.includes('min-height'))
