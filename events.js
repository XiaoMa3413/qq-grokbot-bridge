'use strict';

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Walk d.msg_elements recursively.
// Returns { texts, attachments, quoted }.
//   texts        - every non-empty trimmed content, at any depth.
//   attachments  - every attachment object (same refs used inside quoted).
//   quoted       - an entry for each top-level element AND each deeper element
//                  whose message_type is 102 or 103.
function parseElements(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.msg_elements)) {
    return { texts: [], attachments: [], quoted: [] };
  }
  const texts = [];
  const attachments = [];
  const quoted = [];

  const walk = (elements, topLevel) => {
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;

      const content = str(el.content).trim();
      if (content !== '') texts.push(content);

      const atts = Array.isArray(el.attachments) ? el.attachments : [];
      for (const a of atts) attachments.push(a);

      const quotable = topLevel || el.message_type === 102 || el.message_type === 103;
      if (quotable) {
        quoted.push({
          author: el.author ? el.author.username || el.author.id || null : null,
          content,
          attachments: atts,
        });
      }

      if (Array.isArray(el.msg_elements)) walk(el.msg_elements, false);
    }
  };

  walk(d.msg_elements, true);
  return { texts, attachments, quoted };
}

// d.message_scene.ext is an array of 'key=value' strings.
function refMsgIdx(d) {
  if (!d || typeof d !== 'object') return null;
  const scene = d.message_scene;
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.ext)) return null;
  for (const item of scene.ext) {
    if (typeof item !== 'string') continue;
    const eq = item.indexOf('=');
    if (eq !== -1 && item.slice(0, eq) === 'ref_msg_idx') return item.slice(eq + 1);
  }
  return null;
}

class SeenIds {
  constructor(max = 1000) {
    this.max = max;
    this._set = new Set(); // Set preserves insertion order -> easy FIFO.
  }
  has(id) {
    return this._set.has(id);
  }
  add(id) {
    if (this._set.has(id)) return; // no reorder for existing ids
    this._set.add(id);
    while (this._set.size > this.max) {
      this._set.delete(this._set.values().next().value); // drop oldest
    }
  }
  check(id) {
    if (this._set.has(id)) return true;
    this.add(id);
    return false;
  }
}

class RecentImages {
  constructor(windowMs = 600000, max = 5) {
    this.windowMs = windowMs;
    this.max = max;
    this._groups = new Map();
  }
  add(group, entry, now = Date.now()) {
    if (!entry || typeof entry !== 'object') return;
    const list = this._groups.get(group) || [];
    const ts = typeof entry.timestamp === 'number' ? entry.timestamp : now;
    list.push({ local_path: entry.local_path, nickname: entry.nickname, timestamp: ts });
    list.sort((a, b) => a.timestamp - b.timestamp);
    const floor = now - this.windowMs;
    this._groups.set(group, list.filter((e) => e.timestamp >= floor));
  }
  get(group, now = Date.now()) {
    const list = this._groups.get(group);
    if (!list) return [];
    const floor = now - this.windowMs;
    const within = list.filter((e) => e.timestamp <= now && e.timestamp >= floor);
    return within.slice(Math.max(0, within.length - this.max)).map((e) => ({ ...e }));
  }
}

// Deep copy omitting any key matching /token|secret/i at every level.
function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj)) {
      if (/token|secret/i.test(key)) continue;
      out[key] = redact(obj[key]);
    }
    return out;
  }
  return obj;
}

module.exports = { parseElements, refMsgIdx, SeenIds, RecentImages, redact };
