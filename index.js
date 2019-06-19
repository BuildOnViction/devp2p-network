const chalk = require('chalk')
const os = require('os')
const Buffer = require('safe-buffer').Buffer
const { randomBytes } = require('crypto')
const devp2p = require('ethereumjs-devp2p')
const geoip = require('geoip-lite')
const debug = require('debug')('infura:main')
const Web3 = require('web3')
// https://github.com/ethereum/web3.js/issues/2786
const web3 = new Web3('https://rpc.tomochain.com')
const _ = require('lodash')
const db = require('./lib/db')()
const Common = require('ethereumjs-common')

const options = {
    name: 'TomoChain',
    chainId: 88,
    networkId: 88,
    comment: 'TomoChain - The most efficient Blockchain for the Token Economy',
    hardforks: [],
    genesis: {
        hash: '9326145f8a2c8c00bbe13afc7d7f3d9c868b5ef39d89f2f4e9390e9720298624'
    },
    bootstrapNodes: [{
        id: '97f0ca95a653e3c44d5df2674e19e9324ea4bf4d47a46b1d8560f3ed4ea328f725acec3fcfcb37eb11706cf07da669e9688b091f1543f89b2425700a68bc8876',
        ip: '104.248.98.78',
        port: 30301
    }, {
        id: 'b72927f349f3a27b789d0ca615ffe3526f361665b496c80e7cc19dace78bd94785fdadc270054ab727dbb172d9e3113694600dd31b2558dd77ad85a869032dea',
        ip: '188.166.207.189',
        port: 30301
    }]
}
const c = new Common(options)
//const web3Url = process.env.PROVIDER || `https://mainnet.infura.io/v3/${process.env.INFURA_ID}`
const tomoProvider = new Web3.providers.HttpProvider('https://rpc.tomochain.com')
web3.setProvider(tomoProvider)

const { EthPeer, PeerErr } = db

const PRIVATE_KEY = randomBytes(32)
const BOOTNODES = c.bootstrapNodes().map((node) => {
  return {
    address: node.ip,
    udpPort: node.port,
    tcpPort: node.port
  }
})

const CHAIN_ID = 88
const GENESIS_TD = 17179869184
const GENESIS_HASH = Buffer.from('9326145f8a2c8c00bbe13afc7d7f3d9c868b5ef39d89f2f4e9390e9720298624', 'hex')

const myStatus = {
  networkId: CHAIN_ID,
  td: devp2p._util.int2buffer(GENESIS_TD),
  genesisHash: GENESIS_HASH,
  bestHash: GENESIS_HASH
}

const dpt = new devp2p.DPT(Buffer.from(PRIVATE_KEY, 'hex'), {
  endpoint: {
    address: '0.0.0.0',
    udpPort: null,
    tcpPort: null
  },
  refreshInterval: 20000 // refresh every 20s
})

// RLPx
const rlpx = new devp2p.RLPx(PRIVATE_KEY, {
  dpt: dpt,
  clientId: `tomo/v1.4.1-stable/${os.platform()}-${os.arch()}/go1.10.8`,
  maxPeers: 25,
  capabilities: [
    devp2p.ETH.eth63,
    devp2p.ETH.eth62
  ],
  remoteClientIdFilter: [],
  listenPort: null
})

rlpx.on('error', (err) => console.error(chalk.red(`RLPx error: ${err.stack || err}`)))

rlpx.on('peer:added', (peer) => {
  let hello = peer.getHelloMessage()
  let capabilityStr = _.map(hello.capabilities, (cap) => { return `${cap.name}.${cap.version}` })
  let { remoteAddress, remotePort } = peer._socket
  let splitClientId = hello.clientId.split('/')
  let peerGeo = geoip.lookup(remoteAddress)

  peer.on('error', (err) => {
    debug(`${remoteAddress}:${remotePort} (Peer Error) ${err}`)
    PeerErr.create({
      address: remoteAddress,
      capabilities: capabilityStr,
      clientId: hello.clientId,
      country: _.has(peerGeo, 'country') ? peerGeo.country : null,
      enode: hello.id.toString('hex'),
      port: peer._socket.remotePort,
      timestamp: new Date(),
      error: err.message,
      clientMeta1: splitClientId[0],
      clientMeta2: splitClientId[1],
      clientMeta3: splitClientId[2],
      clientMeta4: splitClientId[3],
      latitude: peerGeo.ll[0],
      longitude: peerGeo.ll[1]
    }).then(() => {
      debug('Saved peer error')
    }).catch((err) => {
      debug(`Error saving peerErr: ${err}`)
    })
  })

  debug(`${remoteAddress}: ${capabilityStr}`)
  let b = EthPeer.build({
    address: remoteAddress,
    capabilities: capabilityStr,
    clientId: hello.clientId,
    enode: hello.id.toString('hex'),
    port: peer._socket.remotePort,
    timestamp: new Date(),
    country: _.has(peerGeo, 'country') ? peerGeo.country : null,
    city: _.has(peerGeo, 'city') ? peerGeo.city : null,
    latitude: peerGeo.ll[0],
    longitude: peerGeo.ll[1],
    clientMeta1: splitClientId[0],
    clientMeta2: splitClientId[1],
    clientMeta3: splitClientId[2],
    clientMeta4: splitClientId[3]
  })

  const eth = peer.getProtocols()[0]
  eth.sendStatus(myStatus)

  eth.once('status', (peerStatus) => {
    debug(`${remoteAddress}: Received status`)
    b.bestHash = '0x' + peerStatus.bestHash.toString('hex')
    b.totalDifficulty = peerStatus.td.toString('hex')
    web3.eth.getBlock(b.bestHash, false)
      .then((block) => {
        if (_.has(block, 'number')) {
          debug(`Received: ${block.number}`)
          b.bestBlockNumber = block.number
        }
        return web3.eth.getBlockNumber()
      })
      .then((infuraBlockNumber) => {
        debug(`Infura Block: ${infuraBlockNumber}`)
        b.infuraBlockNumber = infuraBlockNumber
        b.infuraDrift = Math.abs(b.infuraBlockNumber - b.bestBlockNumber) || 0
        debug(`Found Drift: ${b.infuraDrift}`)
        // db.on('error', console.error.bind(console, 'connection error:'))
        b.save().then((ethpeer) => {
          debug(`${remoteAddress}: Saved peer ${ethpeer.enode}`)
        })
      })
      .catch(function (err) {
        console.error(err)
      })
  })
})

rlpx.on('peer:removed', (peer) => {
  debug(peer._socket.remoteAddress, peer.getDisconnectPrefix(peer._disconnectReason))
  // const eth = peer.getProtocols()[0]
  // eth.sendStatus(myStatus)
})

for (let bootnode of BOOTNODES) {
  debug(`Connecting to ${bootnode.address}`)
  dpt.bootstrap(bootnode).catch((err) => console.error(chalk.bold.red(err.stack || err)))
}

dpt.on('error', (err) => console.error(chalk.red(err.stack || err)))

dpt.on('peer:added', (peer) => {
  // const info = `(${peer.id.toString('hex')},${peer.address},${peer.udpPort},${peer.tcpPort})`
  // console.log(chalk.green(`New peer: ${info} (total: ${dpt.getPeers().length})`))
  debug(`DHT peer count: ${dpt.getPeers().length}`)
})

dpt.on('peer:removed', (peer) => {
  // console.log(chalk.yellow(`Remove peer: ${peer.id.toString('hex')} (total: ${dpt.getPeers().length})`))
})

function runIdle () {
}

function run () {
  setInterval(runIdle, 30000)
}

run()
