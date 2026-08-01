import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
source = source.replace(/^import .*\n\n/, '').replace(/export function /g, 'function ')

let requestedOptions = null
let privateRequestedOptions = null
const rows = Array.from({length: 200}, (_, index) => ({
  id: `battle_1-${index + 1}`,
  game_id: 'battle_1',
  shot_number: index + 1,
  action_id: `shot-${index + 1}`,
  side: index % 2 ? 'player2' : 'player1',
  target_side: index % 2 ? 'player1' : 'player2',
  cell: 'A1',
  result: 'miss',
  ship: '',
  sunk: false,
  created_at: index + 1
}))
const storage = {
  getPaginated(_table, options) {
    privateRequestedOptions = options
    return {data: [], total: 0}
  },
  getPublicPaginated(_table, options) {
    requestedOptions = options
    return {
      data: rows.slice(options.offset, options.offset + options.limit),
      total: rows.length
    }
  }
}
const api = Function(
  'storage',
  'system',
  'wallet',
  'websocket',
  `${source}; return {publicShotsForGame, shotForCell}`
)(storage, {}, {}, {})

const firstPage = api.publicShotsForGame({id: 'battle_1'}, 0, 200)
assert.equal(requestedOptions.limit, 10, 'A public refresh must read at most 10 shots.')
assert.equal(firstPage.data.length, 10)
assert.equal(firstPage.total, 200)

const finalPage = api.publicShotsForGame({id: 'battle_1'}, 190, 10)
assert.equal(requestedOptions.offset, 190)
assert.equal(finalPage.data[0].shotNumber, 191)
assert.equal(finalPage.data.length, 10)

assert.equal(api.shotForCell('battle_1', 'player2', 'A1'), null)
assert.deepEqual(privateRequestedOptions.filters, {
  game_id: 'battle_1',
  target_side: 'player2',
  cell: 'A1'
})
assert.equal(privateRequestedOptions.limit, 1)

console.log('Battleships public shot fuel regression tests passed')
