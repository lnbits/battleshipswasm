import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
const source = await fs.readFile(
  new URL('../../static/admin.js', import.meta.url),
  'utf8'
)
const calls = []
const notices = []
let component
const client = {
  async requestBackgroundPaymentPermission(grant, options) {
    calls.push({grant, options})
    return {grant: {max_amount: 37}}
  }
}
const window = {createLNbitsExtensionClient: () => client}
const Vue = {
  createApp(definition) {
    component = definition
    return {use() {}, mount() {}}
  }
}

Function('window', 'Vue', 'Quasar', source)(window, Vue, {})

const context = {
  effectiveWalletId: 'wallet_1',
  canAuthorizePayments: true,
  authorizingPayments: false,
  paymentAuthorizationGrant() {
    return component.methods.paymentAuthorizationGrant.call(this)
  },
  notify(message, type) {
    notices.push({message, type})
  },
  showError(error) {
    throw error
  }
}

assert.deepEqual(context.paymentAuthorizationGrant(), {
  walletId: 'wallet_1',
  maxAmount: 1,
  destinationPolicy: 'own_wallets_only'
})
assert.equal(component.computed.canAuthorizePayments.call({
  settings: {enabled: true},
  effectiveWalletId: 'wallet_1',
  gameForm: {joinAmount: ''}
}), true)
await component.methods.authorizePayments.call(context)
assert.deepEqual(calls, [{
  grant: {
    walletId: 'wallet_1',
    maxAmount: 1,
    destinationPolicy: 'own_wallets_only'
  },
  options: {forcePrompt: true}
}])
assert.deepEqual(notices, [{
  message: 'Payment permission saved at 37 sats.',
  type: 'positive'
}])

console.log('Battleships payment authorization tests passed')
