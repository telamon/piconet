// SPDX-License-Identifier: AGPL-3.0-or-later
const PLUG_SYMBOL = Symbol.for('pico:plug')
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

  const [$closed, setClosed] = unpromise()
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
        return Promise.race([
          (isA ? castB : castA).then(cast => !!cast),
          $closed.then(() => { throw new Error('Disconnected') })
        ])
      },
      get closed () {
        return $closed
      },
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
        const resolve = scope => sink(scope)
        return Recurser(isA, resolve, msg, flags)
      },
      get isActive () { return (isA ? bOpened : aOpened) && !closed },
      get isClosed () { return closed },

      open (handler) {
        if (isPlug(handler)) return spliceWires(plug, handler)
        plug.onmessage = handler
        return plug.opened
          .then(() => [plug.postMessage, plug])
      },
      close (err = null) { tearDown(isA, err) },
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
    if (closed) throw new Error('Disconnected') // console.warn('Message dropped, connection closed', msg)
    if (typeof flags === 'function') throw new Error('Callback API has been deprecated')
    const replyExpected = flags & REPLY_EXPECTED || flags
    const tag = module.exports.V && `${(isA ? a : b).name} = ${msg.toString(Buffer.isBuffer(msg) && 'hex').slice(0, 14)}`
    const [$scope, setScope, abortScope] = unpromiseTimeout(MESSAGE_TIMEOUT, tag)
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
    // console.debug('PipeClosed by: %s cause: %s pending: %d', isA ? 'A' : 'B', error?.message, pending.size)
    closed = true // block further interaction
    for (const set of Array.from(pending)) {
      pending.delete(set)
      set.abort(error || new Error('Disconnected'))
    }
    setClosed(error)
    if (broadcastsExported[0]) abortCastA(error || new Error('Disconnected'))
    if (broadcastsExported[1]) abortCastB(error || new Error('Disconnected'))
    return $closed
  }
}

function isPlug (o) { return !!(o && o[PLUG_SYMBOL]) }

function spliceWires (a, b) {
  if (!isPlug(a) || !isPlug(b)) throw new Error('Expected two pipe-ends')
  // console.log(`Splicing ${plug.id} <--> ${other.id}`)
  function stitch (sink, scope) {
    if (!Array.isArray(scope)) throw new Error('DesignFlaw')
    const [msg, reply] = scope
    let next = sink(msg, !!reply)
    if (reply) next = next.then(stitch.bind(null, reply))
    return next
      .catch(err => {
        console.warn('Trap S: ', err.message)
        // throw err // there's nothing to catch this error
      })
  }
  a.onmessage = scope => stitch(b.postMessage, scope)
  b.onmessage = scope => stitch(a.postMessage, scope)
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
  let stack = null
  try { throw new Error() } catch (e) { stack = e.stack }
  console.debug('[UNP]', id, tag, 'Promise Created\n', module.exports.V > 1 && stack)

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
    if (state === 'set') {
      let stack = null
      try { throw new Error() } catch (e) { stack = e.stack }
      module.exports.V > 1 && console.debug('[UNP]', id, tag, 'SET at: \n', stack)
      return
    }
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
 *
 * @param {function<Receiver>} onmessage a default sink for all incoming messages
 * @param {function} onclose triggers whenever a wire is closed
 */
class PicoHub {
  constructor (onmessage, onclose) {
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
  createWire (externalOnOpen, opts = {}) {
    const [hubEnd, looseEnd] = picoWire(opts)
    hubEnd.onmessage = ([msg, reply]) => {
      if (this._tap) {
        this._tap(hubEnd, msg, reply)
          .catch(err => console.error('_tap failed:', err))
      } else {
        return this.broadcast(msg, reply, hubEnd)
          .catch(err => console.error('_broadcast failed:', err))
      }
    }
    const antiLeakTimer = setTimeout(
      () => hubEnd.close(new Error('NodeTimedout')),
      30 * 1000
    )
    hubEnd.opened.then(open => {
      if (!open) return console.warn('wire.opened resolved false?', open)
      clearTimeout(antiLeakTimer)
      this._nodes.add(hubEnd)
      if (typeof externalOnOpen === 'function') externalOnOpen(hubEnd)
    }).catch(err => this.disconnect(hubEnd, err))

    hubEnd.closed.then(err => this.disconnect(hubEnd, err))
    return looseEnd
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
   * A special broadcast that supports bi-directional channels
   * */
  async * survey (message, flags, filter) {
    let abort = false
    const pending = new Set()
    // Broadcast message to all wires, push returned promise to pending
    for (const sink of this._filterNodes(filter)) {
      const p = sink.postMessage(message, flags)
      pending.add(p)
      p.catch(err => {
        pending.delete(p)
        console.warn('Survey node ignored:', err)
      })
    }
    // race all promises and remove them from pending list as they resolve or timeout.
    while (!abort && pending.size) {
      const res = await Promise.race(
        Array.from(pending)
          .map(p => p.then(val => ({ val, p })))
      )
      if (!res) continue
      pending.delete(res.p)
      const abortSurvey = () => { abort = true }
      yield [...res.val, abortSurvey]
    }
  }

  /*
   * A simplier interface for survey iterator
   * that waits for all messages to be transmited
   * before returning. Use survey directly if you want
   * fast asynchroneous behaviour.
   */
  async broadcast (message, flags, filter) {
    const iterator = this.survey(message, flags, filter)
    const responses = []
    let res = await iterator.next()
    while (!res.done) {
      responses.push(res.value)
      res = await iterator.next()
    }
    return responses
  }

  _filterNodes (filter) {
    if (!filter) return this._nodes
    if (!Array.isArray(filter)) filter = [filter]
    return Array.from(this._nodes).filter(sink =>
      sink.isActive &&
      !filter.find(t => isPlug(t) ? t === sink : t === sink.id)
    )
  }
}

/**
 * HyperWire: PicoWire <-> Stream adapter
 * Encodes callstack into vector clocks (inspired by TCP/IP sequence numbers)
 * Or maybe more like ports.
 * TODO: convert into binaryEncoderAdapter(plug) for compatibility with
 * any type of serial socket.
 *
 * @param {Plug} plug
 * @param {HypercoreProtocolStream} hyperstream
 * @param {Buffer<32>} stream encryption key
 */
const NETWORK_TIMEOUT = 30 * 1000
function hyperWire (plug, hyperStream, key, extensionId = 125) {
  if (!isPlug(plug)) throw new Error('Wire end expected')
  const routingTable = new Map()
  let seq = 1
  const channel = hyperStream.open(key, {
    onextension: onStreamReceive,
    onclose: plug.close,
    onchannelclose: () => plug.close()
  })
  const closeStream = err => {
    if (!channel.closed) {
      err ? hyperStream.destroy(err) : channel.close() && hyperStream.end()
    }
  }
  // TODO: consider changing onmessage api to (scope: Array)
  // to avoid unwrap/rewrap issues
  plug.onmessage = scope => sendExt(0, scope)
  plug.closed
    .then(closeStream)
    .catch(closeStream) // TODO: not sure how i thought here both then and catch provides err.
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

/**
 * Converts a plug into a websocket
 * @param {Plug} plug
 * @param {WebSocket} webSocket
 */
function wsWire (plug, webSocket) {
  if (!isPlug(plug)) throw new Error('Wire end expected')
  // Exposing onerror callback here gives socket a chance to recover
  const rt = routingTable(() => plug.close(new Error('ResponseTimeout')))
  webSocket.onclose = ev => ev.wasClean ? plug.close() : plug.close(ev.reason)
  webSocket.onmessage = streamRecv
  webSocket.onerror = plug.close // brainghosts
  webSocket.onopen = () => {
    // Open plug
    plug.onmessage = scope => streamSend(0, scope) // Broadcast
  }
  const closeStream = err => {
    if (err) console.error('WebSocket Disconnected:', err)
    webSocket.close()
  }
  plug.closed
    .then(closeStream)
    .catch(closeStream) // TODO: not sure how i thought here both then and catch provides err.
  return closeStream

  function streamSend (dstPort, scope) {
    const [message, replyTo] = scope
    if (!Buffer.isBuffer(message)) throw new Error('Binary message expected')
    let srcPort = 0
    let flags = 0
    if (typeof replyTo === 'function') {
      srcPort = rt.push(replyTo)
      flags = flags | REPLY_EXPECTED
    }
    // TODO: avoid memcopy + alloc
    const txBuffer = Buffer.alloc(message.length + 5)
    txBuffer.writeUInt16BE(dstPort) // In reply to
    txBuffer.writeUInt16BE(srcPort, 2) // this packet id
    txBuffer[4] = flags
    message.copy(txBuffer, 5)
    webSocket.send(txBuffer)
  }

  function streamRecv (event) {
    const chunk = event.data
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    const flags = chunk[4]
    const replyExpected = !!(flags & REPLY_EXPECTED)
    const replyTo = dstPort === 0 ? plug.postMessage : rt.pop(dstPort)
    if (!replyTo) {
      console.warn('wsWire: message dropped unknown port', dstPort, srcPort)
      return
    }
    replyTo(chunk.slice(5), flags)
      .then(replyExpected && streamSend.bind(null, srcPort))
      .catch(error => console.error('wsWire writeerror', error))
  }
}

// TODO: reimplement chunking using optional flags - don't overengineer.
// const MTU = 256 << 10 // 256kB
/**
 * Adapts a plug into a node-stream
 * !!! ALPHA; Still not testcovered/used
 * @param {Plug} plug
 * @param {DuplexStream} duplexStream
 */
function streamWire (plug, duplexStream) {
  if (!isPlug(plug)) throw new Error('Wire end expected')

  duplexStream.on('data', streamRecv)
  duplexStream.once('close', onclose)
  duplexStream.once('error', onclose)

  const closeStream = err => err ? duplexStream.end() : duplexStream.destroy(err)
  const rt = routingTable(() => closeStream(new Error('ResponseTimeout')))

  plug.onmessage = scope => streamSend(0, scope)
  plug.closed
    .then(closeStream)
    .catch(closeStream)
  return closeStream

  function onclose (err) { // when stream externally closed.
    duplexStream.off('data', streamRecv)
    duplexStream.off('error', onclose)
    duplexStream.off('close', onclose)
    plug.close(err)
  }

  function streamRecv (chunk) {
    const dstPort = chunk.readUInt16BE(0)
    const srcPort = chunk.readUInt16BE(2)
    const flags = chunk[4]
    const replyExpected = !!(flags & REPLY_EXPECTED)
    const replyTo = dstPort === 0 ? plug.postMessage : rt.pop(dstPort)
    if (!replyTo) {
      console.warn('streamWire: message dropped unknown port', dstPort, srcPort)
      return
    }
    replyTo(chunk.slice(5), flags)
      .then(replyExpected && streamSend.bind(null, srcPort))
      .catch(error => console.error('wsWire writeerror', error))
  }

  function streamSend (dstPort, scope) {
    const [message, replyTo] = scope
    if (!Buffer.isBuffer(message)) throw new Error('Binary message expected')
    let srcPort = 0
    let flags = 0
    if (typeof replyTo === 'function') {
      srcPort = rt.push(replyTo)
      flags = flags | REPLY_EXPECTED
    }
    // TODO: avoid memcopy + alloc
    const txBuffer = Buffer.alloc(message.length + 5)
    txBuffer.writeUInt16BE(dstPort) // In reply to
    txBuffer.writeUInt16BE(srcPort, 2) // this packet id
    txBuffer[4] = flags
    // if (flags & FLAG_CHUNK) txBuffer.writeUInt16BE(packetSize, 5) // Packet size
    message.copy(txBuffer, 5)
    duplexStream.write(txBuffer)
  }
}

function routingTable (ontimeout, timeout = NETWORK_TIMEOUT) {
  const rt = new Map()
  let seq = 1
  return {
    push (replyTo) {
      const srcPort = seq++
      const timer = setTimeout(() => {
        if (!rt.has(srcPort)) return
        const replyTo = rt.get(srcPort)
        rt.delete(srcPort)
        ontimeout(srcPort, replyTo)
      }, NETWORK_TIMEOUT)
      rt.set(srcPort, { replyTo, timer })
      return srcPort
    },
    pop (dstPort) {
      if (!rt.has(dstPort)) return
      const { replyTo, timer } = rt.get(dstPort)
      rt.delete(dstPort)
      clearTimeout(timer)
      return replyTo
    }
  }
}

// Practical starting point
module.exports = PicoHub
module.exports.Hub = PicoHub
module.exports.V = 0 // verbosity level 'debug' lib is good but need conditional execution.
// Main pipe/wire spawners
module.exports.picoWire = picoWire
module.exports.simpleWire = _picoWire

// Adapters
module.exports.streamWire = streamWire
module.exports.hyperWire = hyperWire
module.exports.spliceWires = spliceWires
module.exports.wsWire = wsWire

// misc
module.exports.unpromise = unpromise
module.exports.routingTable = routingTable
