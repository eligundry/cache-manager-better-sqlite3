# cache-manager-better-sqlite3

A modern SQlite cache store for [node-cache-manager](https://github.com/BryanDonovan/node-cache-manager). Featuring:

 - Async sqlite3 using [better-sqlite3](https://www.npmjs.com/package/better-sqlite3)
 - `async`/`await` support with Promise
 - 100% test coverage and production ready
 - Optimized `mset`/`mget` support
 - Supports CBOR for efficient and fast storage (selectable between `json` or `cbor` default: `cbor`)
 - Support for custom serializers
 - Smart purging support, no configuration required

This is a fork of [node-cache-manager-sqlite](https://github.com/maxpert/node-cache-manager-sqlite). The big differences
between this and the original are:

- Swapping out sqlite3 for better-sqlite3 as sqlite3 has a bunch of unneeded dependencies for testing that are specified
  as required that will break in a Vite build environment.
- It only supports initialization and configuration through the API specified via cache-manager >= 5.0.0
- Full Typescript support!
- ESM (I'm so sorry in advance, you will need to do some annoying stuff to make this work as better-sqlite3 isn't ESM).
- When passing invalid values to the serialization functions, errors are thrown instead of silently swallowed.
- `mget` will return `undefined` for values that do not exist instead of omitting them.

## Why?

The goal was to have a local key value storage built on top of [proven technology](https://www.sqlite.org/testing.html).
While other options like [node-cache-manager-fs-binary](https://github.com/sheershoff/node-cache-manager-fs-binary) have
similar functionality; they are littered with all sort of problems from race conditions, (multi-process) to corruption.
SQLite on the other end has been battle tested, and using WAL allows multiple node processes (forked web servers) to share the same
cache across various processes, without the headaches of flat file based systems.

SQLite based storage is ideal for:
 - Faster local storage than filesystem. [Yes you heard it right](https://www.sqlite.org/fasterthanfs.html)
 - Reslience to corruption and recovery.
 - Multiprocess Node.js processes (typical in server deployments with many cores)
 - Large number of entries.

## Installation

```
npm i cache-manager-better-sqlite3
```

## Requirements

 - SQLite 3 with [better-sqlite3 package](https://www.npmjs.com/package/better-sqlite3)
 - Node 14+

## Usage

## Single store
```typescript
import sqliteStore from 'cache-manager-better-sqlite'
import cacheManager from 'cache-manager'

// SQLite :memory: cache store
const memStoreCache = await cacheManager.caching(sqliteStore{
  serializer: 'json', // default is 'cbor'
  ttl: 20 // TTL in seconds
})

// On disk cache on employees table
const cache = await cacheManager.caching(sqliteStore, {
  name: 'employees',
  path: '/tmp/cache.db'
})


// TTL in seconds
await cache.set('foo', { test: 'bar' }, 10)
const value = await cache.get('foo')
```

### Multi-store example:

```typescript
import cacheManager from 'cache-manager'
import redisStore from 'cache-manager-ioredis'
import sqliteStore from 'cache-manager-better-sqlite'

const redisCache = await cacheManager.caching(redisStore, {
  db: 0,
  ttl: 600,
})
const sqliteCache = await cacheManager.caching(sqliteStore, {
  path: '/tmp/cache.db',
  name: 'users',
  ttl: 600,
})

const multiCache = cacheManager.multiCaching([sqliteCache, redisCache])

// Basic get/set
await multiCache.set('foo2', 'bar2', customTTL)
const v = await multiCache.get('foo2')

// Wrap call example
const userId = 'user-1'

// Optionally pass ttl
await multiCache.wrap(userId, async () => {
  console.log("Calling expensive service")
  const value = await getUserFromExpensiveService(userId)
  return value
}, customTTL)
```

## Contributing

This package requires Node v18 or higher for development as it uses the built in Node test runner.

```bash
# Run the tests
$ npm test
# Prettier the files
$ npm run prettier
```

## License

The `node-cache-manager-better-sqlite` is licensed under the MIT license.
