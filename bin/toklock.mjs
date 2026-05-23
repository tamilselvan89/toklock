#!/usr/bin/env node
/**
 * toklock CLI
 * Usage: npx toklock [--port 4000]
 */

import { createProxy } from '../src/proxy.mjs';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : (parseInt(process.env.TOKLOCK_PORT, 10) || 4000);

console.log(`
  ████████╗ ██████╗ ██╗  ██╗██╗      ██████╗  ██████╗██╗  ██╗
     ██╔══╝██╔═══██╗██║ ██╔╝██║     ██╔═══██╗██╔════╝██║ ██╔╝
     ██║   ██║   ██║█████╔╝ ██║     ██║   ██║██║     █████╔╝
     ██║   ██║   ██║██╔═██╗ ██║     ██║   ██║██║     ██╔═██╗
     ██║   ╚██████╔╝██║  ██╗███████╗╚██████╔╝╚██████╗██║  ██╗
     ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝

  Token-aware rate-limit queue proxy for the Anthropic Claude API
  Your agents never see a 429. They just wait.

  GitHub : https://github.com/tamilselvan89/toklock
  License: Apache-2.0
`);

createProxy({ port });

console.log(`  Quick start:`);
console.log(`    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
console.log(`    claude  # or any Anthropic SDK call\n`);
