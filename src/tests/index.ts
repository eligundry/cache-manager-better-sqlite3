import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import cacheManager, { Cache } from 'cache-manager'
import sinon from 'sinon'
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

  before(async () => {
    cache = await cacheManager.caching(sqliteStore, {
      path: '/tmp/test1.db',
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

  it('should set and get value with ttl', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value, 200)

    assert.deepEqual(await cache.get(key), value)
  })

  it('should return undefined if the key does not exist', async () => {
    assert.equal(await cache.get('foo' + new Date().getTime()), undefined)
  })

  it('should return undefined if the key has expired', async () => {
    const key = createKey()
    const value = { foo: 1 }
    await cache.set(key, value, -200)

    assert.deepEqual(await cache.get(key), undefined)
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

  it('should have mset respect ttl if passed', async () => {
    const keys = ['mset1', 'mset2', 'mset3']
    await cache.store.mset(
      keys.map((k, i) => [k, i + 1]),
      -1
    )
    const vals = await cache.store.mget(...keys)
    assert.deepEqual(vals, [undefined, undefined, undefined])
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
