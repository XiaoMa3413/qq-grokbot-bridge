'use strict';
const fs = require('fs'), path = require('path');
const { historyKey } = require('./history');
function log(...a) { console.log(new Date().toISOString(), ...a); }
function memoryDir() { return process.env.QQ_MEMORY_DIR || path.join(__dirname, 'memory'); }
function memoryPath(type, id) {
  const f = path.join(memoryDir(), historyKey(type, id) + '.md');
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  } catch (e) { log('memory path error', f, e.message); }
  return f;
}
module.exports = { memoryPath, memoryDir };
