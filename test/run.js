// Runs every *.test.js under test/ in its own process, the way the domain
// library runs in the API: with TZ=UTC (see lib/atodo/domain/clock.js --
// the rules use JavaScript's "local" time as a plain wall clock). Stops at
// the first failing file. `npm test`.
const { readdirSync, statSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

function testFiles(dir) {
 return readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return testFiles(path);
  return name.endsWith('.test.js') ? [path] : [];
 });
}

for (const file of testFiles(__dirname).sort()) {
 const result = spawnSync(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
 if (result.status !== 0) {
  console.error(`FAILED: ${file}`);
  process.exit(result.status || 1);
 }
}
console.log('all tests passed');
