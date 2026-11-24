'use strict';
/**
 * Storage layer.
 *  - Production: Neon Postgres (DATABASE_URL). ID photos are kept in a bytea column,
 *    so they are never reachable by a public URL; only the admin API can read them.
 *  - Local dev (no DATABASE_URL): JSON file + image files in ./data  (never used in production)
 *
 * Both expose the same functions, so server.js does not care which one is active.
 */
const crypto = require('crypto');

const hasDatabase = !!process.env.DATABASE_URL;

/* ------------------------------ Postgres (Neon) ------------------------------ */
function postgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000, // Neon may suspend idle connections; do not hold them
    connectionTimeoutMillis: 20000, // allow for Neon waking from sleep
  });
  pool.on('error', (e) => console.error('Postgres pool error:', e.message));

  const fromRow = (r) => ({
    id: r.id,
    createdAt: r.created_at,
    name: r.name,
    studentNumber: r.student_number,
    university: r.university,
    phone: r.phone,
    room: r.room,
    status: r.status,
  });

  return {
    kind: 'neon',

    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS applications (
          id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at     timestamptz NOT NULL DEFAULT now(),
          name           text NOT NULL,
          student_number text NOT NULL,
          university     text NOT NULL,
          phone          text NOT NULL,
          room           text NOT NULL,
          status         text NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new','contacted','accepted','declined')),
          id_type        text NOT NULL,
          id_photo       bytea NOT NULL
        )`);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC)'
      );
    },

    async save(app, file) {
      const { rows } = await pool.query(
        `INSERT INTO applications
           (name, student_number, university, phone, room, id_type, id_photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [app.name, app.studentNumber, app.university, app.phone, app.room, file.type, file.buffer]
      );
      return rows[0].id;
    },

    async list() {
      // id_photo is deliberately NOT selected here
      const { rows } = await pool.query(
        `SELECT id, created_at, name, student_number, university, phone, room, status
           FROM applications ORDER BY created_at DESC LIMIT 1000`
      );
      return rows.map(fromRow);
    },

    async getId(id) {
      const { rows } = await pool.query(
        'SELECT id_type, id_photo FROM applications WHERE id = $1',
        [id]
      );
      return rows[0] ? { buffer: rows[0].id_photo, type: rows[0].id_type } : null;
    },

    async setStatus(id, status) {
      const r = await pool.query('UPDATE applications SET status = $2 WHERE id = $1', [id, status]);
      return r.rowCount > 0;
    },

    async remove(id) {
      const r = await pool.query('DELETE FROM applications WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
}

/* ------------------------------- Local (dev) ------------------------------- */
function localStore() {
  const fs = require('fs/promises');
  const path = require('path');
  const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const FILE = path.join(DIR, 'applications.json');
  const IDS = path.join(DIR, 'ids');

  let chain = Promise.resolve(); // tiny mutex so concurrent writes never clobber each other
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    try {
      return JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  async function persist(rows) {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE + '.tmp', JSON.stringify(rows, null, 2));
    await fs.rename(FILE + '.tmp', FILE);
  }
  const pub = ({ idPath, idType, ...rest }) => rest;

  return {
    kind: 'local',

    async init() {},

    save: (app, file) =>
      locked(async () => {
        await fs.mkdir(IDS, { recursive: true });
        const idPath = `${crypto.randomUUID()}.${file.ext}`;
        await fs.writeFile(path.join(IDS, idPath), file.buffer);
        const rows = await load();
        const row = {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          ...app,
          status: 'new',
          idPath,
          idType: file.type,
        };
        rows.unshift(row);
        await persist(rows);
        return row.id;
      }),

    list: async () => (await load()).map(pub),

    getId: async (id) => {
      const row = (await load()).find((r) => r.id === id);
      if (!row) return null;
      return { buffer: await fs.readFile(path.join(IDS, row.idPath)), type: row.idType };
    },

    setStatus: (id, status) =>
      locked(async () => {
        const rows = await load();
        const row = rows.find((r) => r.id === id);
        if (!row) return false;
        row.status = status;
        await persist(rows);
        return true;
      }),

    remove: (id) =>
      locked(async () => {
        const rows = await load();
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return false;
        await fs.rm(path.join(IDS, rows[i].idPath), { force: true });
        rows.splice(i, 1);
        await persist(rows);
        return true;
      }),
  };
}

module.exports = { hasDatabase, create: () => (hasDatabase ? postgresStore() : localStore()) };
