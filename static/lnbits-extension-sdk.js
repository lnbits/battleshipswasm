;(function () {
  let bridgePortPromise = null
  const bridgeEventHandlers = new Map()
  const LOG_PREFIX = '[battleshipswasm extension]'

  function createLNbitsExtensionClient({extensionId}) {
    const baseUrl = `/api/v1/ext/${extensionId}`

    return {
      context() {
        return bridgeRequest({action: 'context'})
      },

      notify(message, level = 'info') {
        return bridgeRequest({
          action: 'ui.notify',
          level,
          message: errorMessage(message)
        })
      },

      notifyError(message) {
        return this.notify(message, 'negative')
      },

      requestBackgroundPaymentPermission(grant, options = {}) {
        return bridgeRequest({
          action: 'permissions.request_background_payment',
          grant,
          forcePrompt: options.forcePrompt === true
        })
      },

      getSettings() {
        return request(`${baseUrl}/settings`)
      },

      saveSettings(payload) {
        return request(`${baseUrl}/settings`, {
          method: 'PUT',
          body: payload
        })
      },

      listWallets() {
        return request(`${baseUrl}/wallets`)
      },

      createGame(payload) {
        return request(`${baseUrl}/games`, {
          method: 'POST',
          body: payload
        })
      },

      listGames(params = {}) {
        const query = new URLSearchParams()
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === '') continue
          query.set(key, String(value))
        }
        const suffix = query.toString() ? `?${query.toString()}` : ''
        return request(`${baseUrl}/games${suffix}`)
      },

      deleteGame(gameId) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}`, {
          method: 'DELETE'
        })
      },

      getPublicGame(gameId, playerToken = '', options = {}) {
        const query = new URLSearchParams()
        if (playerToken) query.set('playerToken', playerToken)
        if (Number.isInteger(options.shotOffset) && options.shotOffset >= 0) {
          query.set('shotOffset', String(options.shotOffset))
        }
        if (Number.isInteger(options.shotLimit) && options.shotLimit > 0) {
          query.set('shotLimit', String(options.shotLimit))
        }
        const suffix = query.toString() ? `?${query.toString()}` : ''
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}${suffix}`)
      },

      joinGame(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/join`, {
          method: 'POST',
          body: payload
        })
      },

      placeFleet(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/fleet`, {
          method: 'POST',
          body: payload
        })
      },

      fireShot(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/shots`, {
          method: 'POST',
          body: payload
        })
      },

      resign(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/resign`, {
          method: 'POST',
          body: payload
        })
      },

      settlePlayerPayout(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/payout`, {
          method: 'POST',
          body: payload
        })
      },

      settleGame(gameId) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/settle`, {
          method: 'POST',
          body: {}
        })
      },

      subscribePayment(paymentHash, callback) {
        return subscribePayment(paymentHash, callback)
      },

      subscribeWebsocket(itemId, callback) {
        return subscribeWebsocket(itemId, callback)
      }
    }
  }

  function request(path, {method = 'GET', body = null} = {}) {
    const safeBody = plainData(body)
    const message = {
      action: 'api',
      method,
      path,
      body: safeBody
    }

    return bridgeRequest(message)
      .then(unwrapRuntimeResponse)
      .catch(error => {
        logFailure('API request failed.', {method, path, body: safeBody, error})
        throw error
      })
  }

  function plainData(value) {
    if (value === undefined || value === null) return null
    return JSON.parse(JSON.stringify(value))
  }

  function bridgeRequest(message) {
    if (window.parent === window) {
      const error = new Error('LNbits extension bridge is not available.')
      logFailure('Bridge unavailable.', {message, error})
      return Promise.reject(error)
    }

    return getBridgePort()
      .then(port => bridgePortRequest(port, message))
      .catch(error => {
        if (message.action !== 'api') {
          logFailure('Bridge request failed.', {message, error})
        }
        throw error
      })
  }

  function getBridgePort() {
    if (!bridgePortPromise) {
      bridgePortPromise = connectBridge()
    }
    return bridgePortPromise
  }

  function connectBridge() {
    const id = requestId()
    const channel = new MessageChannel()
    const parentOrigin = bridgeParentOrigin()

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.port1.removeEventListener('message', onMessage)
        channel.port1.close()
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== channel.port1) return
        const response = event.data
        if (!response || response.type !== 'lnbits-extension:connected' || response.id !== id) {
          return
        }
        window.clearTimeout(timeout)
        channel.port1.removeEventListener('message', onMessage)
        attachBridgeEvents(channel.port1)
        resolve(channel.port1)
      }

      channel.port1.addEventListener('message', onMessage)
      channel.port1.start()
      window.parent.postMessage({type: 'lnbits-extension:connect', id}, parentOrigin, [channel.port2])
    })
  }

  function bridgePortRequest(port, message) {
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', onMessage)
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== port) return
        const response = event.data
        if (!response || response.type !== 'lnbits-extension:response' || response.id !== id) {
          return
        }
        window.clearTimeout(timeout)
        port.removeEventListener('message', onMessage)
        if (response.ok === false) {
          reject(new Error(response.error || 'Extension call failed.'))
          return
        }
        resolve(response.data)
      }

      port.addEventListener('message', onMessage)
      port.postMessage({type: 'lnbits-extension:request', id, ...message})
    })
  }

  function attachBridgeEvents(port) {
    if (port.__lnbitsExtensionEventsAttached) return
    port.__lnbitsExtensionEventsAttached = true
    port.addEventListener('message', event => {
      if (event.currentTarget !== port) return
      const message = event.data
      if (!message || message.type !== 'lnbits-extension:event') return
      const handler = bridgeEventHandlers.get(message.subscriptionId)
      if (handler) handler(message)
    })
  }

  function subscribePayment(paymentHash, callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(new Error('Payment subscription needs a callback.'))
    }
    const subscriptionId = requestId()
    bridgeEventHandlers.set(subscriptionId, callback)
    return bridgeRequest({
      action: 'payment.subscribe',
      subscriptionId,
      paymentHash
    })
      .then(() => {
        let active = true
        return () => {
          if (!active) return
          active = false
          bridgeEventHandlers.delete(subscriptionId)
          bridgeRequest({action: 'payment.unsubscribe', subscriptionId}).catch(error => {
            logFailure('Payment unsubscribe failed.', {subscriptionId, error})
          })
        }
      })
      .catch(error => {
        bridgeEventHandlers.delete(subscriptionId)
        throw error
      })
  }

  function subscribeWebsocket(itemId, callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(new Error('Websocket subscription needs a callback.'))
    }
    const subscriptionId = requestId()
    bridgeEventHandlers.set(subscriptionId, callback)
    return bridgeRequest({
      action: 'websocket.subscribe',
      subscriptionId,
      itemId
    })
      .then(() => {
        let active = true
        const deactivate = () => {
          active = false
          bridgeEventHandlers.delete(subscriptionId)
        }
        return {
          get active() {
            return active
          },
          unsubscribe() {
            if (!active) return
            deactivate()
            bridgeRequest({action: 'websocket.unsubscribe', subscriptionId}).catch(error => {
              logFailure('Websocket unsubscribe failed.', {subscriptionId, error})
            })
          }
        }
      })
      .catch(error => {
        bridgeEventHandlers.delete(subscriptionId)
        throw error
      })
  }

  function unwrapRuntimeResponse(value) {
    if (typeof value === 'string') value = JSON.parse(value)
    if (value && value.ok === false) throw new Error(value.error || 'Extension call failed.')
    if (value && value.ok === true) return value.data || {}
    return value || {}
  }

  function errorMessage(value) {
    return String(value || 'Something went wrong.').slice(0, 500)
  }

  function requestId() {
    return (
      window.crypto?.randomUUID?.() ||
      `request_${Date.now()}_${Math.random().toString(36).slice(2)}`
    )
  }

  function bridgeParentOrigin() {
    return new URL(window.location.href).origin
  }

  function logFailure(message, details = {}) {
    if (!window.console || typeof window.console.error !== 'function') return
    window.console.error(LOG_PREFIX, message, details)
  }

  window.createLNbitsExtensionClient = createLNbitsExtensionClient
})()
