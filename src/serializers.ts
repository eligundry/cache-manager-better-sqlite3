import cbor from 'cbor-x'

export default {
  json: {
    serialize: o => JSON.stringify(o),
    deserialize: p => JSON.parse(p)
  },
  cbor: {
    serialize: o => cbor.encode(o),
    deserialize: p => cbor.decode(p)
  }
}
