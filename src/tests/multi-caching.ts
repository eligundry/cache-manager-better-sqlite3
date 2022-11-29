import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import cacheManager from 'cache-manager'
import sqliteStore from '../index'

const cacheFactory = async () => {
  const cache = cacheManager.multiCaching([
    await cacheManager.caching(sqliteStore, {
      path: '/tmp/test1.db',
    }),
  ])

  return cache
}

describe('cache-manager.multiCaching', async () => {
  afterEach(async () => {
    const cache = await cacheFactory()
    await cache.reset()
  })

  it('should reject when setting bad value', async () => {
    const cache = await cacheFactory()
    assert.rejects(async () => await cache.set('foo-bad', function () {}))
  })

  it('get value when TTL within range from set', async () => {
    const cache = await cacheFactory()
    const key = 'foo' + new Date().getTime()
    const valu = { foo: 1 }

    await cache.set(key, valu, -200)
    const val = await cache.get(key)
    assert.equal(val, undefined)
  })

  it('should read saved value', async () => {
    const cache = await cacheFactory()
    const key = 'foo' + new Date().getTime()
    const valu = { foo: 1 }

    await cache.set(key, valu)
    const val = await cache.get(key)
    assert.deepEqual(val, valu)
  })

  it('does not error on del non-existent key', async () => {
    const cache = await cacheFactory()
    const key = 'foo' + new Date().getTime()

    await cache.del(key)
  })

  it('removes existing key with del', async () => {
    const cache = await cacheFactory()
    const key = 'foo' + new Date().getTime()
    const valu = { foo: 1 }

    await cache.set(key, valu)
    await cache.del(key)
    const v = await cache.get(key)
    assert.equal(v, undefined)
  })

  it('truncates database on reset', async () => {
    const cache = await cacheFactory()
    const key = 'foo' + new Date().getTime()
    const valu = { foo: 1 }

    await cache.set(key, valu)
    await cache.reset()
    const v = await cache.get(key)
    assert.equal(v, undefined)
  })
})
