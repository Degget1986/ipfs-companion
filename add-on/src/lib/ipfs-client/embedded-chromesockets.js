'use strict'
/* eslint-env browser, webextensions */
const browser = require('webextension-polyfill')

/* *********************************************************
   This file is a wip sandbox.
   Code will be refactored when kinks are ironed out.
   ********************************************************* */

const debug = require('debug')
const log = debug('ipfs-companion:client:embedded')
log.error = debug('ipfs-companion:client:embedded:error')

// Polyfills required by embedded HTTP server
const uptimeStart = Date.now()
process.uptime = () => Math.floor((Date.now() - uptimeStart) / 1000)
process.hrtime = require('browser-process-hrtime')

const mergeOptions = require('merge-options')
const Ipfs = require('ipfs')
const HttpApi = require('ipfs/src/http')
const multiaddr = require('multiaddr')
const maToUri = require('multiaddr-to-uri')
const getPort = require('get-port')

// libp2p
const WS = require('libp2p-websockets')
// const WSM = require('libp2p-websocket-star-multi')
const TCP = require('libp2p-tcp')
const MulticastDNS = require('libp2p-mdns')
const Bootstrap = require('libp2p-bootstrap')

const { optionDefaults } = require('../options')

// js-ipfs with embedded hapi HTTP server
let node = null
let nodeHttpApi = null

async function buildConfig (opts) {
  const defaultOpts = JSON.parse(optionDefaults.ipfsNodeConfig)
  const userOpts = JSON.parse(opts.ipfsNodeConfig)

  const ipfsNodeConfig = mergeOptions.call({ concatArrays: true }, defaultOpts, userOpts, { start: false })

  // TODO: replace object with function that builds the bundle
  // See defaultBundle in js-ipfs/src/core/components/libp2p.js
  ipfsNodeConfig.libp2p = {
    // node defaults instead of browser ones
    switch: {
      blacklistTTL: 2 * 60 * 1e3, // 2 minute base
      blackListAttempts: 5, // back off 5 times
      maxParallelDials: 150,
      maxColdCalls: 50,
      dialTimeout: 10e3 // Be strict with dial time
    },
    modules: {
      transport: [new TCP(), new WS()],
      peerDiscovery: [
        MulticastDNS,
        new Bootstrap({ list: ipfsNodeConfig.config.Bootstrap })
      ]
    },
    config: {
      peerDiscovery: {
        autoDial: true,
        mdns: {
          enabled: true
        },
        bootstrap: {
          enabled: true
        },
        websocketStar: {
          enabled: true
        }
      },
      dht: {
        // TODO: KadDHT seems to be CPU-bound in browser context, needs investigation
        kBucketSize: 20,
        enabled: false,
        randomWalk: {
          enabled: false
        }
      }
    }
  }

  // Detect when API or Gateway port is not available (taken by something else)
  // We find the next free port and update configuration to use it instead
  const multiaddr2port = (ma) => parseInt(new URL(multiaddr2httpUrl(ma)).port, 10)
  const gatewayPort = multiaddr2port(ipfsNodeConfig.config.Addresses.Gateway)
  const apiPort = multiaddr2port(ipfsNodeConfig.config.Addresses.API)
  log(`checking if ports are available: api: ${apiPort}, gateway: ${gatewayPort}`)
  const freeGatewayPort = await getPort({ port: getPort.makeRange(gatewayPort, gatewayPort + 100) })
  const freeApiPort = await getPort({ port: getPort.makeRange(apiPort, apiPort + 100) })
  if (gatewayPort !== freeGatewayPort || apiPort !== freeApiPort) {
    log(`updating config to available ports: api: ${freeApiPort}, gateway: ${freeGatewayPort}`)
    const addrs = ipfsNodeConfig.config.Addresses
    addrs.Gateway = addrs.Gateway.replace(gatewayPort.toString(), freeGatewayPort.toString())
    addrs.API = addrs.API.replace(apiPort.toString(), freeApiPort.toString())
  }

  return ipfsNodeConfig
}

exports.init = async function init (opts) {
  log('init embedded:chromesockets')

  const ipfsOpts = await buildConfig(opts)
  log('creating js-ipfs with opts: ', ipfsOpts)
  node = new Ipfs(ipfsOpts)

  return new Promise((resolve, reject) => {
    node.once('error', (error) => {
      log.error('something went terribly wrong during startup of js-ipfs!', error)
      reject(error)
    })
    node.once('ready', async () => {
      node.once('start', async () => {
        // HttpApi is off in browser context and needs to be started separately
        try {
          const httpServers = new HttpApi(node, ipfsOpts)
          nodeHttpApi = await httpServers.start()
          await updateConfigWithHttpEndpoints(node, opts)
          resolve(node)
        } catch (err) {
          reject(err)
        }
      })
      try {
        node.on('error', error => {
          log.error('something went terribly wrong in embedded js-ipfs!', error)
        })
        await node.start()
      } catch (err) {
        reject(err)
      }
    })
  })
}

const multiaddr2httpUrl = (ma) => maToUri(ma.includes('/http') ? ma : multiaddr(ma).encapsulate('/http'))

// Update internal configuration to HTTP Endpoints from js-ipfs instance
async function updateConfigWithHttpEndpoints (ipfs, opts) {
  const localConfig = await browser.storage.local.get('ipfsNodeConfig')
  if (localConfig && localConfig.ipfsNodeConfig) {
    const gwMa = await ipfs.config.get('Addresses.Gateway')
    const apiMa = await ipfs.config.get('Addresses.API')
    const httpGateway = multiaddr2httpUrl(gwMa)
    const httpApi = multiaddr2httpUrl(apiMa)
    // update ports in JSON configuration for embedded js-ipfs
    const ipfsNodeConfig = JSON.parse(localConfig.ipfsNodeConfig)
    ipfsNodeConfig.config.Addresses.Gateway = gwMa
    ipfsNodeConfig.config.Addresses.API = apiMa
    const configChanges = {
      customGatewayUrl: httpGateway,
      ipfsApiUrl: httpApi,
      ipfsNodeConfig: JSON.stringify(ipfsNodeConfig, null, 2)
    }
    // update current runtime config (in place)
    Object.assign(opts, configChanges)
    // update user config in storage (triggers async client restart if ports changed)
    log(`synchronizing ipfsNodeConfig with customGatewayUrl (${configChanges.customGatewayUrl}) and ipfsApiUrl (${configChanges.ipfsApiUrl})`)
    await browser.storage.local.set(configChanges)
  }
}

exports.destroy = async function () {
  log('destroy: embedded:chromesockets')

  if (nodeHttpApi) {
    try {
      await nodeHttpApi.stop()
    } catch (err) {
      // TODO: needs upstream fix like https://github.com/ipfs/js-ipfs/issues/2257
      if (err.message !== 'Cannot stop server while in stopping phase') {
        log.error('failed to stop HttpApi', err)
      }
    }
    nodeHttpApi = null
  }
  if (node) {
    const stopped = new Promise((resolve, reject) => {
      node.on('stop', resolve)
      node.on('error', reject)
    })
    try {
      await node.stop()
    } catch (err) {
      // TODO: remove when fixed upstream: https://github.com/ipfs/js-ipfs/issues/2257
      if (err.message === 'Not able to stop from state: stopping') {
        log('destroy: embedded:chromesockets waiting for node.stop()')
        await stopped
      } else {
        throw err
      }
    }
    node = null
  }
}
