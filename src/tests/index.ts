import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import cacheManager, { Cache } from 'cache-manager'
import sinon from 'sinon'
import { Database } from 'better-sqlite3'
import sqliteStore, { SqliteCacheAdapter } from '../index'

const createKey = () => 'foo' + process.hrtime.bigint()

describe('cache-manager.caching', () => {
  it('should be able to open directly using SqliteCacheAdapter constructor', () => {
    cacheManager.caching(
      new SqliteCacheAdapter({
        name: 'fool',
        path: '/tmp/cache.db',
      })
    )
  })

  it('should be able to use default options', () => {
    cacheManager.caching(sqliteStore)
  })

  it('should be able to open via options', (done) => {
    cacheManager.caching(sqliteStore, {
      name: 'fool',
      path: '/tmp/cache.db',
      onReady: () => {
        done()
      },
    })
  })

  it('should create the kv tables', () => {
    cacheManager.caching(sqliteStore, {
      path: ':memory:',
      onReady: (db) => {
        const schema = db
          .prepare("SELECT * FROM schema WHERE name = 'kv'")
          .get()
        assert(!!schema)
        assert.equal(schema.name, 'kv')
      },
    })
  })
})

describe('cacheManager methods', () => {
  let cache: Cache
  let db: Database

  before(async () => {
    cache = await cacheManager.caching(sqliteStore, {
      path: '/tmp/test1.db',
      onReady: (database) => {
        db = database
      },
    })
  })

  afterEach(async () => {
    await cache.reset()
  })

  it('should throw error if value is unserializable', async () => {
    assert.rejects(async () => await cache.set('foo-bad', function () {}))
  })

  it('should set and get value', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value)

    assert.deepEqual(await cache.get(key), value)
  })

  it('should set ttl to Infinity if not provided', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value)

    assert.deepEqual(await cache.get(key), value)

    const stmt = db.prepare('select * from kv where key = ?')
    const row = stmt.get(key)
    assert.equal(row.expire_at, Infinity)
  })

  it('should set and get value with ttl', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value, 200)

    assert.deepEqual(await cache.get(key), value)
  })

  it('should return undefined if the key does not exist', async () => {
    assert.equal(await cache.get(createKey()), undefined)
  })

  it('should return undefined if the key has expired', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value, -200)

    assert.deepEqual(await cache.get(key), undefined)
  })

  it('should have get purge expired keys if key is expired', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value, -200)
    await cache.set(createKey(), 1, -500)

    assert.deepEqual(await cache.get(key), undefined)

    await new Promise((resolve) => {
      process.nextTick(() => {
        const stmt = db.prepare('select count(*) as records from kv')
        assert.equal(stmt.get().records, 0)
        resolve(true)
      })
    })
  })

  it('should update value if it already exists', async () => {
    const key = createKey()
    await cache.set(key, 1)
    assert.equal(await cache.get(key), 1)
    await cache.set(key, 200)
    assert.equal(await cache.get(key), 200)
  })

  it('should delete saved key', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value)
    await cache.del(key)
    assert.equal(await cache.get(key), undefined)
  })

  it('should not throw an error when deleting an non-existent key', async () => {
    assert.doesNotReject(async () => await cache.del(createKey()))
  })

  it('should return all keys when queried', async () => {
    const targetKey = createKey()
    await cache.set(targetKey, 1)
    const keys = await cache.store.keys()
    assert(keys.includes(targetKey))
    assert(keys.length > 0)
  })

  it('should be able to filter keys with a pattern', async () => {
    const allKeys = ['foo1', 'foo2', 'bar1', 'bar2', 'foo10000']
    await Promise.all(allKeys.map((key, i) => cache.set(key, i)))
    const keys = await cache.store.keys('foo%')
    assert.deepEqual(
      keys,
      allKeys.filter((k) => k.startsWith('foo'))
    )
  })

  it('should truncate the database on reset', async () => {
    await cache.set(createKey(), 1)
    await cache.reset()
    const keys = await cache.store.keys()
    assert.equal(keys.length, 0)
  })

  it('should return the ttl of a key', async () => {
    const key = createKey()
    await cache.set(key, 1)
    const ttl = await cache.store.ttl(key)
    assert(typeof ttl === 'number')
    assert(ttl > 0)
  })

  it('should return a ttl of Infinity if the key does not exist', async () => {
    assert.equal(await cache.store.ttl(createKey()), Infinity)
  })

  it('should be able to mset and mget values', async () => {
    const keys = ['mset1', 'mset2', 'mset3']
    await cache.store.mset(keys.map((k, i) => [k, i + 1]))
    const vals = await cache.store.mget(...keys)
    assert.deepEqual(vals, [1, 2, 3])
  })

  it('should have mget return undefined for keys that do not exist', async () => {
    const keys = ['mget0', 'mget1', 'mget2', 'mget3']
    await cache.store.mset([
      [keys[0], 1],
      [keys[2], 3],
    ])
    const vals = await cache.store.mget(...keys)
    assert.deepEqual(vals, [1, undefined, 3, undefined])
  })

  it('should have mget purge expired keys if a key is expired', async () => {
    const keys = [createKey(), createKey(), createKey(), createKey()]
    await cache.store.mset(
      [
        [keys[0], 1],
        [keys[1], 2],
      ],
      -500
    )
    await cache.store.mset([
      [keys[2], 3],
      [keys[3], 4],
    ])
    const [expired1, expired2, valid1, valid2] = await cache.store.mget(...keys)

    assert.equal(expired1, undefined)
    assert.equal(expired2, undefined)
    assert.equal(valid1, 3)
    assert.equal(valid2, 4)

    await new Promise((resolve) => {
      process.nextTick(() => {
        const stmt = db.prepare('select count(*) as records from kv')
        assert.equal(stmt.get().records, 2)
        resolve(true)
      })
    })
  })

  it('should have mget retain gaps in queries', async () => {
    const keys = [createKey(), 'nope', createKey()]
    await cache.store.mset([
      [keys[0], 1],
      [keys[2], 2],
    ])
    assert.deepEqual(await cache.store.mget(...keys), [1, undefined, 2])
  })

  it('should have mget retain order of the keys in queries', async () => {
    const keys = [createKey(), createKey(), createKey()]
    await cache.store.mset(keys.map((k, i) => [k, i]))
    assert.deepEqual(
      await cache.store.mget(keys[1], keys[0], keys[2]),
      [1, 0, 2]
    )
  })

  it('should have mset respect ttl if passed', async () => {
    const keys = ['mset1', 'mset2', 'mset3']
    await cache.store.mset(
      keys.map((k, i) => [k, i + 1]),
      -1
    )
    const vals = await cache.store.mget(...keys)
    assert.deepEqual(vals, [undefined, undefined, undefined])
  })

  it('should be able to wrap an async function and set value to what is returned', async () => {
    const key = createKey()
    await cache.wrap(key, async () => {
      return 1
    })
    assert.equal(await cache.get(key), 1)
  })

  it('should not set value if isCacheable returns false', async () => {
    const isCacheableSpy = sinon.spy()
    cache = await cacheManager.caching(sqliteStore, {
      path: '/tmp/test1.db',
      isCacheable: (value) => {
        isCacheableSpy(value)
        return false
      },
    })
    assert.rejects(async () => await cache.set('key', 1), /no cacheable value/)
    sinon.assert.calledOnce(isCacheableSpy)
    sinon.assert.calledWith(isCacheableSpy, 1)
  })

  it('should not mset values if isCacheable returns false', async () => {
    const isCacheableSpy = sinon.spy()
    cache = await cacheManager.caching(sqliteStore, {
      path: '/tmp/test1.db',
      isCacheable: (v) => {
        isCacheableSpy(v)
        return typeof v === 'number' && v % 2 !== 0
      },
    })

    assert.rejects(
      async () =>
        await cache.store.mset([
          ['foo', 1],
          ['bar', 2],
          ['baz', 3],
        ]),
      /no cacheable value/
    )
    sinon.assert.calledTwice(isCacheableSpy)

    // No rows should be saved in this instance
    const query = db.prepare('select count(*) as records from kv')
    assert.equal(query.get().records, 0)
  })
})

describe('sqlite failure handling', () => {
  let cache: Cache<SqliteCacheAdapter>
  let prepareSpy: any

  before(async () => {
    cache = await cacheManager.caching(sqliteStore, {
      path: ':memory:',
      onReady: (db) => {
        prepareSpy = sinon.stub(db, 'prepare')
      },
    })
  })

  beforeEach(() => {
    prepareSpy.reset()
  })

  afterEach(() => {
    prepareSpy.restore()
  })

  it('should fail get if sqlite errors out', async () => {
    prepareSpy.rejects(new Error('Fake error'))
    assert.rejects(async () => cache.get('foo'), 'Fake error')
  })

  it('should fail ttl if sqlite errors out', async () => {
    prepareSpy.yieldsRight(new Error('Fake error'))
    assert.rejects(async () => cache.store.ttl('foo'), 'Fake error')
  })
})
