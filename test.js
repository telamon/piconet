// Networks sucks
const test = require('tape')
const ProtoStream = require('hypercore-protocol')
const Hub = require('.')
const {
  picoWire, // 2.x
  hyperWire,
  simpleWire,
  spliceWires,
  unpromise,
  wsWire
} = Hub

// Unix sockets were a blast, a simplified variant
// of a network connection in a local system.
// Abstractions are good, until we have to live with them
test('picoWire() returns two ends for bi-directional messaging', async t => {
  // t.plan(9)
  const [a, b] = picoWire() // returns two quantum wire-ends
  function aHandler ([msg, reply, quark]) {
    t.equal(msg, 'Yo', '3. a called')
    t.notOk(reply, '4. No reply expected')
    t.equal(quark, a)
  }
  function bHandler ([msg, reply, quark]) {
    t.equal(msg, 'Hello', '1. b called')
    t.notOk(reply, '2. No reply expected')
    t.equal(quark, b)
  }
  a.closed
    .then(err => t.notOk(err, 'a closed 1'))
    .catch(t.error)
  b.closed
    .then(err => t.notOk(err, 'b closed 1'))
    .catch(t.error)

  // when a-onmessage is set, b can post messages and vice-versa
  t.equal(a.isActive, false)
  t.equal(b.isActive, false)
  b.open(bHandler)
    .then(scope => {
      t.ok(Array.isArray(scope), 'b.open resolves an array')
      const [sink, quark] = scope
      t.equal(a.isActive, true)
      t.equal(sink, b.postMessage)
      t.equal(typeof sink, 'function', 'sinkB is a function')
      t.equal(quark, b)
      quark.closed
        .then(() => t.pass('b closed 2'))
        .catch(t.error)
    })
    .catch(e => t.fail(e))

  // onopen handler replaced by promise getter
  await a.opened
  t.equal(a.isActive, true, 'A opens when B is set')

  await a.postMessage('Hello')

  a.onmessage = aHandler
  t.equal(b.isActive, true, 'B is active when a handler is set')
  await b.postMessage('Yo')

  a.close()
  t.equal(a.isActive, false)
  t.equal(b.isActive, false)
  await a.closed.then(() => t.pass('a closed 2'))
  await a.opened
    .then(t.fail)
    .catch(err => t.equal(err.message, 'Disconnected'))
})

test('picoWire() supports dynamic channels', async t => {
  const [a, b] = picoWire()
  a.closed.then(err => t.notOk(err, 'a closed')).catch(t.error)
  b.closed.then(err => t.notOk(err, 'b closed')).catch(t.error)

  // Alice uses then/catch
  a.open(([msg, reply, quark]) => {
    t.equal(msg, 'who are you?', '1. msg received')
    t.equal(typeof reply, 'function', '2. reply expected')

    reply('I am Alice, and you?', true)
      .then(([msg, reply]) => {
        t.equal(msg, 'Bob', '6. response received')
        return reply('Cool! Bye~', true)
      })
      .then(([msg, reply]) => {
        t.equal(msg, ':/, bye!')
        t.notOk(reply, 'end of conversation')
      })
      .catch(t.error) // gotta catch 'em all
  })

  // Bob uses async/await
  const [sink] = await b.open(([msg, replyTo]) => {
    t.fail('unicast should not be invoked')
  })
  // 2nd-param should be flags not boolean/ for now only ACK flag planned
  const scope = await sink('who are you?', true)
  t.ok(Array.isArray(scope), '3. resolved values is an Array/Scope')
  const [res1, reply1] = scope
  t.equal(res1, 'I am Alice, and you?', '4. question answered')
  t.equal(typeof reply1, 'function', '5. reply expected')

  const [res2, reply2] = await reply1('Bob', 1)
  t.equal(res2, 'Cool! Bye~', '7. bye transmitted')
  const [res3, reply3] = await reply2(':/, bye!') // handling rejection like a champ
  t.notOk(res3, 'No further messages')
  t.notOk(reply3, '8. No further reply expected')
  b.close()
})

test('picoWire() unicast errors not eaten', async t => {
  t.plan(7)
  const [a, b] = picoWire()
  a.closed.then(err => t.notOk(err, 'a closed')).catch(t.error)
  b.closed.then(err => t.notOk(err, 'b closed')).catch(t.error)
  a.onmessage = ([msg, reply]) => {
    throw new Error('FakeError')
  }
  await b.postMessage('Hola!', 1)
    .then(() => t.fail('response not rejected'))
    .catch(err => t.equal(err.message, 'FakeError', 'resolves error'))

  // Wait what?? 3.x can recover from errors? COol!
  t.equal(a.isClosed, false, 'a closed state')
  t.equal(b.isClosed, false, 'b closed state')
  t.equal(a.isActive, false, 'a active')
  t.equal(b.isActive, true, 'b active')
  a.close()
  await a.closed
})

test('picoWire() close(err) can be caught', async t => {
  t.plan(7)
  const [a, b] = picoWire({ timeout: 500 })
  const aC = a.closed
    .then(e => t.equal(e.message, 'test', 'a closed'))
    .catch(t.error)
  const bC = b.closed
    .then(e => t.equal(e.message, 'test', 'b closed'))
    .catch(t.error)
  a.onmessage = (msg, reply) => {
    t.equal(msg, 'Hola!', 'cast received')
  }
  b.postMessage('Hola!', 1)
    .catch(err => t.equal(err.message, 'Disconnected', 'resolves error'))
  a.close(new Error('test'))
  t.equal(a.isClosed, true, 'a closed state')
  t.equal(b.isClosed, true, 'b closed state')
  t.equal(a.isActive, false, 'a not active')
  t.equal(b.isActive, false, 'b not active')
  await Promise.all([aC, bC])
})

// this test seems pointless.
test.skip('picoWire() channel errors not eaten', async t => {
  // t.plan(7)
  const [a, b] = picoWire()
  a.closed.then(err => t.notOk(err, 'a closed')).catch(t.error)
  b.closed.then(err => t.notOk(err, 'b closed')).catch(t.error)
  a.onmessage = (msg, reply) => {
    t.equal(msg, 'Hola!')
    return reply('Who are you?', 1)
      .then(([msg, reply]) => {
        // This error cannot be accesed by promise that is waiting for
        // a response (bob has to wait 30s timeout or tearDown()) to be
        // notified of failure, Alice sees error properly.
        throw new Error('Aaaaaah!')
      })
  }
  await b.postMessage('Hola!', 1)
    .then(([msg, reply]) => {
      t.equal(msg, 'Who are you?')
      return reply('Boogeyman', 1)
    })
    .then(() => t.fail('response not rejected'))
    .catch(err => t.equal(err.message, 'FakeError', 'resolves error'))

  // Wait what?? 3.x can recover from errors? COol!
  t.equal(a.isClosed, false, 'a closed state')
  t.equal(b.isClosed, false, 'b closed state')
  t.equal(a.isActive, false, 'a active')
  t.equal(b.isActive, true, 'b active')
  a.close()
  await a.closed
})

test('picoWire() can be spliced together', async t => {
  // t.plan(8)
  const [a, b] = picoWire({ id: 'Ali', timeout: 3000 })
  const [d, c] = picoWire({ id: 'Bob', timeout: 3000 })

  // Both ends queue up some messsages
  a.open(([msg]) => t.equal(msg, 'Bonjour', '5. A end recieved hello'))
    .then(([sink]) => {
      t.pass('2. A onopen')
      sink('Hey')
    })

  // D Serves as our async RPC running on a separate event-chain
  d.open(([msg, reply]) => {
    switch (msg) {
      case 'Hey':
        t.pass('4. D recieved hello')
        break
      case 'Who are you?':
        t.pass('1. D query')
        reply('francis', true)
          .then(([msg, reply]) => {
            t.equal(msg, 'Cool, I am blake', '7. D response')
            setTimeout(
              () => reply('bye')
                .then(t.pass.bind(null, '8. bye sent'))
                .catch(t.error),
              50
            ) // simlag
          }).catch(t.error)
        break
      default:
        t.fail('unexpected message: ' + msg)
    }
  })
    .then(([sink]) => {
      t.pass('3. D onopen')
      sink('Bonjour')
    })
  spliceWires(b, c)
  const [name, reply] = await a.postMessage('Who are you?', true)
  t.equal(name, 'francis', '6. ident')
  const [bye] = await reply('Cool, I am blake', true)
  t.equal(bye, 'bye', '9. ack')
})

test('picoWire() splice timeouts are caught', async t => {
  const [a, b] = picoWire({ id: 'Ali', timeout: 30 })
  const [d, c] = picoWire({ id: 'Bob', timeout: 30 })
  const [done, setDone] = unpromise()
  spliceWires(b, d)
  await c.open(async ([msg, reply]) => {
    t.equal(msg, 'hey', 'msg received')
    t.ok(reply, 'reply expected')
    c.close(new Error('test'))
    await reply('hi')
      .catch(err => t.equal(err.message, 'Disconnected', 'reply caught'))
      .finally(setDone)
  })
  a.closed.then(err => t.equal(err.message, 'test', 'Closed handler fired'))
  try {
    await a.postMessage('hey', 1)
  } catch (err) { t.equal(err.message, 'test', 'postMessage caught') }
  await done
})

test('PicoHub: broadcast when _tap not set', async t => {
  const hub = new Hub()
  const pending = []
  for (let i = 0; i < 3; i++) {
    const [p, set, abort] = unpromise()
    pending[i] = p
    // spawn peers
    hub.createWire()
      .open(([msg, open]) => set(msg.toString()))
      .catch(abort)
  }
  await hub.createWire().open(() => t.fail('Hub should not echo message to source'))
    .then(([sinkD]) => {
      return sinkD(Buffer.from('hello'))
    })
  const received = await Promise.all(pending)
  t.deepEqual(received, ['hello', 'hello', 'hello'])
})

test('PicoHub: survey() streams replies and stops after all wires responded', async t => {
  const hub = new Hub()
  const query = Buffer.from('Anybody there?')

  // Spawn 10 wires
  const allOpen = []
  for (let i = 0; i < 10; i++) {
    const [hubEndOpened, setOpened] = unpromise()
    allOpen.push(hubEndOpened)
    const plug = hub.createWire(setOpened)
    plug.onmessage = ([msg, reply]) => {
      setTimeout(() => { // Simulate network latency
        t.ok(query.equals(msg), `#${i} request received`)
        reply(Buffer.from([i]))
        // 3rd wire is naughty and sends multiple replies...
        if (i === 3) reply(Buffer.from([99]))
      }, Math.random() * 300)
    }
  }
  await Promise.all(allOpen)

  const responses = []
  // Conditions for end
  // - operation reached maximum timeout
  // - a specific response satisfies the query. (stop() was invoked)
  // - all wires responded (no more messages expected
  for await (const [msg, reply, node, abort] of hub.survey(query, true)) {
    t.equal(typeof abort, 'function', 'abort is a function')
    t.notOk(reply, 'remote end does not expect a reply')
    t.ok(node, 'hub node exported for potential disconnect')
    responses.push(msg[0])
  }
  t.deepEqual(responses.sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'All wires responded')
})

test('Survey into conversation', async t => {
  const hub = new Hub()
  const [hubEndOpened, setOpened] = unpromise()
  const plug = hub.createWire(setOpened)
  plug.onmessage = async ([m1, r1]) => {
    t.equal(m1, 'WantSteak?', 'S1')
    const [m2, r2] = await r1('Yes', true)
    t.equal(m2, 'HereYouGo', 'S2')
    const [m3, r3] = await r2('Thanks!', true)
    t.equal(m3, 'np, anything else?', 'S3')
    await r3('nope, bye')
  }
  await hubEndOpened
  for await (const [m1, r1] of hub.survey('WantSteak?', true)) {
    t.equal(m1, 'Yes', 'A1')
    const [m2, r2] = await r1('HereYouGo', true)
    t.equal(m2, 'Thanks!', 'A2')
    const [m3, r3] = await r2('np, anything else?', true)
    t.equal(m3, 'nope, bye', 'A3')
    t.notOk(r3)
  }
})

test('Survey iterator does not fail if node fails', async t => {
  const hub = new Hub()
  const [haOpen, setA] = unpromise()
  const [hbOpen, setB] = unpromise()
  const handler = async ([m1, r1, q]) => {
    t.equal(m1, 'WantSteak?', 'S1')
    const [m2, r2] = await r1('Yes', true)
    t.equal(m2, 'HereYouGo', 'S2')
    if (q === a) return a.close(new Error('ChangedMyMind'))
    const [m3, r3] = await r2('Thanks!', true)
    t.equal(m3, 'np, anything else?', 'S3')
    await r3('nope, bye')
  }
  const a = hub.createWire(setA)
  a.closed.then(err => t.equal(err.message, 'ChangedMyMind'))
  a.onmessage = handler
  const b = hub.createWire(setB)
  b.onmessage = handler
  await Promise.all([haOpen, hbOpen])
  for await (const [m1, r1] of hub.survey('WantSteak?', true)) {
    t.equal(m1, 'Yes', 'A1')
    try {
      const [m2, r2] = await r1('HereYouGo', true)
      t.equal(m2, 'Thanks!', 'A2')
      const [m3, r3] = await r2('np, anything else?', true)
      t.equal(m3, 'nope, bye', 'A3')
      t.notOk(r3)
    } catch (err) {
      t.equal(err.message, 'ChangedMyMind')
    }
  }
})

/*
 * Should install itself as an "side-channel" extension
 * piggybacking onto an existing stream leveraging all the
 * secure handshake and encryption/privacy offered by the
 * hyper eco-system.
 */
test('HyperWire: hyper-protocol stream to wire adapter', async t => {
  t.plan(11)
  const encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')
  // Set up 2 connected hypercore-protocol streams
  const hyperA = new ProtoStream(true)
  const hyperB = new ProtoStream(false)
  hyperA.pipe(hyperB).pipe(hyperA)
  const [hyperStreamsClosed, setStreamsClosed] = unpromise()
  hyperA.on('close', () => t.pass('8 protostreamA closed'))
  hyperB.on('close', () => { t.pass('9 protostreamB closed'); setStreamsClosed() })

  const [a, c] = picoWire({ id: 'local' })
  a.onmessage = (msg, reply) => { t.fail('A Broadcast invoked') }
  a.closed.catch(err => t.notOk(err, '8 A closed'))
  const [conversationWorks, done] = unpromise()

  // Leaving b with legacy style initialization just in case
  const connectB = simpleWire(
    ([msg, reply]) => {
      t.equal(msg.toString(), 'AUTO_A', '4 msg onopen from A')
      reply(Buffer.from('TO_A_BROADCAST'), true)
        .then(([msg, replyTo]) => {
          t.equal(msg.toString(), 'TO_B_CALLBACK', '6 conversation works')
          t.notOk(replyTo, '7 No more replies')
          done()
        })
    },
    () => t.pass('3 B opened'),
    () => t.pass('10 B closed')
  )
  const destroyA = hyperWire(c, hyperA, encryptionKey)
  const destroyB = hyperWire(connectB, hyperB, encryptionKey)

  t.equal(typeof destroyA, 'function', '1 destroy A exported')
  t.equal(typeof destroyB, 'function', '2 destroy A exported')

  const [msg, reply] = await a.postMessage(Buffer.from('AUTO_A'), true)
  t.equal(msg.toString(), 'TO_A_BROADCAST', '5 B broadcast reply')
  const p = reply(Buffer.from('TO_B_CALLBACK'))
  await conversationWorks
  a.close()
  await hyperStreamsClosed
  t.ok(Array.isArray(await p), '11 Empty scope')
})

test('wsWire adapters', async t => {
  const Websocket = require('ws')
  const wss = new Websocket.WebSocketServer({ port: 1337 })
  wss.on('connection', ws => {
    const [b, d] = picoWire({ id: 'remote' })
    wsWire(d, ws)
    // broadcast
    b.onmessage = async ([msg, reply]) => {
      t.equal(msg.toString(), 'Hello?', 'WSS_RECV1')
      t.ok(reply)
      const [req, res] = await reply(Buffer.from('Yes?'), true)
      t.equal(req.toString(), 'One fresh pile of central stuff plz', 'WSS_RECV2')
      await res(Buffer.from('CominRight up!'))
    }
  })

  try {
    const [a, c] = picoWire({ id: 'local' })
    a.onmessage = (msg, reply) => { t.fail('A Broadcast invoked') }
    a.closed.catch(err => t.notOk(err, '8 A closed'))

    // Plug C into websocket
    const cut = wsWire(c, new Websocket('ws://localhost:1337'))
    await a.opened // wait for websocket to connect

    const [msg, reply] = await a.postMessage(Buffer.from('Hello?'), true)
    t.equal(msg.toString(), 'Yes?', 'Reply from wss')
    const [msg2] = await reply(Buffer.from('One fresh pile of central stuff plz'), true)
    t.equal(msg2.toString(), 'CominRight up!', 'Nested reply from wss')
    cut()
  } finally {
    wss.close()
  }
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

test.skip('picoWire() handles channel errors', async t => {
  // t.plan(5)
  const [a, b] = picoWire()
  // Alice uses callbacks
  a.open(([msg, reply]) => {
    reply('I am Alice, and you?', (name, reply) => {
      if (name === 'Boogieman') throw new Error('Aaaaaah!')
    })
    t.pass('reply invoked on next tick')
  })
  a.onclose = err => t.equal(err.message, 'Aaaaaah!', '3. A proper panic')

  // Bob uses promises
  b.onclose = err => t.equal(err.message, 'Aaaaaah!', '2. B proper explanation')
  const sink = b.open(([msg, replyTo]) => {
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

// Passes but some timer lingers for about 10sec
test.skip('hyperpipe fails gracefully', async t => {
  const { a, b, hA, hB } = spawnHyperPipe()
  hA.on('close', () => t.pass('protostreamA closed'))
  hB.on('close', () => t.pass('protostreamB closed'))
  hA.on('error', err => t.equal(err.message, 'FauxErrB', 'protostreamA destroyed'))
  hB.on('error', err => t.equal(err.message, 'FauxErrB', 'protostreamB destroyed'))
  a.closed.catch(err => t.equal(err?.message, undefined)) // 'ClosedByRemote') TODO: binary-serialize adapter with flags
  b.closed.catch(err => t.equal(err?.message, 'FauxErrB', 'b onclose has correct error'))
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
  const [a, c] = picoWire({ name: 'north', timeout: 1000 })
  const [b, d] = picoWire({ name: 'south', timeout: 1000 })
  const encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')
  // Set up 2 connected hypercore-protocol streams
  const hyperA = new ProtoStream(true)
  const hyperB = new ProtoStream(false)
  hyperA.pipe(hyperB).pipe(hyperA)
  hyperWire(c, hyperA, encryptionKey)
  hyperWire(d, hyperB, encryptionKey)
  return { a, b, hA: hyperA, hB: hyperB }
}
