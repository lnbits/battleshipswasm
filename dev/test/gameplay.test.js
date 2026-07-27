import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
source = source.replace(/^import .*\n\n/, '').replace(/export function /g, 'function ')
const config = JSON.parse(
  await fs.readFile(new URL('../../config.json', import.meta.url), 'utf8')
)
const publicPolicies =
  config.permissions.find(permission => permission.id === 'ext.storage.read_public')
    ?.policies || []
const publicGameFields =
  publicPolicies.find(policy => policy.table_name === 'battleships_games')
    ?.public_fields || []
assert.equal(
  publicPolicies.some(policy => policy.table_name === 'battleships_fleets'),
  false,
  'Fleet storage must not have a public-read policy.'
)
assert.equal(
  publicGameFields.some(field => field.includes('payment_hash')),
  false,
  'Player tokens must not be public storage fields.'
)

const rows = new Map()
const storage = {
  get(table, id, fallback) {
    return rows.get(`${table}:${id}`) || fallback
  },
  getPaginated(table, options = {}) {
    const data = [...rows.entries()]
      .filter(([key, value]) => {
        if (!key.startsWith(`${table}:`)) return false
        return Object.entries(options.filters || {}).every(
          ([field, expected]) => value[field] === expected
        )
      })
      .map(([, value]) => value)
    return {data, total: data.length}
  },
  getPublicPaginated(table, options = {}) {
    return this.getPaginated(table, {
      filters: {game_id: options.sourceId}
    })
  },
  set(table, row) {
    rows.set(`${table}:${row.id}`, row)
  }
}
const system = {now: () => 1_700_000_000, log() {}}
const websocket = {publish() {}}
const api = Function(
  'storage', 'system', 'wallet', 'websocket',
  `${source}; return {placeBattleshipsFleet, fireBattleshipsShot, getPublicBattleshipsGame, normalizeFleet}`
)(storage, system, {}, websocket)

const game = {
  id: 'battle_1',
  settings_id: 'battleshipswasm-settings',
  name: 'Gameplay test',
  join_amount: 20,
  haircut: 0,
  players_count: 2,
  status: 'placing',
  player_one_ln_address: 'one@example.com',
  player_two_ln_address: 'two@example.com',
  player_one_payment_hash: 'token_one',
  player_two_payment_hash: 'token_two',
  player_one_fleet_placed: false,
  player_two_fleet_placed: false,
  winner_side: '',
  winner_ln_address: '',
  payout_pending: false,
  payout_status: '',
  turn: 'player1',
  shot_count: 0
}
rows.set('battleships_games:battle_1', game)

const fleetOne = [
  {name: 'carrier', start: 'A1', orientation: 'horizontal'},
  {name: 'battleship', start: 'A2', orientation: 'horizontal'},
  {name: 'cruiser', start: 'A3', orientation: 'horizontal'},
  {name: 'submarine', start: 'A4', orientation: 'horizontal'},
  {name: 'destroyer', start: 'A5', orientation: 'horizontal'}
]
const fleetTwo = [
  {name: 'carrier', start: 'A1', orientation: 'vertical'},
  {name: 'battleship', start: 'B1', orientation: 'vertical'},
  {name: 'cruiser', start: 'C1', orientation: 'vertical'},
  {name: 'submarine', start: 'D1', orientation: 'vertical'},
  {name: 'destroyer', start: 'E1', orientation: 'vertical'}
]

assert.throws(
  () => api.normalizeFleet([
    ...fleetOne.slice(0, 4),
    {name: 'destroyer', start: 'A4', orientation: 'horizontal'}
  ]),
  /overlap/
)
assert.throws(
  () => api.normalizeFleet([
    {...fleetOne[0], start: 'H1'},
    ...fleetOne.slice(1)
  ]),
  /beyond/
)

const placedOne = JSON.parse(
  api.placeBattleshipsFleet(
    JSON.stringify({
      gameId: 'battle_1',
      playerToken: 'token_one',
      ships: fleetOne
    })
  )
)
assert.equal(placedOne.ok, true, placedOne.error)
assert.equal(placedOne.data.game.status, 'placing')

const placedTwo = JSON.parse(
  api.placeBattleshipsFleet(
    JSON.stringify({
      gameId: 'battle_1',
      playerToken: 'token_two',
      ships: fleetTwo
    })
  )
)
assert.equal(placedTwo.ok, true, placedTwo.error)
assert.equal(placedTwo.data.game.status, 'active')

const spectator = JSON.parse(
  api.getPublicBattleshipsGame(JSON.stringify({gameId: 'battle_1'}))
)
assert.equal(spectator.ok, true, spectator.error)
assert.equal(spectator.data.fleet, null, 'Spectators must never receive a fleet.')

const owner = JSON.parse(
  api.getPublicBattleshipsGame(
    JSON.stringify({gameId: 'battle_1', playerToken: 'token_one'})
  )
)
assert.equal(owner.data.fleet.side, 'player1')
assert.equal(owner.data.fleet.ships.length, 5)

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
assert.equal(shot.data.shot.result, 'hit')
assert.equal(shot.data.game.turn, 'player2')

const outOfTurn = JSON.parse(
  api.fireBattleshipsShot(
    JSON.stringify({
      gameId: 'battle_1',
      playerToken: 'token_one',
      cell: 'A2'
    })
  )
)
assert.equal(outOfTurn.ok, false)
assert.match(outOfTurn.error, /player2/)

console.log('Battleships fleet privacy and gameplay tests passed')
