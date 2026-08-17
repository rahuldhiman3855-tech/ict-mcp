'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');

/**
 * Telegram subscribers — chats that should receive workflow notifications.
 * Replaces the single `telegramChatId` setting: any number of users/groups
 * can subscribe, discovered via Telegram's getUpdates or added by chat id
 * directly. File-store, same pattern as settings.js / mcpStore.js.
 */

const FILE = path.join(config.dataDir, 'subscribers.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function writeAll(list) {
  await fsp.mkdir(config.dataDir, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, FILE);
}

function list() {
  return readAll();
}

function findByChatId(chatId) {
  return readAll().find((s) => String(s.chatId) === String(chatId)) || null;
}

async function create({ chatId, name, username, type }) {
  if (!chatId) throw Object.assign(new Error('chatId is required'), { status: 400 });
  const existing = findByChatId(chatId);
  if (existing) return existing;

  const all = readAll();
  const entry = {
    id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: String(chatId),
    name: name || String(chatId),
    username: username || null,
    type: type || 'private',
    subscribedAt: new Date().toISOString(),
  };
  all.push(entry);
  await writeAll(all);
  return entry;
}

async function remove(id) {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

module.exports = { list, findByChatId, create, remove };
