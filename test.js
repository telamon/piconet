// Networks sucks
const test = require('tape')
const { BufferedThrottleStream } = require('hyper-simulator')
const ProtoStream = require('hypercore-protocol')
const Hub = require('.')
const varint = require('varint')
const {
  picoWire, // 2.x
  _picoWire, // 1.x
  hyperWire,
  jsonTransformer,
  encodingTransformer,
  unpromise,
  spliceWires
} = Hub

// Unix sockets were a blast, a simplified variant
// of a network connection in a local system.
// Abstractions are good, until we have to live with them

test('@legacy: PicoWire: basic wire', t => {
  t.plan(7)
  // A wire host such as the Hub owns the network state
  // and is forced to provide 3 handlers:
  // - onmessage
  // - onopen
  // - onclose
  const connect = _picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'hello from human', '6 Client initated message recieved')
      reply(Buffer.from('hello from machine'))
    },
    sink => {
      sink(Buffer.from('auto greet'))
    },
    error => {
      t.notOk(error, '5. closed without error')
      t.end()
    }
  )

  t.equal(typeof connect, 'function', '1 pipe() exported on loose wire end')

  function consumerHandler (msg, reply, close) {
    t.equal(msg.toString(), 'auto greet', '2 Broadcast received')
    t.notOk(reply, '3 No reply provided')
  }

  // A wire consumer (App) is only required to provide the onmessage handler,
  // minimizing the complexity to communicate.
  const toHost = connect(consumerHandler)
  t.equal(typeof toHost.close, 'function', '4 close() exported')

  // Test consumer initated conversation
  toHost(Buffer.from('hello from human'), (msg, reply) => {
    t.equal(msg.toString(), 'hello from machine', '7 reply recevied')
    toHost.close()
  })
})

test('@legacy: PicoWire: pipe/ splice two wire ends together', async t => {
  // t.plan(5)
  const [messagingFinished, set] = unpromise()
  const connectA = _picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'AUTO_B', '1. msg onopen from B')
    },
    sink => {
      sink(Buffer.from('AUTO_A'))
    },
    err => t.notOk(err, 'A closed'),
    'alice'
  )
  const connectB = _picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'AUTO_A', '2. msg onopen from A')
      set()
    },
    sink => {
      sink(Buffer.from('AUTO_B'))
    },
    err => {
      t.notOk(err, 'B closed')
    },
    'bob'
  )
  const close = connectA(connectB)
  await messagingFinished
  t.equal(typeof close, 'function', 'legacy return()')
  close()
})

// A regular binary stream
// DOUBLESKIP (never got this working in 1.x)
test.skip('StreamWire: duplex stream to wire adapter', t => {
  t.plan(9)
  let destroyB = null
  const dualHead = new BufferedThrottleStream({ id: 'A' }, { id: 'B' })
  const connectA = picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'TO_A_BROADCAST', '5 B broadcast reply')
      reply(Buffer.from('TO_B_CALLBACK'))
    },
    sink => sink(Buffer.from('AUTO_A')),
    () => t.pass('7 A closed') // BUG! IS NEVER INVOKED.
  )
  const connectB = picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'AUTO_A', '4 msg onopen from A')
      reply(Buffer.from('TO_A_BROADCAST'), msg => {
        t.equal(msg.toString(), 'TO_B_CALLBACK', '6 conversation works')
        destroyB()
      })
    },
    () => t.pass('1 B opened'),
    () => t.pass('8 B closed')
  )
  const destroyA = connectA.pipe(dualHead)
  destroyB = connectB.pipe(dualHead.out)
  t.equal(typeof destroyA, 'function', '2 destroy A exported')
  t.equal(typeof destroyB, 'function', '3 destroy A exported')
  dualHead.autoPump(100)
    .then(() => t.pass('9 Stream closed'))
    .catch(t.error)
    .then(() => t.end())
})

test('PicoHub: survey() stops after all wires responded', async t => {
  const hub = new Hub()
  const query = Buffer.from('Anybody there?')

  // Spawn 10 wires
  for (let i = 0; i < 10; i++) {
    const plug = hub.createWire()
    plug.onmessage = (msg, reply) => {
      setTimeout(() => { // Simulate network latency
        t.ok(query.equals(msg), `#${i} request received`)
        reply(Buffer.from([i]))
        // 3rd wire is naughty and sends multiple replies...
        if (i === 3) reply(Buffer.from([99]))
      }, Math.random() * 300)
    }
  }

  const responses = []
  // Conditions for end
  // - operation reached maximum timeout
  // - a specific response satisfies the query. (stop() was invoked)
  // - all wires responded (no more messages expected
  for await (const [msg, reply, abort] of hub.survey(query, 1000)) {
    t.equal(typeof abort, 'function', 'abort is a function')
    t.notOk(reply, 'remote end does not expect a reply')
    responses.push(msg[0])
  }
  t.deepEqual(responses.sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'All wires responded')
})

/*
 * Should install itself as an "side-channel" extension
 * piggybacking onto an existing stream leveraging all the
 * secure handshake and encryption/privacy offered by the
 * hyper eco-system.
 */
test('HyperWire: hyper-protocol stream to wire adapter', async t => {
  t.plan(12)

  const encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')
  // Set up 2 connected hypercore-protocol streams
  const hyperA = new ProtoStream(true)
  const hyperB = new ProtoStream(false)
  hyperA.pipe(hyperB).pipe(hyperA)
  const [hyperStreamsClosed, setStreamsClosed] = unpromise()
  hyperA.on('close', () => t.pass('9 protostreamA closed'))
  hyperB.on('close', () => { t.pass('10 protostreamB closed'); setStreamsClosed() })

  const [a, c] = picoWire()
  a.onmessage = (msg, reply) => { t.fail('A Broadcast invoked') }
  a.onclose = err => t.notOk(err, '8 A closed')
  const [conversationWorks, done] = unpromise()
  // Leaving b with legacy style initialization just in case
  const connectB = _picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'AUTO_A', '4 msg onopen from A')
      reply(Buffer.from('TO_A_BROADCAST'), (msg, replyTo) => {
        t.equal(msg.toString(), 'TO_B_CALLBACK', '6 conversation works')
        t.notOk(replyTo, 'No more replies')
        done()
      })
    },
    () => t.pass('1 B opened'),
    () => t.pass('7 B closed')
  )
  const destroyA = hyperWire(c, hyperA, encryptionKey)
  const destroyB = hyperWire(connectB._plug, hyperB, encryptionKey)

  t.equal(typeof destroyA, 'function', '2 destroy A exported')
  t.equal(typeof destroyB, 'function', '3 destroy A exported')

  const [msg, reply] = await a.postMessage(Buffer.from('AUTO_A'), true)
  t.equal(msg.toString(), 'TO_A_BROADCAST', '5 B broadcast reply')
  const p = reply(Buffer.from('TO_B_CALLBACK'))
  await conversationWorks
  a.close()
  await hyperStreamsClosed
  t.notOk(p, 'Empty promise')
})

test('PicoHub: broadcast', t => {
  t.plan(3)
  const hub = new Hub()
  hub.createWire().open(msg => t.equal(msg.toString(), 'hello')) // A
  hub.createWire().open(msg => t.equal(msg.toString(), 'hello')) // B
  hub.createWire().open(msg => t.equal(msg.toString(), 'hello')) // C
  const wireD = hub.createWire().open(() => t.fail('Hub should not echo message to source'))
  wireD(Buffer.from('hello'))
  t.end()
})

test.skip('PicoWire AbstractEncoding transformer', t => {
  const hub = new Hub()
  const createEncodedWire = () => encodingTransformer(hub.createWire(), varint)

  createEncodedWire()((i, reply) => { // Receive A
    t.equal(i, 666)
    reply(7777)
  })

  const wireB = createEncodedWire()((msg, reply) => {
    t.fail('broadcast should not receive any messages')
  })

  wireB(666, (i, reply) => { // Receive B
    t.equal(i, 7777)
    t.notOk(reply, 'conversation ends')
  })
  t.end()
})

test.skip('PicoWire JSON transformer', t => {
  const hub = new Hub()
  const createJwire = () => jsonTransformer(hub.createWire())

  createJwire()((obj, reply) => { // Receive A
    obj.a++
    t.equal(obj.from, 'B')
    t.equal(obj.word, 'hello')
    reply({ from: 'A', word: 'bye' })
  })

  const wireB = createJwire()((msg, reply) => {
    t.fail('broadcast should not receive any messages')
  })

  wireB({ from: 'B', word: 'hello' }, (obj, reply) => { // Receive B
    t.equal(obj.from, 'A')
    t.equal(obj.word, 'bye')
    t.notOk(reply, 'conversation ends')
  })

  t.end()
})

test('picoWire() returns two ends for bi-directional messaging', async t => {
  t.plan(9)
  const [a, b] = picoWire()
  function aHandler (msg, reply) {
    t.equal(msg, 'Yo', '3. a called')
    t.notOk(reply, '4. No reply expected')
  }
  function bHandler (msg, reply) {
    t.equal(msg, 'Hello', '1. b called')
    t.notOk(reply, '2. No reply expected')
  }
  a.onmessage = aHandler
  a.postMessage('Hello')
  a.onclose = err => t.notOk(err, '6. a onclose invoked without error')
  b.onclose = err => t.notOk(err, '5. b onclose invoked without error')
  // functional api
  const sink = b.open(bHandler)
  sink('Yo')
  a.close()
  t.equal(a.closed, b.closed, '7. both pipe ends are closed')
  t.ok(a.closed, '8. pipe is closed')
  t.notOk(a.opened, '9. pipe is not opened')
})

test('picoWire() does not eat errors occuring in onmessage', async t => {
  t.plan(5)
  const [a, b] = picoWire()
  b.onclose = err => t.equal(err.message, 'FakeError')
  a.onclose = err => t.equal(err.message, 'FakeError')
  a.onmessage = msg => {
    if (msg !== 'Hi!') throw new Error('FakeError')
  }
  const sink = b.open(msg => t.fail('Truly Unexpected Message'))
  sink('Hola!')
  t.equal(a.closed, b.closed)
  t.equal(a.opened, b.opened)
  t.notOk(a.opened)
})

test('picoWire() supports dynamic channels', async t => {
  t.plan(8)
  const [a, b] = picoWire()
  // Alice uses callbacks
  a.open((msg, reply) => {
    t.equal(msg, 'who are you?', '1. msg received')
    t.equal(typeof reply, 'function', '2. reply expected')
    reply('I am Alice, and you?', (msg, reply) => {
      t.equal(msg, 'Bob', '6. response received')
      reply('Cool! Bye~')
    })
  })

  // Bob uses promises
  const sink = b.open((msg, replyTo) => {
    t.fail('broadcast should not be invoked')
  })
  const scope = await sink('who are you?', true)
  t.ok(Array.isArray(scope), '3. resolved values is an Array/Scope')
  const [name, reply] = scope
  t.equal(name, 'I am Alice, and you?', '4. question answered')
  t.equal(typeof reply, 'function', '5. reply expected')
  const [msg, reply2] = await reply('Bob', 1)
  t.equal(msg, 'Cool! Bye~', '7. bye transmitted')
  t.notOk(reply2, '8. No further reply expected')
})

test.skip('Sanitycheck', async t => {
  function syncThrower () { throw new Error('SyncError') }
  async function asyncThrower () { throw new Error('AsyncError') }
  try {
    syncThrower()
    t.fail('error gobbled')
  } catch (err) {
    t.equal(err.message, 'SyncError')
  }

  // sync in async context (await being the keyword here ensuring a timely catch)
  await new Promise((resolve, reject) => {
    syncThrower()
  }).catch(err => t.equal(err.message, 'SyncError'))

  // async in async context (await being the keyword here ensuring a timely catch)
  await new Promise((resolve, reject) => {
    asyncThrower() // => invoking an async function generates an unhandled promise
    t.fail('gobble gobble')
  }).catch(err => t.equal(err.message, 'AsyncError'))
})

test('picoWire() handles channel errors', async t => {
  // t.plan(5)
  const [a, b] = picoWire()
  // Alice uses callbacks
  a.open((msg, reply) => {
    reply('I am Alice, and you?', (name, reply) => {
      if (name === 'Boogieman') throw new Error('Aaaaaah!')
    })
    t.pass('reply invoked on next tick')
  })
  a.onclose = err => t.equal(err.message, 'Aaaaaah!', '3. A proper panic')

  // Bob uses promises
  b.onclose = err => t.equal(err.message, 'Aaaaaah!', '2. B proper explanation')
  const sink = b.open((msg, replyTo) => {
    t.fail('broadcast should not be invoked')
  })
  const [name, reply] = await sink('who are you?', true)
  t.equal(name, 'I am Alice, and you?', '1. question answered')
  let error = null
  try {
    await reply('Boogieman', 1)
    t.fail('Should not resolve')
  } catch (e) {
    t.pass('4. impl handler invoked')
    error = e
  }
  // TODO: error handling can be futher improved by properly clearing timeouts
  t.equal(error?.message, 'Aaaaaah!', '5. Promise properly fails')
})

test('picoWire() can be spliced', async t => {
  t.plan(8)
  const [a, b] = picoWire({ name: 'north' })
  const [c, d] = picoWire({ name: 'south' })
  a.onopen = sink => {
    t.pass('1. A onopen')
    sink('Hey')
  }
  d.onopen = sink => {
    t.pass('2. A onopen')
    sink('Bonjour')
  }
  a.onmessage = msg => t.equal(msg, 'Bonjour', '3. A end recieved hello')
  let seq = 0
  d.onmessage = (msg, reply) => {
    switch (++seq) {
      case 1:
        t.equal(msg, 'Hey', '4. A end recieved hello')
        break
      case 2:
        t.equal(msg, 'Who are you?', '5. A query')
        reply('francis', (msg, reply) => {
          t.equal(msg, 'Cool, I am blake', '7. A name')
          setTimeout(() => reply('bye'), 50) // simlag
        })
        break
      default:
        t.fail('unexpected message: ' + seq)
    }
  }
  spliceWires(b, c)
  const [name, reply] = await a.postMessage('Who are you?', true)
  t.equal(name, 'francis', '6. ident')
  const [bye] = await reply('Cool, I am blake', true)
  t.equal(bye, 'bye', '8. ack')
})

// Passes but some timer lingers for about 10sec
test.skip('hyperpipe fails gracefully', async t => {
  const { a, b, hA, hB } = spawnHyperPipe()
  hA.on('close', () => t.pass('protostreamA closed'))
  hB.on('close', () => t.pass('protostreamB closed'))
  hA.on('error', err => t.equal(err.message, 'FauxErrB', 'protostreamA destroyed'))
  hB.on('error', err => t.equal(err.message, 'FauxErrB', 'protostreamB destroyed'))
  a.onclose = err => t.equal(err?.message, undefined) // 'ClosedByRemote') TODO: binary-serialize adapter with flags
  b.onclose = err => t.equal(err?.message, 'FauxErrB', 'b onclose has correct error')
  a.onmessage = () => t.fail()
  b.onmessage = (msg, reply) => {
    throw new Error('FauxErrB')
  }
  try {
    await a.postMessage(Buffer.from('noop'), 1)
    t.fail('Aborted scope is a borted')
  } catch (err) {
    t.equal(err.message, 'Disconnected', 'Pending reply properly aborted')
  }
  t.end()
})

function spawnHyperPipe () {
  const [a, c] = picoWire({ name: 'north' })
  const [b, d] = picoWire({ name: 'south' })
  const encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')
  // Set up 2 connected hypercore-protocol streams
  const hyperA = new ProtoStream(true)
  const hyperB = new ProtoStream(false)
  hyperA.pipe(hyperB).pipe(hyperA)
  hyperWire(c, hyperA, encryptionKey)
  hyperWire(d, hyperB, encryptionKey)
  return { a, b, hA: hyperA, hB: hyperB }
}
