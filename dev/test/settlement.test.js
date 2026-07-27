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
  getPaginated() {
    return {data: [], total: 0}
  },
  set(table, row) {
    rows.set(`${table}:${row.id}`, row)
  }
}
let payoutCalls = 0
const wallet = {
  payLnurl(request) {
    payoutCalls += 1
    assert.equal(request.amount, 36)
    return {
      ok: true,
      checkingId: 'payout_1',
      paymentHash: 'hash_1',
      status: 'success'
    }
  }
}
const websocket = {publish() {}}
const system = {now: () => 1_784_736_605, log() {}}
const api = Function(
  'storage',
  'system',
  'wallet',
  'websocket',
  `${source}; return {fireBattleshipsShot, settlePlayerBattleshipsPayout}`
)(storage, system, wallet, websocket)

rows.set('battleships_settings:battleshipswasm-settings', {
  id: 'battleshipswasm-settings',
  wallet_id: 'wallet_1'
})
rows.set('battleships_games:battle_1', {
  id: 'battle_1',
  settings_id: 'battleshipswasm-settings',
  wallet_id: 'wallet_1',
  name: 'Paid Battleships game',
  join_amount: 20,
  haircut: 10,
  players_count: 2,
  status: 'active',
  player_one_ln_address: 'one@example.com',
  player_two_ln_address: 'two@example.com',
  player_one_payment_hash: 'token_one',
  player_two_payment_hash: 'token_two',
  player_one_fleet_placed: true,
  player_two_fleet_placed: true,
  winner_side: '',
  winner_ln_address: '',
  payout_pending: false,
  payout_status: '',
  turn: 'player1',
  shot_count: 16,
  completed_at: 0
})

const ships = [
  {name: 'carrier', size: 5, cells: ['A1', 'A2', 'A3', 'A4', 'A5']},
  {name: 'battleship', size: 4, cells: ['B1', 'B2', 'B3', 'B4']},
  {name: 'cruiser', size: 3, cells: ['C1', 'C2', 'C3']},
  {name: 'submarine', size: 3, cells: ['D1', 'D2', 'D3']},
  {name: 'destroyer', size: 2, cells: ['E1', 'E2']}
]
const allCells = ships.flatMap(ship => ship.cells)
rows.set('battleships_fleets:battle_1-player2', {
  id: 'battle_1-player2',
  game_id: 'battle_1',
  side: 'player2',
  ships_json: JSON.stringify(ships),
  hits_json: JSON.stringify(allCells.filter(cell => cell !== 'A1')),
  placed_at: 1
})

const shot = JSON.parse(
  api.fireBattleshipsShot(
    JSON.stringify({
      gameId: 'battle_1',
      playerToken: 'token_one',
      cell: 'A1'
    })
  )
)
assert.equal(shot.ok, true, shot.error)
assert.equal(shot.data.game.status, 'completed')
assert.equal(shot.data.game.payoutStatus, 'pending')
assert.equal(shot.data.payout.pending, true)
assert.equal(payoutCalls, 0, 'The final shot must not pay inside its fuel budget.')

const settlement = JSON.parse(
  api.settlePlayerBattleshipsPayout(
    JSON.stringify({gameId: 'battle_1', playerToken: 'token_one'})
  )
)
assert.equal(settlement.ok, true, settlement.error)
assert.equal(settlement.data.payout.ok, true)
assert.equal(settlement.data.game.payoutStatus, 'paid')
assert.equal(settlement.data.game.payoutPending, false)
assert.equal(payoutCalls, 1)

const repeated = JSON.parse(
  api.settlePlayerBattleshipsPayout(
    JSON.stringify({gameId: 'battle_1', playerToken: 'token_one'})
  )
)
assert.equal(repeated.ok, true, repeated.error)
assert.equal(repeated.data.payout.alreadySettled, true)
assert.equal(payoutCalls, 1, 'A repeated settlement request must not pay twice.')

console.log('Battleships split settlement tests passed')
