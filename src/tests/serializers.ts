import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import cacheManager from 'cache-manager'
import sqliteStore from '../index'

describe('cacheManager serializers', () => {
  it('supports CBOR', async () => {
    const cache = await cacheManager.caching(sqliteStore, {
      serializer: 'cbor',
    })

    await cache.set('foo', { foo: 'bar', arr: [1, true, null] })
    assert.deepEqual(await cache.get('foo'), {
      foo: 'bar',
      arr: [1, true, null],
    })
  })

  it('supports JSON', async () => {
    const cache = await cacheManager.caching(sqliteStore, {
      serializer: 'json',
    })

    await cache.set('foo', { foo: 'bar', arr: [1, true, null] })
    assert.deepEqual(await cache.get('foo'), {
      foo: 'bar',
      arr: [1, true, null],
    })
  })
})

describe('cacheManager custom serializers', () => {
  it('bad serializer throws', async () => {
    const cache = await cacheManager.caching(sqliteStore, {
      serializer: {
        serialize: (): string => {
          throw new Error('Fake error')
        },
        deserialize: (): unknown => {
          throw new Error('Fake error')
        },
      },
    })

    assert.rejects(
      async () => await cache.set('foo', { foo: 'bar', arr: [1, true, null] })
    )
  })

  it('bad deserializer throws', async () => {
    const cache = await cacheManager.caching(sqliteStore, {
      serializer: {
        serialize: (p) => JSON.stringify(p),
        deserialize: (): unknown => {
          throw new Error('Fake error')
        },
      },
    })

    await cache.set('foo', { foo: 'bar', arr: [1, true, null] })
    assert.rejects(async () => await cache.get('foo'))
  })
})
