// SPDX-License-Identifier: AGPL-3.0-or-later
const SURVEY_TIMEOUT = 30 * 1000 // 30 seconds NOT USED
const PLUG_SYMBOL = Symbol.for('pico:plug')

function picoWire (opts = {}) {
  const PRECONNECT_BUFFERSIZE = opts?.bufferSize || 256 // messages, not bytes
  const MESSAGE_TIMEOUT = opts?.timeout || 30 * 1000
  const NAME = opts?.name // named pipes?
  let opened = false
  let closed = false
  const a = mkPlug(true)
  const b = mkPlug(false)
  const buf = []
  let outA = null
  let outB = null
  let closeHandlerA = null
  let closeHandlerB = null
  const pending = new Set()
  return [a, b]
  function mkPlug (isA) {
    const plug = {
      get name () { return NAME },
      get id () { return `${NAME || '|'}_${isA ? 'a' : 'b'}` },
      onopen: null,
      get onmessage () { return isA ? outA : outB },
      set onmessage (fn) { // broadcast handler
        if (typeof fn !== 'function') throw new Error('expected onmessage to be a function')
        if (isA ? outA : outB) throw new Error('Handler has already been set')
        if (isA) outA = fn
        else outB = fn
        if (isA ? outB : outA) drain(isA)
      },
      get onclose () { return isA ? closeHandlerA : closeHandlerB },
      set onclose (fn) {
        if (typeof fn !== 'function') throw new Error('expected onclose to be a function')
        if (isA) closeHandlerA = fn
        else closeHandlerB = fn
      },
      postMessage (msg, replyExpected = false) {
        if (closed) throw new Error('BrokenPipe')
        // console.log(`${plug.id} postMessage(`, msg.toString(), ',', replyExpected, ')')
        if (!(isA ? outA : outB)) throw new Error('Handler must be set before posting')
        let flush = null
        if (opened) {
          flush = (_, scope) => (isA ? outB : outA)(...scope)
        } else {
          if (buf.length >= PRECONNECT_BUFFERSIZE) return tearDown(isA, new Error('BurstPipe'))
          flush = (_, scope) => buf.push(scope)
        }

        return ReplyHandler(isA, flush, msg, replyExpected)
      },
      get opened () { return opened && !closed },
      get closed () { return closed },
      // backwards compatible with previous purely funcitonal api.
      open (handler) {
        if (plug.opened) throw new Error('Already opened')
        if (isPlug(handler)) return spliceWires(plug, handler)
        plug.onmessage = handler
        return plug.postMessage
      },
      close (err = null) { return tearDown(isA, err) }
    }
    plug.postMessage.close = plug.close // TODO: deprecate sink.close()
    plug[PLUG_SYMBOL] = true // used by splice
    return plug
  }

  // Internal onopen handler, drains pre-open buffer
  function drain (isA) {
    // const id = `${NAME || '|'}_${isA ? 'a' : 'b'}`
    // console.log(`DRAIN(${id}) => ${buf.length}`)
    // Destroy pipe if error occurs on output? 'WriteError'
    try {
      const out = isA ? outA : outB
      while (buf.length) {
        const [msg, reply] = buf.shift()
        out(msg, reply)
      }
    } catch (error) { tearDown(!isA, error) }
    opened = true
    const first = isA ? a : b
    const second = isA ? b : a
    if (typeof first.onopen === 'function') first.onopen(first.postMessage, first.close)
    if (typeof second.onopen === 'function') second.onopen(second.postMessage, second.close)
  }

  function tearDown (isA, error) {
    if (closed) return true // TODO: disable line for unhandled failing timers
    // console.warn('Pipe dead', isA ? 'A' : 'B', error?.message)
    closed = true // block further interaction
    const lhandler = isA ? closeHandlerA : closeHandlerB
    const rhandler = !isA ? closeHandlerA : closeHandlerB
    for (const resolve of pending) {
      resolve(error || new Error('PipeClosed'))
    }
    if (rhandler) rhandler(error) // ? new Error('RemoteError') : null)
    if (lhandler) lhandler(error)
    else if (error) throw error
    return closed
  }

  function ReplyHandler (isA, flush, msg, reply) {
    let next = null
    let p = null
    if (reply) {
      const [promise, nextOut] = unpromiseTimeout(MESSAGE_TIMEOUT)
      pending.add(nextOut)
      p = promise
        .then(scope => {
          pending.delete(nextOut)
          if (typeof reply === 'function') reply(...scope)
          else return scope
        })
        .catch(err => {
          tearDown(isA, err) // Ensure pipe-close
          if (!isA) throw err // rethrow
        })
      next = ReplyHandler.bind(null, !isA, nextOut)
    }

    try {
      flush(null, [msg, next])
    } catch (error) {
      // console.warn('Error occured on broadcast?', isA, error)
      tearDown(!isA, error)
    }
    return p
  }
}

function isPlug (o) { return !!(o && o[PLUG_SYMBOL]) }

function spliceWires (plug, other) {
  if (!isPlug(plug) || !isPlug(other)) throw new Error('Expected two pipe-ends')
  // console.log(`Splicing ${plug.id} <--> ${other.id}`)
  plug.onclose = other.close
  other.onclose = plug.close
  const b = []
  plug.onmessage = (msg, reply) => {
    if (other.opened) other.postMessage(msg, reply)
    else b.push([msg, reply])
  }
  // plug.onmessage = other.postMessage
  other.onmessage = plug.postMessage
  while (b.length) other.postMessage(...b.shift())
  return plug.close
}

/**
 * single ended wire-factory,
 * that abstracts a duplex-stream
 * @deprecated replaced by picoWire()
 */
function _picoWire (onmessage, onopen, onclose, name) {
  const [a, b] = picoWire({ name })
  a.onclose = onclose
  a.onopen = onopen
  a.onmessage = onmessage
  const open = sink => b.open(sink?._plug || sink)
  open._plug = b
  return open
}

function unpromiseTimeout (t) {
  const [promise, set] = unpromise()
  const id = setTimeout(set.bind(null, new Error('Timeout')), t)
  return [
    promise,
    (err, value) => {
      clearTimeout(id)
      set(err, value)
    },
    function abort () {
      clearTimeout(id)
      set(new Error('Aborted'))
    }
  ]
}

function unpromise () {
  let r, e
  return [
    new Promise((resolve, reject) => { r = resolve; e = reject }),
    (err, value) => err ? e(err) : r(value)
  ]
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
  constructor (onmessage, id) {
    this.broadcast = this.broadcast.bind(this)
    this._template = id || 'root'
    this._nodes = new Set()
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
  createWire (externalOnOpen, name) {
    const [hubEnd, looseEnd] = picoWire({ name })
    hubEnd.onmessage = (msg, reply) => {
      if (this._tap) this._tap(msg, reply)
      else this._broadcast(hubEnd, msg, reply)
    }
    hubEnd.onopen = (sink, close) => {
      this._nodes.add(hubEnd)
      if (typeof externalOnOpen === 'function') externalOnOpen(sink, close)
    }
    hubEnd.onclose = err => this.disconnect(hubEnd, err)
    return looseEnd
  }

  _broadcast (source, msg, reply, ...filter) {
    const sid = !isPlug(source) ? source : undefined
    for (const sink of this._nodes) {
      if (sink === source) continue
      if (sid && sink.name === sid) continue
      // TODO: don't like this, remove prob
      if (filter.find(t => isPlug(t) ? t === sink : t === sink.name)) continue
      // bug only first node to reply will resolve
      sink.postMessage(msg, reply)
    }
  }

  // TODO: remove this functionality unless we're prepared to recognize the PicoFax-machine.
  // messages shouldn't be broadcasted really, at least not directly injected into a hub...
  // though then survey() function needs to be rethought as well.
  broadcast (msg, reply, ...filter) {
    return this._broadcast(null, msg, reply, ...filter)
  }

  disconnect (sinkOrId, err) {
    if (!sinkOrId) return false
    if (this._nodes.delete(sinkOrId)) {
      console.warn('NodeDisconnected', err)
      return true
    }
    // Attempt to delete by id equality
    for (const sink of this._nodes) {
      if (sink.name === sinkOrId) return this._nodes.delete(sink)
    }
  }

  /**
   * Sets the master-tap wire that reroutes all incoming traffic to itself.
   * Use this function if an onmessage handler was not provided to constructor.
   */
  tapWire () {
    return _picoWire(
      // onMsg
      this.broadcast.bind(this), // _tap is not in the _nodes array so it's excluded by default
      // onopen
      sink => { this._tap = sink },
      // onclose
      () => { this._tap = null }
    )
  }

  get count () { return this._nodes.size }

  /**
   * A special broadcast that asynchroneously waits
   * for each wire to respond
   * TODO: inconsistent API with broadcast(message, ...filters)
   */
  async * survey (message, timeout = SURVEY_TIMEOUT) {
    let abort = false
    const pending = []
    // Broadcast message to all wires, push returned promise to pending
    for (const sink of this._nodes) {
      pending.push(
        sink.postMessage(message, true)
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
 * HyperWire: PicoWire <-> Stream adapter
 * Encodes callstack into vector clocks (inspired by TCP/IP sequence numbers)
 * Or maybe more like ports. either way this is a bad idea to allow remote
 * end signal which program callback to invoke..
 */
const NETWORK_TIMEOUT = 30 * 1000
function hyperWire (plug, hyperStream, key, extensionId = 125) {
  const REPLY_EXPECTED = 1
  if (!isPlug(plug)) throw new Error('Wire end expected')
  const routingTable = new Map()
  let seq = 1
  const channel = hyperStream.open(key, {
    onextension: onStreamReceive,
    onclose: () => plug.close()
  })
  const closeStream = () => channel.close()
  plug.onmessage = sendExt.bind(null, 0)
  plug.onclose = () => {
    if (!channel.closed) closeStream()
  }
  return closeStream

  function onStreamReceive (id, chunk) {
    if (id !== extensionId) {
      return console.warn('Message dropped! multiple extensions on this channel??', extensionId, id)
    }
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    const flags = chunk[4]
    if (routingTable.has(dstPort)) {
      const { replyTo, timer } = routingTable.get(dstPort)
      routingTable.delete(dstPort)
      clearTimeout(timer)
      replyTo(chunk.slice(5), flags & REPLY_EXPECTED
        ? (msg, replyTo) => sendExt(srcPort, msg, replyTo)
        : null
      )
    } else if (dstPort === 0) { // broadcast
      plug.postMessage(chunk.slice(5), flags & REPLY_EXPECTED
        ? (msg, replyTo) => sendExt(srcPort, msg, replyTo)
        : null
      )
    } else {
      console.warn('Message dropped! unknown port', dstPort, srcPort)
    }
  }

  function sendExt (dstPort, message, replyTo) {
    let srcPort = 0
    let flags = 0
    if (typeof replyTo === 'function') {
      srcPort = seq++
      registerCallback(srcPort, replyTo)
      flags = flags | REPLY_EXPECTED
    }
    const txBuffer = Buffer.alloc(message.length + 5)
    txBuffer.writeUInt16BE(dstPort) // In reply to
    txBuffer.writeUInt16BE(srcPort, 2) // this packet id
    txBuffer[4] = flags
    message.copy(txBuffer, 5)
    channel.extension(extensionId, txBuffer)
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
function streamWire (plug, duplexStream) {
  const routingTable = new Map()
  let seq = 1
  let txBuffer = Buffer.alloc(256)
  const broadcast = plug(streamSend.bind(null, 0))
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
    // const size = chunk.readUInt16BE(4)
    // TODO: streamWire does not support fragmentation ATM
    // if (chunk.length < size) debugger

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
function jsonTransformer (plug) {
  return encodingTransformer(plug, {
    encode: obj => Buffer.from(JSON.stringify(obj)),
    decode: msg => JSON.parse(msg)
  })
}

// Recursivly binds abstract encoding codec without plugging in
// wire.
function encodingTransformer (plug, encoder) {
  const encode = (forward, obj, r, c) => forward(
    encoder.encode(obj),
    r && decode.bind(null, r, c)
  )
  const decode = (forward, msg, r, c) => forward(
    encoder.decode(msg),
    r && encode.bind(null, r, c)
  )

  return down => {
    const up = plug(decode.bind(null, down))
    return encode.bind(null, up)
  }
}

// Practical starting point
module.exports = PicoHub

// Main pipe/wire spawners
module.exports.picoWire = picoWire
module.exports._picoWire = _picoWire // legacy wire

// Adapters
module.exports.streamWire = streamWire
module.exports.hyperWire = hyperWire
module.exports.spliceWires = spliceWires

// Transformers
module.exports.jsonTransformer = jsonTransformer
module.exports.encodingTransformer = encodingTransformer

// misc
module.exports.messageIterator = messageIterator
module.exports.unpromise = unpromise
