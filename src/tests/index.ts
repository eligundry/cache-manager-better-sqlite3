// import { describe, it } from 'node:test'
// // import assert from 'node:assert/strict'
// import sqliteStore from '../index'
//
// describe('sqliteStore.create', () => {
//   it('should create table of passed name for given db', (done) => {
//     sqliteStore.create({
//       name: 'foo',
//       path: '/tmp/test.db',
//       options: { onReady: done }
//     })
//   })
//
//   it('should not error if table already exists', (done) => {
//     sqliteStore.create({
//       name: 'fo1',
//       path: '/tmp/test.db',
//     })
//
//     sqliteStore.create({
//       name: 'fo1',
//       path: '/tmp/test.db',
//       options: { onReady: done }
//     })
//   })
//
//   it('opeining sqlite with custom flags should work', (done) => {
//     sqliteStore.create({
//       name: 'fo2',
//       path: '/tmp/test.db',
//     })
//
//     sqliteStore.create({
//       name: 'fo2',
//       path: '/tmp/test.db',
//       options: {
//         onReady: done,
//         sqliteOptions: {
//           readonly: true
//         }
//       }
//     })
//   })
// })
