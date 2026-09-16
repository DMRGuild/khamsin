// Keep the established entry point while configuration lives in one CLI.
process.argv.splice(2,0,'setup');
await import('./config.mjs');
