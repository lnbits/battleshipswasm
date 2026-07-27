import {storage, system, wallet, websocket} from './lnbits-sdk.js'

const SETTINGS_TABLE = 'battleships_settings'
const GAMES_TABLE = 'battleships_games'
const PLAYERS_TABLE = 'battleships_players'
const FLEETS_TABLE = 'battleships_fleets'
const SHOTS_TABLE = 'battleships_shots'
const SETTINGS_ID = 'battleshipswasm-settings'
const MIN_JOIN_SATS = 20
const GAME_SEARCH_FIELDS = ['name', 'winner_ln_address', 'status']
const COLUMNS = 'ABCDEFGHIJ'
const FLEET_SPEC = [
  {name: 'carrier', size: 5},
  {name: 'battleship', size: 4},
  {name: 'cruiser', size: 3},
  {name: 'submarine', size: 3},
  {name: 'destroyer', size: 2}
]

export function getBattleshipsSettings(_requestJson) {
  return runJson(() => ({settings: publicSettings(getSettings())}))
}

export function saveBattleshipsSettings(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getSettings()
    const now = system.now()
    const walletId = cleanText(request.walletId ?? request.wallet_id, 128)
    const walletName = cleanText(request.walletName ?? request.wallet_name, 120)
    const settings = {
      id: SETTINGS_ID,
      wallet_id: walletId,
      wallet_name: walletName || walletId,
      enabled: request.enabled === true,
      haircut: normalizePercent(request.haircut, 0),
      join_amount: Number(existing.join_amount || 100),
      max_bet: Number(existing.max_bet || 100000000),
      created_at: existing.created_at || now,
      updated_at: now
    }
    if (settings.enabled && !settings.wallet_id) {
      throw new Error('walletId is required when Battleships games are enabled.')
    }
    storage.set(SETTINGS_TABLE, settings)
    system.log('battleships: saved settings')
    return {settings: publicSettings(settings)}
  })
}

export function listBattleshipsWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function createBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const settings = getSettings()
    if (!settings.enabled) throw new Error('Battleships games are disabled.')
    if (!settings.wallet_id) throw new Error('Battleships wallet is not configured.')
    const joinAmount = normalizeInteger(
      request.joinAmount ?? request.join_amount,
      100,
      MIN_JOIN_SATS,
      Number.MAX_SAFE_INTEGER
    )
    const now = system.now()
    const generatedId = system.id('battle')
    const game = {
      id:
        cleanId(request.id) ||
        (typeof generatedId === 'string' ? generatedId : generatedId.id),
      settings_id: settings.id,
      wallet_id: settings.wallet_id,
      name: cleanText(request.name, 80) || 'Paid Battleships game',
      join_amount: joinAmount,
      haircut: Number(settings.haircut || 0),
      players_count: 0,
      status: 'waiting',
      player_one_ln_address: '',
      player_two_ln_address: '',
      player_one_payment_hash: '',
      player_two_payment_hash: '',
      player_one_fleet_placed: false,
      player_two_fleet_placed: false,
      winner_side: '',
      winner_ln_address: '',
      payout_pending: false,
      payout_status: '',
      turn: 'player1',
      shot_count: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null
    }
    storage.set(GAMES_TABLE, game)
    system.log(`battleships: created game ${game.id}`)
    return {game: publicGame(game), publicUrl: `/battleshipswasm/games/${game.id}`}
  })
}

export function listBattleshipsGames(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const rowsPerPage = normalizePageSize(request.rowsPerPage)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(GAMES_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: GAME_SEARCH_FIELDS,
      sortBy: normalizeGameSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: rowsPerPage,
      offset: (page - 1) * rowsPerPage
    })
    return {games: response.data.map(publicGame), total: response.total}
  })
}

export function deleteBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = getGame(gameId)
    if (game.status === 'completed' && game.payout_pending === true) {
      throw new Error('Settle the pending payout before deleting this Battleships game.')
    }
    for (let number = 1; number <= Number(game.shot_count || 0); number += 1) {
      storage.delete(SHOTS_TABLE, `${gameId}-${number}`)
    }
    storage.delete(FLEETS_TABLE, fleetId(gameId, 'player1'))
    storage.delete(FLEETS_TABLE, fleetId(gameId, 'player2'))
    if (game.player_one_payment_hash) {
      storage.delete(PLAYERS_TABLE, game.player_one_payment_hash)
    }
    if (game.player_two_payment_hash) {
      storage.delete(PLAYERS_TABLE, game.player_two_payment_hash)
    }
    storage.delete(GAMES_TABLE, gameId)
    system.log(`battleships: deleted game ${gameId}`)
    return {deleted: true, gameId}
  })
}

export function getPublicBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = getGame(gameId)
    const player = playerForToken(
      game,
      cleanText(request.playerToken ?? request.player_token, 128)
    )
    const fleet = player
      ? storage.get(FLEETS_TABLE, fleetId(game.id, player.side), null)
      : null
    return {
      game: publicGame(game),
      players: publicPlayersFromGame(game),
      shots: publicShotsForGame(game),
      player: player ? publicPlayer(player, true) : null,
      fleet: fleet ? publicFleet(fleet) : null,
      fleetSpec: FLEET_SPEC,
      canJoin: game.status === 'waiting' && Number(game.players_count || 0) < 2
    }
  })
}

export function joinBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const lnAddress = normalizeLnAddress(request.lnAddress ?? request.ln_address)
    const game = getGame(gameId)
    if (game.status !== 'waiting') throw new Error('This Battleships game has already started.')
    if (Number(game.players_count || 0) >= 2) {
      throw new Error('This Battleships game is already full.')
    }
    const invoice = wallet.createInvoicePublic({
      sourceId: game.id,
      amount: Number(game.join_amount),
      currency: 'sat',
      memo: `Battleships ${game.name} for ${lnAddress}`,
      extra: {game_id: game.id, ln_address: lnAddress}
    })
    return {
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      checkingId: invoice.checkingId
    }
  })
}

export function recordBattleshipsPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const paymentHash = eventPaymentHash(event)
    const extensionExtra =
      event.extra?.extra_battleshipswasm ||
      event.payment?.extra?.extra_battleshipswasm ||
      {}
    const gameId = cleanText(
      extensionExtra.game_id || event.extra?.game_id || event.payment?.extra?.game_id,
      128
    )
    const lnAddress = normalizeLnAddress(
      extensionExtra.ln_address ||
        event.extra?.ln_address ||
        event.payment?.extra?.ln_address
    )
    if (!paymentHash) throw new Error('paymentHash is required.')
    if (!gameId) throw new Error('game_id is required.')
    const game = getGame(gameId)
    const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
    if (existing) {
      return {
        game: publicGame(game),
        player: publicPlayer(existing, true),
        status: existing.status
      }
    }
    const paidSat = Math.abs(Number(event.amount || event.payment?.amount || 0)) / 1000
    if (paidSat && Math.trunc(paidSat) !== Number(game.join_amount)) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'amount-mismatch')
      const refund = refundPlayer(
        game,
        lnAddress,
        Math.trunc(paidSat),
        gameId,
        'amount-mismatch'
      )
      if (refund.ok) {
        player.status = 'refunded'
        storage.set(PLAYERS_TABLE, player)
      }
      return {
        game: publicGame(game),
        player: publicPlayer(player, true),
        status: player.status,
        refund
      }
    }
    if (game.status !== 'waiting' || Number(game.players_count || 0) >= 2) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'refund-pending')
      const refund = refundPlayer(game, lnAddress, Math.trunc(paidSat), gameId, 'full')
      if (refund.ok) {
        player.status = 'refunded'
        storage.set(PLAYERS_TABLE, player)
      }
      return {
        game: publicGame(game),
        player: publicPlayer(player, true),
        status: player.status,
        refund
      }
    }
    const paidPlayers = paidPlayersForGame(gameId)
    const side = paidPlayers.length === 0 ? 'player1' : 'player2'
    const player = markPlayer(paymentHash, gameId, lnAddress, side, 'paid')
    const now = system.now()
    const playersCount = paidPlayers.length + 1
    const updatedGame = {
      ...game,
      players_count: playersCount,
      player_one_ln_address:
        side === 'player1' ? lnAddress : game.player_one_ln_address,
      player_two_ln_address:
        side === 'player2' ? lnAddress : game.player_two_ln_address,
      player_one_payment_hash:
        side === 'player1' ? paymentHash : game.player_one_payment_hash,
      player_two_payment_hash:
        side === 'player2' ? paymentHash : game.player_two_payment_hash,
      status: playersCount === 2 ? 'placing' : 'waiting',
      updated_at: now
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, 'player-paid')
    return {
      game: publicGame(updatedGame),
      player: publicPlayer(player, true),
      status: 'paid'
    }
  })
}

export function placeBattleshipsFleet(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(
      request.playerToken ?? request.player_token,
      'playerToken',
      128
    )
    const game = getGame(gameId)
    const player = requirePaidPlayer(game, token)
    if (game.status !== 'placing') {
      throw new Error('Fleets can only be placed during the placement phase.')
    }
    const id = fleetId(gameId, player.side)
    if (storage.get(FLEETS_TABLE, id, null)) {
      throw new Error('Your fleet has already been placed.')
    }
    const ships = normalizeFleet(request.ships)
    const now = system.now()
    const fleet = {
      id,
      game_id: gameId,
      side: player.side,
      ships_json: JSON.stringify(ships),
      hits_json: '[]',
      placed_at: now
    }
    storage.set(FLEETS_TABLE, fleet)
    const otherPlaced =
      player.side === 'player1'
        ? game.player_two_fleet_placed === true
        : game.player_one_fleet_placed === true
    const updatedGame = {
      ...game,
      player_one_fleet_placed:
        player.side === 'player1' ? true : game.player_one_fleet_placed === true,
      player_two_fleet_placed:
        player.side === 'player2' ? true : game.player_two_fleet_placed === true,
      status: otherPlaced ? 'active' : 'placing',
      turn: 'player1',
      started_at: otherPlaced ? now : game.started_at,
      updated_at: now
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, otherPlaced ? 'battle-started' : 'fleet-placed')
    return {
      game: publicGame(updatedGame),
      player: publicPlayer(player, true),
      fleet: publicFleet(fleet)
    }
  })
}

export function fireBattleshipsShot(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(
      request.playerToken ?? request.player_token,
      'playerToken',
      128
    )
    const cell = normalizeCell(request.cell)
    const game = getGame(gameId)
    const player = requirePaidPlayer(game, token)
    if (game.status !== 'active') throw new Error('This Battleships game is not active.')
    if (player.side !== game.turn) throw new Error(`It is ${game.turn}'s turn.`)
    const targetSide = oppositeSide(player.side)
    const targetFleet = storage.get(FLEETS_TABLE, fleetId(gameId, targetSide), null)
    if (!targetFleet) throw new Error("The opponent's fleet is missing.")
    const priorShots = shotsForGame(gameId)
    if (
      priorShots.some(
        shot => shot.target_side === targetSide && shot.cell === cell
      )
    ) {
      throw new Error('That cell has already been targeted.')
    }
    const ships = parseStoredArray(targetFleet.ships_json, 'fleet')
    const previousHits = parseStoredArray(targetFleet.hits_json, 'fleet hits')
    const hitShip = ships.find(ship => ship.cells.includes(cell)) || null
    const hits = hitShip ? [...previousHits, cell] : previousHits
    const sunk =
      hitShip !== null && hitShip.cells.every(shipCell => hits.includes(shipCell))
    const won =
      hitShip !== null &&
      ships.every(ship => ship.cells.every(shipCell => hits.includes(shipCell)))
    const now = system.now()
    const shotNumber = Number(game.shot_count || 0) + 1
    const shot = {
      id: `${gameId}-${shotNumber}`,
      game_id: gameId,
      shot_number: shotNumber,
      side: player.side,
      target_side: targetSide,
      cell,
      result: hitShip ? 'hit' : 'miss',
      ship: sunk ? hitShip.name : '',
      sunk,
      created_at: now
    }
    storage.set(SHOTS_TABLE, shot)
    if (hitShip) {
      storage.set(FLEETS_TABLE, {
        ...targetFleet,
        hits_json: JSON.stringify(hits)
      })
    }
    const updatedGame = {
      ...game,
      status: won ? 'completed' : 'active',
      winner_side: won ? player.side : '',
      winner_ln_address: won ? player.ln_address : '',
      payout_pending: won,
      payout_status: won ? 'pending' : '',
      turn: won ? game.turn : targetSide,
      shot_count: shotNumber,
      updated_at: now,
      completed_at: won ? now : null
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, won ? 'game-over' : 'shot')
    return {
      game: publicGame(updatedGame),
      shot: publicShot(shot),
      player: publicPlayer(player, true),
      payout: {ok: true, pending: won}
    }
  })
}

export function resignBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(
      request.playerToken ?? request.player_token,
      'playerToken',
      128
    )
    const game = getGame(gameId)
    const player = requirePaidPlayer(game, token)
    if (!['placing', 'active'].includes(game.status)) {
      throw new Error('Only a started Battleships game can be resigned.')
    }
    const winnerSide = oppositeSide(player.side)
    const winner = playerFromGameBySide(game, winnerSide)
    if (!winner) throw new Error('Opponent is missing.')
    const now = system.now()
    const updatedGame = {
      ...game,
      status: 'completed',
      winner_side: winnerSide,
      winner_ln_address: winner.ln_address,
      payout_pending: true,
      payout_status: 'pending',
      updated_at: now,
      completed_at: now
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGame(updatedGame, 'resigned')
    return {
      game: publicGame(updatedGame),
      player: publicPlayer(player, true),
      payout: {ok: true, pending: true}
    }
  })
}

export function settlePlayerBattleshipsPayout(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(
      request.playerToken ?? request.player_token,
      'playerToken',
      128
    )
    const game = getGame(gameId)
    requirePaidPlayer(game, token)
    if (game.status !== 'completed') {
      throw new Error('Only completed Battleships games can be settled.')
    }
    if (!game.winner_ln_address || !game.winner_side) {
      throw new Error('Battleships winner is missing.')
    }
    if (game.payout_pending !== true) {
      return {
        game: publicGame(game),
        payout: {
          ok: game.payout_status === 'paid',
          pending: false,
          alreadySettled: true
        }
      }
    }
    if (game.payout_status === 'processing') {
      return {game: publicGame(game), payout: {ok: true, pending: true, processing: true}}
    }
    const settlement = settleBattleshipsPayout(game, 'settled')
    return {game: publicGame(settlement.game), payout: settlement.payout}
  })
}

export function settleBattleshipsGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = getGame(gameId)
    if (game.status !== 'completed') {
      throw new Error('Only completed Battleships games can be settled.')
    }
    if (!game.winner_ln_address || !game.winner_side) {
      throw new Error('Battleships winner is missing.')
    }
    if (game.payout_pending !== true) {
      throw new Error('This Battleships game is already settled.')
    }
    if (game.payout_status === 'processing') {
      throw new Error('Payout is already processing.')
    }
    const settlement = settleBattleshipsPayout(game, 'settled')
    return {game: publicGame(settlement.game), payout: settlement.payout}
  })
}

function settleBattleshipsPayout(game, event) {
  const processingGame = {
    ...game,
    payout_pending: true,
    payout_status: 'processing',
    updated_at: system.now(),
    completed_at: game.completed_at || system.now()
  }
  storage.set(GAMES_TABLE, processingGame)
  const settings = getSettingsById(processingGame.settings_id)
  let payout
  try {
    payout = payWinner({
      walletId: processingGame.wallet_id || settings.wallet_id,
      lnAddress: processingGame.winner_ln_address,
      maxSat: payoutAmount(processingGame),
      description: `Battleships winnings for ${processingGame.name}`,
      gameId: processingGame.id,
      side: processingGame.winner_side
    })
  } catch (error) {
    payout = {ok: false, error: errorMessage(error)}
  }
  const updatedGame = {
    ...processingGame,
    payout_pending: !payout.ok,
    payout_status: payout.ok ? 'paid' : 'failed',
    updated_at: system.now()
  }
  storage.set(GAMES_TABLE, updatedGame)
  publishGame(updatedGame, event)
  return {game: updatedGame, payout}
}

function publishGame(game, event) {
  try {
    websocket.publish(`game:${game.id}`, {
      type: 'server',
      event,
      game: publicGame(game)
    })
  } catch (error) {
    system.log(
      `battleships websocket publish failed: ${errorMessage(error)}`,
      'warning'
    )
  }
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    return JSON.stringify({ok: false, error: errorMessage(error)})
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function getSettings() {
  return storage.get(SETTINGS_TABLE, SETTINGS_ID, defaultSettings())
}

function getSettingsById(settingsId) {
  const settings = storage.get(SETTINGS_TABLE, settingsId || SETTINGS_ID, null)
  if (!settings) throw new Error('Battleships settings not found.')
  return settings
}

function defaultSettings() {
  const now = system.now()
  return {
    id: SETTINGS_ID,
    wallet_id: '',
    wallet_name: '',
    enabled: false,
    haircut: 0,
    join_amount: 100,
    max_bet: 100000000,
    created_at: now,
    updated_at: now
  }
}

function getGame(gameId) {
  const game = storage.get(GAMES_TABLE, gameId, null)
  if (!game) throw new Error('Battleships game not found.')
  return game
}

function markPlayer(paymentHash, gameId, lnAddress, side, status) {
  const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
  const now = system.now()
  const player = {
    id: paymentHash,
    game_id: gameId,
    ln_address: existing?.ln_address || lnAddress,
    payment_hash: paymentHash,
    side: existing?.side || side,
    status,
    created_at: existing?.created_at || now,
    paid_at: ['paid', 'refund-pending'].includes(status)
      ? existing?.paid_at || now
      : existing?.paid_at || null
  }
  storage.set(PLAYERS_TABLE, player)
  return player
}

function paidPlayersForGame(gameId) {
  return storage.getPaginated(PLAYERS_TABLE, {
    filters: {game_id: gameId, status: 'paid'},
    sortBy: 'paid_at',
    descending: false,
    limit: 10,
    offset: 0
  }).data
}

function publicPlayersFromGame(game) {
  const players = []
  if (game.player_one_ln_address) {
    players.push(
      publicPlayer(
        {
          id: '',
          game_id: game.id,
          ln_address: game.player_one_ln_address,
          side: 'player1',
          status: 'paid',
          paid_at: 0
        },
        false
      )
    )
  }
  if (game.player_two_ln_address) {
    players.push(
      publicPlayer(
        {
          id: '',
          game_id: game.id,
          ln_address: game.player_two_ln_address,
          side: 'player2',
          status: 'paid',
          paid_at: 0
        },
        false
      )
    )
  }
  return players
}

function playerForToken(game, token) {
  if (!token) return null
  if (token === game.player_one_payment_hash) {
    return {
      id: token,
      game_id: game.id,
      ln_address: game.player_one_ln_address,
      payment_hash: token,
      side: 'player1',
      status: 'paid',
      paid_at: 0
    }
  }
  if (token === game.player_two_payment_hash) {
    return {
      id: token,
      game_id: game.id,
      ln_address: game.player_two_ln_address,
      payment_hash: token,
      side: 'player2',
      status: 'paid',
      paid_at: 0
    }
  }
  return null
}

function playerFromGameBySide(game, side) {
  return playerForToken(
    game,
    side === 'player1'
      ? game.player_one_payment_hash
      : game.player_two_payment_hash
  )
}

function requirePaidPlayer(game, token) {
  const player = playerForToken(game, token)
  if (
    !player ||
    player.status !== 'paid' ||
    !['player1', 'player2'].includes(player.side)
  ) {
    throw new Error('A paid player token is required.')
  }
  return player
}

function shotsForGame(gameId) {
  return storage.getPaginated(SHOTS_TABLE, {
    filters: {game_id: gameId},
    sortBy: 'shot_number',
    descending: false,
    limit: 200,
    offset: 0
  }).data
}

function publicShotsForGame(game) {
  return storage
    .getPublicPaginated(SHOTS_TABLE, {
      sourceId: game.id,
      sortBy: 'shot_number',
      descending: false,
      limit: 200,
      offset: 0
    })
    .data.map(publicShot)
}

function fleetId(gameId, side) {
  return `${gameId}-${side}`
}

function normalizeFleet(value) {
  if (!Array.isArray(value) || value.length !== FLEET_SPEC.length) {
    throw new Error('Place exactly five ships.')
  }
  const byName = new Map()
  for (const ship of value) {
    if (!ship || typeof ship !== 'object' || Array.isArray(ship)) {
      throw new Error('Each ship placement must be an object.')
    }
    const name = cleanText(ship.name, 20).toLowerCase()
    if (byName.has(name)) throw new Error(`Ship ${name} was placed more than once.`)
    byName.set(name, ship)
  }
  const occupied = new Set()
  return FLEET_SPEC.map(spec => {
    const ship = byName.get(spec.name)
    if (!ship) throw new Error(`Place the ${spec.name}.`)
    const start = normalizeCell(ship.start)
    const orientation = cleanText(ship.orientation, 10).toLowerCase()
    if (!['horizontal', 'vertical'].includes(orientation)) {
      throw new Error(`${spec.name} needs a horizontal or vertical orientation.`)
    }
    const cells = shipCells(start, spec.size, orientation)
    for (const cell of cells) {
      if (occupied.has(cell)) throw new Error('Ships cannot overlap.')
      occupied.add(cell)
    }
    return {name: spec.name, size: spec.size, cells}
  })
}

function shipCells(start, size, orientation) {
  const column = COLUMNS.indexOf(start[0])
  const row = Number(start.slice(1)) - 1
  const cells = []
  for (let offset = 0; offset < size; offset += 1) {
    const nextColumn = column + (orientation === 'horizontal' ? offset : 0)
    const nextRow = row + (orientation === 'vertical' ? offset : 0)
    if (
      nextColumn < 0 ||
      nextColumn >= COLUMNS.length ||
      nextRow < 0 ||
      nextRow >= 10
    ) {
      throw new Error('A ship cannot extend beyond the grid.')
    }
    cells.push(`${COLUMNS[nextColumn]}${nextRow + 1}`)
  }
  return cells
}

function parseStoredArray(value, label) {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    if (!Array.isArray(parsed)) throw new Error()
    return parsed
  } catch (_) {
    throw new Error(`Invalid stored ${label}.`)
  }
}

function payoutAmount(game) {
  const total = Number(game.join_amount || 0) * 2
  const haircut = total * (Number(game.haircut || 0) / 100)
  return Math.max(0, Math.trunc(total - haircut))
}

function payWinner({walletId, lnAddress, maxSat, description, gameId, side}) {
  if (!walletId) return {ok: false, error: 'Battleships wallet is not configured.'}
  if (!lnAddress) return {ok: false, error: 'Lightning address is missing.'}
  if (!Number.isInteger(maxSat) || maxSat <= 0) {
    return {ok: false, error: 'Payout amount must be greater than zero.'}
  }
  const response = wallet.payLnurl({
    walletId,
    lnurl: lnAddress,
    amount: maxSat,
    currency: 'sat',
    comment: 'Battleships winnings',
    maxSat,
    description,
    extra: {battleships_game_id: gameId, battleships_winner_side: side}
  })
  return {
    ok: response.ok === true,
    error: response.error || '',
    checkingId: response.checkingId || '',
    paymentHash: response.paymentHash || '',
    status: response.status || '',
    amountMsat: Number(response.amountMsat || 0),
    feeMsat: Number(response.feeMsat || 0)
  }
}

function refundPlayer(game, lnAddress, amountSats, gameId, reason) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    return {ok: false, error: 'Refund amount must be greater than zero.'}
  }
  if (!game.wallet_id) {
    return {ok: false, error: 'Battleships wallet is not configured.'}
  }
  if (!lnAddress) return {ok: false, error: 'Lightning address is missing.'}
  const response = wallet.payLnurl({
    walletId: game.wallet_id,
    lnurl: lnAddress,
    amount: amountSats,
    currency: 'sat',
    comment: 'Battleships refund',
    maxSat: amountSats,
    description: `Battleships refund for ${game.name}`,
    extra: {battleships_game_id: gameId, battleships_refund_reason: reason}
  })
  return {
    ok: response.ok === true,
    error: response.error || '',
    checkingId: response.checkingId || '',
    paymentHash: response.paymentHash || '',
    status: response.status || ''
  }
}

function publicSettings(settings) {
  return {
    id: settings.id,
    enabled: settings.enabled === true,
    haircut: Number(settings.haircut || 0),
    walletId: settings.wallet_id || '',
    walletName: settings.wallet_name || '',
    createdAt: Number(settings.created_at || 0),
    updatedAt: Number(settings.updated_at || 0)
  }
}

function publicGame(game) {
  return {
    id: game.id,
    settingsId: game.settings_id,
    name: game.name,
    joinAmount: Number(game.join_amount || 0),
    haircut: Number(game.haircut || 0),
    playersCount: Number(game.players_count || 0),
    status: game.status || 'waiting',
    playerOneFleetPlaced: game.player_one_fleet_placed === true,
    playerTwoFleetPlaced: game.player_two_fleet_placed === true,
    winnerSide: game.winner_side || '',
    winnerLnAddress: maskLnAddress(game.winner_ln_address || ''),
    payoutPending: game.payout_pending === true,
    payoutStatus: game.payout_status || '',
    turn: game.turn || 'player1',
    shotCount: Number(game.shot_count || 0),
    createdAt: Number(game.created_at || 0),
    updatedAt: Number(game.updated_at || 0),
    startedAt: Number(game.started_at || 0),
    completedAt: Number(game.completed_at || 0)
  }
}

function publicPlayer(player, includeToken) {
  return {
    id: includeToken ? player.id : '',
    gameId: player.game_id,
    lnAddress: maskLnAddress(player.ln_address),
    side: player.side || '',
    status: player.status || 'pending',
    paidAt: Number(player.paid_at || 0)
  }
}

function publicFleet(fleet) {
  return {
    side: fleet.side,
    ships: parseStoredArray(fleet.ships_json, 'fleet'),
    hits: parseStoredArray(fleet.hits_json, 'fleet hits'),
    placedAt: Number(fleet.placed_at || 0)
  }
}

function publicShot(shot) {
  return {
    id: shot.id,
    gameId: shot.game_id,
    shotNumber: Number(shot.shot_number || 0),
    side: shot.side,
    targetSide: shot.target_side,
    cell: shot.cell,
    result: shot.result,
    ship: shot.ship || '',
    sunk: shot.sunk === true,
    createdAt: Number(shot.created_at || 0)
  }
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number)) throw new Error('value must be an integer.')
  if (number < min) throw new Error(`value must be at least ${min}.`)
  if (number > max) throw new Error(`value must be at most ${max}.`)
  return number
}

function normalizePercent(value, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number)) throw new Error('haircut must be a number.')
  if (number < 0 || number > 100) {
    throw new Error('haircut must be between 0 and 100.')
  }
  return number
}

function normalizePageSize(value) {
  const size = Number(value || 10)
  if (!Number.isInteger(size) || size <= 0) return 10
  return Math.min(size, 100)
}

function normalizePage(value) {
  const page = Number(value || 1)
  if (!Number.isInteger(page) || page <= 0) return 1
  return page
}

function normalizeGameSortBy(value) {
  return (
    {
      name: 'name',
      joinAmount: 'join_amount',
      playersCount: 'players_count',
      status: 'status',
      createdAt: 'created_at'
    }[value] || 'created_at'
  )
}

function normalizeLnAddress(value) {
  const lnAddress = cleanText(value, 180).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lnAddress)) {
    throw new Error('A valid Lightning address is required.')
  }
  return lnAddress
}

function normalizeCell(value) {
  const cell = cleanText(value, 3).toUpperCase()
  if (!/^[A-J](10|[1-9])$/.test(cell)) {
    throw new Error('A valid Battleships cell is required.')
  }
  return cell
}

function oppositeSide(side) {
  return side === 'player1' ? 'player2' : 'player1'
}

function eventPaymentHash(event) {
  return (
    cleanText(event.paymentHash, 128) ||
    cleanText(event.payment_hash, 128) ||
    cleanText(event.extra?.paymentHash, 128) ||
    cleanText(event.payment?.payment_hash, 128) ||
    cleanText(event.payment?.paymentHash, 128)
  )
}

function cleanId(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${field} is required.`)
  return text
}

function maskLnAddress(lnAddress) {
  const value = cleanText(lnAddress, 180)
  const [name, domain] = value.split('@')
  if (!name || !domain) return value
  return `${name.slice(0, 3)}${name.length > 3 ? '...' : ''}@${domain}`
}
