import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
source = source.replace(/^import .*\n\n/, '').replace(/export function /g, 'function ')

const rows = new Map()
const storage = {
  get(table, id, fallback) {
    return rows.get(`${table}:${id}`) || fallback
  },
  set(table, row) {
    rows.set(`${table}:${row.id}`, row)
  },
  getPaginated(table) {
    const data = [...rows.entries()]
      .filter(([key]) => key.startsWith(`${table}:`))
      .map(([, row]) => row)
    return {data, total: data.length}
  }
}
const system = {
  id() { return {id: 'battleships_1'} },
  now() { return 1_700_000_000 },
  log() {}
}
const api = Function(
  'storage', 'system', 'wallet', 'websocket',
  `${source}; return {saveBattleshipsSettings, createBattleshipsGame, payoutAmount}`
)(storage, system, {}, {})

const saved = JSON.parse(api.saveBattleshipsSettings(JSON.stringify({
  enabled: true,
  walletId: 'wallet_1',
  walletName: 'Wallet',
  haircut: 15
})))
assert.equal(saved.ok, true, saved.error)
assert.equal(saved.data.settings.haircut, 15)
assert.equal(saved.data.settings.id, 'battleships_1')

const resaved = JSON.parse(api.saveBattleshipsSettings(JSON.stringify({
  enabled: true,
  walletId: 'wallet_2',
  walletName: 'Second wallet',
  haircut: 15
})))
assert.equal(resaved.ok, true, resaved.error)
assert.equal(resaved.data.settings.id, saved.data.settings.id)
assert.equal(resaved.data.settings.walletId, 'wallet_2')

const created = JSON.parse(api.createBattleshipsGame(JSON.stringify({
  name: 'Haircut game',
  joinAmount: 101
})))
assert.equal(created.ok, true, created.error)
assert.equal(created.data.game.haircut, 15)
assert.equal(rows.get('battleships_games:battleships_1').wallet_id, 'wallet_2')
assert.equal(api.payoutAmount(rows.get('battleships_games:battleships_1')), 171)

console.log('Battleships haircut tests passed')
