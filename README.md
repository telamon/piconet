[`pure | 📦`](https://github.com/telamon/create-pure)
[`code style | standard`](https://standardjs.com/)
```ascii
 ____  _           _   _      _
|  _ \(_) ___ ___ | \ | | ___| |_
| |_) | |/ __/ _ \|  \| |/ _ \ __|
|  __/| | (_| (_) | |\  |  __/ |_
|_|   |_|\___\___/|_| \_|\___|\__|
Minimal network stack
```

This library is a redesign of network interactions.
It started as a separation layer between Application and Network,
solving the need to factor out Network when debugging
the application.

Initial design specs:

- want a single solid error handler.
- want a single method to close/destroy/end the connection.
- want application to be transport/runtime/lock-in agnostic.
- want nodes using piconet over multiple protocols to form a bridge between networks.
- no more EventEmitters. Use Promises
- no network in tests and simulation.

> Disclaimer: no responsibilities taken 🦶🔫

## 3.x spec

**Receiver** `Array(2)`

The resolved return value of a Transmitter
contains the received message and next transmitter if so signaled by other end.
```js
rx[0] // message: Buffer
rx[1] // transmitter: Function?
```

**Transmitter** `async function`

Functions `postMessage` and `replyTo` are considered transmitters.
They take exactly 2 arguments;

```js
@param {Buffer} message
@param {Boolean} flag, default: false
```

**Plug**
```
/* State: 4 getters */
plug.id // {string} `writable` optional wire label
plug.isActive // {boolean} true when other end is open and not closed.
plug.isClosed // {boolean} true after any end is closed.
plug.other // {Plug} reference to other end

/* Actions: 3 methods */
plug.open(handler|plug) // {function} broadcast receiver
                      splices two wires together if passed a plug.

plug.close(Error?) // Disconnect with optional error

// Transmit
plug.postMessage(data: Buffer, replyExpected: boolean) // => [message, replyTo]

/* Events: 2 */
await plug.opened // {Promise} `readonly` resolves if/when both ends
                                          are plugged in.
await plug.closed // {Promise} `readonly` resolves when any end is
                                          closed.
```

## Use

```bash
$ yarn add piconet
```

## Examples

Anything that is pushed into one wire end; emerges at the other.
```js
import { picoWire } from 'piconet'
const [plugA, plugB] = picoWire({ id: 'OptionalLabel })

plugA.onmessage = (data, replyTo) => console.log('A received:', data)
plugB.postMessage(Buffer.from('Hello A!'))

// => A received: Hello A!
```

When sending a message, you can `await` a reply:
```js
const [plugA, plugB] = picoWire({ id: 'OptionalLabel })

plugA.onmessage = (data, replyTo) => {
  console.log('A received:', data)
  replyTo('Hey B!')
}

// Second parameter flags 'replyExpected' as true
const [data, replyTo] = await plugB.postMessage(Buffer.from('Hello A!'), true)
console.log('B received:', data)

// => A received: Hello A!
// => B received: Hey B!
```

This can be used to hold an conversation:
```js
const [a, b] = picoWire()

a.onmessage = ([data, replyTo]) => {
  console.log('A received:', data)
  replyTo('Hello Bob', true)
    .then(([data, replyTo]) => {
      console.log('A received:', data)
      return replyTo('No AFAIK we are communicating over latched Promises', true)
    })
    .then(([data, replyTo]) => {
      console.log('A received:', data)
      return replyTo('Yes way! We can debug-step between nodes! :o', true)
    })
    .then(([data, replyTo]) => {
      console.log('A received:', data)
      return replyTo('Yup! :> a wire without network', true)
    })
    .then(([data, replyTo]) => {
      console.log('A received:', data)
      return replyTo('Do not worry, check the transport section', false)
    })
}

await b.postMessage('Hey Alice!', true)
  .then(([data, replyTo]) => {
    console.log('B received:', data)
    return replyTo('Is this data transmitted over network?', true)
  })
  .then(([data, replyTo]) => {
    console.log('B received:', data)
    return replyTo('No way??', true)
  })
  .then(([data, replyTo]) => {
    console.log('B received:', data)
    return replyTo('Holy Mango! But then there is no actual network?', true)
  })
  .then(([data, replyTo]) => {
    console.log('B received:', data)
    return replyTo('That sounds a bit... illogical', true)
  })
  .then(([data, replyTo]) => console.log('B received:', data))
```

Outputs:
```bash
A received: Hey Alice!
B received: Hello Bob
A received: Is this data transmitted over network?
B received: No AFAIK we are communicating over latched Promises
A received: No way??
B received: Yes way! We can debug-step between nodes! :o
A received: Holy Mango! But then there is no actual network?
B received: Yup! :> a wire without network
A received: That sounds a bit... illogical
B received: Do not worry, check the transport section
```

## RPC
And to build an remote procedure call service

```js
import { Hub } from 'piconet'

const rpc = new Hub(async (plug, message, replyTo) => {
  const command = message.toString()
  switch (command) {
    case 'hello':
      await replyTo('Hi there')
      break

    case 'time':
      await replyTo(Date.now() + '')
      break

    case 'get_price': {
      const [subCommand, r] = replyTo('get price of?', true)
      const table = {
        'ice-cream': 3,
        'beer': 2,
        'freedom': Infinity
      }
      await r(table[subCommand])
    }

    default:
      await replyTo('InvalidCommand')
      plug.close()
  }
})

rpc.createWire() // => Plug
```

## Transports
When the App's tests pass,
it's time to switch protocols.

Here's an example that acts as a bridge between
tcp, hyperswarm and Websocket.
###

```js
import { createConnection } from 'node:net'
import {
  picoWire,
  hyperWire,
  wsWire,
  streamWire,
  Hub
} from 'piconet'

const repeater = new Hub() // default mode: dumb repeater

// Connect TCP localhost:5554
const stream = createConnection({ port: '5554' })
streamWire(repeater.createWire(), stream)

// Websocket
wsWire(
  repeater.createWire(),
  new Websocket('wss://someplatform.tld')
)

// hyperWire
TODO: haven't looked at hyperswarm-v3 yet;
hyperWire(repeater.createWire(), secretStream, key)

// Transmit on all channels
const plug = repeater.createWire()
await plug.postMessage('Cross-protocol hello!')
```
---

Developed by Decent Labs 2023 - AGPL - Discord:  https://discord.gg/8RMRUPZ9RS
