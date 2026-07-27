import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
source = source.replace(/^import .*\n\n/, '').replace(/export function /g, 'function ')

function createGame(joinAmount, expectedOk = true) {
  let storedGame = null
  const storage = {
    get(table) {
      if (table === 'battleships_settings') {
        return {
          id: 'battleshipswasm-settings',
          enabled: true,
          wallet_id: 'wallet_1',
          haircut: 0
        }
      }
      return null
    },
    set(table, row) {
      if (table === 'battleships_games') storedGame = row
    }
  }
  const system = {
    id() { return {id: 'battleships_1'} },
    now() { return 1_700_000_000 },
    log() {}
  }
  const createBattleshipsGame = Function(
    'storage', 'system', 'wallet', 'websocket',
    `${source}; return createBattleshipsGame`
  )(storage, system, {}, {})
  const response = JSON.parse(createBattleshipsGame(JSON.stringify({joinAmount})))
  assert.equal(response.ok, expectedOk, response.error)
  if (!response.ok) return {error: response.error}
  return {game: response.data.game, storedGame}
}

const belowMinimum = createGame(19, false)
assert.match(belowMinimum.error, /at least 20/)

for (const [requested, expected] of [[20, 20], [100_000_001, 100_000_001]]) {
  const result = createGame(requested)
  assert.equal(result.game.joinAmount, expected)
  assert.equal(result.storedGame.join_amount, expected)
}

console.log('Battleships minimum join amount tests passed')
