// SPDX-License-Identifier: AGPL-3.0-or-later
const WIRE_SYMBOL = Symbol.for('Pico::wire')
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
/**
 * single ended wire-factory,
 * that abstracts a duplex-stream
 */
function picoWire (onmessage, onopen, onclose) {
  // The wire-end has minimal state, a wire only keeps
  // track of if it's been opened once, and disconnected once.
  let opened = false
  let disconnected = false
  const connect = sink => {
    if (opened) throw new Error('WireAlreadyConnected')
    opened = true
    const source = (msg, replyTo) => {
      if (disconnected) { // Not sure if good idea to throw
        const err = new Error('WireDisconnected')
        err.message = msg
        throw err
      } else msg && onmessage(msg, replyTo, source.close)
    }
    source.close = err => {
      if (disconnected) return
      disconnected = true
      if (typeof onclose === 'function') onclose(sink)
      else console.error('wire.close() invoked with error', err)
    }
    if (typeof onopen === 'function') onopen(sink, source.close)
    return source
  }
  connect[WIRE_SYMBOL] = true

  // End of basic wire, extended functionality:

  // Splices two wire ends together
  const splice = target => {
    const preConnectBuffer = []
    let sinkB = null
    const sinkA = connect( // Open source wire
      (msg, reply) => sinkB
        ? sinkB(msg, reply) // wireB is connected, forward
        : preConnectBuffer.push([msg, reply]) // wireB not yet connected, buffer
    )
    sinkB = target(sinkA) // Open target wire

    // Drain temporary buffer
    while (preConnectBuffer.length) sinkB(...preConnectBuffer.shift())
    return function close () {
      sinkA.close()
      sinkB.close()
    }
  }

  // Very smartpipe...
  connect.pipe = target => {
    if (target[WIRE_SYMBOL]) return splice(target)
    return streamWire(connect, target)
  }

  return connect // returns pluggable wire end
}

/**
 * So the repeater is a naive fictional network-hub that dumbly
 * repeats all message to all available nodes;
 * I might have just described a shared message-bus (a.k.a EventEmitter)
 *
 * Bridging two repeaters is surprisingly simple:
 * const a = new Repeater()
 * const b = new Repeater()
 * a.createWire()(b.broadcast)
 * b.createWire()(a.broadcast)
 * - or -
 * a.createWire().pipe(b.createWire())
 *
 *
 * Repeater is now PicoHub having 2 modes of operation.
 * if instantiated without onmessage handler it acts as a dumb
 * repeater, re-emitting a messages on all wires.
 * When onmessage handler is provided all incoming traffic will
 * be forwarded to the master handler.
 */
class PicoHub {
  constructor (onmessage) {
    this.broadcast = this.broadcast.bind(this)
    this._nodes = []
    this._tap = null
    if (typeof onmessage === 'function') this._tap = onmessage
  }

  /**
   * Repeater.createWire() spawns a new 'connect' function
   * that can be used as such:
   *
   * const publish = connect(function onread (msg, reply, disconnect) {
   *   if (msg === 'Hello') publish('Hey!!')
   *   else if (msg === 'Bye') disconnect()
   *   else if (msg === 'Hello tony!' && this.name === 'tony') reply('Bob, is that you?')
   * })
   */
  createWire () {
    let sink = null
    const onmessage = (msg, reply, disconnect) => {
      if (this._tap) this._tap(msg, reply, disconnect)
      else this._broadcast(sink, msg, reply, disconnect)
    }
    const onopen = s => {
      // Use original broadcast-receiver as wire-ID
      sink = s
      this._nodes.push(sink)
    }
    const onclose = this.disconnect.bind(this)
    return picoWire(onmessage, onopen, onclose)
  }

  _broadcast (source, msg, reply, ...filter) {
    for (const sink of this._nodes) {
      if (
        sink !== source && // source is the handler that was provided
        !~filter.indexOf(sink) // TODO: don't like this, remove prob.
      ) sink(msg, reply)
    }
  }

  // TODO: remove this functionality unless we're prepared to recognize the PicoFax-machine.
  // messages should be transported over wires, maybe not directly injected into a hub...
  // though then survey() function needs to be rethought as well.
  broadcast (msg, reply, ...filter) {
    this._broadcast(null, msg, reply, ...filter)
  }

  disconnect (sink) {
    const idx = this._nodes.indexOf(sink)
    if (~idx) this._nodes.splice(idx, 1)
  }

  /**
   * Sets the master-tap wire that reroutes all incoming traffic to itself.
   * Use this function if an onmessage handler was not provided to constructor.
   */
  tapWire () {
    return picoWire(
      // onMsg
      this.broadcast.bind(this), // _tap is not in the _nodes array so it's excluded by default
      // onopen
      sink => { this._tap = sink },
      // onclose
      () => { this._tap = null }
    )
  }

  get count () { return this._nodes.length }

  /**
   * A special broadcast that asynchroneously waits
   * for each wire to respond
   * TODO: inconsistent API with broadcast(message, ...filters)
   */
  async * survey (message, timeout = DEFAULT_TIMEOUT) {
    let abort = false
    const pending = []
    // Broadcast message to all wires, push returned promise to pending
    for (const sink of this._nodes) {
      pending.push(
        asyncronizeSend(sink, message, timeout)
      )
    }
    // race all promises and remove them from pending list as they resolve or timeout.
    while (!abort && pending.length) {
      const settledIdx = await Promise.race(
        pending.map((promise, idx) => promise.finally().then(() => idx))
      )
      const settled = pending[settledIdx]
      pending.splice(settledIdx, 1) // Remove settled promise from pending
      // val should be an array containing [message, reply], add abort function to end of it.
      yield settled.then(val => [...val, () => { abort = true }])
    }
  }
}

/**
 * Helper to wrap to replace the onmessage handler with an
 * promise. Might become standard behaviour of wire.
 */
function asyncronizeSend (sink, message, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TimeoutReached')), timeout)
    sink(message, (msg, reply) => {
      clearTimeout(timer)
      resolve([msg, reply])
    })
  })
}

/**
 * HyperWire: PicoWire <-> Stream adapter
 * Encodes callstack into vector clocks (inspired by TCP/IP sequence numbers)
 * Or maybe more like ports. either way this is a bad idea to allow remote
 * end signal which program callback to invoke..
 */
const NETWORK_TIMEOUT = 1000 * 10

function hyperWire (connect, hyperStream, key, extensionId = 125) {
  const routingTable = new Map()
  let seq = 1
  const channel = hyperStream.open(key, {
    onextension: onStreamReceive,
    onclose: () => wire.close()
  })
  const closeStream = () => channel.close()
  const wire = connect(sendExt.bind(null, 0))
  return closeStream

  // TODO: DEDUPLICATE this code from streamWire.
  function onStreamReceive (id, chunk) {
    if (id !== extensionId) {
      return console.warn('Message dropped! multiple extensions on this channel??', extensionId, id)
    }
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    if (routingTable.has(dstPort)) {
      const { replyTo, timer } = routingTable.get(dstPort)
      routingTable.delete(dstPort)
      clearTimeout(timer)
      replyTo(chunk.slice(4), (msg, replyTo) => sendExt(srcPort, msg, replyTo))
    } else if (dstPort === 0) { // broadcast
      wire(chunk.slice(4), (msg, replyTo) => sendExt(srcPort, msg, replyTo))
    } else {
      console.warn('WARN: unknown port, streamWire Message dropped', chunk[6])
    }
  }

  function sendExt (dstPort, message, replyTo) {
    let srcPort = 0
    if (typeof replyTo === 'function') {
      srcPort = seq++
      registerCallback(srcPort, replyTo)
    }
    const txBuffer = Buffer.alloc(message.length + 4)
    txBuffer.writeUInt16BE(dstPort) // In reply to
    txBuffer.writeUInt16BE(srcPort, 2) // this packet id
    message.copy(txBuffer, 4)
    channel.extension(extensionId, txBuffer.slice(0, txBuffer.length))
  }

  function registerCallback (srcPort, replyTo) {
    const timer = setTimeout(() => {
      if (!routingTable.has(srcPort)) return
      routingTable.delete(srcPort)
      closeStream(new Error('ResponseTimeout'))
    }, NETWORK_TIMEOUT)
    routingTable.set(srcPort, { replyTo, timer })
  }
}

const MTU = 256 << 10 // 256kB
function streamWire (connect, duplexStream) {
  const routingTable = new Map()
  let seq = 1
  let txBuffer = Buffer.alloc(256)
  const broadcast = connect(streamSend.bind(null, 0))
  duplexStream.on('data', onStreamReceive)
  duplexStream.once('close', onclose)
  duplexStream.once('error', onclose)

  const closeStream = err => err ? duplexStream.end() : duplexStream.destroy(err)
  return closeStream

  function onclose (err) {
    duplexStream.off('data', onStreamReceive)
    duplexStream.off('error', onclose)
    duplexStream.off('close', onclose)
    broadcast.close(err)
  }

  function onStreamReceive (chunk) {
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    const size = chunk.readUInt16BE(4)
    // TODO: streamWire does not support fragmentation ATM
    if (chunk.length < size) debugger

    if (routingTable.has(dstPort)) {
      const { replyTo, timer } = routingTable.get(dstPort)
      routingTable.delete(dstPort)
      clearTimeout(timer)
      replyTo(chunk.slice(6), (msg, replyTo) => streamSend(srcPort, msg, replyTo))
    } else if (dstPort === 0) { // broadcast
      broadcast(chunk.slice(6), (msg, replyTo) => streamSend(srcPort, msg, replyTo))
    } else {
      console.warn('WARN: streamWire Message dropped', chunk[6])
    }
  }

  function streamSend (dstPort, msg, replyTo) {
    let srcPort = 0
    if (typeof replyTo === 'function') {
      srcPort = seq++
      registerCallback(srcPort, replyTo)
    }
    const packetSize = msg.length + 6 // seq
    if (packetSize > txBuffer.length) {
      if (packetSize >= MTU) throw new Error('Message exceeds MTU')
      txBuffer = Buffer.alloc(packetSize)
    }
    txBuffer.writeUInt16BE(dstPort) // In reply to
    txBuffer.writeUInt16BE(srcPort, 2) // this packet id
    txBuffer.writeUInt16BE(packetSize, 4) // Packet size
    msg.copy(txBuffer, 6)
    duplexStream.write(txBuffer.slice(0, packetSize))
  }

  function registerCallback (srcPort, replyTo) {
    const timer = setTimeout(() => {
      if (!routingTable.has(srcPort)) return
      // get replyTo from table to allow GC clear up replyTo reference
      routingTable.delete(srcPort)
      closeStream(new Error('ResponseTimeout'))
    }, NETWORK_TIMEOUT)
    routingTable.set(srcPort, { replyTo, timer })
  }
}

async function * messageIterator (wire) {
  const pBuffer = []
  const rBuffer = []
  let done = false
  pBuffer.push(new Promise(resolve => rBuffer.push(resolve)))

  const send = wire((message, reply) => {
    pBuffer.push(new Promise(resolve => rBuffer.push(resolve)))
    rBuffer.shift()([
      message,
      reply,
      function stopGeneratorAndCloseWire () {
        send.close()
        done = true
      }
    ])
  })
  while (!done) yield await pBuffer.shift() // eslint-disable-line no-unmodified-loop-condition
}

// Recursivly binds JSON codec without plugging in
// wire.
function jsonTransformer (connect) {
  const encode = (forward, obj, r) => forward(
    Buffer.from(JSON.stringify(obj)),
    r && decode.bind(null, r)
  )
  const decode = (forward, msg, r) => forward(
    JSON.parse(msg),
    r && encode.bind(null, r)
  )

  return down => {
    const up = connect(decode.bind(null, down))
    return encode.bind(null, up)
  }
}

module.exports = PicoHub
module.exports.picoWire = picoWire
module.exports.streamWire = streamWire
module.exports.hyperWire = hyperWire
module.exports.jsonTransformer = jsonTransformer
module.exports.messageIterator = messageIterator
