/**
 * database.js
 * Simple persistent key-value store using a JSON file.
 * For production, replace with MongoDB, PostgreSQL, Redis, etc.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'deals.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, '{}');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

const db = {
  get(key) {
    const data = load();
    return data[key] || null;
  },
  set(key, value) {
    const data = load();
    data[key] = value;
    save(data);
    return value;
  },
  delete(key) {
    const data = load();
    delete data[key];
    save(data);
  },
  all() {
    return load();
  }
};

module.exports = { db };
