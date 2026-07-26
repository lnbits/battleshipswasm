# Battleships

Battleships is an LNbits WebAssembly extension for paid, public, two-player
Battleships games. The winner receives the pot minus the configured haircut.

An LNbits user enables the extension, selects a wallet, creates a game with a
join amount, and shares its public link. Each player enters a Lightning address
and pays the join invoice. Player links contain a private `#playerToken=...`
fragment that authorizes fleet placement and shots.

## Game flow

1. Two players pay the configured join amount.
2. Each player privately places a carrier (5), battleship (4), cruiser (3),
   submarine (3), and destroyer (2) on a 10×10 grid.
3. Player 1 fires first; turns alternate after every shot.
4. Hits, misses, and sunk ships are public, but unhit fleet positions are only
   returned to their owner.
5. Sinking all 17 opposing ship cells or receiving a resignation wins the game.
6. The winner payout can be settled from either player's page or the admin page.

The copied public link strips the private player token and is safe to share with
the opponent or spectators.

## Extension details

- Extension ID: `battleshipswasm`
- Extension type: `wasm`
- Minimum LNbits version: `1.5.5`
- Admin route: `/ext/battleshipswasm`
- Public route: `/ext/battleshipswasm/games/{game_id}`
- WASM module: `wasm/module.wasm`

## Build and test

```bash
cd lnbits/extensions/battleshipswasm/dev
npm run check
npm run build:wasm
```

The build writes the installable component to `../wasm/module.wasm`.
