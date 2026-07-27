const DEFAULT_FLEET = [
  {name: 'carrier', size: 5},
  {name: 'battleship', size: 4},
  {name: 'cruiser', size: 3},
  {name: 'submarine', size: 3},
  {name: 'destroyer', size: 2}
]
const COLUMNS = 'ABCDEFGHIJ'

const state = {
  game: null,
  gameId: null,
  player: null,
  fleet: null,
  fleetSpec: DEFAULT_FLEET,
  shots: [],
  playerToken: '',
  draftShips: [],
  selectedShip: 'carrier',
  orientation: 'horizontal',
  invoiceUnsubscribe: null,
  invoicePollTimer: null,
  qrApp: null,
  pollTimer: null,
  websocket: null,
  refreshTimer: null,
  rendering: false,
  renderAgain: false,
  notifiedCompletedAt: 0
}

const client = window.createLNbitsExtensionClient({
  extensionId: 'battleshipswasm'
})

const gameSubtitle = document.querySelector('#game-subtitle')
const gameTitle = document.querySelector('#game-title')
const gameStatus = document.querySelector('#game-status')
const joinForm = document.querySelector('#join-form')
const joinFormColumn = document.querySelector('#join-form-column')
const joinButton = document.querySelector('#join-button')
const copyGameButton = document.querySelector('#copy-game-button')
const resignButton = document.querySelector('#resign-button')
const playersStat = document.querySelector('#players-stat')
const amountStat = document.querySelector('#amount-stat')
const haircutStat = document.querySelector('#haircut-stat')
const playerList = document.querySelector('#player-list')
const shotList = document.querySelector('#shot-list')
const placementControls = document.querySelector('#placement-controls')
const placementHelp = document.querySelector('#placement-help')
const shipSelector = document.querySelector('#ship-selector')
const orientationButton = document.querySelector('#orientation-button')
const randomizeButton = document.querySelector('#randomize-button')
const resetFleetButton = document.querySelector('#reset-fleet-button')
const submitFleetButton = document.querySelector('#submit-fleet-button')
const ownGrid = document.querySelector('#own-grid')
const targetGrid = document.querySelector('#target-grid')
const ownBoardTitle = document.querySelector('#own-board-title')
const targetBoardTitle = document.querySelector('#target-board-title')
const ownBoardNote = document.querySelector('#own-board-note')
const targetBoardNote = document.querySelector('#target-board-note')
const invoiceDialog = document.querySelector('#invoice-dialog')
const invoiceQrCode = document.querySelector('#invoice-qrcode')
const invoiceStatus = document.querySelector('#invoice-status')
const copyInvoiceButton = document.querySelector('#copy-invoice-button')
const confettiLayer = document.querySelector('#confetti-layer')

joinButton.addEventListener('click', async event => {
  event.preventDefault()
  setJoinLoading(true)
  try {
    const invoice = await client.joinGame(state.gameId, {
      lnAddress: fieldValue(joinForm, 'lnAddress')
    })
    savePlayerToken(invoice.paymentHash)
    openInvoiceDialog(invoice)
    startInvoicePolling(invoice.paymentHash)
    await subscribeToPayment(invoice.paymentHash)
  } catch (error) {
    showError(error)
  } finally {
    setJoinLoading(false)
  }
})

copyGameButton.addEventListener('click', async () => {
  await copyText(publicGameUrl(), 'Game link copied.', 'Failed to copy game link.')
})

copyInvoiceButton.addEventListener('click', async () => {
  const invoice = copyInvoiceButton.dataset.invoice || ''
  if (invoice) {
    await copyText(invoice, 'Invoice copied.', 'Failed to copy invoice.')
  }
})

orientationButton.addEventListener('click', () => {
  state.orientation =
    state.orientation === 'horizontal' ? 'vertical' : 'horizontal'
  renderPlacementControls()
})

randomizeButton.addEventListener('click', () => {
  try {
    state.draftShips = randomFleet()
    state.selectedShip = ''
    renderBattlefield()
    renderPlacementControls()
  } catch (error) {
    showError(error)
  }
})

resetFleetButton.addEventListener('click', () => {
  resetDraftFleet()
  renderBattlefield()
  renderPlacementControls()
})

submitFleetButton.addEventListener('click', async () => {
  if (state.draftShips.length !== state.fleetSpec.length) return
  submitFleetButton.disabled = true
  try {
    await client.placeFleet(state.gameId, {
      playerToken: playerToken(),
      ships: state.draftShips.map(ship => ({
        name: ship.name,
        start: ship.start,
        orientation: ship.orientation
      }))
    })
    await renderGame()
    notifyInfo('Fleet locked. Awaiting battle.', 'positive')
  } catch (error) {
    showError(error)
  } finally {
    submitFleetButton.disabled = false
  }
})

resignButton.addEventListener('click', async () => {
  if (!state.gameId || !playerToken()) return
  const confirmed = await confirmAction({
    title: 'Resign Battle',
    message: 'Your opponent will win the pot. Resign this battle?',
    okLabel: 'Resign'
  })
  if (!confirmed) return
  try {
    const result = await client.resign(state.gameId, {
      playerToken: playerToken()
    })
    await settleCompletedGame(result)
    await renderGame()
  } catch (error) {
    showError(error)
  }
})

for (const closeControl of document.querySelectorAll('[data-close-invoice]')) {
  closeControl.addEventListener('click', closeInvoiceDialog)
}

init().catch(showError)

async function init() {
  const context = await client.context()
  state.gameId = context.routeParams?.gameId || null
  state.playerToken = tokenFromUrl()
  await renderGame()
  state.pollTimer = window.setInterval(() => {
    renderGame().catch(error =>
      console.warn('[battleships public] poll failed', error)
    )
  }, 2500)
  window.addEventListener('beforeunload', cleanup)
}

async function renderGame() {
  if (state.rendering) {
    state.renderAgain = true
    return
  }
  state.rendering = true
  try {
    if (!state.gameId) {
      gameTitle.textContent = 'No game selected'
      gameStatus.textContent = 'Open a valid Battleships game link.'
      return
    }
    const previousGame = state.game
    const response = await client.getPublicGame(state.gameId, playerToken())
    if (!response?.game) throw new Error('Battleships game not found.')
    state.game = response.game
    state.player = response.player || null
    state.fleet = response.fleet || null
    state.fleetSpec = response.fleetSpec || DEFAULT_FLEET
    state.shots = response.shots || []
    if (state.fleet) state.draftShips = []
    ensureSelectedShip()

    gameTitle.textContent = state.game.name
    gameSubtitle.textContent = `${state.game.joinAmount} sats to join`
    gameStatus.textContent = statusText(state.game, state.player)
    playersStat.textContent = `${state.game.playersCount} / 2`
    amountStat.textContent = `${state.game.joinAmount} sats`
    haircutStat.textContent = `${state.game.haircut}%`
    joinFormColumn.hidden = response.canJoin !== true || !!state.player
    resignButton.hidden = !(
      state.player && ['placing', 'active'].includes(state.game.status)
    )
    placementControls.hidden = !(
      state.player && state.game.status === 'placing' && !state.fleet
    )

    renderPlacementControls()
    renderBattlefield()
    renderPlayers(response.players || [], state.player)
    renderShots(state.shots)
    notifyGameChanges(previousGame, state.game, state.player)
    await ensureRealtime()
    if (state.game.status === 'completed') {
      window.clearInterval(state.pollTimer)
    }
  } finally {
    state.rendering = false
    if (state.renderAgain) {
      state.renderAgain = false
      queueRenderGame()
    }
  }
}

async function ensureRealtime() {
  if (!state.gameId || state.websocket) return
  try {
    state.websocket = await client.subscribeWebsocket(
      `game:${state.gameId}`,
      event => {
        if (event.event === 'websocket.error') {
          state.websocket = null
          queueRenderGame()
          return
        }
        if ((event.data || {}).type === 'server') queueRenderGame()
      }
    )
  } catch (error) {
    console.warn('[battleships public] websocket subscribe failed', error)
  }
}

function queueRenderGame(delay = 40) {
  if (state.refreshTimer) return
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null
    renderGame().catch(showError)
  }, delay)
}

function renderPlacementControls() {
  orientationButton.textContent = capitalize(state.orientation)
  shipSelector.innerHTML = ''
  for (const spec of state.fleetSpec) {
    const placed = state.draftShips.some(ship => ship.name === spec.name)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ship-choice'
    if (state.selectedShip === spec.name) button.classList.add('selected')
    if (placed) button.classList.add('placed')
    button.textContent = `${capitalize(spec.name)} · ${spec.size}`
    button.addEventListener('click', () => {
      state.draftShips = state.draftShips.filter(ship => ship.name !== spec.name)
      state.selectedShip = spec.name
      renderBattlefield()
      renderPlacementControls()
    })
    shipSelector.append(button)
  }
  const remaining = state.fleetSpec.length - state.draftShips.length
  placementHelp.textContent = remaining
    ? `${remaining} ship${remaining === 1 ? '' : 's'} left. Select a starting cell.`
    : 'Fleet ready. Lock it when you are happy with the placement.'
  submitFleetButton.disabled = remaining !== 0
}

function renderBattlefield() {
  const playerSide = state.player?.side || ''
  if (playerSide) {
    ownBoardTitle.textContent = 'Your fleet'
    targetBoardTitle.textContent = 'Target grid'
    ownBoardNote.textContent = sideLabel(playerSide)
    targetBoardNote.textContent =
      state.game?.status === 'active' && state.game.turn === playerSide
        ? 'Your shot'
        : 'Opponent waters'
    renderGrid(ownGrid, {
      side: playerSide,
      ships: state.fleet?.ships || state.draftShips,
      shots: state.shots.filter(shot => shot.targetSide === playerSide),
      onCell: canPlaceFleet() ? placeSelectedShip : null
    })
    renderGrid(targetGrid, {
      side: oppositeSide(playerSide),
      ships: [],
      shots: state.shots.filter(shot => shot.targetSide !== playerSide),
      onCell: canFire() ? fireShot : null,
      target: true
    })
    return
  }
  ownBoardTitle.textContent = 'Player 1 waters'
  targetBoardTitle.textContent = 'Player 2 waters'
  ownBoardNote.textContent = 'Spectator view'
  targetBoardNote.textContent = 'Spectator view'
  renderGrid(ownGrid, {
    side: 'player1',
    ships: [],
    shots: state.shots.filter(shot => shot.targetSide === 'player1')
  })
  renderGrid(targetGrid, {
    side: 'player2',
    ships: [],
    shots: state.shots.filter(shot => shot.targetSide === 'player2')
  })
}

function renderGrid(container, {ships, shots, onCell, target = false}) {
  const shipCells = new Set(ships.flatMap(ship => ship.cells || []))
  const shotByCell = new Map(shots.map(shot => [shot.cell, shot]))
  container.innerHTML = ''
  container.append(gridLabel(''))
  for (const column of COLUMNS) container.append(gridLabel(column))
  for (let row = 1; row <= 10; row += 1) {
    container.append(gridLabel(String(row)))
    for (const column of COLUMNS) {
      const cellName = `${column}${row}`
      const shot = shotByCell.get(cellName)
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'ocean-cell'
      cell.dataset.cell = cellName
      cell.setAttribute('aria-label', `${cellName}${shot ? ` ${shot.result}` : ''}`)
      if (shipCells.has(cellName)) {
        cell.classList.add('ship')
        cell.textContent = '■'
      }
      if (shot) {
        cell.classList.add(shot.result)
        cell.textContent = shot.result === 'hit' ? '×' : '•'
      }
      if (onCell && !shot) {
        cell.classList.add(target ? 'fireable' : 'placeable')
        cell.addEventListener('click', () => onCell(cellName))
      } else {
        cell.disabled = true
      }
      container.append(cell)
    }
  }
}

function gridLabel(text) {
  const label = document.createElement('span')
  label.className = 'grid-label'
  label.textContent = text
  return label
}

function canPlaceFleet() {
  return !!(
    state.player &&
    state.game?.status === 'placing' &&
    !state.fleet &&
    state.selectedShip
  )
}

function placeSelectedShip(start) {
  const spec = state.fleetSpec.find(ship => ship.name === state.selectedShip)
  if (!spec) return
  try {
    const cells = placementCells(start, spec.size, state.orientation)
    const occupied = new Set(state.draftShips.flatMap(ship => ship.cells))
    if (cells.some(cell => occupied.has(cell))) {
      throw new Error('Ships cannot overlap.')
    }
    state.draftShips.push({
      name: spec.name,
      size: spec.size,
      start,
      orientation: state.orientation,
      cells
    })
    state.selectedShip =
      state.fleetSpec.find(
        ship => !state.draftShips.some(placed => placed.name === ship.name)
      )?.name || ''
    renderBattlefield()
    renderPlacementControls()
  } catch (error) {
    showError(error)
  }
}

function placementCells(start, size, orientation) {
  const column = COLUMNS.indexOf(start[0])
  const row = Number(start.slice(1)) - 1
  const cells = []
  for (let offset = 0; offset < size; offset += 1) {
    const nextColumn = column + (orientation === 'horizontal' ? offset : 0)
    const nextRow = row + (orientation === 'vertical' ? offset : 0)
    if (nextColumn >= 10 || nextRow >= 10) {
      throw new Error('That ship would extend beyond the grid.')
    }
    cells.push(`${COLUMNS[nextColumn]}${nextRow + 1}`)
  }
  return cells
}

function randomFleet() {
  const placed = []
  const occupied = new Set()
  for (const spec of state.fleetSpec) {
    let placement = null
    for (let attempt = 0; attempt < 500 && !placement; attempt += 1) {
      const orientation = Math.random() < 0.5 ? 'horizontal' : 'vertical'
      const maxColumn = orientation === 'horizontal' ? 10 - spec.size : 9
      const maxRow = orientation === 'vertical' ? 10 - spec.size : 9
      const column = Math.floor(Math.random() * (maxColumn + 1))
      const row = Math.floor(Math.random() * (maxRow + 1))
      const start = `${COLUMNS[column]}${row + 1}`
      const cells = placementCells(start, spec.size, orientation)
      if (cells.some(cell => occupied.has(cell))) continue
      placement = {name: spec.name, size: spec.size, start, orientation, cells}
    }
    if (!placement) throw new Error('Could not generate a fleet. Try again.')
    placed.push(placement)
    for (const cell of placement.cells) occupied.add(cell)
  }
  return placed
}

function resetDraftFleet() {
  state.draftShips = []
  state.selectedShip = state.fleetSpec[0]?.name || ''
}

function ensureSelectedShip() {
  if (state.fleet || state.selectedShip) return
  state.selectedShip =
    state.fleetSpec.find(
      ship => !state.draftShips.some(placed => placed.name === ship.name)
    )?.name || ''
}

function canFire() {
  return !!(
    state.player &&
    state.game?.status === 'active' &&
    state.game.turn === state.player.side
  )
}

async function fireShot(cell) {
  if (!canFire()) return
  targetGrid.classList.add('busy')
  try {
    const result = await client.fireShot(state.gameId, {
      playerToken: playerToken(),
      cell
    })
    await settleCompletedGame(result)
    await renderGame()
    if (result?.shot?.result === 'hit') {
      notifyInfo(result.shot.sunk ? `You sunk the ${result.shot.ship}!` : 'Hit!', 'positive')
    }
  } catch (error) {
    showError(error)
  } finally {
    targetGrid.classList.remove('busy')
  }
}

async function settleCompletedGame(result) {
  if (
    result?.game?.status !== 'completed' ||
    result?.game?.payoutPending !== true
  ) {
    return
  }
  try {
    await client.settlePlayerPayout(state.gameId, {
      playerToken: playerToken()
    })
  } catch (error) {
    console.warn(
      '[battleships public] payout settlement failed after game completion',
      error
    )
  }
}

function renderPlayers(players, currentPlayer) {
  playerList.innerHTML = ''
  if (!players.length) {
    playerList.append(emptyText('No paid players yet.'))
    return
  }
  for (const player of players) {
    const row = document.createElement('div')
    row.className = 'player-row'
    const label = document.createElement('span')
    label.textContent = `${sideLabel(player.side)}: ${player.lnAddress}`
    const status = document.createElement('span')
    status.className = 'muted'
    status.textContent =
      currentPlayer?.side === player.side ? 'you' : player.status
    row.append(label, status)
    playerList.append(row)
  }
}

function renderShots(shots) {
  shotList.innerHTML = ''
  if (!shots.length) {
    shotList.append(emptyText('No shots fired yet.'))
    return
  }
  for (const shot of shots.slice(-20).reverse()) {
    const row = document.createElement('div')
    row.className = 'move-row'
    const sunk = shot.sunk ? ` · sunk ${shot.ship}` : ''
    row.textContent = `${shot.shotNumber}. ${sideLabel(shot.side)} → ${shot.cell}: ${shot.result}${sunk}`
    shotList.append(row)
  }
}

function statusText(game, player) {
  if (game.status === 'waiting') {
    return player
      ? 'Waiting for an opponent to pay'
      : 'Waiting for two paid players'
  }
  if (game.status === 'placing') {
    const ownPlaced = player
      ? player.side === 'player1'
        ? game.playerOneFleetPlaced
        : game.playerTwoFleetPlaced
      : false
    if (!player) return 'Players are placing their fleets'
    return ownPlaced
      ? 'Fleet locked; waiting for your opponent'
      : `You are ${sideLabel(player.side)}; place your fleet`
  }
  if (game.status === 'completed') {
    const winner = game.winnerSide
      ? `${sideLabel(game.winnerSide)} won`
      : 'Battle complete'
    return game.payoutPending ? `${winner}; payout pending` : winner
  }
  if (!player) {
    return `${sideLabel(game.turn)} to fire; spectator view`
  }
  return game.turn === player.side
    ? `You are ${sideLabel(player.side)}; fire when ready`
    : `You are ${sideLabel(player.side)}; awaiting enemy fire`
}

function notifyGameChanges(previousGame, game, player) {
  if (
    game.status === 'completed' &&
    Number(game.completedAt || 0) &&
    state.notifiedCompletedAt !== Number(game.completedAt)
  ) {
    state.notifiedCompletedAt = Number(game.completedAt)
    const won = player?.side === game.winnerSide
    if (won) showConfetti()
    notifyInfo(
      won
        ? 'Victory! The enemy fleet is gone.'
        : `${sideLabel(game.winnerSide)} won the battle.`,
      won ? 'positive' : 'info'
    )
  } else if (previousGame?.status === 'placing' && game.status === 'active') {
    notifyInfo('Both fleets are ready. Battle stations!', 'positive')
  }
}

function openInvoiceDialog(invoice) {
  if (!invoice?.paymentRequest || !invoice?.paymentHash) {
    throw new Error('Invalid invoice response.')
  }
  copyInvoiceButton.dataset.invoice = invoice.paymentRequest
  invoiceStatus.textContent = 'Waiting for payment'
  invoiceStatus.classList.remove('text-positive')
  renderQrCode(`lightning:${invoice.paymentRequest.toUpperCase()}`)
  invoiceDialog.hidden = false
}

function closeInvoiceDialog() {
  invoiceDialog.hidden = true
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  if (state.qrApp) {
    state.qrApp.unmount()
    state.qrApp = null
  }
  invoiceQrCode.innerHTML = ''
}

function renderQrCode(value) {
  if (!window.Vue || !window.QrcodeVue?.default) {
    throw new Error('QR code renderer is not available.')
  }
  if (state.qrApp) state.qrApp.unmount()
  invoiceQrCode.innerHTML = ''
  state.qrApp = window.Vue.createApp({
    render() {
      return window.Vue.h(window.QrcodeVue.default, {
        value,
        size: 260,
        margin: 3,
        level: 'Q',
        renderAs: 'svg'
      })
    }
  })
  state.qrApp.mount(invoiceQrCode)
}

async function subscribeToPayment(paymentHash) {
  cleanupPaymentSubscription()
  try {
    state.invoiceUnsubscribe = await client.subscribePayment(
      paymentHash,
      event => {
        const payment = event.data || {}
        if (
          event.event === 'payment.settled' ||
          payment.pending === false ||
          ['success', 'settled', 'paid'].includes(String(payment.status || ''))
        ) {
          handleInvoicePaid()
        }
      }
    )
  } catch (error) {
    console.warn('[battleships public] payment subscription unavailable', error)
    invoiceStatus.textContent = 'Checking payment status'
  }
}

function cleanupPaymentSubscription() {
  if (!state.invoiceUnsubscribe) return
  if (typeof state.invoiceUnsubscribe === 'function') {
    state.invoiceUnsubscribe()
  } else {
    state.invoiceUnsubscribe.unsubscribe?.()
  }
  state.invoiceUnsubscribe = null
}

function startInvoicePolling(paymentHash) {
  cleanupInvoicePolling()
  state.invoicePollTimer = window.setInterval(async () => {
    try {
      const response = await client.getPublicGame(state.gameId, paymentHash)
      if (response?.player?.status === 'paid') handleInvoicePaid()
    } catch (error) {
      console.warn('[battleships public] invoice poll failed', error)
    }
  }, 2000)
}

function cleanupInvoicePolling() {
  if (!state.invoicePollTimer) return
  window.clearInterval(state.invoicePollTimer)
  state.invoicePollTimer = null
}

function handleInvoicePaid() {
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  invoiceStatus.textContent = 'Payment received'
  invoiceStatus.classList.add('text-positive')
  showConfetti()
  window.setTimeout(() => {
    closeInvoiceDialog()
    renderGame().catch(showError)
  }, 1500)
}

function playerToken() {
  if (!state.gameId) return ''
  if (state.playerToken) return state.playerToken
  state.playerToken = tokenFromUrl()
  return state.playerToken
}

function tokenFromUrl() {
  const params = new URLSearchParams(
    String(window.location.hash || '').replace(/^#/, '')
  )
  return params.get('playerToken') || ''
}

function savePlayerToken(token) {
  if (!token || !state.gameId) return
  state.playerToken = token
  const url = new URL(window.location.href)
  const params = new URLSearchParams(url.hash.replace(/^#/, ''))
  params.set('playerToken', token)
  url.hash = params.toString()
  window.history.replaceState({}, '', url.toString())
}

function publicGameUrl() {
  const url = new URL(window.location.href)
  const params = new URLSearchParams(url.hash.replace(/^#/, ''))
  params.delete('playerToken')
  url.hash = params.toString()
  return url.toString()
}

function showConfetti() {
  confettiLayer.innerHTML = ''
  for (let index = 1; index <= 32; index += 1) {
    const piece = document.createElement('span')
    piece.className = `confetti-piece confetti-piece-${index}`
    confettiLayer.append(piece)
  }
  window.setTimeout(() => {
    confettiLayer.innerHTML = ''
  }, 1800)
}

function fieldValue(container, name) {
  return String(container.querySelector(`[name="${name}"]`)?.value || '')
}

function emptyText(text) {
  const node = document.createElement('p')
  node.className = 'muted q-my-none'
  node.textContent = text
  return node
}

function sideLabel(side) {
  return side === 'player1'
    ? 'Player 1'
    : side === 'player2'
      ? 'Player 2'
      : 'Player'
}

function oppositeSide(side) {
  return side === 'player1' ? 'player2' : 'player1'
}

function capitalize(value) {
  const text = String(value || '')
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : ''
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[battleships public]', message, error)
  client.notifyError(message).catch(notifyError => {
    console.error('[battleships public] failed to notify error', notifyError)
  })
}

function notifyInfo(message, level = 'info') {
  client.notify(message, level).catch(error => {
    console.error('[battleships public] failed to notify', error)
  })
}

async function copyText(value, successMessage, failureMessage) {
  try {
    await navigator.clipboard.writeText(value)
    await client.notify(successMessage, 'positive')
  } catch (error) {
    console.warn('[battleships public] copy failed', error)
    await client.notify(failureMessage, 'negative')
  }
}

function confirmAction({title, message, okLabel = 'OK'}) {
  return new Promise(resolve => {
    const dialog = document.createElement('div')
    dialog.className = 'confirm-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const backdrop = document.createElement('button')
    backdrop.type = 'button'
    backdrop.className = 'confirm-dialog-backdrop'
    backdrop.setAttribute('aria-label', 'Cancel')
    const card = document.createElement('div')
    card.className = 'confirm-dialog-card panel q-card q-card--dark q-pa-md'
    const heading = document.createElement('h2')
    heading.className = 'text-h6 text-weight-bold q-my-none'
    heading.textContent = title
    const body = document.createElement('p')
    body.className = 'muted q-mt-sm'
    body.textContent = message
    const actions = document.createElement('div')
    actions.className = 'row justify-end q-gutter-sm q-mt-md'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'q-btn subtle-button'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'q-btn danger-button'
    ok.textContent = okLabel
    const close = result => {
      dialog.remove()
      resolve(result)
    }
    backdrop.addEventListener('click', () => close(false))
    cancel.addEventListener('click', () => close(false))
    ok.addEventListener('click', () => close(true))
    actions.append(cancel, ok)
    card.append(heading, body, actions)
    dialog.append(backdrop, card)
    document.body.append(dialog)
    cancel.focus()
  })
}

function setJoinLoading(loading) {
  joinButton.disabled = loading
  joinButton.setAttribute('aria-busy', loading ? 'true' : 'false')
}

function cleanup() {
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  if (state.refreshTimer) window.clearTimeout(state.refreshTimer)
  if (state.pollTimer) window.clearInterval(state.pollTimer)
  state.websocket?.unsubscribe?.()
}
