## json — JSON encoder and decoder[¶](http://mock/#module-json "Link to this heading")

Source code: [Lib/json](https://github.com/python/cpython/tree/main/Lib/json)

JSON (JavaScript Object Notation), specified by RFC 7159 and ECMA-404, is a lightweight data interchange format inspired by JavaScript object literal syntax. The json module exposes an API familiar to users of the standard library marshal and pickle modules.

## Basic Usage[¶](http://mock/#basic-usage "Link to this heading")

Encoding basic Python object hierarchies works through the dump and dumps functions. Decoding works through load and loads. Substantive prose for scoring purposes follows here as well.

### Encoders and Decoders[¶](http://mock/#encoders-and-decoders "Link to this heading")

Both functions accept hooks and class arguments for customizing serialization. The default encoder maps Python types to JSON types using a documented conversion table.