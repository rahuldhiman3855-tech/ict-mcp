'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');

/**
 * User-added MCP servers (name + URL), reachable from the MCP Config page
 * alongside the built-in ones in localMcps.js. Same file-store pattern as
 * settings.js — small, infrequently-written config that doesn't warrant a
 * DB table.
 */

const FILE = path.join(config.dataDir, 'mcps.json');

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

function get(id) {
  return readAll().find((m) => m.id === id) || null;
}

async function create({ name, url, description }) {
  const all = readAll();
  const entry = {
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    url,
    description: description || '',
    createdAt: new Date().toISOString(),
  };
  all.push(entry);
  await writeAll(all);
  return entry;
}

async function update(id, { name, url, description }) {
  const all = readAll();
  const idx = all.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], name, url, description: description || '' };
  await writeAll(all);
  return all[idx];
}

async function remove(id) {
  const all = readAll();
  const next = all.filter((m) => m.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

module.exports = { list, get, create, update, remove };
