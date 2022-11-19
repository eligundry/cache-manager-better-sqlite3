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
// This query looks nasty but it's fun. If you are going to mget a bunch of
// keys, and some of them may not exist, you're still going to expect an empty
// value back in the position that you requested it. In order to do that, we
// create a CTE of the keys passed in and LEFT JOIN to the actual cache table.
// This has the added benefit of automatically ordering the results in the order
// the keys were passed in.
const SelectKeysStatementFn = (keys: string[], tableName: string) => {
  const placeholderValues = keys.map(() => `(?)`).join(', ')
  return util.format(`
    WITH getKeys(key) AS (VALUES ${placeholderValues})
    SELECT
      getKeys.key,
      val,
      created_at,
      expire_at
    FROM getKeys
    LEFT JOIN %s ON %s.key = getKeys.key
  `, tableName, tableName)
}
const SelectKeysStatement = "SELECT key FROM %s"
const SelectKeysPatternStatement = "SELECT key FROM %s WHERE key LIKE ?"
const DeleteStatement = "DELETE FROM %s WHERE key = ?"
const TruncateStatement = "DELETE FROM %s"
const PurgeExpiredStatement = "DELETE FROM %s WHERE expire_at < ?"
const UpsertManyStatementPrefix = "INSERT OR REPLACE INTO %s(key, val, created_at, expire_at) VALUES ?, ?, ?, ?"

function now() {
  return new Date().getTime()
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
    serialize: (o: unknown) => (Buffer | string)
    deserialize: (p: string) => unknown
  }
  ttl?: number
}

interface CacheRow {
  key: string
  val: any
  created_at: number | null
  expire_at: number | null
}

class SqliteCacheAdapter implements Store {
  /**
   * @property {sqlite.Database} db for db instance
   */
  db: sqlite.Database

  // Name of key-value space
  #name: string

  // Seralizer to serialize/deserialize payloads
  #serializer: {
    serialize: (o: unknown) => (Buffer | string)
    deserialize: (p: string) => unknown
  }

  // TTL in seconds
  #default_ttl = 24 * 60 * 60

  /**
   * @param name - name of key-value space
   * @param path - path of database file
   * @param {SqliteOpenOptions} options for opening database
   */
  constructor(name: string, path: string, options: SqliteOpenOptions) {
    // const mode = options.flags || (sqlite.OPEN_CREATE | sqlite.OPEN_READWRITE)
    this.#name = name
    this.#default_ttl = typeof options.ttl === 'number' ? options.ttl : this.#default_ttl
    this.#serializer = serializers.cbor

    if (options.serializer !== null) {
      if (typeof options.serializer === 'object') {
        this.#serializer = options.serializer
      } else if (typeof options.serializer === 'string') {
        this.#serializer = serializers[options.serializer]
      }
    }

    this.db = new sqlite(path)
    this.db.exec(ConfigurePragmas + util.format(CreateTableStatement, name, name, name))
  }


  #fetchAll(keys: string[]): CacheRow[] {
    const stmt = this.db.prepare(SelectKeysStatementFn(keys, this.#name))
    return stmt.all(keys)
  }

  async mget(...args: string[]) {
    const ts = now()
    const rows = this.#fetchAll(args)
    const hasExpiredRow = rows.find(r => r.expire_at !== null && r.expire_at < ts)

    // Schedule cleanup for expired rows
    if (hasExpiredRow) {
      process.nextTick(() => this.#purgeExpired())
    }

    // Deserialize rows returned by DB
    // If any expired or does not exist, set them to undefined
    return rows.map(r => (r.expire_at === null || r.expire_at < ts) ? this.#deserialize(r.val) : undefined)
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
    const rows = this.#fetchAll([key])

    if (!rows || !rows.length || rows[0].expire_at === null) {
      return Infinity
    }

    return rows[0].expire_at - now()
  }

  async keys(pattern?: string): Promise<string[]> {
    let rows: Pick<CacheRow, 'key'>[] = []

    if (pattern) {
      const stmt = this.db.prepare(util.format(SelectKeysPatternStatement, this.#name))
      rows = stmt.all(pattern)
    } else {
      const stmt = this.db.prepare(util.format(SelectKeysStatement, this.#name))
      rows = stmt.all()
    }

    return rows.map(r => r.key)
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
