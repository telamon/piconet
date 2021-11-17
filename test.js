// Networks sucks
const test = require('tape')
const { BufferedThrottleStream } = require('hyper-simulator')
const ProtoStream = require('hypercore-protocol')
const Hub = require('.')
const varint = require('varint')
const {
  picoWire,
  hyperWire,
  jsonTransformer,
  encodingTransformer,
  isClose
} = Hub

test('PicoWire: basic wire', t => {
  t.plan(7)
  const consumerHandler = (msg, reply) => {
    t.equal(msg.toString(), 'auto greet', '3 Broadcast received')
  }

  // A wire host such as the Hub owns the network state
  // and is forced to provide 3 handlers:
  // - onmessage
  // - onopen
  // - onclose
  const connect = picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'hello from human', '5 Client initated message recieved')
      reply(Buffer.from('hello from machine'))
    },
    sink => {
      t.equal(consumerHandler, sink, '2 remoteHandler exported on open')
      sink(Buffer.from('auto greet'))
    },
    sink => {
      t.equals(consumerHandler, sink, '7 remoteHandler exported on close')
      t.end()
    }
  )

  t.equal(typeof connect, 'function', '1 pipe() exported on loose wire end')

  // A wire consumer (App) is only required to provide the onmessage handler,
  // minimizing the complexity to communicate.
  const toHost = connect(consumerHandler)
  t.equal(typeof toHost.close, 'function', '4 close() exported')

  // Test consumer initated conversation
  toHost(Buffer.from('hello from human'), (msg, reply) => {
    t.equal(msg.toString(), 'hello from machine', '6 reply recevied')
  })

  toHost.close()
})

test('PicoWire: pipe/ splice two wire ends together', t => {
  t.plan(5)
  const connectA = picoWire(
    (msg, reply) => t.equal(msg.toString(), 'AUTO_B', 'msg onopen from B'),
    sink => sink(Buffer.from('AUTO_A')),
    () => t.pass('A closed')
  )
  const connectB = picoWire(
    (msg, reply) => t.equal(msg.toString(), 'AUTO_A', 'msg onopen from A'),
    sink => sink(Buffer.from('AUTO_B')),
    () => {
      t.pass('B closed')
      t.end()
    }
  )

  const close = connectA(connectB)
  t.equal(typeof close, 'function')
  close()
})

test.skip('PicoWire: splice exports close() on sinks', t => {
  // t.plan(5)
  const connectA = picoWire(
    (msg, reply) => t.ok(isClose(reply?.close), 'close() exported on B`s reply'),
    sink => {
      t.ok(isClose(sink.close), 'close() exported onopen A')
      sink(Buffer.from('AUTO_A'))
    },
    () => t.pass('A closed')
  )
  const connectB = picoWire(
    (msg, reply) => t.ok(isClose(reply?.close), 'close() exported on A`s reply'),
    sink => {
      t.ok(isClose(sink.close), 'close() exported onopen B')
      sink(Buffer.from('AUTO_B'))
    },
    () => {
      t.pass('B closed')
      t.end()
    }
  )

  const close = connectA(connectB)
  t.equal(typeof close, 'function')
  close()
})

// A regular binary stream
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
  try {
    const hub = new Hub()
    const query = Buffer.from('Anybody there?')

    // Spawn 10 wires
    for (let i = 0; i < 10; i++) {
      const connect = hub.createWire()
      connect((msg, reply) => {
        setTimeout(() => { // Simulate network latency
          t.ok(query.equals(msg), `#${i} request received`)
          reply(Buffer.from([i]))
          // 3rd wire is naughty and sends multiple replies...
          if (i === 3) reply(Buffer.from([99]))
        }, Math.random() * 300)
      })
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
  } catch (err) { t.error(err) }
  t.end()
})

/*
 * Should install itself as an "side-channel" extension
 * piggybacking onto an existing stream leveraging all the
 * secure handshake and encryption/privacy offered by the
 * hyper eco-system.
 */
test('HyperWire: hyper-protocol stream to wire adapter', t => {
  t.plan(10)
  let destroyB = null
  const encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')
  // Set up 2 connected hypercore-protocol streams
  const hyperA = new ProtoStream(true)
  const hyperB = new ProtoStream(false)
  hyperA.pipe(hyperB).pipe(hyperA)
  hyperA.on('close', () => t.pass('9 protostreamA closed'))
  hyperB.on('close', () => t.pass('10 protostreamB closed'))

  const connectA = picoWire(
    (msg, reply) => {
      t.equal(msg.toString(), 'TO_A_BROADCAST', '5 B broadcast reply')
      reply(Buffer.from('TO_B_CALLBACK'))
    },
    sink => sink(Buffer.from('AUTO_A')),
    () => t.pass('8 A closed')
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
    () => t.pass('7 B closed')
  )
  const destroyA = hyperWire(connectA, hyperA, encryptionKey)
  destroyB = hyperWire(connectB, hyperB, encryptionKey)

  t.equal(typeof destroyA, 'function', '2 destroy A exported')
  t.equal(typeof destroyB, 'function', '3 destroy A exported')
  /*
  dualHead.autoPump(100)
    .then(() => t.pass('Stream closed'))
    .catch(t.error)
    .then(() => t.end())
    */
})

test('PicoHub: broadcast', t => {
  t.plan(3)
  const hub = new Hub()
  hub.createWire()(msg => t.equal(msg.toString(), 'hello')) // A
  hub.createWire()(msg => t.equal(msg.toString(), 'hello')) // B
  hub.createWire()(msg => t.equal(msg.toString(), 'hello')) // C
  const wireD = hub.createWire()(() => t.fail('Hub should not echo message to source'))
  wireD(Buffer.from('hello'))
  t.end()
})

test('PicoWire AbstractEncoding transformer', t => {
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

test('PicoWire JSON transformer', t => {
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

// Just a sketch, ultra low prio
test.skip('PicoWire: async api', async t => {
  t.plan(7)
  try {
    const consumerHandler = (msg, reply) => {
      t.equal(msg.toString(), 'auto greet', '3 Broadcast received')
    }

    const connect = picoWire(
      (msg, reply) => {
        t.equal(msg.toString(), 'hello from human', '5 Client initated message recieved')
        reply(Buffer.from('hello from machine'))
      },
      sink => {
        t.equal(consumerHandler, sink, '2 remoteHandler exported on open')
        sink(Buffer.from('auto greet'))
      },
      sink => {
        t.equals(consumerHandler, sink, '7 remoteHandler exported on close')
        t.end()
      }
    )
    t.equal(typeof connect, 'function', '1 pipe() exported on loose wire end')

    // Wire connected
    const toHost = connect(consumerHandler)
    t.equal(typeof toHost.close, 'function', '4 close() exported')

    // Async  wire API; Passing a boolean instead of callback returns a promise
    const [msg1, reply1] = await toHost(Buffer.from('hello from human'), true)
    t.equal(msg1.toString(), 'hello from machine', '6 reply recevied')

    const [msg2, reply2] = await reply1('Hey Alice!', true)
    t.equal(msg2.toString(), "I'm not Alice!")
    t.equal(typeof reply2, 'function')

    const [msg3, reply3] = await reply2('Oh really?') // no reply expected then no await.
    t.equal(msg3.toString(), 'Whatever...')
    t.equal(typeof reply3, 'undefined')

    toHost.close()
  } catch (err) { t.error(err) }
})
