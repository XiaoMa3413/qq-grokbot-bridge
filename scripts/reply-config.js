'use strict';
const { loadReplyToken } = require('../configuration');
function replyConfiguration() {
  const url = new URL(process.env.QQ_REPLY_URL || `http://127.0.0.1:${process.env.QQ_REPLY_PORT || 8787}/reply`);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/reply') throw new Error('QQ_REPLY_URL must use HTTPS (HTTP is allowed only on loopback) and end in /reply');
  if (!loopback && !process.env.QQ_REPLY_TOKEN) throw new Error('set QQ_REPLY_TOKEN for remote replies');
  return { url, token: loadReplyToken() };
}
module.exports = { replyConfiguration };
