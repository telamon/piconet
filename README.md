[`pure | 📦`](https://github.com/telamon/create-pure)
[`code style | standard`](https://standardjs.com/)
# piconet

> Minimal and opinionated network stack

This is an experimental redesign of how we communicate over networks
in an attempt to make life easier for P2P app developers.


It was created with the following constraints in mind:

- Offline-first applications should not maintain network state,
  they should function with or without network, using data-types that are
  conflict-resistant should mitigate any signal fluctuations or out-of-order
  messages.

- In networks without a supernode, it is pointless for applications
  to maintain individual peer identities.
  Though replying to a specific source is still a valid use-case.

- To minimize braindamage and timeloss caused by troubleshooting network-issues
  In unit-tests I want to have non-eventdriven and traceable call-stacks and also
  be able to easier mimic network topologies.

- My Application should be transport agnostic and operate regardless if it's
  messages are transmitted:
    - over network sockets
    - in-browser [`postMessage`]() (ex. ServiceWorker IPC)
    - in-memory unit tests
    - bonus: plugging a usb-thumbdrive back and forth between computers.


> Disclaimer: I take no responsibility for any foot injury. 🦶🔫

## Use

```bash
$ npm install piconet
```

Basic repeater-hub with 2 wires:
```js
const Hub = require('piconet')

const hub = new Hub()

const wireA = hub.createWire()((message, reply) => {
  console.log(message.toString()) // => Hello Alice
  reply(Buffer.from('Hey Bob!'))
})


const wireB = hub.createWire()()

wireB(Buffer.from('Hello Alice'), (message, reply) => {
  console.log(message.toString()) // => Hey Bob!
  wireB.close()
})
```

## Basic API

Heavily inspired by the infamous and easy to use `(request, response) => {}` handler
found in software such as `express.js`.

The initial idea revolves around two symmetric interfaces
that unwinds a traditional stream of messages into
parallel lock-stepped "conversations".

Which I hope is a better fit for use-cases without servers.

### SendInterface `send(message, replyHandler)`

**Arguments**

- **message** `Buffer|Uint8Array` - the payload to send.
- replyHandler `function` (optional) - message handler for replies to this payload, see ReplyHandler below

**Description**

The `send` interface roughly translates to "the remotes reply handler"
and holds true when doing in-memory transmissions.

The root send the function also has a `close` property which is a function that disconnects the wire.
`send.close()` Disconnects the wire. Subject to refinement.

### ReplyHandler `function (message, replyTo) {...}`

**Provided parameters**
- **message** `Buffer|Uint8Array` - the received message in binary form.
- replyTo `function` - an instance of SendInterface described above or `undefined`


**Description**

In the event that `replyTo` equals `undefined` it indicates end of
a conversation, in other words: the remote does not expect a reply.

Example handler:
```js
const miniRPC = (message, reply) => {
  switch (message[0]) { // Use first byte as type
    case 0: // Greet service
      reply(Buffer.from('Hello'))
      break
    case 1: // Time service
      reply(Buffer.from(new Date()))
      break
    case 2: // Innuendo service
      reply(Buffer.from('The hear the birds are flying south', (msg, reply) => {
        if (msg.toString() === 'But the rivers are not yet frozen!') {
          reply(Buffer.from('Hail Admin!'), imaginarySuperRPC)
        } else {
          reply(Buffer.from('Or so they say...'))
        }
      })
    default:
      disconnect()
  }
}
```

## Extended use

As an application developer you are only exposed to pluggable wires.

When you invoke `hub.createWire()` it returns a "unplugged" wire (a.k.a `connect` function) that you can choose to plug
into either your application or to another transport protocol.

```js
const hub = new PicoHub()

const connect = hub.createWire() // returns a dangling wire
const send = connect(replyHandler) // Plug in the wire
```

### Transports

##### Wire to Wire
Connect two Hubs to each other
```js
const hub1 = new Hub()
const hub2 = new Hub()

hub1.createWire().pipe(hub2.createWire())

// broadcast message to all connected wires of both hubs.
hub2.broadcast(Buffer.from('WHO HAS pants'))
```


##### Wire to Stream
```js
const { createConnection } = require('net') // node std
const myStream = createConnection(host, port)

const wire = hub.createWire()
const disconnect = wire.pipe(myStream) // stream.pipe(wire) is not supported

// -- or --
const { wireStream } = require('piconet')
const disconnect = wireStream(wire, myStream, { mtu: 256 << 8, timeout: 30 * 1000 })
```

##### Wire to HyperSwarm
Simple swarm connected hub:
```js
const { hyperWire } = require('piconet')
const replicate = require('@hyperswarm/replicator')

const hub = new PicoHub(miniRPC) // see example above for miniRPC reference


const swarm = replicate(aHypercore, { // From @hyperswarm/replicator docs
  onstream (stream) {
    hyperWire(
      hub.createWire(),
      stream,
      aHypercore.key
    )
  }
})
// ( adapter might be reworked to use core.registerExtension() )
```
##### Wire to Hypercore protocol stream
Opens an encrypted channel and installs itself as an extension.

Example connecting two hubs over hypercore protocol streams:

```js
const { hyperWire } = require('piconet')
const ProtoStream = require('hypercore-protocol')


const key = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')

// Connect two streams as demonstrated hypercore-protocol docs
const hyperA = new ProtoStream(true)
const hyperB = new ProtoStream(false)

hyperA
  .pipe(hyperB)
  .pipe(hyperA)

// Set up 2 pico hubs
const hub1 = new PicoHub()
const hub2 = new PicoHub()

const disconnectA = hyperWire(hub1.createWire(), hyperA, key)
const disconnectB = hyperWire(hub2.createWire(), hyperB, key)
```

### Misc docs

##### Hub mode

The Hub class has 2 modes of operation; either as a blind
repeater of messages when initialized with empty constructor:
```js
const hub = new PicoHub() // repeater
```

Or it can act as a router where all incoming messages are received
only by the broadcast receiver.
```js
const hub = new PicoHub((msg, reply, disconnectWire) => {
  if (isGood(msg)) {
    this.broadcast(msg)  // forward messages to other wires
  } else if (isBad(msg)) {
    disconnectWire()
  } else {
    reply(Buffer.from('Please send good messages'))
  }
})
```

Mode can also be switched during runtime:

```
const hub = new PicoHub() // repeater
hub.tap(myBroadcastReceiver) // router
```

##### JSON transformer

```js
const PicoHub = require('piconet')
const { jsonTransformer } = PicoHub

const hub = new PicoHub()

// Currys `connect` with an transparent JSON encoder/decoder
const connect = jsonTransformer(hub.createWire())

// Both send and receive is no longer binary
const send = connect((msg, reply) => {
  console.log(msg) // => { nick: 'doedoe87', hobbies: 'gaming' }

  if (msg.hobbies === 'sleeping') {
    reply({ subscribeTo: 'friendship' })
  }
})

send({ hello: 'world' })
```

#### `hub.survey(message, timeout) // => async iterator`

Survey is a special broadcast that is exposed as an async generator.
It will broadcast a message to all connected wires and await exactly one
reply from each source or until a certain timeout is reached.

```
// Imagine hyperswarm-connected hub as
// demonstrated in simple swarm example
const hub = ...

const query = Buffer.from('Should crime be abolished?')

let yay = 0
let nay = 0

for await (const [msg, reply, abort] of hub.survey(query, 30000)) {
  if (msg.toString() === 'yay) jerry++
  else ben++
}

console.log({
  inFavour: yay,
  against: nay
})
```

The `abort` callback is used to ignore further replies:

```js
const hub = ... // swarm connected hub

const query = Buffer.from("What's the capital of sweden?")

for await (const [msg, reply, abort] of hub.survey(query, 30000)) {
  if (msg.toString() === 'Stockholm') {
    abort()
    reply(Buffer.from('Ding! You win!'))
  } else {
    reply(Buffer.from('Better luck next time'))
  }
}
```

##### Building a wirehost
The wirehost is reponsible for maintaining network
state.

If a connection is dropped or times out it is
the wirehost's responsibility to recover from failure
and release allocated resources.

```
const { picoWire } = require('piconet')

const spawnCustomWire = () => {
  const onmessage = (msg, replyTo, disconnectWire) => {
    ...
  }

  const onopen = (sink, disconnectWire) {
    // sink: is the message handler passed to connect()
    ...
  }

  const onclose = sink => {
    // sink: is the message handler passed to connect()
    ...
  }

  return picoWire (onmessage, onopen, onclose)
}

const connect = spawnCustomWire()

const send = connect(myHandler)

// refer to Hub.createWire() implementation for mor info.
```

## Donations

```ad
 _____                      _   _           _
|  __ \   Help Wanted!     | | | |         | |
| |  | | ___  ___ ___ _ __ | |_| |     __ _| |__  ___   ___  ___
| |  | |/ _ \/ __/ _ \ '_ \| __| |    / _` | '_ \/ __| / __|/ _ \
| |__| |  __/ (_|  __/ | | | |_| |___| (_| | |_) \__ \_\__ \  __/
|_____/ \___|\___\___|_| |_|\__|______\__,_|_.__/|___(_)___/\___|

If you're reading this it means that the docs are missing or in a bad state.

Writing and maintaining friendly and useful documentation takes
effort and time. In order to do faster releases
I will from now on provide documentation relational to project activity.

  __How_to_Help____________________________________.
 |                                                 |
 |  - Open an issue if you have ANY questions! :)  |
 |  - Star this repo if you found it interesting   |
 |  - Fork off & help document <3                  |
 |.________________________________________________|

I publish all of my work as Libre software and will continue to do so,
drop me a penny at Patreon to help fund experiments like these.

Patreon: https://www.patreon.com/decentlabs
Discord: https://discord.gg/tJhmxqX
```


## Changelog

### 0.1.0 first release

## Contributing

By making a pull request, you agree to release your modifications under
the license stated in the next section.

Only changesets by human contributors will be accepted.

## License

[AGPL-3.0-or-later](./LICENSE)

2020 &#x1f12f; Tony Ivanov
