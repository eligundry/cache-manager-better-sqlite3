import sqlite from 'better-sqlite3'
import util from 'node:util'
import type { Store } from 'cache-manager'
import serializers from './serializers'

const ConfigurePragmas = `
PRAGMA main.synchronous = NORMAL;
PRAGMA main.journal_mode = WAL2;
PRAGMA main.auto_vacuum = INCREMENTAL;
`
const CreateTableStatement = `
CREATE TABLE IF NOT EXISTS %s (
    key TEXT PRIMARY KEY,
    val BLOB,
    created_at INTEGER,
    expire_at INTEGER
);
CREATE INDEX IF NOT EXISTS index_expire_%s ON %s(expire_at);
`
const SelectKeyStatementPrefix = "SELECT * FROM %s WHERE key IN "
const DeleteStatement = "DELETE FROM %s WHERE key = ?"
const TruncateStatement = "DELETE FROM %s"
const PurgeExpiredStatement = "DELETE FROM %s WHERE expire_at < ?"
const UpsertManyStatementPrefix = "INSERT OR REPLACE INTO %s(key, val, created_at, expire_at) VALUES ?, ?, ?, ?"

function isObject(o) {
  return o !== null && typeof o === 'object'
}

function now() {
  return new Date().getTime()
}

function generatePlaceHolders(length: number) {
  return '(' + ('?'.repeat(length).split('').join(', ')) + ')'
}

export interface SqliteOpenOptions {
  /* callback function when database open if failure or success */
  onOpen?: Function
  /* callback function when database table for key-value space has been created */
  onReady?: Function
  /* sqlite3 open flags for database file*/
  flags?: number
  /* serialization options */
  serializer?: 'json' | 'cbor' | {
    serialize: (o: unknown) => string
    deserialize: (p: string) => unknown
  }
}

interface CacheRow {
  key: string
  val: any
  created_at: number
  expire_at: number
}

class SqliteCacheAdapter implements Store {
  /**
   * @property {sqlite.Database} db for db instance
   */
  db: sqlite.Database

  // Name of key-value space
  #name: string

  // Seralizer to serialize/deserialize payloads
  #serializer = null

  // TTL in seconds
  #default_ttl = 24 * 60 * 60

  /**
   * @param name - name of key-value space
   * @param path - path of database file
   * @param {SqliteOpenOptions} options for opening database
   */
  constructor(name: string, path: string, options: SqliteOpenOptions) {
    const mode = options.flags || (sqlite.OPEN_CREATE | sqlite.OPEN_READWRITE)
    const ser = options.serializer
    this.#name = name
    this.#default_ttl = typeof options.ttl === 'number' ? options.ttl : this.#default_ttl
    this.#serializer = isObject(ser) ? ser : serializers[ser || 'cbor']

    this.db = new sqlite(path)
    this.db.serialize(() => {
      const stmt = ConfigurePragmas + util.format(CreateTableStatement, name, name, name)
      this.db.exec(stmt, options.onReady)
    })
  }


  _fetch_all(keys: string[]): CacheRow[] {
    const postFix = generatePlaceHolders(keys.length)
    const stmt = this.db.prepare(util.format(SelectKeyStatementPrefix + postFix, this.#name))
    return stmt.all(keys)
  }

  async mget(...args: string[]) {
    const ts = now()
    const allRows = this._fetch_all(args)
    const notExpiredRows = allRows.filter(r => r.expire_at > ts)

    // Schedule cleanup for expired rows
    if (notExpiredRows.length < allRows.length) {
      process.nextTick(() => this.#purgeExpired())
    }

    // Deserialize rows returned by DB
    // If any expired, set them to undefined
    return allRows.map(r => r.expire_at > ts ? this.#deserialize(r.val) : undefined)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.mget(key) as (T | undefined)
  }

  async mset(...args: Parameters<Store['mset']>) {
    const keyValues = (args.filter(o => Array.isArray(o)) ?? []) as [string, unknown][]

    if (keyValues.length === 0) {
      return
    }

    const ttl = typeof args.at(-1) === 'number' ? args.at(-1) as number : this.#default_ttl
    const ts = now()
    const expire = ts + ttl
    const stmt = this.db.prepare(util.format(UpsertManyStatementPrefix, this.#name))

    this.db.transaction(() => {
      for (const [key, value] of keyValues) {
        const serializedValue = this.#serialize(value)
        stmt.run(key, serializedValue, ts, expire)
      }
    })
  }

  async set<T>(key: string, value: T, ttl?: number) {
    this.mset([[key, value]], ttl)
  }

  async mdel(...args: string[]) {
    const stmt = this.db.prepare(util.format(DeleteStatement, this.#name))

    this.db.transaction(() => {
      for (const key of args) {
        stmt.run(key)
      }
    })
  }

  async del(key: string) {
    this.mdel(key)
  }

  async reset() {
    this.db.exec(util.format(TruncateStatement, this.#name))
  }

  async ttl(key: string): Promise<number> {
    const rows = this._fetch_all([key])

    if (!rows || !rows.length) {
      return Infinity
    }

    return rows[0].expire_at - now()
  }

  #serialize(obj: unknown) {
    try {
      return this.#serializer.serialize(obj)
    } catch (e) {
      return undefined
    }
  }

  #deserialize(payload: string) {
    try {
      return this.#serializer.deserialize(payload)
    } catch (e) {
      return undefined
    }
  }

  #purgeExpired() {
    const stmt = this.db.prepare(util.format(PurgeExpiredStatement, this.#name))
    stmt.run(now())
  }
}

function create(args: { name?: string, path?: string, options?: SqliteOpenOptions }) {
  return new SqliteCacheAdapter(args.name || 'kv', args.path || ':memory:', args.options || {})
}

export default {
  create,
}
