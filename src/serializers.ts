import * as cbor from 'cbor-x'

export default {
  json: {
    serialize: (o: unknown) => JSON.stringify(o),
    deserialize: (p: string) => JSON.parse(p),
  },
  cbor: {
    serialize: (o: unknown) => cbor.encode(o),
    deserialize: (p: any) => cbor.decode(p),
  },
}
