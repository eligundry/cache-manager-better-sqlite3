import sqlite from 'better-sqlite3'
import util from 'node:util'
import type { Store, FactoryStore, Config } from 'cache-manager'
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
  return util.format(
    `
      WITH getKeys(key) AS (VALUES ${placeholderValues})
      SELECT
        getKeys.key,
        val,
        created_at,
        expire_at
      FROM getKeys
      LEFT JOIN %s ON %s.key = getKeys.key
    `,
    tableName,
    tableName
  )
}
const SelectKeyStatement = 'SELECT * FROM %s WHERE key = ?'
const SelectKeysStatement = 'SELECT key FROM %s'
const SelectKeysPatternStatement =
  'SELECT key FROM %s WHERE key LIKE ? ORDER BY created_at'
const DeleteStatement = 'DELETE FROM %s WHERE key = ?'
const TruncateStatement = 'DELETE FROM %s'
const PurgeExpiredStatement = 'DELETE FROM %s WHERE expire_at < ?'
const UpsertStatement =
  'INSERT OR REPLACE INTO %s(key, val, created_at, expire_at) VALUES (?, ?, ?, ?)'

function now() {
  return new Date().getTime()
}

export interface SqliteCacheAdapterOptions extends Config {
  name?: string
  path?: string
  /* callback function when database table for key-value space has been created */
  onReady?: (db: sqlite.Database) => any
  /* serialization options */
  serializer?:
    | 'json'
    | 'cbor'
    | {
        serialize: (o: unknown) => Buffer | string
        deserialize: (p: string) => unknown
      }
  /* options to pass to better-sqlite */
  sqliteOptions?: sqlite.Options
}

interface CacheRow {
  key: string
  val: any
  created_at: number | null
  expire_at: number | null
}

export class SqliteCacheAdapter implements Store {
  db: sqlite.Database

  // Name of key-value space
  #name: string

  // Seralizer to serialize/deserialize payloads
  #serializer: {
    serialize: (o: unknown) => Buffer | string
    deserialize: (p: string) => any
  }

  #statements: {
    get: sqlite.Statement<[string]>
    set: sqlite.Statement<[string, string | Buffer, number, number]>
    del: sqlite.Statement<[string]>
    keys: sqlite.Statement
    keysPattern: sqlite.Statement<[string]>
    reset: sqlite.Statement
    purgeExpired: sqlite.Statement<[number]>
  }

  // TTL in seconds
  #default_ttl = 24 * 60 * 60

  // Checks if value is cacheable
  #isCachable: SqliteCacheAdapterOptions['isCacheable']

  /**
   * @param name - name of key-value space
   * @param path - path of database file
   * @param options - options for opening database
   */
  constructor(options: SqliteCacheAdapterOptions) {
    this.#name = options.name ?? 'kv'
    this.#default_ttl =
      typeof options.ttl === 'number' ? options.ttl : this.#default_ttl
    this.#serializer = serializers.cbor

    if (options.serializer !== null) {
      if (typeof options.serializer === 'object') {
        this.#serializer = options.serializer
      } else if (typeof options.serializer === 'string') {
        this.#serializer = serializers[options.serializer]
      }
    }

    this.db = new sqlite(options.path ?? ':memory:', options.sqliteOptions)
    this.db.exec(
      ConfigurePragmas +
        util.format(
          CreateTableStatement,
          options.name,
          options.name,
          options.name
        )
    )
    this.#statements = {
      get: this.db.prepare(util.format(SelectKeyStatement, this.#name)),
      set: this.db.prepare(util.format(UpsertStatement, this.#name)),
      del: this.db.prepare(util.format(DeleteStatement, this.#name)),
      keys: this.db.prepare(util.format(SelectKeysStatement, this.#name)),
      keysPattern: this.db.prepare(
        util.format(SelectKeysPatternStatement, this.#name)
      ),
      reset: this.db.prepare(util.format(TruncateStatement, this.#name)),
      purgeExpired: this.db.prepare(
        util.format(PurgeExpiredStatement, this.#name)
      ),
    }
    this.#isCachable = options.isCacheable
    options.onReady?.(this.db)
  }

  #fetchAll(keys: string[]): CacheRow[] {
    const stmt = this.db.prepare(SelectKeysStatementFn(keys, this.#name))
    return stmt.all(...keys)
  }

  async mget(...args: string[]) {
    console.log(...args)
    const ts = now()
    const rows = this.#fetchAll(args)
    const hasExpiredRow = rows.find(
      (r) => r.expire_at !== null && r.expire_at < ts
    )

    // Schedule cleanup for expired rows
    if (hasExpiredRow) {
      process.nextTick(() => this.#purgeExpired())
    }

    // Deserialize rows returned by DB
    // If any expired or does not exist, set them to undefined
    return rows.map((r) =>
      r.expire_at !== null && r.expire_at > ts && r.val
        ? this.#deserialize(r.val)
        : undefined
    )
  }

  async get<T>(key: string): Promise<T | undefined> {
    const ts = now()
    const row: CacheRow = this.#statements.get.get(key)

    if (!row || !row.expire_at || !row.val) {
      return undefined
    } else if (row.expire_at < ts) {
      process.nextTick(() => this.#purgeExpired())
      return undefined
    }

    return this.#serializer.deserialize(row.val)
  }

  async mset(args: [string, unknown][], keyTTL?: number) {
    const ttl = keyTTL ?? this.#default_ttl
    const ts = now()
    const expire = ts + ttl

    this.db.transaction(() => {
      for (const [key, value] of args) {
        if (this.#isCachable && !this.#isCachable(value)) {
          throw new Error(`no cacheable value ${JSON.stringify(value)}`)
        }

        const serializedValue = this.#serialize(value)
        this.#statements.set.run(key, serializedValue, ts, expire)
      }
    })()
  }

  async set<T>(key: string, value: T, ttl?: number) {
    await this.mset([[key, value]], ttl)
  }

  async mdel(...args: string[]) {
    this.db.transaction(() => {
      for (const key of args) {
        this.#statements.del.run(key)
      }
    })()
  }

  async del(key: string) {
    this.mdel(key)
  }

  async reset() {
    this.#statements.reset.run()
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
      rows = this.#statements.keysPattern.all(pattern)
    } else {
      rows = this.#statements.keys.all()
    }

    return rows.map((r) => r.key)
  }

  #serialize(obj: unknown) {
    return this.#serializer.serialize(obj)
  }

  #deserialize(payload: string) {
    return this.#serializer.deserialize(payload)
  }

  #purgeExpired() {
    this.#statements.purgeExpired.run(now())
  }
}

const sqliteStore: FactoryStore<
  SqliteCacheAdapter,
  SqliteCacheAdapterOptions
> = (options) => {
  return new SqliteCacheAdapter({
    name: 'kv',
    path: ':memory:',
    ...options,
  })
}

export default sqliteStore
