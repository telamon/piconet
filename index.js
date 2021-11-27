// SPDX-License-Identifier: AGPL-3.0-or-later
const D = require('debug')('pico-net')
const PLUG_SYMBOL = Symbol.for('pico:plug')

const SURVEY_TIMEOUT = 30 * 1000 // 30 seconds NOT USED
const REPLY_EXPECTED = 1
// const END_OF_STREAM = 1  // plug.close()
// const ERROR = 1 << 1 // plug.close(new Error('RemoteError'))
// const BANNED = 1 << 2 // plug.close(new Error('BannedByRemote'))

function picoWire (opts = {}) {
  const MESSAGE_TIMEOUT = opts?.timeout || 30 * 1000
  let id = opts?.id // named pipes?
  let closed = false
  let [aOpened, bOpened] = [false, false]
  const a = mkPlug(true)
  const b = mkPlug(false)
  const [castA, setCastA, abortCastA] = unpromise()
  const [castB, setCastB, abortCastB] = unpromise()
  const broadcastsExported = [false, false]

  const [$closed, gracefulClose, destroy] = unpromise()
  const pending = new Set()
  return [a, b]
  function mkPlug (isA) {
    const plug = {
      // get name () { return `${id || '|'}_${isA ? 'a' : 'b'}` },
      get name () { return `${id || '|'} ${isA ? '-->' : '<--'} ` },
      get id () { return id },
      set id (v) {
        if (id) throw new Error('ID has already been set')
        id = v
      },
      get onmessage () {
        broadcastsExported[isA ? 0 : 1] = true
        return isA ? castA : castB
      },
      get opened () {
        if (closed) return Promise.reject(new Error('Disconnected'))
        broadcastsExported[isA ? 1 : 0] = true
        return (isA ? castB : castA).then(cast => !!cast)
      },
      get closed () { return $closed },
      set onmessage (fn) { // broadcast handler
        if (typeof fn !== 'function') throw new Error('expected onmessage to be a function')
        if (isA ? aOpened : bOpened) throw new Error('Handler has already been set')
        if (isA) {
          setCastA(fn)
          aOpened = true
        } else {
          setCastB(fn)
          bOpened = true
        }
      },

      async postMessage (msg, flags) {
        if (closed) throw new Error('Disconnected')
        if (!plug.isActive) throw new Error('Void')
        broadcastsExported[isA ? 1 : 0] = true
        const sink = await (isA ? castB : castA)
        const unwrap = a => sink(...a)
        return Recurser(isA, unwrap, msg, flags)
      },
      get isActive () { return (isA ? bOpened : aOpened) && !closed },
      get isClosed () { return closed },

      async open (handler) {
        if (isPlug(handler)) return spliceWires(plug, handler)
        plug.onmessage = handler
        await plug.opened
        return [plug.postMessage, plug]
      },
      close (err = null) { return tearDown(isA, err) },
      get other () { return isA ? b : a }
    }
    plug[PLUG_SYMBOL] = true // used by open/splice
    return plug
  }

  /**
   * Generates two lock-stepped promise chains until
   * a reply is invoked without the expectResponse flags set
   */
  async function Recurser (isA, sink, msg, flags) {
    if (typeof flags === 'function') throw new Error('Callback API has been deprecated')
    const replyExpected = flags & REPLY_EXPECTED || flags
    const [$scope, setScope, abortScope] = unpromiseTimeout(MESSAGE_TIMEOUT) //, `${plug.name}#${msg}`)
    setScope.abort = abortScope // tiny hack
    if (replyExpected) pending.add(setScope)
    pending.delete(sink)
    const reply = !replyExpected ? null : Recurser.bind(null, !isA, setScope)
    try { // Second async context that runs past this methods lifetime
      sink([msg, reply, !isA ? a : b]) // transmit to other
      if (!replyExpected) setScope([]) // Consider message delivered
    } catch (err) { abortScope(err); console.warn('Trap A: ', err.message) }
    return $scope // installTrap($scope, err => { console.warn('Trap B: ', err.message) })
      .catch(err => { console.warn('Trap B: ', err.message); throw err })
  }

  /*
  // Now some black magic
  function installTrap (p, h, depth = 0) {
    if (!p || typeof p.then !== 'function') return p
    const t = p.then.bind(p)
    p.then = (a) => {
      console.info(depth, 'Installing trap after', a.toString())
      const next = t(s => { console.log(depth, 'then Hijacked', s[0]); return a(s) })
        .catch(err => { console.log(depth, 'catch Hijacked', err); h(err); throw err })
      installTrap(next, h, ++depth)
      return next
    }
    return p
  }
  */

  function tearDown (isA, error = null) {
    if (closed) return true
    D('PipeClosed by: %s cause: %s pending: %d', isA ? 'A' : 'B', error?.message, pending.size)
    closed = true // block further interaction
    for (const set of pending) {
      pending.delete(set)
      set.abort(error || new Error('Disconnected'))
    }
    if (!error) gracefulClose()
    else destroy(error)
    if (broadcastsExported[0]) abortCastA(error || new Error('Disconnected'))
    if (broadcastsExported[1]) abortCastB(error || new Error('Disconnected'))
    return $closed
  }
}

function isPlug (o) { return !!(o && o[PLUG_SYMBOL]) }

function spliceWires (a, b) {
  if (!isPlug(a) || !isPlug(b)) throw new Error('Expected two pipe-ends')
  // console.log(`Splicing ${plug.id} <--> ${other.id}`)
  async function stitch (sink, scope) {
    if (!Array.isArray(scope)) throw new Error('DesignFlaw')
    const [msg, reply] = scope
    let next = sink(msg, !!reply)
    if (reply) next = next.then(stitch.bind(null, reply))
    return next
      .catch(err => {
        console.warn('Trap S: ', err.message)
        throw err
      })
  }
  a.onmessage = (msg, reply) => stitch(b.postMessage, [msg, reply])
  b.onmessage = (msg, reply) => stitch(a.postMessage, [msg, reply])
  a.closed.then(b.close).catch(b.close)
  b.closed.then(a.close).catch(a.close)
  return a.close
}

function _picoWire (onmessage, onopen, onclose) {
  const [a, b] = picoWire()
  a.closed
    .then(onclose)
    .catch(onclose)
  a.opened
    .then(onopen)
    .catch(onopen)
  a.onmessage = onmessage
  return b
}

function unpromiseTimeout (t, debug = false) {
  const [promise, set, abort] = unpromise(debug)
  const id = setTimeout(abort.bind(null, new Error('Timeout')), t)
  return [
    promise,
    (err, value) => {
      clearTimeout(id)
      set(err, value)
    },
    function _abort (err) {
      clearTimeout(id)
      abort(err || new Error('Aborted'))
    }
  ]
}

// Stay healthy, stay sane
let _unpctr = 0
const _active = []
function unpromiseD (tag = '_') {
  const id = _unpctr++
  console.debug('[UNP]', id, tag, 'Promise Created')
  const [$p, set, abort] = unpromise()
  _active[id] = abort
  return [
    $p.then(v => ((notify('resolved', v), v)))
      .catch(e => { notify('rejected', undefined, e); throw e }),
    v => { notify('set', v); set(v) },
    e => { notify('abort', undefined, e); abort(e) }
  ]
  function notify (state, value, error) {
    _active[id] = undefined
    const active = _active.map((a, i) => a && i).filter(n => n)
    if (state === 'set') return
    console.debug(
      '[UNP]',
      id,
      tag,
      state,
      `P(${active.join(',')})`,
      error
        ? error.message
        : Array.isArray(value)
          ? `Arr[${value.length}]: ${value[0] || ''}`
          : value
    )
  }
}
function unpromise (debug = false) {
  if (debug) return unpromiseD(debug)
  let set, abort
  return [
    new Promise((resolve, reject) => { set = resolve; abort = reject }),
    set,
    abort
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
  constructor (onmessage, onclose) {
    this.broadcast = this.broadcast.bind(this)
    this._nodes = new Set()
    this._tap = null
    if (typeof onmessage === 'function') this._tap = onmessage
    if (typeof onclose === 'function') this._afterRemove = onclose
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
  createWire (externalOnOpen, id) {
    const [hubEnd, looseEnd] = picoWire({ id })
    hubEnd.onmessage = (msg, reply) => {
      if (this._tap) this._tap(hubEnd, msg, reply)
      else this._broadcast(hubEnd, msg, reply)
    }
    hubEnd.opened.then(open => {
      if (!open) return console.warn('wire.opened resolved false?', open)
      this._nodes.add(hubEnd)
      if (typeof externalOnOpen === 'function') externalOnOpen(hubEnd)
    }).catch(err => this.disconnect(hubEnd, err))

    hubEnd.closed.then(() => this.disconnect(hubEnd))
      .catch(err => this.disconnect(hubEnd, err))
    return looseEnd
  }

  async _broadcast (source, msg, reply, ...filter) {
    const sid = !isPlug(source) ? source : undefined
    const pending = []
    for (const sink of this._nodes) {
      if (sink === source) continue
      if (sid && sink.id === sid) continue
      // TODO: don't like this, remove prob
      if (filter.find(t => isPlug(t) ? t === sink : t === sink.id)) continue
      const p = sink.postMessage(msg, !!reply)
      if (reply) pending.push(p)
    }
    return Promise.all(pending)
  }

  // TODO: remove this functionality unless we're prepared to recognize the PicoFax-machine.
  // messages shouldn't be broadcasted really, at least not directly injected into a hub...
  // though then survey() function needs to be rethought as well.
  async broadcast (msg, reply, ...filter) {
    return this._broadcast(null, msg, reply, ...filter)
  }

  disconnect (sink, err) {
    if (!sink) return false
    if (this._nodes.delete(sink)) {
      if (typeof this._afterRemove === 'function') this._afterRemove(sink, err)
      else if (err) console.warn('NodeDisconnected', err)
      return true
    }
    // Attempt to delete by id equality
    for (const sink of this._nodes) {
      if (sink.id === sink && this._nodes.delete(sink)) {
        if (typeof this._afterRemove === 'function') this._afterRemove(sink, err)
        else if (err) console.warn('NodeDisconnected', err)
        return true
      }
    }
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
 * Or maybe more like ports.
 * TODO: convert into binaryEncoderAdapter(plug) for compatibility with
 * any type of serial socket.
 */
const NETWORK_TIMEOUT = 30 * 1000
function hyperWire (plug, hyperStream, key, extensionId = 125) {
  if (!isPlug(plug)) throw new Error('Wire end expected')
  const routingTable = new Map()
  let seq = 1
  const channel = hyperStream.open(key, {
    onextension: onStreamReceive,
    onclose: plug.close
  })
  const closeStream = () => {
    channel.close()
  }
  // TODO: consider changing onmessage api to (scope: Array)
  // to avoid unwrap/rewrap issues
  plug.onmessage = (...args) => sendExt(0, args)
  plug.closed
    .then(() => !channel.closed && closeStream())
    .catch(err => hyperStream.delete(err))
  return closeStream

  function onStreamReceive (id, chunk) {
    if (id !== extensionId) {
      return console.warn('Message dropped! multiple extensions on this channel??', extensionId, id)
    }
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    const flags = chunk[4]
    const replyExpected = !!(flags & REPLY_EXPECTED)
    if (routingTable.has(dstPort)) {
      const { replyTo, timer } = routingTable.get(dstPort)
      routingTable.delete(dstPort)
      clearTimeout(timer)
      replyTo(chunk.slice(5), flags)
        .then(replyExpected && sendExt.bind(null, srcPort))
        .catch(error => console.error('Hyperwire writeerror', error))
    } else if (dstPort === 0) { // broadcast
      plug.postMessage(chunk.slice(5), flags)
        .then(replyExpected && sendExt.bind(null, srcPort))
        .catch(error => console.error('Hyperwire writeerror', error))
    } else {
      console.warn('Hyperwire message dropped! unknown port', dstPort, srcPort)
    }
  }

  function sendExt (dstPort, scope) {
    const [message, replyTo] = scope
    if (!Buffer.isBuffer(message)) throw new Error('Binary message expected')
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
module.exports.simpleWire = _picoWire

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
