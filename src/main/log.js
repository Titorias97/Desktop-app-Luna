'use strict';
/** Tiny file logger: %APPDATA%/Luna/luna.log (plus stderr). */
const fs = require('fs');
const path = require('path');

let file = null;
function init(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'luna.log'); fs.writeFileSync(file, ''); } catch (e) { file = null; }
}
function write(level, msg, err) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${err ? ` :: ${err.stack || err}` : ''}\n`;
  if (level === 'error') process.stderr.write(line); else process.stdout.write(line);
  if (file) { try { fs.appendFileSync(file, line); } catch (e) { /* ignore */ } }
}
module.exports = { init, info: (m) => write('info', m), error: (m, e) => write('error', m, e), path: () => file };
