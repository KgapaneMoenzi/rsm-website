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
    email: r.email,
    room: r.room,
    funding: r.funding,
    status: r.status,
    acceptedEmailedAt: r.accepted_emailed_at,
    rent: r.rent,
    movedInOn: r.moved_in_on,
    leftOn: r.left_on,
  });
  const SA_TODAY = "(now() AT TIME ZONE 'Africa/Johannesburg')::date";

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
      // added later: older rows simply have no email
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS email text');
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS accepted_emailed_at timestamptz');
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS funding text');
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS rent integer');
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS moved_in_on date');
      await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS left_on date');
      // 'left' = a student who has moved out (older databases only allowed four statuses)
      await pool.query('ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check');
      await pool.query(
        "ALTER TABLE applications ADD CONSTRAINT applications_status_check CHECK (status IN ('new','contacted','accepted','declined','left'))"
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          month          text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
          amount         integer NOT NULL CHECK (amount > 0 AND amount <= 100000),
          paid_on        date NOT NULL,
          note           text,
          created_at     timestamptz NOT NULL DEFAULT now()
        )`);
      await pool.query('CREATE INDEX IF NOT EXISTS payments_app_idx ON payments (application_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS payments_month_idx ON payments (month)');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS room_capacity (
          room  text PRIMARY KEY,
          total integer NOT NULL DEFAULT 0 CHECK (total >= 0)
        )`);
      await pool.query(`
        INSERT INTO room_capacity (room, total)
        VALUES ('Bachelor Room',0),('Single Room',0),('Sharing Room',0)
        ON CONFLICT (room) DO NOTHING`);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC)'
      );
    },

    async save(app, file) {
      const { rows } = await pool.query(
        `INSERT INTO applications
           (name, student_number, university, phone, email, room, funding, id_type, id_photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
        [app.name, app.studentNumber, app.university, app.phone, app.email, app.room, app.funding, file.type, file.buffer]
      );
      return { id: rows[0].id, createdAt: rows[0].created_at };
    },

    async list() {
      // id_photo is deliberately NOT selected here
      const { rows } = await pool.query(
        `SELECT id, created_at, name, student_number, university, phone, email, room, funding, status, accepted_emailed_at, rent,
                to_char(moved_in_on,'YYYY-MM-DD') AS moved_in_on, to_char(left_on,'YYYY-MM-DD') AS left_on
           FROM applications ORDER BY created_at DESC LIMIT 1000`
      );
      return rows.map(fromRow);
    },

    async getForNotify(id) {
      const { rows } = await pool.query(
        `SELECT name, student_number, university, phone, email, room, funding, accepted_emailed_at
           FROM applications WHERE id = $1`,
        [id]
      );
      return rows[0]
        ? {
            name: rows[0].name,
            studentNumber: rows[0].student_number,
            university: rows[0].university,
            phone: rows[0].phone,
            email: rows[0].email,
            room: rows[0].room,
            funding: rows[0].funding,
            acceptedEmailedAt: rows[0].accepted_emailed_at,
          }
        : null;
    },

    async markAcceptedEmailed(id) {
      await pool.query('UPDATE applications SET accepted_emailed_at = now() WHERE id = $1', [id]);
    },

    async acceptedCounts() {
      const { rows } = await pool.query(
        "SELECT room, count(*)::int AS n FROM applications WHERE status = 'accepted' GROUP BY room"
      );
      return Object.fromEntries(rows.map((r) => [r.room, r.n]));
    },

    async getCapacity() {
      const { rows } = await pool.query('SELECT room, total FROM room_capacity');
      return Object.fromEntries(rows.map((r) => [r.room, r.total]));
    },

    async setCapacity(room, total) {
      await pool.query(
        `INSERT INTO room_capacity (room, total) VALUES ($1, $2)
         ON CONFLICT (room) DO UPDATE SET total = EXCLUDED.total`,
        [room, total]
      );
    },

    async getId(id) {
      const { rows } = await pool.query(
        'SELECT id_type, id_photo FROM applications WHERE id = $1',
        [id]
      );
      return rows[0] ? { buffer: rows[0].id_photo, type: rows[0].id_type } : null;
    },

    async setStatus(id, status) {
      const r = await pool.query(
        `UPDATE applications SET status = $2,
           moved_in_on = CASE WHEN $2 = 'accepted' AND moved_in_on IS NULL THEN ${SA_TODAY} ELSE moved_in_on END,
           left_on = CASE WHEN $2 = 'left' THEN COALESCE(left_on, ${SA_TODAY})
                          WHEN $2 = 'accepted' THEN NULL ELSE left_on END
         WHERE id = $1`,
        [id, status]
      );
      return r.rowCount > 0;
    },

    async setResident(id, f) {
      const sets = [], vals = [id];
      for (const [col, key] of [['rent', 'rent'], ['moved_in_on', 'movedInOn'], ['left_on', 'leftOn']]) {
        if (key in f) { vals.push(f[key]); sets.push(`${col} = $${vals.length}`); }
      }
      if (!sets.length) return true;
      const r = await pool.query(`UPDATE applications SET ${sets.join(', ')} WHERE id = $1`, vals);
      return r.rowCount > 0;
    },

    async listPayments() {
      const { rows } = await pool.query(
        `SELECT id, application_id, month, amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on, note
           FROM payments ORDER BY paid_on DESC, created_at DESC LIMIT 20000`
      );
      return rows.map((r) => ({ id: r.id, applicationId: r.application_id, month: r.month, amount: r.amount, paidOn: r.paid_on, note: r.note }));
    },

    async addPayment(p) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO payments (application_id, month, amount, paid_on, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [p.applicationId, p.month, p.amount, p.paidOn, p.note || null]
        );
        return rows[0].id;
      } catch (e) {
        if (e.code === '23503') return null; // no such student
        throw e;
      }
    },

    async removePayment(id) {
      const r = await pool.query('DELETE FROM payments WHERE id = $1', [id]);
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
  const pub = ({ idPath, idType, ...rest }) => ({ rent: null, movedInOn: null, leftOn: null, ...rest });
  const todaySA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  const PAY = path.join(DIR, 'payments.json');
  const readPay = async () => { try { return JSON.parse(await fs.readFile(PAY, 'utf8')); } catch (e) { return []; } };
  const writePay = async (rows) => { await fs.mkdir(DIR, { recursive: true }); await fs.writeFile(PAY, JSON.stringify(rows, null, 2)); };
  const CAP = path.join(DIR, 'capacity.json');
  const CAP_DEFAULT = { 'Bachelor Room': 0, 'Single Room': 0, 'Sharing Room': 0 };
  async function readCap() {
    try {
      return { ...CAP_DEFAULT, ...JSON.parse(await fs.readFile(CAP, 'utf8')) };
    } catch (e) {
      return { ...CAP_DEFAULT };
    }
  }

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
        return { id: row.id, createdAt: row.createdAt };
      }),

    list: async () => (await load()).map(pub),

    getForNotify: async (id) => {
      const row = (await load()).find((r) => r.id === id);
      return row ? pub(row) : null;
    },

    acceptedCounts: async () => {
      const out = {};
      for (const r of await load()) if (r.status === 'accepted') out[r.room] = (out[r.room] || 0) + 1;
      return out;
    },

    getCapacity: readCap,

    setCapacity: (room, total) =>
      locked(async () => {
        const c = await readCap();
        c[room] = total;
        await fs.mkdir(DIR, { recursive: true });
        await fs.writeFile(CAP, JSON.stringify(c, null, 2));
      }),

    markAcceptedEmailed: (id) =>
      locked(async () => {
        const rows = await load();
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.acceptedEmailedAt = new Date().toISOString();
          await persist(rows);
        }
      }),

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
        if (status === 'accepted') { row.movedInOn = row.movedInOn || todaySA(); row.leftOn = null; }
        if (status === 'left') row.leftOn = row.leftOn || todaySA();
        await persist(rows);
        return true;
      }),

    setResident: (id, f) =>
      locked(async () => {
        const rows = await load();
        const row = rows.find((r) => r.id === id);
        if (!row) return false;
        for (const k of ['rent', 'movedInOn', 'leftOn']) if (k in f) row[k] = f[k];
        await persist(rows);
        return true;
      }),

    listPayments: async () => (await readPay()).sort((a, b) => (a.paidOn < b.paidOn ? 1 : -1)),

    addPayment: (p) =>
      locked(async () => {
        if (!(await load()).some((r) => r.id === p.applicationId)) return null;
        const rows = await readPay();
        const id = crypto.randomUUID();
        rows.push({ id, applicationId: p.applicationId, month: p.month, amount: p.amount, paidOn: p.paidOn, note: p.note || null });
        await writePay(rows);
        return id;
      }),

    removePayment: (id) =>
      locked(async () => {
        const rows = await readPay();
        const n = rows.filter((r) => r.id !== id);
        if (n.length === rows.length) return false;
        await writePay(n);
        return true;
      }),

    remove: (id) =>
      locked(async () => {
        const rows = await load();
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) return false;
        await fs.rm(path.join(IDS, rows[i].idPath), { force: true });
        const gone = rows[i].id;
        rows.splice(i, 1);
        await persist(rows);
        await writePay((await readPay()).filter((p) => p.applicationId !== gone));
        return true;
      }),
  };
}

module.exports = { hasDatabase, create: () => (hasDatabase ? postgresStore() : localStore()) };
